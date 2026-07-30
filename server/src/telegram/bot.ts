import fs from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Bot, Context, InlineKeyboard, InputFile, session, SessionFlavor, Api, RawApi } from "grammy";

import { runChat, generateMemoryForSession } from "../core/chat";
import {
  applyCharacterPatch,
  AVATAR_DIR,
  audioUrlToPath,
  ensureRelationshipMode,
  getCharacters,
  loadCustomHumans,
  resolveCharacter,
  sanitizeAvatarFileName,
  writeCustomHumans
} from "../core/data";
import {
  COMPANION_INTERACTIONS,
  COMPANION_SCENES,
  getInteractionById,
  getSceneById,
  isCompanionSceneId,
  isResponseStyleId,
  RESPONSE_STYLES
} from "../core/scenes";
import { synthesizeSpeech } from "../services/tts";
import { transcribeSpeechAudio } from "../services/transcription";
import { runPhotoTask } from "../services/photoGen";
import { clearSession, importSession, loadSession, updateSessionMeta } from "../services/session";
import { ChatMessage, DigitalHumanConfig, SessionContext } from "../types";

const execFileAsync = promisify(execFile);

// 强制 Node 优先 IPv4 解析：境外服务器常无可用 IPv6 路由，undici fetch 先试 IPv6 会 ETIMEDOUT
// （Telegram 文件下载 api.telegram.org/file/... 因此超时）。改为 ipv4first 后走通。
dns.setDefaultResultOrder("ipv4first");

// MiMo mimo-v2.5-tts 全部可选音色（与网页端下拉保持一致）
const MIMO_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];
const RELATIONSHIP_MODES = ["flirty", "playful", "mature", "sweet"];

// ---------- session ----------
interface CreateDraft {
  name?: string;
  description?: string;
  avatarUrl?: string;
  voice?: string;
  relationshipMode?: string;
}

interface BotSessionData {
  currentCharacterId?: string;
  voiceEnabled: boolean;
  activeSceneId?: "daily" | "date" | "comfort" | "flirty" | "bedtime";
  responseStyle?: "warm" | "soft" | "mature";
  adultVerified?: boolean;
  pendingAdultScene?: "daily" | "date" | "comfort" | "flirty" | "bedtime";
  pendingAdultInteraction?: "hug" | "hand" | "whisper" | "comfort" | "goodnight";
  create?: CreateDraft;
  createStep?: "name" | "description" | "avatar" | "voice" | "relationshipMode" | "confirm";
  editId?: string;
  editField?: "name" | "description" | "avatarUrl" | "voice" | "relationshipMode";
  pendingImport?: boolean;
}

type BotContext = Context & SessionFlavor<BotSessionData>;

// ---------- helpers ----------
// 说明：chatSessionId / currentCharacter / runChatWithContext 已移至 registerBot 内部，
// 以便支持「一角色一机器人」的固定角色（fixedCharacterId）闭包，避免多实例共享全局变量冲突。

