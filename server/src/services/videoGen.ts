import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  writeFileSync,
  renameSync
} from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Api, InputFile } from "grammy";

import { getRunningHubConfig } from "../core/config";
import { DATA_DIR } from "../core/data";
import { getOpenAiClient, resolveLlmModel } from "./llm";
import { loadSession } from "./session";
import { ChatMessage, DigitalHumanConfig } from "../types";

const execFileAsync = promisify(execFile);

const RH_BASE = "https://www.runninghub.ai/openapi/v2";
const VIDEO_APP_ID = "2086406765420687361"; // 图生视频工作流
const VIDEO_POLL_INTERVAL_MS = 20000; // 20s 轮询
const VIDEO_POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 分钟超时
const MAX_CONSECUTIVE_QUERY_FAILURES = 30; // 连续查询失败 ≈10min 后判定超时
const DEFAULT_DURATION_SEC = 10;

const VIDEO_TASKS_FILE = path.join(DATA_DIR, "video-tasks.json");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ⚠️ 全局单在途锁：同一时刻只允许 1 个视频生成任务在途（用户确认）。
// 任何终态（SUCCESS/FAILED/TIMEOUT/连续查询失败）都必须释放该锁，否则功能会永久卡死。
let videoInFlight = false;
export function isVideoInFlight(): boolean {
  return videoInFlight;
}

interface VideoTask {
  taskId: string;
  chatId: number;
  characterId: string;
  sessionId: string;
  botToken: string;
  repliedPhotoFileId: string;
  userText: string;
  durationSec: number;
  prompt: string; // H3 提示词，"" 表示空白提示词
  fileName: string; // RunningHub 上传后的图片 fileName（恢复时无需重新下载照片）
  createdAt: number;
}

// ---------- 持久化（重启续轮询）----------

