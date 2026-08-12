import { readFileSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { getRunningHubConfig } from "../core/config";
import { AVATAR_DIR } from "../core/data";
import { getOpenAiClient, resolveLlmModel } from "./llm";
import { ChatMessage, DigitalHumanConfig } from "../types";

const execFileAsync = promisify(execFile);

const RH_BASE = "https://www.runninghub.ai/openapi/v2";
const APP_ID = "2075560920047575042";
const POLL_INTERVAL_MS = 8000;
const POLL_TIMEOUT_MS = 150000;

// ⚠️ 仅作为「风格 / 格式」示范写入 LLM 的 system prompt，严禁作为实际提示词原话发送给 RunningHub。
// 真实提示词必须由 LLM 依据数字人人设创作；上下文不足时由 LLM 随机生成衣着 / 环境 / 姿势。
const PROMPT_STYLE_EXAMPLE =
  "女人全身只穿着一件白色的男士衬衣，跪在床上，双腿自然张开，正在自拍，摆出可爱的自拍手势，柔和光线，全身构图";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生图轮询超时异常（与「RunningHub 接口报错」区分，便于上层走不同提示） */
export class PhotoTimeoutError extends Error {
  constructor(message = "生图超时") {
    super(message);
    this.name = "PhotoTimeoutError";
  }
}

// ---------- RunningHub 接口封装 ----------

async function rhUploadImage(apiKey: string, imagePath: string): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([readFileSync(imagePath)], { type: "image/png" }),
    path.basename(imagePath)
  );
  const resp = await fetch(`${RH_BASE}/media/upload/binary`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  const json = (await resp.json().catch(() => ({}))) as { code?: number; data?: { fileName?: string }; message?: string };
  if (resp.status !== 200 || !json?.data?.fileName) {
    throw new Error(`RunningHub 头像上传失败：${json?.message || JSON.stringify(json).slice(0, 160)}`);
  }
  return json.data.fileName;
}

async function rhSubmit(apiKey: string, fileName: string, prompt: string): Promise<string> {
  // 严格照官方文档原样提交，不自定义任何可控参数
  const body = {
    nodeInfoList: [
      { nodeId: "154", fieldName: "image", fieldValue: fileName, description: "Upload image" },
      { nodeId: "186", fieldName: "value", fieldValue: "2048", description: "Resolution" },
      { nodeId: "187", fieldName: "value", fieldValue: "1", description: "Quantity/Piece" },
      {
        nodeId: "188",
        fieldName: "value",
        fieldValue: "false",
        description: "Other proportions (Text-to-image must be enabled)"
      },
      {
        nodeId: "189",
        fieldName: "aspect_ratio",
        fieldData: '[["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"], {"default": "1:1"}]',
        fieldValue: "3:4",
        description: "Ratio selection (Effective when the switch above is turned on)"
      },
      { nodeId: "192", fieldName: "value", fieldValue: "true", description: "Gray image output (default Zip)" },
      { nodeId: "195", fieldName: "text", fieldValue: prompt, description: "Prompt" }
    ],
    instanceType: "default",
    usePersonalQueue: "false"
  };
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`${RH_BASE}/run/ai-app/${APP_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      const json = (await resp.json().catch(() => ({}))) as { taskId?: string; errorCode?: string; errorMessage?: string };
      if (resp.status === 200 && json?.taskId) return json.taskId;
      const msg = json?.errorMessage || json?.errorCode || JSON.stringify(json).slice(0, 160);
      lastErr = new Error(`RunningHub 提交失败：${msg}`);
      // 仅并发/限流类错误才退避重试（名额约 1-2 分钟释放）
      const isLimit = resp.status === 429 || /queue limit|too many requests|rate limit|并发/i.test(msg);
      if (!isLimit || attempt === MAX_ATTEMPTS) throw lastErr;
      const wait = Math.min(8000, 1000 * attempt * 2);
      console.warn(`[RB] 提交被限流，${wait}ms 后重试(${attempt}/${MAX_ATTEMPTS})：${msg}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    } catch (e) {
      lastErr = e;
      const isLimit = e instanceof Error && /queue limit|too many requests|rate limit|并发/i.test(e.message);
      if (!isLimit || attempt === MAX_ATTEMPTS) throw e;
      const wait = Math.min(8000, 1000 * attempt * 2);
      console.warn(`[RB] 提交异常，${wait}ms 后重试(${attempt}/${MAX_ATTEMPTS})：${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function rhQuery(apiKey: string, taskId: string): Promise<{
  status: string;
  results?: Array<{ url: string; outputType: string }>;
  errorMessage?: string;
  failedReason?: unknown;
}> {
  const resp = await fetch(`${RH_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ taskId })
  });
  return (await resp.json().catch(() => ({}))) as {
    status: string;
    results?: Array<{ url: string; outputType: string }>;
    errorMessage?: string;
    failedReason?: unknown;
  };
}

