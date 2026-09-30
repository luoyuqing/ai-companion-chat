/**
 * Matrix 渠道适配器（一角色一账号一私聊房间）。
 *
 * 职责边界：**只做渠道适配** —— 人设、提示词、记忆总结、情绪推断、TTS、ASR、生图生视频
 * 全部调用 core/ 与 services/ 的现有函数，不复制任何业务逻辑。
 * 这也是「换渠道当天人设/记忆/称呼/对话历史无缝续接」能成立的原因：
 * 长期记忆按角色 id 存储（user-memories/<charId>.json），主人私聊会话为 sessions/mem-<charId>.json，
 * 两者都与渠道无关。
 *
 * 与 Telegram 侧的关键差异：
 * - 语音回复：MiMo 产出 mp3，Matrix 直接发 m.audio，**不需要 ffmpeg 转 OGG/Opus**（比 TG 链路短）。
 * - 语音输入：Element 录音多为 ogg/opus 或 m4a，仍用 ffmpeg 统一转 16k 单声道 wav 后走现有 ASR。
 * - 生视频触发：TG 是「回复一张照片」；Matrix 是消息带 `m.relates_to.m.in_reply_to` 指向某个 m.image 事件。
 * - typing：homeserver 侧会自动过期，需周期性续期。
 * - 房间：按 roomId 路由（不做「只有一个房间」的假设），为后续群聊扩展预留。
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runChat } from "../core/chat";
import { markUserActivity } from "../core/activity";
import { getRunningHubConfig } from "../core/config";
import { AVATAR_DIR, DATA_DIR, applyCharacterPatch, audioUrlToPath, getCharacters, resolveCharacter } from "../core/data";
import { resolveMatrixEndpoint } from "../core/channel";
import {
  COMPANION_INTERACTIONS,
  COMPANION_SCENES,
  RESPONSE_STYLES,
  getInteractionById,
  getSceneById,
  isCompanionSceneId,
  isResponseStyleId
} from "../core/scenes";
import type { CompanionInteractionId, CompanionSceneId, ResponseStyleId } from "../core/scenes";
import { MatrixClient, MatrixEvent } from "./client";
import { synthesizeSpeech } from "../services/tts";
import { transcribeSpeechAudio } from "../services/transcription";
import { runPhotoTask, PhotoTimeoutError } from "../services/photoGen";
import { startVideoTask, isVideoInFlight } from "../services/videoGen";
import { recordPhoto } from "../services/stats";
import { appendToSession, clearSession, loadSession, updateSessionMeta } from "../services/session";
import type { DigitalHumanConfig } from "../types";

const execFileAsync = promisify(execFile);

// `/sync` 长轮询窗口：固定 30s。CF 隧道对空闲长连接约 100s 超时，30s 可保证隧道内始终有数据流动。
const SYNC_TIMEOUT_MS = 30000;
const SYNC_RETRY_BASE_MS = 2000;
const SYNC_RETRY_MAX_MS = 60000;
const TYPING_REFRESH_MS = 20000;

const SYNC_FILE = path.join(DATA_DIR, "matrix-sync.json");
const OWNER_FILE = path.join(DATA_DIR, "owner-matrix.json");

type SceneId = CompanionSceneId;
type StyleId = ResponseStyleId;

interface PendingMenu {
  /** 菜单种类，决定数字回复的语义 */
  kind: "scene" | "style" | "action";
  options: string[];
  /** 触发该菜单的消息事件 id（用于把数字回复关联到同一话题） */
  promptEventId?: string;
}

interface RoomState {
  voiceEnabled: boolean;
  activeSceneId?: SceneId;
  responseStyle?: StyleId;
  adultVerified: boolean;
  pendingMenu?: PendingMenu;
  /** 待成年确认的亲密互动（矩阵无按钮 UI，用文本确认） */
  pendingAdultAction?: CompanionInteractionId;
  photoPending: boolean;
}

interface MatrixRuntime {
  characterId: string;
  characterName: string;
  client: MatrixClient;
  homeRoomId: string;
  state: RoomState;
  syncSince?: string;
  /** 首次 sync 只取游标、不处理事件，避免开机即回复历史消息 */
  primed: boolean;
  running: boolean;
  loggedForeignRooms: Set<string>;
}

const runtimes = new Map<string, MatrixRuntime>();

// ---------- 同步游标持久化 ----------
// 只存 next_batch，不含任何聊天内容；用于重启后接着上次位置同步，避免重复处理旧事件。