function loadTasks(): VideoTask[] {
  try {
    if (!existsSync(VIDEO_TASKS_FILE)) return [];
    const arr = JSON.parse(readFileSync(VIDEO_TASKS_FILE, "utf8")) as VideoTask[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persistTasks(tasks: VideoTask[]): void {
  try {
    mkdirSync(path.dirname(VIDEO_TASKS_FILE), { recursive: true });
    const tmp = `${VIDEO_TASKS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), "utf8");
    renameSync(tmp, VIDEO_TASKS_FILE);
  } catch (err) {
    console.error("[VIDEO] 持久化任务失败（不影响主流程）:", err);
  }
}

function releaseTask(taskId: string): void {
  const tasks = loadTasks().filter((t) => t.taskId !== taskId);
  persistTasks(tasks);
  // 若还有其他在途（理论上不会，因全局单锁），保持锁；否则释放
  videoInFlight = tasks.length > 0;
}

// ---------- RunningHub 接口封装（复用拍照同 key）----------

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
  const json = (await resp.json().catch(() => ({}))) as {
    code?: number;
    data?: { fileName?: string };
    message?: string;
  };
  if (resp.status !== 200 || !json?.data?.fileName) {
    throw new Error(`RunningHub 图片上传失败：${json?.message || JSON.stringify(json).slice(0, 160)}`);
  }
  return json.data.fileName;
}

async function rhSubmitVideo(
  apiKey: string,
  fileName: string,
  prompt: string,
  durationSec: number
): Promise<string> {
  const body = {
    nodeInfoList: [
      { nodeId: "40", fieldName: "image", fieldValue: fileName, description: "Upload image" },
      { nodeId: "55", fieldName: "text", fieldValue: prompt, description: "Input requirements" },
      { nodeId: "56", fieldName: "value", fieldValue: "0.4", description: "Pixels/Million" },
      {
        nodeId: "14",
        fieldName: "value",
        fieldValue: String(durationSec),
        description: "Duration/seconds"
      }
    ],
    instanceType: "default",
    usePersonalQueue: "false"
  };
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`${RH_BASE}/run/ai-app/${VIDEO_APP_ID}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      const json = (await resp.json().catch(() => ({}))) as {
        taskId?: string;
        errorCode?: string;
        errorMessage?: string;
      };
      if (resp.status === 200 && json?.taskId) return json.taskId;
      const msg = json?.errorMessage || json?.errorCode || JSON.stringify(json).slice(0, 160);
      lastErr = new Error(`RunningHub 视频提交失败：${msg}`);
      const isLimit = resp.status === 429 || /queue limit|too many requests|rate limit|并发/i.test(msg);
      if (!isLimit || attempt === MAX_ATTEMPTS) throw lastErr;
      const wait = Math.min(8000, 1000 * attempt * 2);
      console.warn(`[VIDEO] 提交被限流，${wait}ms 后重试(${attempt}/${MAX_ATTEMPTS})：${msg}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    } catch (e) {
      lastErr = e;
      const isLimit = e instanceof Error && /queue limit|too many requests|rate limit|并发/i.test(e.message);
      if (!isLimit || attempt === MAX_ATTEMPTS) throw e;
      const wait = Math.min(8000, 1000 * attempt * 2);
      console.warn(`[VIDEO] 提交异常，${wait}ms 后重试(${attempt}/${MAX_ATTEMPTS})：${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function rhQuery(
  apiKey: string,
  taskId: string
): Promise<{
  status: string;
  results?: Array<{ url: string; outputType: string }>;
  errorMessage?: string;
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
  };
}

// ---------- 下载 / 解压 / 取视频 ----------

async function downloadFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载视频结果失败（HTTP ${resp.status}）`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
}

function findFirstVideo(dir: string): string | null {
  const exts = [".mp4", ".webm", ".mov", ".m4v", ".avi"];
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

// ---------- Telegram 文件下载（回复的照片）----------

async function downloadTelegramFile(
  api: Api,
  botToken: string,
  fileId: string,
  dest: string
): Promise<void> {
  const file = await api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("文件无可用路径");
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync("curl", ["-4", "-sS", "-f", "--max-time", "30", "-o", dest, url]);
      const st = await fs.stat(dest);
      if (!st.size) throw new Error("下载文件为空");
      return;
    } catch (e) {
      lastErr = e;
      await sleep(800 * attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("下载 Telegram 文件失败");
}

// ---------- 提示词生成（MiniMax H3 I2VA 规范）----------

// 仅当回复文字为「无意义填充词」时才传空白提示词；否则调 LLM 按 H3 图生视频规范扩写。
const FILLER_RE = /^(好|好的|嗯|嗯嗯|噢|哦|ok|okay|go|来|生成|做|视频|拍|谢谢|thx|thanks|👌|😊|嘿|hi|hello|在吗|好呀|行|可以|收到|对|是的|嗯好)*$/i;

function parseDuration(userText: string): number {
  const m = (userText || "").match(/(\d{1,3})\s*秒/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 4 && n <= 15) return n; // H3 时长范围 4–15s
  }
  return DEFAULT_DURATION_SEC; // 默认 10s
}

const VIDEO_PROMPT_SYSTEM =
  "You are the cinematographer for an AI companion's image-to-video clip. " +
  "The first frame is ALREADY a photo of her — you only describe what MOVES and what stays FIXED.\n" +
  "Rules:\n" +
  "1. Write the prompt in English.\n" +
  "2. Do NOT include any negative prompt (this model has no negative-prompt support).\n" +
  "3. Describe ONE clear motion/action (e.g. hair swaying, a slow smile, leaning closer, " +
  "wind through hair, a hand gesture) plus subtle camera movement (slow push-in / pan / handheld).\n" +
  "4. Lock invariants: her identity, outfit, and background must stay EXACTLY as the seed image — " +
  "do NOT describe them as changing.\n" +
  "5. Adult / NSFW content is allowed; you may describe intimate motion directly and without euphemism.\n" +
  "6. Keep it to 2–4 sentences. Output ONLY the prompt, no quotes, no explanation.\n" +
  "7. Do not embed timecodes; the clip duration is applied separately.";

export async function generateVideoPrompt(
  character: DigitalHumanConfig,
  recentMessages: ChatMessage[],
  userText: string
): Promise<string> {
  const trimmed = (userText || "").trim();
  if (!trimmed || FILLER_RE.test(trimmed.replace(/\s+/g, ""))) {
    return ""; // 空白提示词
  }
  const client = getOpenAiClient();
  if (!client) {
    // 无 LLM 通道时不强依赖，退化为空白提示词（仍会生成视频）
    console.warn("[VIDEO] 未配置 LLM 通道，视频使用空白提示词");
    return "";
  }

  const identity = `名字：${character.name}\n设定：${character.description}`;
  const context = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.content}`)
    .join("\n");

  const userPrompt =
    `${identity}\n\n【最近对话】\n${context || "（无）"}\n\n` +
    `【用户对这张照片的指令】${trimmed}\n\n` +
    `基于用户的指令，写一段英文图生视频提示词（只描述运动 + 运镜 + 锁定不变量，2-4 句）：`;

  try {
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.9,
      stream: false,
      messages: [
        { role: "system", content: VIDEO_PROMPT_SYSTEM },
        { role: "user", content: userPrompt }
      ]
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    return text || "";
  } catch (err) {
    // 提示词生成失败不阻断视频生成，退化为空白提示词
    console.error("[VIDEO] 生成提示词失败，退回空白提示词：", err);
    return "";
  }
}

const VIDEO_FOLLOWUP_FALLBACK = "（刚把那张照做成小视频啦，你看看～）";

async function generateVideoFollowup(
  character: DigitalHumanConfig,
  sessionId: string,
  userText: string
): Promise<string> {
  const client = getOpenAiClient();
  if (!client) return VIDEO_FOLLOWUP_FALLBACK;
  try {
    const session = await loadSession(sessionId);
    const context = (session?.history ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.content}`)
      .join("\n");
    const system =
      `你是「${character.name}」。用户之前让你把她的一张照片做成视频，现在视频已经生成好了，` +
      `你要自然地把这个消息告诉她，就像你刚忙完回来顺口说的。` +
      `结合最近对话上下文，写一句简短（不超过 40 字）自然的话，可以呼应她之前的指令。` +
      `不要解释技术细节，不要提 RunningHub / AI / 模型 / 视频生成这类词。` +
      `可以带点她的人设语气，让这条延迟消息看起来像顺理成章的续聊。`;
    const userPrompt =
      `${context}\n\n用户当时的指令：${(userText || "").trim() || "（没特别说）"}\n\n写一句自然的话告诉她视频好了：`;
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.8,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt }
      ]
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    return text || VIDEO_FOLLOWUP_FALLBACK;
  } catch (err) {
    console.error("[VIDEO] 生成收尾文案失败，使用兜底：", err);
    return VIDEO_FOLLOWUP_FALLBACK;
  }
}

// ---------- 推送（视频或失败文案）----------

async function sendVideoMessage(
  task: VideoTask,
  videoPath: string | null,
  text: string
): Promise<void> {
  const api = new Api(task.botToken);
  try {
    if (videoPath) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.sendChatAction(task.chatId, "upload_video").catch(() => {});
          await api.sendVideo(task.chatId, new InputFile(videoPath), {
            caption: text.slice(0, 1024)
          });
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await sleep(500 * Math.pow(2, attempt));
        }
      }
    } else {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await api.sendMessage(task.chatId, text.slice(0, 4000));
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          await sleep(500 * Math.pow(2, attempt));
        }
      }
    }
  } catch (err) {
    console.error(`[VIDEO][${task.characterId}] 推送失败:`, err);
  } finally {
    releaseTask(task.taskId); // 任一终态都强制释放锁 + 删除持久化任务
  }
}

// ---------- 成功处理（下载 / 自适应解压 / 推送）----------

async function handleVideoSuccess(task: VideoTask, videoUrl: string | null): Promise<void> {
  const tag = `[VIDEO][${task.characterId}]`;
  if (!videoUrl) {
    await sendVideoMessage(task, null, "视频生成成功，但未能获取视频地址，请稍后重试。");
    return;
  }
  const tmpDir = path.join(os.tmpdir(), `dg-video-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  const rawPath = path.join(tmpDir, "raw");
  try {
    await downloadFile(videoUrl, rawPath);
    const head = readFileSync(rawPath).slice(0, 12);
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04; // "PK\x03\x04"
    let videoPath: string;
    if (isZip) {
      await execFileAsync("unzip", ["-o", rawPath, "-d", tmpDir]);
      const v = findFirstVideo(tmpDir);
      if (!v) throw new Error("视频结果中未找到视频文件");
      videoPath = v;
      console.log(`${tag} 视频完成(压缩包) 本地=${videoPath}`);
    } else {
      // 直出视频：按 magic bytes 判定容器
      const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      const isMp4 = head.slice(4, 8).toString("latin1") === "ftyp";
      const ext = isWebm ? "webm" : isMp4 ? "mp4" : "mp4"; // 兜底 mp4
      videoPath = path.join(tmpDir, `out.${ext}`);
      writeFileSync(videoPath, readFileSync(rawPath));
      console.log(`${tag} 视频完成(直出) 本地=${videoPath}`);
    }
    const followup = await generateVideoFollowup(
      await loadCharacter(task.characterId),
      task.sessionId,
      task.userText
    );
    await sendVideoMessage(task, videoPath, followup);
  } catch (err) {
    console.error(`${tag} 视频下载/解压失败:`, err);
    await sendVideoMessage(task, null, "视频已生成，但下载或解压失败，请稍后重试。");
  } finally {
    cleanupDir(tmpDir); // 零留存：推送完毕后立即删除本地视频
  }
}

// 轻量取数字人配置（用于生成收尾文案，失败兜底）
async function loadCharacter(characterId: string): Promise<DigitalHumanConfig> {
  try {
    const { getCharacters } = await import("../core/data");
    const chars = await getCharacters();
    const c = chars.find((x) => x.id === characterId);
    if (c) return c;
  } catch {
    /* ignore */
  }
  return { id: characterId, name: "她", description: "", relationshipMode: "sweet", defaultMood: "neutral", avatarType: "image", voiceProfile: { provider: "mimo", voice: "冰糖" } };
}

// ---------- 轮询 ----------

async function pollVideoTask(task: VideoTask): Promise<void> {
  const tag = `[VIDEO][${task.characterId}]`;
  const cfg = getRunningHubConfig();
  const apiKey = cfg.apiKey || process.env.RUNNINGHUB_API_KEY;
  if (!apiKey) {
    await sendVideoMessage(task, null, "未配置 RunningHub API Key，无法查询视频任务。");
    return;
  }
  // 截止时间取「20 分钟窗口」，恢复的任务以创建时间为起点，避免重启后续等过久
  const deadline = Math.min(Date.now() + VIDEO_POLL_TIMEOUT_MS, task.createdAt + VIDEO_POLL_TIMEOUT_MS);
  let consecutiveFails = 0;
  while (Date.now() < deadline) {
    await sleep(VIDEO_POLL_INTERVAL_MS);
    try {
      const r = await rhQuery(apiKey, task.taskId);
      consecutiveFails = 0;
      if (r.status === "SUCCESS") {
        console.log(`${tag} 轮询=SUCCESS`);
        await handleVideoSuccess(task, r.results?.[0]?.url ?? null);
        return;
      }
      if (r.status === "FAILED") {
        console.error(`${tag} 视频失败 status=FAILED errorMessage=${r.errorMessage || ""}`);
        await sendVideoMessage(
          task,
          null,
          `视频生成失败了${r.errorMessage ? "：" + r.errorMessage.slice(0, 120) : ""}`
        );
        return;
      }
      // QUEUED / RUNNING → 继续轮询
    } catch (e) {
      consecutiveFails++;
      console.warn(`${tag} 查询异常(第${consecutiveFails}次)：${e instanceof Error ? e.message : e}`);
      if (consecutiveFails >= MAX_CONSECUTIVE_QUERY_FAILURES) {
        console.error(`${tag} 查询连续失败${consecutiveFails}次，判定超时`);
        await sendVideoMessage(task, null, "视频生成查询连续失败，已停止等待，可稍后重试。");
        return;
      }
    }
  }
  console.error(`${tag} 视频超时（超过 ${VIDEO_POLL_TIMEOUT_MS / 60000} 分钟）`);
  await sendVideoMessage(task, null, "视频生成超时（已等20分钟），可稍后重试。");
}

// ---------- 对外主入口 ----------

export async function startVideoTask(opts: {
  api: Api;
  botToken: string;
  chatId: number;
  character: DigitalHumanConfig;
  repliedPhotoFileId: string;
  userText: string;
  recentMessages: ChatMessage[];
  sessionId: string;
}): Promise<void> {
  // 同步置锁，防止并发触发多个在途任务（Node 单线程，此处安全）
  if (videoInFlight) {
    throw new Error("VIDEO_INFLIGHT");
  }
  videoInFlight = true;

  const tag = `[VIDEO][${opts.character.name}]`;
  const t0 = Date.now();
  console.log(`${tag} 视频生成开始 chatId=${opts.chatId}`);

  let imgTmp: string | null = null;
  try {
    const cfg = getRunningHubConfig();
    const apiKey = cfg.apiKey || process.env.RUNNINGHUB_API_KEY;
    if (!apiKey) {
      throw new Error("未配置 RunningHub API Key（请在系统设置页填写）");
    }

    const durationSec = parseDuration(opts.userText);
    const prompt = await generateVideoPrompt(opts.character, opts.recentMessages, opts.userText);
    console.log(`${tag} 时长=${durationSec}s 提交提示词 → ${prompt || "(空白)"}`);

    // 下载用户回复的照片（临时，用完即删，不在服务器留存）
    imgTmp = path.join(os.tmpdir(), `dg-vsrc-${Date.now()}-${Math.random().toString(16).slice(2)}.img`);
    await downloadTelegramFile(opts.api, opts.botToken, opts.repliedPhotoFileId, imgTmp);

    // 上传到 RunningHub
    const fileName = await rhUploadImage(apiKey, imgTmp);
    console.log(`${tag} 照片已上传 fileName=${fileName}`);
    // 源照片已上传，本地临时文件立即删除（零留存）
    try {
      rmSync(imgTmp, { force: true });
    } catch {
      /* ignore */
    }
    imgTmp = null;

    // 提交视频 app
    const taskId = await rhSubmitVideo(apiKey, fileName, prompt, durationSec);
    console.log(`${tag} 任务已提交 taskId=${taskId}`);

    const task: VideoTask = {
      taskId,
      chatId: opts.chatId,
      characterId: opts.character.id,
      sessionId: opts.sessionId,
      botToken: opts.botToken,
      repliedPhotoFileId: opts.repliedPhotoFileId,
      userText: opts.userText,
      durationSec,
      prompt,
      fileName,
      createdAt: Date.now()
    };
    persistTasks([task]);

    // 异步轮询，不阻塞聊天
    void pollVideoTask(task).catch((err) => {
      console.error(`${tag} 轮询异常:`, err);
      releaseTask(task.taskId);
    });
  } catch (err) {
    videoInFlight = false; // 未成功提交 → 释放锁
    if (imgTmp) {
      try {
        rmSync(imgTmp, { force: true });
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

// ---------- 重启恢复在途任务 ----------

export function resumeVideoTasks(): void {
  const tasks = loadTasks();
  if (tasks.length === 0) return;
  console.log(`[VIDEO] 恢复 ${tasks.length} 个在途视频任务`);
  videoInFlight = true;
  for (const task of tasks) {
    void pollVideoTask(task).catch((err) => {
      console.error(`[VIDEO][${task.characterId}] 恢复轮询异常:`, err);
      releaseTask(task.taskId);
    });
  }
}