// ---------- 提示词生成（复用现有 LLM 通道） ----------

export async function generatePhotoPrompt(
  character: DigitalHumanConfig,
  recentMessages: ChatMessage[]
): Promise<string> {
  const client = getOpenAiClient();
  if (!client) {
    throw new Error("未配置 LLM 通道，无法生成生图提示词（请检查系统 LLM 配置）");
  }

  const identity = `名字：${character.name}\n设定：${character.description}`;
  const context = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.content}`)
    .join("\n");

  const system =
    `你是「${character.name}」的写真提示词撰写助手。根据她的身份设定与当前对话上下文，撰写一段英文生图提示词，` +
    `描述她的衣着、所处环境、身体姿势与镜头角度。\n` +
    `规则：\n` +
    `1. 若上下文里她描述过自己的衣着 / 环境 / 姿势，务必贴合这些描述。\n` +
    `2. 若上下文没有这些要素，必须依据她的「身份设定」自行创作，并随机生成衣着、环境、姿势——` +
    `每次生成都要不一样、有新鲜感，禁止千篇一律。\n` +
    `3. 允许成人 / NSFW 内容，描写可以直白。\n` +
    `4. 只输出提示词本身，不要任何解释，不要用引号包裹。\n` +
    `5. 下面只是一段「风格 / 格式」示范，仅供体会语气与结构，` +
    `严禁原样照搬或高度相似地翻写，你必须独立创作：\n` +
    `   示范：${PROMPT_STYLE_EXAMPLE}`;

  const user =
    `${identity}\n\n【最近对话】\n${context || "（无）"}\n\n` +
    `请基于她的身份创作一段全新的生图提示词（衣着 / 环境 / 姿势请随机变化，不要重复）：`;

  try {
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.95,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("LLM 返回的生图提示词为空");
    return text;
  } catch (err) {
    // 绝不回退到默认提示词原话：直接抛出，交由上层走「生图失败」分支（保留完整报错供日志排查）
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`生成生图提示词失败：${msg}`);
  }
}

// ---------- 头像路径解析（按数字人隔离） ----------

function resolveAvatarPath(character: DigitalHumanConfig): string | null {
  const av = character.avatarUrl;
  if (av && av.startsWith("/avatars/")) {
    const p = path.join(AVATAR_DIR, path.basename(av));
    if (existsSync(p)) return p;
  }
  const def = path.join(AVATAR_DIR, "default.png");
  return existsSync(def) ? def : null;
}

// ---------- 下载 / 解压 / 取图 ----------

async function downloadFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载生图结果失败（HTTP ${resp.status}）`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
}

