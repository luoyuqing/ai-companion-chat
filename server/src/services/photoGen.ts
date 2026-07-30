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

// 生图提示词兜底（LLM 不可用或无上下文时使用）
const DEFAULT_PHOTO_PROMPT =
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
      { nodeId: "192", fieldName: "value", fieldValue: "false", description: "Gray image output (default Zip)" },
      { nodeId: "195", fieldName: "text", fieldValue: prompt, description: "Prompt" }
    ],
    instanceType: "default",
    usePersonalQueue: "false"
  };
  const resp = await fetch(`${RH_BASE}/run/ai-app/${APP_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const json = (await resp.json().catch(() => ({}))) as { taskId?: string; errorCode?: string; errorMessage?: string };
  if (resp.status !== 200 || !json?.taskId) {
    throw new Error(`RunningHub 提交失败：${json?.errorMessage || json?.errorCode || JSON.stringify(json).slice(0, 160)}`);
  }
  return json.taskId;
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
  if (!client) return DEFAULT_PHOTO_PROMPT;

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
    `1. 若上下文里她描述过自己的衣着 / 环境 / 姿势，务必贴合这些描述；若没有，则自行合理生成` +
    `（例如：女人全身只穿着一件白色的男士衬衣，跪在床上，双腿自然张开，正在自拍，摆出可爱的自拍手势）。\n` +
    `2. 允许成人 / NSFW 内容，描写可以直白。\n` +
    `3. 只输出提示词本身，不要任何解释，不要用引号包裹。`;

  const user = `${identity}\n\n【最近对话】\n${context || "（无）"}\n\n请撰写生图提示词：`;

  try {
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.9,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    return text || DEFAULT_PHOTO_PROMPT;
  } catch (err) {
    console.error("生成生图提示词失败，使用兜底：", err);
    return DEFAULT_PHOTO_PROMPT;
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

  // 下载 ZIP → 解压 → 取首张图片
  const tmpDir = path.join(os.tmpdir(), `dg-photo-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, "out.zip");
  try {
    await downloadFile(imageUrl, zipPath);
    await execFileAsync("unzip", ["-o", zipPath, "-d", tmpDir]);
    const img = findFirstImage(tmpDir);
    if (!img) throw new Error("生图结果中未找到图片文件");
    console.log(`${tag} 生图完成 本地图=${img} 总耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return {
      imagePath: img,
      cleanup: () => cleanupDir(tmpDir)
    };
  } catch (err) {
    cleanupDir(tmpDir);
    throw err;
  }
}