// 在异步耗时操作期间持续发送「正在输入…」指示，让用户知道数字人正在准备回复
async function withTyping<T>(ctx: BotContext, fn: () => Promise<T>): Promise<T> {
  const chatId = ctx.chat?.id;
  if (chatId == null) return fn();
  const send = () => ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  await send();
  const timer = setInterval(send, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function sceneLabel(id?: string): string {
  if (!id) return "未选择（默认日常陪伴）";
  return getSceneById(id as "daily" | "date" | "comfort" | "flirty" | "bedtime")?.label ?? id;
}

function styleLabel(id?: string): string {
  if (!id) return "默认温柔";
  return RESPONSE_STYLES.find((s) => s.id === id)?.label ?? id;
}

// ---------- 访问控制（仅允许主人 TG 账号）----------
const OWNER_FILE = path.resolve(AVATAR_DIR, "..", "owner.json");

function getAllowedIds(): number[] {
  const raw = process.env.ALLOWED_TG_USER_ID?.trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function loadOwner(): number | null {
  try {
    if (!existsSync(OWNER_FILE)) return null;
    const id = Number(JSON.parse(readFileSync(OWNER_FILE, "utf8")).id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function saveOwner(id: number): void {
  try {
    writeFileSync(OWNER_FILE, JSON.stringify({ id, registeredAt: new Date().toISOString() }), "utf8");
  } catch (e) {
    console.error("保存 bot owner 失败：", e);
  }
}

async function listHumansKeyboard(ctx: BotContext): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const characters = await getCharacters();
  const lines = characters.map((c, i) => {
    const mark = c.id === ctx.session.currentCharacterId ? "✅" : "▫️";
    return `${i + 1}. ${mark} ${c.name}`;
  });
  const keyboard = new InlineKeyboard();
  characters.forEach((c, i) => keyboard.text(`${i + 1}. ${c.name}`, `sel:${c.id}`).row());
  return { text: `当前数字人列表：\n${lines.join("\n")}`, keyboard };
}

async function downloadToTemp(ctx: BotContext, fileId: string, ext: string, botToken: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("文件无可用路径");
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const tmp = path.join(os.tmpdir(), `dg-tg-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 用 curl -4 下载：Telegram anycast 存在部分不可达 IPv4，curl 的 happy-eyeballs + 强制 IPv4 比 undici fetch 稳定
      await execFileAsync("curl", ["-4", "-sS", "-f", "--max-time", "20", "-o", tmp, url]);
      const st = await fs.stat(tmp);
      if (!st.size) throw new Error("下载文件为空");
      return tmp;
    } catch (e) {
      lastErr = e;
      console.warn(`下载 TG 文件第 ${attempt} 次失败，重试…`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("下载 Telegram 文件失败");
}

async function saveAvatar(ctx: BotContext, fileId: string, botToken: string): Promise<string> {
  const tmp = await downloadToTemp(ctx, fileId, "img", botToken);
  try {
    const mime = "image/png"; // Telegram 头像统一为静态图
    const safeName = sanitizeAvatarFileName("tg-avatar.png", mime);
    await fs.mkdir(AVATAR_DIR, { recursive: true });
    const dest = path.join(AVATAR_DIR, safeName);
    await fs.copyFile(tmp, dest);
    return `/avatars/${safeName}`;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function oggToWavBase64(oggPath: string): Promise<{ base64: string; mime: string }> {
  const wavPath = `${oggPath}.wav`;
  await execFileAsync("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath], {
    windowsHide: true
  });
  const buf = await fs.readFile(wavPath);
  await fs.unlink(oggPath).catch(() => {});
  await fs.unlink(wavPath).catch(() => {});
  return { base64: buf.toString("base64"), mime: "audio/wav" };
}

// 纯 API 版「文本 + 可选语音」发送：供交互聊天（ctx 包裹）与主动推送（无 ctx）共用。
// voiceEnabled=false 时只发文字，不消耗 TTS 额度（主动推送默认关闭以省额度）。
async function sendTextWithOptionalVoice(
  api: Api<RawApi>,
  chatId: number,
  text: string,
  character: DigitalHumanConfig,
  voiceEnabled: boolean
): Promise<void> {
  await api.sendMessage(chatId, text.slice(0, 4000));
  if (!voiceEnabled) return;
  try {
    const audioUrl = await synthesizeSpeech(text, character);
    if (!audioUrl) return;
    const audioPath = audioUrlToPath(audioUrl);
    if (!audioPath) return;
    if (!(await fs.stat(audioPath).catch(() => null))) return;
    // Telegram 语音消息仅支持 OGG/Opus 容器，MiMo 产出的是 MP3，需转码
    const oggPath = path.join(
      os.tmpdir(),
      `dg-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`
    );
    try {
      await execFileAsync("ffmpeg", ["-y", "-i", audioPath, "-c:a", "libopus", "-b:a", "64k", oggPath]);
      await api.sendVoice(chatId, new InputFile(oggPath));
      await fs.unlink(oggPath).catch(() => {});
    } catch (convErr) {
      console.warn("TG 语音转码失败，回退为发送音频文件：", convErr);
      await api.sendAudio(chatId, new InputFile(audioPath));
    }
    await fs.unlink(audioPath).catch(() => {});
  } catch (err) {
    console.warn("TG 语音合成失败：", err instanceof Error ? err.message : err);
  }
}

async function replyWithTextAndVoice(
  ctx: BotContext,
  text: string,
  character: DigitalHumanConfig
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId == null) {
    await ctx.reply(text.slice(0, 4000));
    return;
  }
  await sendTextWithOptionalVoice(ctx.api, chatId, text, character, ctx.session.voiceEnabled);
}

// ---------- wizard builders ----------
function voiceKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  MIMO_VOICES.forEach((v, i) => {
    kb.text(v, `voice:${v}`);
    if (i % 2 === 1) kb.row();
  });
  return kb;
}

function relationshipKeyboard(prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  RELATIONSHIP_MODES.forEach((m) => kb.text(m, `${prefix}${m}`).row());
  return kb;
}

function sceneKeyboard(selectedId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  COMPANION_SCENES.forEach((scene) => {
    const mark = scene.id === selectedId ? "✅ " : "";
    kb.text(`${mark}${scene.label}`, `scene:${scene.id}`).row();
  });
  return kb;
}

function interactionKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  COMPANION_INTERACTIONS.forEach((interaction, i) => {
    kb.text(interaction.label, `action:${interaction.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (COMPANION_INTERACTIONS.length % 2 === 1) kb.row();
  return kb;
}

function styleKeyboard(selectedId?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  RESPONSE_STYLES.forEach((style) => {
    const mark = style.id === selectedId ? "✅ " : "";
    kb.text(`${mark}${style.label}`, `style:${style.id}`).row();
  });
  return kb;
}

// ---------- bot ----------
export function registerBot(bot: Bot<BotContext>, botToken: string, fixedCharacterId?: string): void {
  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  // 「一角色一机器人」模式：fixedCharacterId 非空时，本 bot 永久绑定该数字人，
  // 跳过角色切换/管理命令，记忆按固定角色隔离（mem:<fixedId> / tg-<chatId>-<fixedId>）。
  const fixedId = fixedCharacterId;

  function chatSessionId(ctx: BotContext): string {
    const charId = fixedId || ctx.session.currentCharacterId || "default";
    const ownerId = loadOwner();
    if (ownerId != null && ctx.from?.id === ownerId) {
      return `mem-${charId}`;
    }
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
    return `tg-${chatId}-${charId}`;
  }

  async function currentCharacter(ctx: BotContext): Promise<DigitalHumanConfig | null> {
    const characters = await getCharacters();
    return resolveCharacter(characters, fixedId || ctx.session.currentCharacterId);
  }

  async function runChatWithContext(
    ctx: BotContext,
    message: string,
    sceneOverride?: "daily" | "date" | "comfort" | "flirty" | "bedtime"
  ): Promise<ReturnType<typeof runChat>> {
    const character = await currentCharacter(ctx);
    if (!character) {
      throw new Error("NO_CHARACTER");
    }
    return withTyping(ctx, () =>
      runChat({
        sessionId: chatSessionId(ctx),
        message,
        characterId: character.id,
        relationshipMode: sceneOverride
          ? (getSceneById(sceneOverride)?.relationshipMode ?? character.relationshipMode)
          : undefined,
        sceneId: sceneOverride || ctx.session.activeSceneId,
        styleId: ctx.session.responseStyle,
        adultVerified: ctx.session.adultVerified
      })
    );
  }

  // 处理【拍张照】生图请求：异步生成并发送，不阻塞正常聊天回复
  async function handlePhotoRequest(ctx: BotContext, character: DigitalHumanConfig): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    await ctx.api.sendChatAction(chatId, "upload_photo").catch(() => {});
    await ctx.reply("📷 姐姐这就去拍，稍等一下下哦~");
    const session = await loadSession(chatSessionId(ctx));
    const recent = (session?.history ?? []).slice(-12);
    const res = await runPhotoTask({ character, recentMessages: recent });
    try {
      await ctx.api.sendPhoto(chatId, new InputFile(res.imagePath));
    } finally {
      res.cleanup();
    }
  }

  bot.use(session({ initial: (): BotSessionData => ({ voiceEnabled: true }) }));

  // 访问控制：仅允许主人 TG 账号。ALLOWED_TG_USER_ID 显式指定时以此为准；
  // 否则进入引导期，首位发送 /start 的用户自动注册为 owner，之后其余账号被拒。
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    const allowed = getAllowedIds();
    if (allowed.length > 0) {
      if (id != null && allowed.includes(id)) return next();
      return ctx.reply("⛔ 未授权：本机器人仅限指定账号使用。").catch(() => {});
    }
    const owner = loadOwner();
    if (owner == null) return next(); // 引导期：首个 /start 将注册为 owner
    if (id != null && id === owner) return next();
    return ctx.reply("⛔ 未授权：本机器人仅限主人使用。").catch(() => {});
  });

  bot.command("start", async (ctx) => {
    const allowed = getAllowedIds();
    if (allowed.length === 0 && loadOwner() == null && ctx.from?.id != null) {
      saveOwner(ctx.from.id);
      console.log(`Telegram bot owner 已注册: ${ctx.from.id}`);
    }
    const character = await currentCharacter(ctx);
    const name = character?.name ?? "（未选择，发送 /list 选择）";
    const session = await loadSession(chatSessionId(ctx));
    const summaryOn = session?.summaryMode ?? false;
    await ctx.reply(
      `👋 你好，我是数字人私聊助手。\n\n` +
        `当前数字人：${name}\n` +
        `陪伴场景：${sceneLabel(ctx.session.activeSceneId)}\n` +
        `回复语气：${styleLabel(ctx.session.responseStyle)}\n` +
        `语音回复：${ctx.session.voiceEnabled ? "开 🔊" : "关 🔇"}\n` +
        `记忆总结：${summaryOn ? "开（只发记忆+最近对话）" : "关（发完整历史）"}\n\n` +
        `常用命令：\n` +
        `/list 查看数字人\n` +
        `/select 切换数字人\n` +
        `/scene 选择陪伴场景\n` +
        `/action 快速互动（抱抱/晚安等）\n` +
        `/style 选择回复语气\n` +
        `/voice 开关语音回复\n` +
        `/summary 开关记忆总结模式\n` +
        `/new 创建数字人\n` +
        `/edit 编辑数字人\n` +
        `/delete 删除数字人\n` +
        `/reset 清空当前对话\n` +
        `/export 导出记忆备份（JSON 文件）\n` +
        `/import 从备份文件恢复记忆\n` +
        `/help 查看全部命令`
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `命令一览：\n` +
        `/start 欢迎与状态\n` +
        `/list 列出数字人\n` +
        `/select <序号或ID> 切换当前数字人\n` +
        `/scene 选择陪伴场景（日常/约会/安慰/亲密/睡前）\n` +
        `/action 快速互动（抱抱/牵手/耳语/依靠/晚安）\n` +
        `/style 选择回复语气（温柔/轻声/沉稳）\n` +
        `/voice 开关语音回复\n` +
        `/new 对话式创建数字人\n` +
        `/edit 对话式编辑（先选人）\n` +
        `/delete <序号> 删除数字人\n` +
        `/reset 清空与当前数字人的对话\n` +
        `/summary 开关记忆总结模式（短上下文模型防超限）\n` +
        `/export 导出当前数字人的记忆备份（JSON 文件）\n` +
        `/import 从备份文件恢复记忆（会覆盖现有记忆）\n` +
        `/cancel 取消正在进行的创建/编辑\n\n` +
        `直接发文字即可聊天；发语音消息会自动转写并回复（语音开启时朗读）。`
    );
  });

  bot.command("list", async (ctx) => {
    if (fixedId) {
      const c = await currentCharacter(ctx);
      return ctx.reply(`本机器人是「${c?.name ?? "专属数字人"}」的专属助手，无需切换角色。`);
    }
    const { text, keyboard } = await listHumansKeyboard(ctx);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.command("select", async (ctx) => {
    if (fixedId) {
      const c = await currentCharacter(ctx);
      return ctx.reply(`本机器人是「${c?.name ?? "专属数字人"}」的专属助手，无需切换角色。`);
    }
    const arg = ctx.match?.trim();
    const characters = await getCharacters();
    let target: DigitalHumanConfig | null = characters[0] ?? null;
    if (arg) {
      const byId = characters.find((c) => c.id === arg);
      const byNum = characters[Number(arg) - 1];
      target = byId ?? byNum ?? null;
    }
    if (!target) {
      return ctx.reply("未找到该数字人，先发送 /list 查看。");
    }
    ctx.session.currentCharacterId = target.id;
    await ctx.reply(`已切换到：${target.name}`);
  });

  bot.command("voice", async (ctx) => {
    ctx.session.voiceEnabled = !ctx.session.voiceEnabled;
    await ctx.reply(`语音回复已${ctx.session.voiceEnabled ? "开启 🔊" : "关闭 🔇"}`);
  });

  bot.command("scene", async (ctx) => {
    await ctx.reply("选择当前陪伴场景：", {
      reply_markup: sceneKeyboard(ctx.session.activeSceneId)
    });
  });

  bot.command("action", async (ctx) => {
    await ctx.reply("选一个互动：", { reply_markup: interactionKeyboard() });
  });

  bot.command("style", async (ctx) => {
    await ctx.reply("选择回复语气风格：", {
      reply_markup: styleKeyboard(ctx.session.responseStyle)
    });
  });

  bot.command("reset", async (ctx) => {
    await clearSession(chatSessionId(ctx));
    await ctx.reply("已清空与当前数字人的对话记忆。");
  });

  // 记忆总结模式：开启后每轮只把「记忆档案 + 最近若干条」发给模型，避免短上下文模型超限
  bot.command("summary", async (ctx) => {
    const character = await currentCharacter(ctx);
    if (!character) {
      return ctx.reply("请先用 /list 选择一个数字人。");
    }
    const sessionId = chatSessionId(ctx);
    const session = await loadSession(sessionId);
    const current = session?.summaryMode ?? false;
    const arg = ctx.match?.trim().toLowerCase();
    let next = current;
    if (arg === "on" || arg === "1" || arg === "开" || arg === "开启") {
      next = true;
    } else if (arg === "off" || arg === "0" || arg === "关" || arg === "关闭") {
      next = false;
    } else {
      next = !current; // 不带参数则切换
    }

    await updateSessionMeta(sessionId, { summaryMode: next });

    if (next) {
      const memory = await generateMemoryForSession(sessionId, character);
      const snippet = memory.trim()
        ? `${memory.trim().slice(0, 240)}${memory.trim().length > 240 ? "…" : ""}`
        : "（当前还没有对话，记得从下一次聊天开始积累）";
      await ctx.reply(
        "✅ 已开启记忆总结模式。\n每轮对话只向模型发送「记忆档案 + 最近若干条」，避免上下文超限导致遗忘。\n\n" +
          `📄 当前记忆档案：\n${snippet}`
      );
    } else {
      await ctx.reply("已关闭记忆总结模式，后续将发送完整历史（短上下文模型可能超限）。");
    }
  });

  // 导出当前数字人的服务器记忆为 JSON 文件（跨设备/跨服务器迁移用）
  bot.command("export", async (ctx) => {
    const character = await currentCharacter(ctx);
    if (!character) {
      return ctx.reply("请先用 /list 选择一个数字人。");
    }
    const record = await loadSession(chatSessionId(ctx));
    if (!record || record.history.length === 0) {
      return ctx.reply("当前数字人还没有对话记忆可导出。");
    }
    const tmp = path.join(os.tmpdir(), `dg-memory-${character.id}-${Date.now()}.json`);
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    try {
      await ctx.api.sendDocument(ctx.chat!.id, new InputFile(tmp, `dg-memory-${character.id}.json`));
      await ctx.reply("已导出当前数字人的记忆备份（JSON 文件）。");
    } catch (err) {
      console.error("export memory failed:", err);
      await ctx.reply("导出失败，请稍后重试。");
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });

  // 进入导入模式：下一步发送的记忆 JSON 会写回当前数字人
  bot.command("import", async (ctx) => {
    const character = await currentCharacter(ctx);
    if (!character) {
      return ctx.reply("请先用 /list 选择一个数字人，导入的记忆会写入该数字人。");
    }
    ctx.session.pendingImport = true;
    await ctx.reply(
      "请发送一个记忆备份 JSON 文件（网页端『备份记忆』下载的文件），我会把其中的对话恢复到当前数字人「" +
        character.name +
        "」。\n注意：会覆盖当前数字人的现有记忆。"
    );
  });

  bot.command("cancel", async (ctx) => {
    ctx.session.create = undefined;
    ctx.session.createStep = undefined;
    ctx.session.editId = undefined;
    ctx.session.editField = undefined;
    ctx.session.pendingAdultScene = undefined;
    ctx.session.pendingAdultInteraction = undefined;
    await ctx.reply("已取消当前操作。");
  });

  bot.command("new", async (ctx) => {
    if (fixedId) {
      const c = await currentCharacter(ctx);
      return ctx.reply(`本机器人仅供「${c?.name ?? "专属数字人"}」使用，创建数字人请在网页端或通用机器人进行。`);
    }
    ctx.session.create = {};
    ctx.session.createStep = "name";
    await ctx.reply("开始创建数字人。\n第一步：请发送她的【名字】（例如：林夕）。");
  });

  bot.command("edit", async (ctx) => {
    if (fixedId) {
      const c = await currentCharacter(ctx);
      return ctx.reply(`本机器人仅供「${c?.name ?? "专属数字人"}」使用，编辑数字人请在网页端或通用机器人进行。`);
    }
    const { text, keyboard } = await listHumansKeyboard(ctx);
    ctx.session.editId = undefined;
    ctx.session.editField = undefined;
    await ctx.reply(`请选择要编辑的数字人：\n${text}`, { reply_markup: keyboard });
  });

  bot.command("delete", async (ctx) => {
    if (fixedId) {
      const c = await currentCharacter(ctx);
      return ctx.reply(`本机器人仅供「${c?.name ?? "专属数字人"}」使用，删除数字人请在网页端或通用机器人进行。`);
    }
    const arg = ctx.match?.trim();
    const characters = await getCharacters();
    let target = arg ? (characters.find((c) => c.id === arg) ?? characters[Number(arg) - 1]) : null;
    if (!target) {
      const { text, keyboard } = await listHumansKeyboard(ctx);
      return ctx.reply(`请选择要删除的数字人：\n${text}`, { reply_markup: keyboard });
    }
    if (characters.length <= 1) {
      return ctx.reply("至少保留一个数字人，不能全部删除。");
    }
    const kb = new InlineKeyboard()
      .text(`确认删除 ${target.name}`, `del:${target.id}`)
      .text("取消", "del:cancel");
    await ctx.reply(`确定要删除「${target.name}」吗？`, { reply_markup: kb });
  });

  // ---------- callback queries ----------
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    try {
      if (data.startsWith("sel:")) {
        const id = data.slice(4);
        const characters = await getCharacters();
        const target = characters.find((c) => c.id === id);
        if (target) {
          ctx.session.currentCharacterId = target.id;
          await ctx.editMessageText(`已切换到：${target.name}`);
        }
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("scene:")) {
        const sceneId = data.slice(6);
        if (!isCompanionSceneId(sceneId)) {
          await ctx.editMessageText("未知场景");
          return ctx.answerCallbackQuery();
        }
        if (sceneId === "flirty" && !ctx.session.adultVerified) {
          ctx.session.pendingAdultScene = sceneId;
          const kb = new InlineKeyboard()
            .text("我已成年，确认进入", "adult:confirm")
            .text("取消", "adult:cancel");
          await ctx.editMessageText(
            "「亲密 18+」场景包含成人暧昧表达。请确认你已年满 18 周岁并自愿进入。",
            { reply_markup: kb }
          );
          return ctx.answerCallbackQuery();
        }
        ctx.session.activeSceneId = sceneId;
        const scene = getSceneById(sceneId);
        await ctx.editMessageText(
          `已切换到场景：${scene?.label ?? sceneId}\n${scene?.description ?? ""}`
        );
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("action:")) {
        const actionId = data.slice(7);
        const interaction = getInteractionById(actionId);
        if (!interaction) {
          await ctx.editMessageText("未知互动");
          return ctx.answerCallbackQuery();
        }
        const scene = getSceneById(interaction.sceneId);
        if (scene?.id === "flirty" && !ctx.session.adultVerified) {
          ctx.session.pendingAdultInteraction = interaction.id;
          const kb = new InlineKeyboard()
            .text("我已成年，确认进入", "adult:confirm")
            .text("取消", "adult:cancel");
          await ctx.editMessageText(
            "该互动会进入「亲密 18+」场景。请确认你已年满 18 周岁并自愿进入。",
            { reply_markup: kb }
          );
          return ctx.answerCallbackQuery();
        }
        await ctx.editMessageText(`${interaction.label} → ${interaction.message}`);
        try {
          const result = await runChatWithContext(ctx, interaction.message, interaction.sceneId);
          await replyWithTextAndVoice(ctx, result.text, result.character);
        } catch (err) {
          console.error("action handling failed:", err);
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "NO_CHARACTER") {
            await ctx.reply("请先用 /list 选择一个数字人。");
          } else {
            await ctx.reply(`互动处理失败：${msg.slice(0, 120)}`);
          }
        }
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("style:")) {
        const styleId = data.slice(6);
        const style = RESPONSE_STYLES.find((s) => s.id === styleId);
        if (!style) {
          await ctx.editMessageText("未知语气风格");
          return ctx.answerCallbackQuery();
        }
        ctx.session.responseStyle = styleId as "warm" | "soft" | "mature";
        await ctx.editMessageText(`已设置回复语气：${style.label}\n${style.instruction}`);
        return ctx.answerCallbackQuery();
      }

      if (data === "adult:confirm") {
        ctx.session.adultVerified = true;
        const pendingScene = ctx.session.pendingAdultScene;
        const pendingInteraction = ctx.session.pendingAdultInteraction;
        ctx.session.pendingAdultScene = undefined;
        ctx.session.pendingAdultInteraction = undefined;
        if (pendingScene) {
          ctx.session.activeSceneId = pendingScene;
          const scene = getSceneById(pendingScene);
          await ctx.editMessageText(
            `已确认并切换到场景：${scene?.label ?? pendingScene}\n${scene?.description ?? ""}`
          );
        } else if (pendingInteraction) {
          const interaction = getInteractionById(pendingInteraction);
          if (interaction) {
            await ctx.editMessageText(`${interaction.label} → ${interaction.message}`);
            try {
              const result = await runChatWithContext(ctx, interaction.message, interaction.sceneId);
              await replyWithTextAndVoice(ctx, result.text, result.character);
            } catch (err) {
              console.error("adult interaction failed:", err);
              const msg = err instanceof Error ? err.message : String(err);
              if (msg === "NO_CHARACTER") {
                await ctx.reply("请先用 /list 选择一个数字人。");
              } else {
                await ctx.reply(`互动处理失败：${msg.slice(0, 120)}`);
              }
            }
          } else {
            await ctx.editMessageText("互动已过期，请重新选择。");
          }
        } else {
          await ctx.editMessageText("已确认成人模式。");
        }
        return ctx.answerCallbackQuery();
      }

      if (data === "adult:cancel") {
        ctx.session.pendingAdultScene = undefined;
        ctx.session.pendingAdultInteraction = undefined;
        await ctx.editMessageText("已取消。");
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("voice:")) {
        const voice = data.slice(6);
        if (ctx.session.create) {
          ctx.session.create.voice = voice;
          ctx.session.createStep = "relationshipMode";
          await ctx.editMessageText(
            `音色已选：${voice}\n最后一步：选择关系模式`,
            { reply_markup: relationshipKeyboard("rm:") }
          );
        } else if (ctx.session.editId && ctx.session.editField === "voice") {
          await applyCharacterPatch(ctx.session.editId, {
            voiceProfile: { provider: "mimo", voice }
          });
          ctx.session.editId = undefined;
          ctx.session.editField = undefined;
          await ctx.editMessageText(`已更新音色为：${voice}`);
        }
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("rm:")) {
        const mode = data.slice(3) as DigitalHumanConfig["relationshipMode"];
        if (ctx.session.create) {
          ctx.session.create.relationshipMode = mode;
          ctx.session.createStep = "confirm";
          const d = ctx.session.create;
          const summary =
            `请确认创建：\n` +
            `名字：${d.name}\n描述：${d.description}\n` +
            `头像：${d.avatarUrl ? "已设置" : "未设置"}\n` +
            `音色：${d.voice}\n关系模式：${d.relationshipMode}`;
          const kb = new InlineKeyboard()
            .text("确认创建", "c:confirm")
            .text("取消", "c:cancel");
          await ctx.editMessageText(summary, { reply_markup: kb });
        } else if (ctx.session.editId && ctx.session.editField === "relationshipMode") {
          await applyCharacterPatch(ctx.session.editId, { relationshipMode: ensureRelationshipMode(mode) });
          ctx.session.editId = undefined;
          ctx.session.editField = undefined;
          await ctx.editMessageText(`已更新关系模式为：${mode}`);
        }
        return ctx.answerCallbackQuery();
      }

      if (data === "c:confirm") {
        const d = ctx.session.create;
        if (!d || !d.name || !d.description) {
          await ctx.editMessageText("信息不完整，已取消。");
        } else {
          const customs = await loadCustomHumans();
          const created: DigitalHumanConfig = {
            id: `tg-${Date.now()}`,
            name: d.name,
            description: d.description,
            avatarUrl: d.avatarUrl || "/avatars/default.png",
            voiceProfile: { provider: "mimo", voice: d.voice || "冰糖" },
            relationshipMode: ensureRelationshipMode(d.relationshipMode),
            defaultMood: "neutral",
            avatarType: "image"
          };
          customs.push(created);
          await writeCustomHumans(customs);
          ctx.session.currentCharacterId = created.id;
          await ctx.editMessageText(`✅ 已创建数字人「${created.name}」并切换为当前。`);
        }
        ctx.session.create = undefined;
        ctx.session.createStep = undefined;
        return ctx.answerCallbackQuery();
      }

      if (data === "c:cancel") {
        ctx.session.create = undefined;
        ctx.session.createStep = undefined;
        await ctx.editMessageText("已取消创建。");
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("del:")) {
        const id = data.slice(4);
        if (id === "cancel") {
          await ctx.editMessageText("已取消删除。");
          return ctx.answerCallbackQuery();
        }
        const characters = await getCharacters();
        if (characters.length <= 1) {
          await ctx.editMessageText("至少保留一个数字人，不能删除。");
          return ctx.answerCallbackQuery();
        }
        const target = characters.find((c) => c.id === id);
        if (!target) {
          await ctx.editMessageText("未找到该数字人。");
          return ctx.answerCallbackQuery();
        }
        // 复用 HTTP 删除逻辑：内置写隐藏，自定义删文件
        const { deleteCustomHumanById, loadHumanOverrides, writeHumanOverrides } = await import("../core/data");
        const deleted = await deleteCustomHumanById(id);
        if (!deleted) {
          const ov = await loadHumanOverrides();
          if (!ov.hidden.includes(id)) ov.hidden.push(id);
          delete ov.overrides[id];
          await writeHumanOverrides(ov);
        }
        if (ctx.session.currentCharacterId === id) ctx.session.currentCharacterId = undefined;
        await ctx.editMessageText(`已删除「${target.name}」。`);
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("edit:")) {
        const id = data.slice(5);
        ctx.session.editId = id;
        const kb = new InlineKeyboard()
          .text("名字", "ef:name").text("描述", "ef:description").row()
          .text("头像", "ef:avatarUrl").text("音色", "ef:voice").row()
          .text("关系模式", "ef:relationshipMode").text("取消", "ef:cancel");
        await ctx.editMessageText("选择要修改的字段：", { reply_markup: kb });
        return ctx.answerCallbackQuery();
      }

      if (data.startsWith("ef:")) {
        const field = data.slice(3);
        if (field === "cancel") {
          ctx.session.editId = undefined;
          ctx.session.editField = undefined;
          await ctx.editMessageText("已取消编辑。");
          return ctx.answerCallbackQuery();
        }
        if (field === "voice") {
          ctx.session.editField = "voice";
          await ctx.editMessageText("选择新音色：", { reply_markup: voiceKeyboard() });
          return ctx.answerCallbackQuery();
        }
        if (field === "relationshipMode") {
          ctx.session.editField = "relationshipMode";
          await ctx.editMessageText("选择新关系模式：", { reply_markup: relationshipKeyboard("rm:") });
          return ctx.answerCallbackQuery();
        }
        ctx.session.editField = field as BotSessionData["editField"];
        const promptMap: Record<string, string> = {
          name: "请发送新的名字",
          description: "请发送新的描述",
          avatarUrl: "请发送头像图片，或发送图片 URL"
        };
        await ctx.editMessageText(promptMap[field] ?? "请发送新内容");
        return ctx.answerCallbackQuery();
      }
    } catch (err) {
      console.error("callback handling failed:", err);
      await ctx.answerCallbackQuery("操作失败，请重试");
    }
  });

  // ---------- photo ----------
  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo!;
    const last = photos[photos.length - 1];
    if (!last) return ctx.reply("图片无效");
    const fileId = last.file_id;
    try {
      if (ctx.session.create && ctx.session.createStep === "avatar") {
        const url = await saveAvatar(ctx, fileId, botToken);
        ctx.session.create.avatarUrl = url;
        ctx.session.createStep = "voice";
        await ctx.reply("头像已保存。请选择音色：", { reply_markup: voiceKeyboard() });
        return;
      }
      if (ctx.session.editId && ctx.session.editField === "avatarUrl") {
        const url = await saveAvatar(ctx, fileId, botToken);
        await applyCharacterPatch(ctx.session.editId, { avatarUrl: url });
        ctx.session.editId = undefined;
        ctx.session.editField = undefined;
        await ctx.reply("头像已更新。");
        return;
      }
      await ctx.reply("可发送 /new 或 /edit 时上传头像。");
    } catch (err) {
      console.error("photo handling failed:", err);
      await ctx.reply("头像处理失败，请重试。");
    }
  });

  // ---------- document (import memory) ----------
  bot.on("message:document", async (ctx) => {
    if (!ctx.session.pendingImport) return;
    ctx.session.pendingImport = false;
    const doc = ctx.message.document;
    if (!doc) return;
    let tmp: string | undefined;
    try {
      tmp = await downloadToTemp(ctx, doc.file_id, "json", botToken);
      const raw = await fs.readFile(tmp, "utf8");
      const parsed = JSON.parse(raw) as { history?: unknown; context?: unknown };
      if (!Array.isArray(parsed.history)) {
        return ctx.reply("文件格式不正确：缺少 history 数组。");
      }
      const character = await currentCharacter(ctx);
      if (!character) {
        return ctx.reply("请先用 /list 选择一个数字人。");
      }
      const record = await importSession(
        chatSessionId(ctx),
        parsed.history as ChatMessage[],
        parsed.context as SessionContext | undefined
      );
      await ctx.reply(`记忆恢复成功，共 ${record.history.length} 条对话。重新打开对话即可看到历史。`);
    } catch (err) {
      console.error("import memory failed:", err);
      const msg = err instanceof Error ? err.message : "未知错误";
      await ctx.reply(`恢复失败：${msg.slice(0, 120)}`);
    } finally {
      if (tmp) await fs.unlink(tmp).catch(() => {});
    }
  });

  // ---------- voice messages ----------
  bot.on("message:voice", async (ctx) => {
    const fileId = ctx.message.voice.file_id;
    let oggPath: string | undefined;
    try {
      oggPath = await downloadToTemp(ctx, fileId, "ogg", botToken);
      const { base64, mime } = await oggToWavBase64(oggPath);
      oggPath = undefined;
      const text = await transcribeSpeechAudio({ audioBase64: base64, mimeType: mime });
      if (!text) {
        return ctx.reply("没听清，能再发一次吗？");
      }
      await ctx.reply(`🎙 识别：${text}`);
      try {
        const result = await runChatWithContext(ctx, text);
        await replyWithTextAndVoice(ctx, result.text, result.character);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "NO_CHARACTER") {
          return ctx.reply("请先用 /list 选择一个数字人。");
        }
        throw err;
      }
    } catch (err) {
      console.error("voice handling failed:", err);
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`语音处理失败：${msg.slice(0, 120)}`);
    } finally {
      if (oggPath) await fs.unlink(oggPath).catch(() => {});
    }
  });

  // ---------- text messages ----------
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return; // 命令交给上面处理

    try {
      // 创建向导
      if (ctx.session.create) {
        const step = ctx.session.createStep;
        if (step === "name") {
          ctx.session.create.name = text;
          ctx.session.createStep = "description";
          return ctx.reply("第二步：请发送她的【人物设定/描述】。");
        }
        if (step === "description") {
          ctx.session.create.description = text;
          ctx.session.createStep = "avatar";
          return ctx.reply("第三步：请发送【头像图片】，或发送图片 URL 链接。");
        }
        if (step === "avatar") {
          if (/^https?:\/\//i.test(text)) {
            ctx.session.create.avatarUrl = text;
            ctx.session.createStep = "voice";
            return ctx.reply("头像已设为链接。请选择音色：", { reply_markup: voiceKeyboard() });
          }
          return ctx.reply("请发送图片，或发送以 http 开头的图片 URL。");
        }
        if (step === "confirm") {
          return ctx.reply("请使用上方按钮确认或取消。");
        }
        return;
      }

      // 编辑向导
      if (ctx.session.editId && ctx.session.editField) {
        const field = ctx.session.editField;
        const patch: Partial<DigitalHumanConfig> = {};
        if (field === "name") patch.name = text;
        else if (field === "description") patch.description = text;
        else if (field === "avatarUrl") {
          if (/^https?:\/\//i.test(text)) patch.avatarUrl = text;
          else return ctx.reply("请发送 http(s) 图片链接。");
        }
        await applyCharacterPatch(ctx.session.editId, patch);
        ctx.session.editId = undefined;
        ctx.session.editField = undefined;
        return ctx.reply(`已更新${field === "name" ? "名字" : field === "description" ? "描述" : "头像"}。`);
      }

      // 普通聊天
      try {
        const result = await runChatWithContext(ctx, text);
        await replyWithTextAndVoice(ctx, result.text, result.character);

        // 【拍张照】触发生图（异步，不阻塞聊天回复；按数字人隔离：各自头像/会话/独立 bot）
        if (text.includes("拍张照")) {
          void handlePhotoRequest(ctx, result.character).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("拍照生图失败:", msg);
            ctx.reply(`📷 拍照失败：${msg.slice(0, 120)}`).catch(() => {});
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "NO_CHARACTER") {
          return ctx.reply("请先用 /list 选择一个数字人再聊天。");
        }
        throw err;
      }
    } catch (err) {
      console.error("text handling failed:", err);
      await ctx.reply("处理失败，请稍后再试。");
    }
  });
}