function loadSyncTokens(): Record<string, string> {
  try {
    if (!existsSync(SYNC_FILE)) return {};
    const obj = JSON.parse(readFileSync(SYNC_FILE, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      const token = typeof v === "string" ? v : (v as { since?: string })?.since;
      if (token) out[k] = token;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSyncToken(characterId: string, since: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const all = loadSyncTokens();
    all[characterId] = since;
    const tmp = `${SYNC_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    // rename 原子替换，避免进程中断留下半截文件（下次 tick 仍会重新写入，失败不影响收发）
    fs.rename(tmp, SYNC_FILE).catch(() => {
      /* 忽略：游标丢失只影响下次启动是否重放少量事件 */
    });
  } catch (err) {
    console.warn("[matrix] 保存 sync 游标失败（不影响收发）:", err instanceof Error ? err.message : err);
  }
}

// ---------- 主人（访问控制）----------

/** 环境变量显式指定的主人 userId（形如 @luoyuqing:matrix.3585616.xyz） */
function allowedOwnerFromEnv(): string | null {
  const raw = process.env.MATRIX_OWNER_USER_ID?.trim();
  return raw || null;
}

function loadOwner(): string | null {
  try {
    if (!existsSync(OWNER_FILE)) return null;
    const j = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { userId?: string };
    const uid = String(j.userId || "").trim();
    return uid || null;
  } catch {
    return null;
  }
}

function saveOwner(userId: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(OWNER_FILE, JSON.stringify({ userId, registeredAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (err) {
    console.error("[matrix] 保存 owner 失败:", err);
  }
}

/** 当前生效的主人的 userId：优先环境变量，其次引导期注册值 */
function effectiveOwner(): string | null {
  return allowedOwnerFromEnv() || loadOwner();
}

// ---------- 工具 ----------

function sceneLabel(id?: string): string {
  if (!id) return "未选择（默认日常陪伴）";
  return getSceneById(id as SceneId)?.label ?? id;
}

function styleLabel(id?: string): string {
  if (!id) return "默认温柔";
  return RESPONSE_STYLES.find((s) => s.id === id)?.label ?? id;
}

/** 角色头像转为本地可上传路径；找不到返回 null（设置头像失败不影响聊天） */
async function resolveAvatarLocalPath(character: DigitalHumanConfig): Promise<string | null> {
  const url = String(character.avatarUrl || "").trim();
  if (!url) return null;
  const m = /^\/avatars\/(.+)$/.exec(url);
  if (m && m[1]) {
    const p = path.join(AVATAR_DIR, m[1]);
    return existsSync(p) ? p : null;
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const ext = path.extname(new URL(url).pathname) || ".png";
      const tmp = path.join(os.tmpdir(), `dg-avatar-${Date.now()}${ext}`);
      writeFileSync(tmp, buf);
      return tmp;
    } catch {
      return null;
    }
  }
  // 相对路径（如 assets/xxx.png）→ 尝试以本地静态资源解析
  const local = path.join(AVATAR_DIR, path.basename(url));
  return existsSync(local) ? local : null;
}

async function downloadMediaToTemp(client: MatrixClient, mxcUri: string, ext: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `dg-mx-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
  await client.downloadMedia(mxcUri, tmp);
  return tmp;
}

/** 任意音频容器 → 16k 单声道 wav 的 base64（ffmpeg 通吃 ogg/opus/m4a/mp4/wav） */
async function audioToWavBase64(inputPath: string): Promise<{ base64: string; mime: string }> {
  const wavPath = `${inputPath}.wav`;
  await execFileAsync("ffmpeg", ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", wavPath], {
    windowsHide: true
  });
  const buf = await fs.readFile(wavPath);
  await fs.unlink(wavPath).catch(() => {});
  return { base64: buf.toString("base64"), mime: "audio/wav" };
}

/** 从 mxc URI 猜测文件扩展名（仅用于临时文件命名） */
function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return ".ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return ".mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return ".m4a";
  if (m.includes("wav")) return ".wav";
  if (m.includes("jpeg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("webm")) return ".webm";
  return ".bin";
}

/** 判断消息是否 @ 了本 bot（群聊预留） */
function mentionsSelf(ev: MatrixEvent, selfUserId: string): boolean {
  const content = ev.content || {};
  const m = content["m.mentions"] as { user_ids?: string[] } | undefined;
  if (m?.user_ids?.includes(selfUserId)) return true;
  // 兜底：正文里出现完整 userId（部分客户端不带 m.mentions）
  return selfUserId ? String(content.body || "").includes(selfUserId) : false;
}

// ---------- 回复发送 ----------

function startTyping(rt: MatrixRuntime, roomId: string): () => void {
  let stopped = false;
  const ping = () => {
    if (stopped) return;
    rt.client.setTyping(roomId, true).catch(() => {
      /* typing 失败不影响主流程 */
    });
  };
  ping();
  const timer = setInterval(ping, TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
    rt.client.setTyping(roomId, false).catch(() => {});
  };
}

/** 在耗时操作期间维持 typing 指示 */
async function withTyping<T>(rt: MatrixRuntime, roomId: string, fn: () => Promise<T>): Promise<T> {
  const stop = startTyping(rt, roomId);
  try {
    return await fn();
  } finally {
    stop();
  }
}

/** 发送文本 +（可选）语音。语音失败不影响文字送达。 */
async function sendTextAndVoice(
  rt: MatrixRuntime,
  character: DigitalHumanConfig,
  roomId: string,
  text: string,
  replyToEventId?: string
): Promise<void> {
  const clipped = text.length > 8000 ? `${text.slice(0, 8000)}…` : text;
  if (replyToEventId) {
    await rt.client.sendReply(roomId, clipped, replyToEventId);
  } else {
    await rt.client.sendText(roomId, clipped);
  }

  if (!rt.state.voiceEnabled) return;
  try {
    const audioUrl = await synthesizeSpeech(text, character);
    if (!audioUrl) return;
    // Matrix 直接支持 mp3，无需 TG 那套 OGG/Opus 转码
    const audioPath = audioUrlToPath(audioUrl);
    if (!audioPath) return;
    if (!(await fs.stat(audioPath).catch(() => null))) return;
    await rt.client.sendMedia(roomId, "audio", audioPath, {});
    await fs.unlink(audioPath).catch(() => {});
  } catch (err) {
    console.warn("[matrix] 语音发送失败（文字已送达）:", err instanceof Error ? err.message : err);
  }
}

// ---------- 会话与聊天 ----------

function chatSessionId(characterId: string): string {
  // 与 TG 主人私聊保持一致：mem-<charId>，两端共用同一份会话历史与长期记忆
  return `mem-${characterId}`;
}

async function resolveOwnCharacter(rt: MatrixRuntime): Promise<DigitalHumanConfig | null> {
  const chars = await getCharacters();
  return resolveCharacter(chars, rt.characterId);
}

async function runChatWithContext(
  rt: MatrixRuntime,
  roomId: string,
  text: string,
  sceneOverride?: SceneId
): Promise<{ text: string; character: DigitalHumanConfig }> {
  const character = await resolveOwnCharacter(rt);
  if (!character) throw new Error("NO_CHARACTER");
  const sid = chatSessionId(character.id);
  const result = await withTyping(rt, roomId, () =>
    runChat({
      sessionId: sid,
      message: text,
      characterId: character.id,
      channel: "matrix",
      relationshipMode: sceneOverride
        ? (getSceneById(sceneOverride)?.relationshipMode ?? character.relationshipMode)
        : undefined,
      sceneId: sceneOverride || rt.state.activeSceneId,
      styleId: rt.state.responseStyle,
      adultVerified: rt.state.adultVerified
    })
  );
  return { text: result.text, character };
}

// ---------- 命令 ----------

function helpText(characterName: string): string {
  return (
    `我是「${characterName}」的专属助手，直接发消息就能聊天。\n\n` +
    `可用命令：\n` +
    `/list 查看当前绑定\n` +
    `/voice 开关语音回复\n` +
    `/scene 选择陪伴场景\n` +
    `/action 快速互动\n` +
    `/style 选择回复语气\n` +
    `/summary 开关记忆总结模式\n` +
    `/reset 清空当前对话\n` +
    `/help 查看本帮助\n\n` +
    `语音消息会自动转写后回复；回复我的照片可以让我把它做成小视频。\n` +
    `数字人的创建与编辑请在网页端管理页操作。`
  );
}

async function handleCommand(rt: MatrixRuntime, roomId: string, text: string, eventId: string): Promise<boolean> {
  const parts = text.trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const character = await resolveOwnCharacter(rt);
  const name = character?.name ?? rt.characterName;

  switch (cmd) {
    case "/help": {
      await rt.client.sendText(roomId, helpText(name));
      return true;
    }
    case "/list": {
      await rt.client.sendText(
        roomId,
        `本账号专属数字人：${name}\n（一个账号绑定一个数字人；角色管理请在网页端「数字人管理」操作）`
      );
      return true;
    }
    case "/voice": {
      if (arg === "on" || arg === "开") rt.state.voiceEnabled = true;
      else if (arg === "off" || arg === "关") rt.state.voiceEnabled = false;
      else rt.state.voiceEnabled = !rt.state.voiceEnabled;
      await rt.client.sendText(roomId, `语音回复已${rt.state.voiceEnabled ? "开启 🔊" : "关闭 🔇"}`);
      return true;
    }
    case "/scene": {
      if (!arg) {
        rt.state.pendingMenu = { kind: "scene", options: COMPANION_SCENES.map((s) => s.id) };
        const list = COMPANION_SCENES.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
        await rt.client.sendText(
          roomId,
          `当前场景：${sceneLabel(rt.state.activeSceneId)}\n请回复序号选择：\n${list}`
        );
        return true;
      }
      const idx = Number(arg);
      const list = COMPANION_SCENES.map((s) => s.id);
      const picked = Number.isInteger(idx) && idx >= 1 && idx <= list.length ? list[idx - 1] : arg;
      if (isCompanionSceneId(picked)) {
        rt.state.activeSceneId = picked as SceneId;
        await rt.client.sendText(roomId, `场景已切换为：${sceneLabel(picked)}`);
      } else {
        await rt.client.sendText(roomId, "没听懂这个场景，发 /scene 看看可选列表吧～");
      }
      return true;
    }
    case "/action": {
      if (!arg) {
        rt.state.pendingMenu = { kind: "action", options: COMPANION_INTERACTIONS.map((a) => a.id) };
        const list = COMPANION_INTERACTIONS.map((a, i) => `${i + 1}. ${a.label}`).join("\n");
        await rt.client.sendText(roomId, `请回复序号选择互动：\n${list}`);
        return true;
      }
      const idx = Number(arg);
      const list = COMPANION_INTERACTIONS.map((a) => a.id);
      const raw = Number.isInteger(idx) && idx >= 1 && idx <= list.length ? list[idx - 1] : arg;
      const interaction = getInteractionById(String(raw ?? ""));
      if (!interaction) {
        await rt.client.sendText(roomId, "没听懂这个互动，发 /action 看看可选列表吧～");
        return true;
      }
      // 亲密类互动（flirty 场景）需先确认成年，与 TG 侧行为一致
      if (interaction.sceneId === "flirty" && !rt.state.adultVerified) {
        rt.state.pendingAdultAction = interaction.id;
        await rt.client.sendText(
          roomId,
          "该互动会进入「亲密 18+」场景。请确认你已年满 18 周岁并自愿进入。\n" +
            "回复「确认」继续，回复其他任意内容取消。"
        );
        return true;
      }
      await runInteraction(rt, roomId, interaction.id);
      return true;
    }
    case "/style": {
      if (!arg) {
        rt.state.pendingMenu = { kind: "style", options: RESPONSE_STYLES.map((s) => s.id) };
        const list = RESPONSE_STYLES.map((s, i) => `${i + 1}. ${s.label}`).join("\n");
        await rt.client.sendText(roomId, `当前语气：${styleLabel(rt.state.responseStyle)}\n请回复序号选择：\n${list}`);
        return true;
      }
      const idx = Number(arg);
      const list = RESPONSE_STYLES.map((s) => s.id);
      const picked = Number.isInteger(idx) && idx >= 1 && idx <= list.length ? list[idx - 1] : arg;
      if (isResponseStyleId(picked)) {
        rt.state.responseStyle = picked as StyleId;
        await rt.client.sendText(roomId, `回复语气已切换为：${styleLabel(picked)}`);
      } else {
        await rt.client.sendText(roomId, "没听懂这个语气，发 /style 看看可选列表吧～");
      }
      return true;
    }
    case "/summary": {
      const sid = chatSessionId(rt.characterId);
      const session = await loadSession(sid);
      const next = !(session?.summaryMode ?? false);
      await updateSessionMeta(sid, { summaryMode: next });
      await rt.client.sendText(
        roomId,
        `记忆总结模式已${next ? "开启" : "关闭"}${next ? "（只发记忆档案 + 最近对话）" : "（发送完整历史）"}`
      );
      return true;
    }
    case "/reset": {
      await clearSession(chatSessionId(rt.characterId));
      await rt.client.sendText(roomId, "好，我们重新开始吧～");
      return true;
    }
    default: {
      void eventId;
      await rt.client.sendText(roomId, "这个命令我还不认识，发 /help 看看能做什么吧～");
      return true;
    }
  }
}

/** 处理「回复序号」的菜单选择（上一条命令给出了列表时） */
async function tryMenuSelection(rt: MatrixRuntime, roomId: string, text: string): Promise<boolean> {
  const menu = rt.state.pendingMenu;
  if (!menu) return false;
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > menu.options.length) return false;
  rt.state.pendingMenu = undefined;
  await handleCommand(rt, roomId, `/${menu.kind} ${n}`, "");
  return true;
}

/** 执行一次快捷互动（与 TG 侧一致：先回显互动语义，再让角色按该互动回应） */
async function runInteraction(rt: MatrixRuntime, roomId: string, interactionId: CompanionInteractionId): Promise<void> {
  const interaction = getInteractionById(interactionId);
  if (!interaction) return;
  await rt.client.sendText(roomId, `${interaction.label} → ${interaction.message}`);
  const result = await runChatWithContext(rt, roomId, interaction.message, interaction.sceneId);
  await sendTextAndVoice(rt, result.character, roomId, result.text);
}

/** 处理「成年确认」的文本应答（Matrix 无按钮，用文本确认） */
async function tryAdultConfirm(rt: MatrixRuntime, roomId: string, text: string): Promise<boolean> {
  const pending = rt.state.pendingAdultAction;
  if (!pending) return false;
  const t = text.trim();
  if (/^(确认|我已成年|已成年|同意|是|yes|y|ok)$/i.test(t)) {
    rt.state.pendingAdultAction = undefined;
    rt.state.adultVerified = true;
    await runInteraction(rt, roomId, pending);
    return true;
  }
  rt.state.pendingAdultAction = undefined;
  await rt.client.sendText(roomId, "好的，已取消。");
  return true;
}

// ---------- 生图 ----------

function containsTrigger(text: string, words?: string[]): string | null {
  if (!words || words.length === 0) return null;
  for (const w of words) {
    if (w && text.includes(w)) return w;
  }
  return null;
}

/**
 * 拍照触发检测 + 等待期拦截（文字/语音共用，保证两个入口行为一致）。
 * 返回 true 表示已处理（触发生图或处于等待期），上层不再走普通聊天。
 */
async function tryPhotoTrigger(rt: MatrixRuntime, roomId: string, text: string): Promise<boolean> {
  const character = await resolveOwnCharacter(rt);
  if (character) markUserActivity(character.id);

  if (rt.state.photoPending) {
    const sid = chatSessionId(rt.characterId);
    await appendToSession(sid, { role: "user", content: text }).catch(() => {});
    return true;
  }

  const rhCfg = getRunningHubConfig();
  const hit = containsTrigger(text, rhCfg.triggerWords);
  if (!hit) return false;
  if (!character) {
    await rt.client.sendText(roomId, "当前角色未就绪，请稍后再试。");
    return true;
  }

  console.log(`[MX][${character.name}] 触发生图 触发词=${hit} room=${roomId}`);
  rt.state.photoPending = true;
  const sid = chatSessionId(character.id);
  await appendToSession(sid, { role: "user", content: text }).catch(() => {});
  await rt.client.sendText(roomId, "📷 好的，那我去拍张照，稍等一下下哦~");

  void runPhotoFlow(rt, character, roomId, sid).catch((err) => {
    console.error("[matrix][拍照] 流程异常:", err);
    rt.state.photoPending = false;
  });
  return true;
}

/** 拍照主流程：生成并发送照片，随后基于等待期累积的上下文统一回复一条 */
async function runPhotoFlow(
  rt: MatrixRuntime,
  character: DigitalHumanConfig,
  roomId: string,
  sid: string
): Promise<void> {
  const cfg = getRunningHubConfig();
  const timeoutMs = Math.max(10, Math.min(600, Number(cfg.timeoutSec) || 120)) * 1000;

  let photoPath: string | null = null;
  let cleanup: (() => void) | null = null;
  let outcome: "ok" | "error" | "timeout" = "ok";
  let errMsg: string | null = null;

  try {
    const session = await loadSession(sid);
    const recent = (session?.history ?? []).slice(-12);
    const res = await runPhotoTask({ character, recentMessages: recent, timeoutMs });
    photoPath = res.imagePath;
    cleanup = res.cleanup;
  } catch (err) {
    outcome = err instanceof PhotoTimeoutError ? "timeout" : "error";
    errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[MX][${character.name}] ${outcome === "timeout" ? "超时" : "接口报错"}:`, errMsg);
  }

  try {
    if (photoPath) {
      try {
        await rt.client.sendMedia(roomId, "image", photoPath, {});
        recordPhoto(character.id, "matrix");
      } catch (err) {
        console.error(`[MX][${character.name}] 发送照片失败:`, err);
      }
    } else {
      const label = outcome === "timeout" ? "拍照超时了" : "拍照失败了";
      await rt.client
        .sendText(roomId, `📷 ${label}${errMsg ? "：" + errMsg.slice(0, 120) : ""}`)
        .catch(() => {});
    }

    const backMessage = "（刚拍完照回来啦，照片已经发给你咯~ 你刚才跟我说的那些我都看到啦，挨个回你）";
    try {
      const result = await runChatWithContext(rt, roomId, backMessage);
      await sendTextAndVoice(rt, result.character, roomId, result.text);
    } catch (replyErr) {
      console.error(`[MX][${character.name}] 照片后统一回复失败:`, replyErr);
      await rt.client.sendText(roomId, "（刚才去拍照啦，这会儿有点忙不过来，你再说一遍好不好~）").catch(() => {});
    }
  } finally {
    if (cleanup) cleanup();
    rt.state.photoPending = false;
  }
}

// ---------- 生视频（回复一张照片）----------

/** 取事件详情（判断被回复的是不是图片） */
async function fetchEventType(rt: MatrixRuntime, roomId: string, eventId: string): Promise<string | null> {
  try {
    const url = `${rt.client.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${rt.client.accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { type?: string; content?: { msgtype?: string } };
    return j.content?.msgtype || j.type || null;
  } catch {
    return null;
  }
}

async function tryVideoTrigger(rt: MatrixRuntime, roomId: string, ev: MatrixEvent): Promise<boolean> {
  const content = ev.content || {};
  const relates = content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined;
  const repliedId = relates?.["m.in_reply_to"]?.event_id;
  if (!repliedId) return false;

  // 仅当被回复的是一条图片消息时才触发（与 TG「回复一张照片」语义对齐）
  const repliedType = await fetchEventType(rt, roomId, repliedId);
  if (repliedType !== "m.image") return false;

  const userText = String(content.body || "");
  if (isVideoInFlight()) {
    await rt.client.sendText(roomId, "视频还在生成中，稍等～");
    return true;
  }

  const character = await resolveOwnCharacter(rt);
  if (!character) {
    await rt.client.sendText(roomId, "当前角色未就绪，请稍后再试。");
    return true;
  }
  const endpoint = resolveMatrixEndpoint(character);
  if (!endpoint) {
    await rt.client.sendText(roomId, "Matrix 渠道凭据不完整，无法取用照片。");
    return true;
  }

  // 源照片的 mxc URI 需要从被回复的事件里取
  let mxcUri = "";
  try {
    const url = `${rt.client.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(repliedId)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${rt.client.accessToken}` },
      signal: AbortSignal.timeout(15000)
    });
    if (resp.ok) {
      const j = (await resp.json()) as { content?: { url?: string; file?: { url?: string } } };
      mxcUri = String(j.content?.url || j.content?.file?.url || "");
    }
  } catch {
    /* 下方统一处理为空 */
  }
  if (!mxcUri) {
    await rt.client.sendText(roomId, "没能取到那张照片，重新发一次试试？");
    return true;
  }

  const sid = chatSessionId(character.id);
  const session = await loadSession(sid);
  const recent = (session?.history ?? []).slice(-12);

  await rt.client.sendText(roomId, "我一会儿拍视频，等5分钟后发你，先聊着～");
  void startVideoTask({
    character,
    delivery: {
      kind: "matrix",
      homeserver: endpoint.homeserver,
      accessToken: endpoint.accessToken,
      userId: endpoint.userId || rt.client.userId,
      roomId
    },
    source: {
      kind: "matrix",
      homeserver: endpoint.homeserver,
      accessToken: endpoint.accessToken,
      mxcUri
    },
    userText,
    recentMessages: recent,
    sessionId: sid
  }).catch((err) => {
    console.error("[matrix][视频] 启动失败:", err);
  });
  return true;
}

// ---------- 事件处理 ----------

async function handleTextEvent(rt: MatrixRuntime, roomId: string, ev: MatrixEvent): Promise<void> {
  const content = ev.content || {};
  const text = String(content.body || "").trim();
  const eventId = String(ev.event_id || "");
  if (!text) return;

  try {
    if (text.startsWith("/")) {
      await handleCommand(rt, roomId, text, eventId);
      return;
    }
    // 成年确认（优先级最高：此时用户的应答不应被当作普通聊天）
    if (await tryAdultConfirm(rt, roomId, text)) return;
    // 「回复序号」完成上一条命令给出的菜单选择
    if (await tryMenuSelection(rt, roomId, text)) return;

    // 回复图片 → 生视频（优先于拍照触发词，与 TG 顺序一致）
    if (await tryVideoTrigger(rt, roomId, ev)) return;

    // 拍照等待期拦截 + 触发词检测
    if (await tryPhotoTrigger(rt, roomId, text)) return;

    // 普通聊天
    const result = await runChatWithContext(rt, roomId, text);
    await sendTextAndVoice(rt, result.character, roomId, result.text, eventId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "NO_CHARACTER") {
      await rt.client.sendText(roomId, "当前角色未就绪，请稍后再试。").catch(() => {});
      return;
    }
    console.error("[matrix] 文本处理失败:", err);
    await rt.client.sendText(roomId, "处理失败，请稍后再试。").catch(() => {});
  }
}

async function handleAudioEvent(rt: MatrixRuntime, roomId: string, ev: MatrixEvent): Promise<void> {
  const content = ev.content || {};
  const mxcUri = String(content.url || (content.file as { url?: string } | undefined)?.url || "");
  if (!mxcUri) return;
  const mime = String((content.info as { mimetype?: string } | undefined)?.mimetype || "audio/ogg");
  let tmp: string | undefined;
  try {
    tmp = await downloadMediaToTemp(rt.client, mxcUri, extFromMime(mime));
    const { base64, mime: wavMime } = await audioToWavBase64(tmp);
    tmp = undefined; // audioToWavBase64 已清理输入文件
    const text = await transcribeSpeechAudio({ audioBase64: base64, mimeType: wavMime });
    if (!text) {
      await rt.client.sendText(roomId, "没听清，能再发一次吗？");
      return;
    }
    await rt.client.sendText(roomId, `🎙 识别：${text}`);
    // 转写文本同样走拍照触发词检测（与 TG 行为一致）
    if (await tryPhotoTrigger(rt, roomId, text)) return;
    const result = await runChatWithContext(rt, roomId, text);
    await sendTextAndVoice(rt, result.character, roomId, result.text);
  } catch (err) {
    console.error("[matrix] 语音处理失败:", err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/识别|ASR|语音|MIMO|API_KEY/.test(msg)) {
      await rt.client.sendText(roomId, "🎙 没听清，能再发一次吗？").catch(() => {});
    } else {
      await rt.client.sendText(roomId, "语音处理失败，请稍后再试。").catch(() => {});
    }
  } finally {
    if (tmp) await fs.unlink(tmp).catch(() => {});
  }
}

async function handleTimeline(rt: MatrixRuntime, roomId: string, events: MatrixEvent[]): Promise<void> {
  const selfUserId = rt.client.userId;
  for (const ev of events) {
    if (ev.type !== "m.room.message") continue;
    if (!ev.sender || ev.sender === selfUserId) continue; // 忽略自己发的

    const owner = effectiveOwner();
    if (!owner) {
      // 引导期：首位私聊用户自动注册为主人（与 TG 侧行为一致）
      saveOwner(ev.sender);
      console.log(`[matrix] owner 已注册: ${ev.sender}`);
      await rt.client.sendText(roomId, "已把当前账号登记为我的主人，之后只有你能跟我对话～").catch(() => {});
    } else if (ev.sender !== owner) {
      continue; // 非授权用户：静默忽略（不回消息，避免暴露存在）
    }

    if (roomId !== rt.homeRoomId) {
      // 群聊预留：本期只服务 home room，其他房间仅记录一次日志（不响应，避免刷屏）
      if (!rt.loggedForeignRooms.has(roomId)) {
        rt.loggedForeignRooms.add(roomId);
        console.log(
          `[matrix][${rt.characterName}] 检测到非 home room ${roomId}，本期不响应` +
            (mentionsSelf(ev, selfUserId) ? "（含 @提及）" : "")
        );
      }
      continue;
    }

    const msgtype = String(ev.content?.msgtype || "");
    if (msgtype === "m.text" || msgtype === "m.notice") {
      await handleTextEvent(rt, roomId, ev);
    } else if (msgtype === "m.audio" || msgtype === "m.voice") {
      await handleAudioEvent(rt, roomId, ev);
    } else if (msgtype === "m.image") {
      console.log(`[matrix][${rt.characterName}] 收到图片（如需生成视频，请「回复」这张图并附一句话）`);
    }
  }
}

// ---------- 同步循环 ----------

async function syncLoop(rt: MatrixRuntime): Promise<void> {
  let backoff = SYNC_RETRY_BASE_MS;
  while (rt.running) {
    try {
      const resp = await rt.client.sync(rt.syncSince, SYNC_TIMEOUT_MS);
      backoff = SYNC_RETRY_BASE_MS;
      if (resp.next_batch) {
        rt.syncSince = resp.next_batch;
        saveSyncToken(rt.characterId, resp.next_batch);
      }
      if (!rt.primed) {
        // 首次同步只取游标，不处理历史事件（避免开机即回复旧消息）
        rt.primed = true;
        console.log(`[matrix][${rt.characterName}] 已就绪（首次同步只取游标，不处理历史）`);
        continue;
      }
      const joined = resp.rooms?.join || {};
      for (const [roomId, room] of Object.entries(joined)) {
        const events = room.timeline?.events || [];
        if (events.length === 0) continue;
        await handleTimeline(rt, roomId, events);
      }
    } catch (err) {
      if (!rt.running) break;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[matrix][${rt.characterName}] sync 异常，${backoff}ms 后重连：${msg}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(SYNC_RETRY_MAX_MS, backoff * 2);
    }
  }
}

// ---------- 启动 ----------

/** 准备房间：无 roomId 时建房并邀请主人，随后做加密自检。返回可用的 roomId；失败返回 null。 */
async function prepareRoom(
  client: MatrixClient,
  character: DigitalHumanConfig,
  endpoint: { homeserver: string; accessToken: string; userId: string; roomId: string }
): Promise<string | null> {
  const ownerUserId = effectiveOwner() || endpoint.userId;
  let roomId = endpoint.roomId;

  if (!roomId) {
    try {
      const invite = ownerUserId ? [ownerUserId] : [];
      roomId = await client.createRoom({
        // ⚠️ 不设置 m.room.encryption：bot 建房是保证房间明文的关键
        name: character.name,
        topic: `${character.name} · AI伴聊`,
        invite
      });
      console.log(`[matrix][${character.name}] 已创建房间 ${roomId}，邀请 ${invite.join(",") || "(无)"}`);

      // 回填 roomId 到角色配置（内置角色 → human-overrides.json，自定义 → custom-humans.json）
      try {
        await applyCharacterPatch(character.id, { matrixRoomId: roomId });
        console.log(`[matrix][${character.name}] roomId 已回填到角色配置`);
      } catch (err) {
        console.error(`[matrix][${character.name}] 回填 roomId 失败（下次启动会再建一个房间）:`, err);
      }
    } catch (err) {
      console.error(`[matrix][${character.name}] 建房失败:`, err);
      return null;
    }
  }

  // 加密自检：明文房间该状态事件不存在（404 → null）
  try {
    const enc = await client.getRoomEncryption(roomId);
    if (enc) {
      console.error(
        `[matrix][${character.name}] ⚠️ 房间 ${roomId} 已启用加密（m.room.encryption 存在），` +
          `bot 将无法读取消息内容。请删除该房间并让 bot 重新建房（bot 建房不设加密）。`
      );
      return null;
    }
  } catch (err) {
    console.warn(`[matrix][${character.name}] 加密状态自检失败（继续运行）:`, err instanceof Error ? err.message : err);
  }

  return roomId;
}

/** 启动单个角色的 Matrix 客户端（失败不抛错，仅记录日志） */
export async function startMatrixBot(characterId: string): Promise<void> {
  const chars = await getCharacters();
  const character = resolveCharacter(chars, characterId);
  if (!character) {
    console.error(`[matrix] 角色不存在: ${characterId}`);
    return;
  }
  const endpoint = resolveMatrixEndpoint(character);
  if (!endpoint) {
    console.error(`[matrix][${character.name}] 凭据不完整（需 homeserver + accessToken），跳过启动`);
    return;
  }

  const client = new MatrixClient({
    homeserver: endpoint.homeserver,
    accessToken: endpoint.accessToken,
    userId: endpoint.userId
  });

  let selfUserId: string;
  try {
    selfUserId = await client.whoami();
    console.log(`[matrix][${character.name}] 登录成功 ${selfUserId}`);
  } catch (err) {
    console.error(`[matrix][${character.name}] 登录校验失败（accessToken 是否正确？）:`, err);
    return;
  }

  const roomId = await prepareRoom(client, character, endpoint);
  if (!roomId) return;

  // 昵称与头像（失败不影响聊天）
  try {
    if (character.name) await client.setDisplayName(character.name);
    const avatarPath = await resolveAvatarLocalPath(character);
    if (avatarPath) await client.setAvatar(avatarPath);
  } catch (err) {
    console.warn(`[matrix][${character.name}] 设置昵称/头像失败:`, err instanceof Error ? err.message : err);
  }

  const rt: MatrixRuntime = {
    characterId: character.id,
    characterName: character.name,
    client,
    homeRoomId: roomId,
    state: { voiceEnabled: true, adultVerified: false, photoPending: false },
    syncSince: loadSyncTokens()[character.id],
    // 有历史游标时可直接处理新事件；无游标则首次同步先取游标
    primed: Boolean(loadSyncTokens()[character.id]),
    running: true,
    loggedForeignRooms: new Set()
  };
  runtimes.set(character.id, rt);

  void syncLoop(rt).catch((err) => console.error(`[matrix][${character.name}] sync 循环退出:`, err));
  console.log(
    `[matrix][${character.name}] 渠道已启动 room=${roomId}` +
      (rt.syncSince ? "（续用历史游标）" : "（首次启动，将跳过历史消息）")
  );
}

/** 停止全部 Matrix 客户端（供重启/关闭时使用） */
export function stopMatrixBots(): void {
  for (const rt of runtimes.values()) rt.running = false;
  runtimes.clear();
}

/** 已启动的运行时（调试/自检用） */
export function getMatrixRuntime(characterId: string): MatrixRuntime | undefined {
  return runtimes.get(characterId);
}