function findFirstImage(dir: string): string | null {
  const exts = [".png", ".jpg", ".jpeg", ".webp"];
  for (const f of readdirSync(dir)) {
    const lower = f.toLowerCase();
    if (exts.some((e) => lower.endsWith(e))) return path.join(dir, f);
  }
  return null;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

// ---------- 对外主入口 ----------

export interface PhotoResult {
  /** 解压后图片的临时文件路径（发送后务必调用 cleanup 删除） */
  imagePath: string;
  cleanup: () => void;
}

export async function runPhotoTask(opts: {
  character: DigitalHumanConfig;
  recentMessages: ChatMessage[];
  /** 轮询超时时间（毫秒），默认 POLL_TIMEOUT_MS。超时抛出 PhotoTimeoutError。 */
  timeoutMs?: number;
}): Promise<PhotoResult> {
  const tag = `[RB][${opts.character.name}]`;
  const t0 = Date.now();
  console.log(`${tag} 生图开始`);

  const cfg = getRunningHubConfig();
  const apiKey = cfg.apiKey || process.env.RUNNINGHUB_API_KEY;
  if (!apiKey) {
    console.error(`${tag} 未配置 RunningHub API Key（请在系统设置页填写）`);
    throw new Error("未配置 RunningHub API Key（请在系统设置页填写）");
  }

  const avatarPath = resolveAvatarPath(opts.character);
  if (!avatarPath) {
    console.error(`${tag} 未找到数字人头像，无法生图`);
    throw new Error("未找到数字人头像，无法生图");
  }

  console.log(`${tag} 正在生成生图提示词…`);
  const prompt = await generatePhotoPrompt(opts.character, opts.recentMessages);
  // 关键：把实际提交给 RunningHub 的提示词落到日志，便于事后核查每个数字人发了什么
  console.log(`${tag} 提交提示词 → ${prompt}`);

  const fileName = await rhUploadImage(apiKey, avatarPath);
  console.log(`${tag} 头像已上传 fileName=${fileName}`);

  const taskId = await rhSubmit(apiKey, fileName, prompt);
  console.log(`${tag} 任务已提交 taskId=${taskId}`);

  // 8s 轮询，直到 SUCCESS / FAILED / 超时（超时时长可经 timeoutMs 配置，默认 POLL_TIMEOUT_MS）
  let imageUrl: string | null = null;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const r = await rhQuery(apiKey, taskId);
    if (r.status === "SUCCESS") {
      imageUrl = r.results?.[0]?.url ?? null;
      console.log(`${tag} 轮询=SUCCESS 图片URL=${imageUrl}`);
      break;
    }
    if (r.status === "FAILED") {
      console.error(`${tag} 生图失败 status=FAILED errorMessage=${r.errorMessage || ""} failedReason=${JSON.stringify(r.failedReason || {})}`);
      throw new Error(`生图失败：${r.errorMessage || JSON.stringify(r.failedReason || {}).slice(0, 160)}`);
    }
  }
  if (!imageUrl) {
    console.error(`${tag} 生图超时（超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成）taskId=${taskId}`);
    throw new PhotoTimeoutError(`生图超时（超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成）`);
  }

  // 下载结果 → 判断真实格式（ZIP 压缩包 or 单张图片）→ 取图
  // 注：RunningHub 在 node192="true" 时返回 ZIP 压缩包；若以后接口又改回单图直链，
  // 这里按文件头 magic bytes 自适应，避免对图片误跑 unzip 导致全部失败。
  const tmpDir = path.join(os.tmpdir(), `dg-photo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const rawPath = path.join(tmpDir, "raw");
  try {
    await downloadFile(imageUrl, rawPath);
    const head = readFileSync(rawPath).slice(0, 4);
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04; // "PK\x03\x04"
    if (isZip) {
      await execFileAsync("unzip", ["-o", rawPath, "-d", tmpDir]);
      const img = findFirstImage(tmpDir);
      if (!img) throw new Error("生图结果中未找到图片文件");
      console.log(`${tag} 生图完成(压缩包) 本地图=${img} 总耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { imagePath: img, cleanup: () => cleanupDir(tmpDir) };
    }
    // 单张图片：按 magic bytes 给正确扩展名后直接作为结果（不再 unzip）
    const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38;
    const isRiff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46; // webp 等
    const ext = isJpeg ? "jpg" : isPng ? "png" : isGif ? "gif" : isRiff ? "webp" : "bin";
    const imgPath = path.join(tmpDir, `out.${ext}`);
    if (rawPath !== imgPath) writeFileSync(imgPath, readFileSync(rawPath));
    console.log(`${tag} 生图完成(单图) 本地图=${imgPath} 总耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { imagePath: imgPath, cleanup: () => cleanupDir(tmpDir) };
  } catch (err) {
    cleanupDir(tmpDir);
    throw err;
  }
}