// 已启动的专属 bot 实例注册表，key 为角色 id，供主动推送调度器按角色发送。
const characterBots = new Map<string, Bot<BotContext>>();

export async function startTelegramBot(token: string, fixedCharacterId?: string): Promise<void> {
  if (!token) return;
  const bot = new Bot<BotContext>(token);
  registerBot(bot, token, fixedCharacterId);
  if (fixedCharacterId) characterBots.set(fixedCharacterId, bot);

  const webhookUrl = process.env.TELEGRAM_WEBHOOK?.trim();
  if (webhookUrl) {
    try {
      await bot.api.setWebhook(webhookUrl);
      console.log(`Telegram bot webhook set to ${webhookUrl}`);
      // 注意：webhook 模式需要通过 express 暴露 /telegram-webhook 路由，
      // 本项目默认使用 polling，避免额外网络配置。
    } catch (err) {
      console.error("设置 Telegram webhook 失败，回退到 polling：", err);
    }
  }

  await bot.start({
    onStart: (me) => console.log(`Telegram bot @${me.username} started (polling)`)
  });
}

// 主动推送：获取某角色已注册的专属 bot 实例。
export function getCharacterBot(characterId: string): Bot<BotContext> | undefined {
  return characterBots.get(characterId);
}

// 主动推送：让某角色专属 bot 给主人发一条消息（文本，可选带语音）。返回是否发送成功。
export async function sendProactiveToOwner(character: DigitalHumanConfig, text: string): Promise<boolean> {
  const bot = characterBots.get(character.id);
  if (!bot) return false;
  const ownerId = loadOwner();
  if (ownerId == null) return false;
  // 语音默认关闭，避免每条定时消息都消耗 MiMo TTS 额度；在角色「主动推送」设置里可开启。
  const voiceEnabled = character.proactive?.voiceEnabled ?? false;
  try {
    await sendTextWithOptionalVoice(bot.api, ownerId, text, character, voiceEnabled);
    return true;
  } catch (err) {
    console.error(`主动向主人推送失败 (${character.id}):`, err);
    return false;
  }
}
