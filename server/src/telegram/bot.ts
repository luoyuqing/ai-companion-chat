import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Bot, Context, InlineKeyboard, InputFile, session, SessionFlavor } from "grammy";

import { runChat } from "../core/chat";
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
import { synthesizeSpeech } from "../services/tts";
import { transcribeSpeechAudio } from "../services/transcription";
import { clearSession } from "../services/session";
import { DigitalHumanConfig } from "../types";

const execFileAsync = promisify(execFile);

// 模块级保存 bot token，供下载 Telegram 文件时拼接 file URL 使用
let BOT_TOKEN = "";

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
  create?: CreateDraft;
  createStep?: "name" | "description" | "avatar" | "voice" | "relationshipMode" | "confirm";
  editId?: string;
  editField?: "name" | "description" | "avatarUrl" | "voice" | "relationshipMode";
}

type BotContext = Context & SessionFlavor<BotSessionData>;

// ---------- helpers ----------
function chatSessionId(ctx: BotContext): string {
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
  return `tg-${chatId}`;
}

async function currentCharacter(ctx: BotContext): Promise<DigitalHumanConfig | null> {
  const characters = await getCharacters();
  return resolveCharacter(characters, ctx.session.currentCharacterId);
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

async function downloadToTemp(ctx: BotContext, fileId: string, ext: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("文件无可用路径");
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("下载 Telegram 文件失败");
  const buffer = Buffer.from(await res.arrayBuffer());
  const tmp = path.join(os.tmpdir(), `dg-tg-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
  await fs.writeFile(tmp, buffer);
  return tmp;
}

async function saveAvatar(ctx: BotContext, fileId: string): Promise<string> {
  const tmp = await downloadToTemp(ctx, fileId, "img");
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

async function replyWithTextAndVoice(
  ctx: BotContext,
  text: string,
  character: DigitalHumanConfig
): Promise<void> {
  await ctx.reply(text.slice(0, 4000));
  if (!ctx.session.voiceEnabled) return;
  try {
    const audioUrl = await synthesizeSpeech(text, character);
    if (!audioUrl) return;
    const audioPath = audioUrlToPath(audioUrl);
    if (audioPath && (await fs.stat(audioPath).catch(() => null))) {
      // Telegram 语音消息仅支持 OGG/Opus 容器，MiMo 产出的是 MP3，需转码
      const oggPath = path.join(
        os.tmpdir(),
        `dg-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.ogg`
      );
      try {
        await execFileAsync("ffmpeg", ["-y", "-i", audioPath, "-c:a", "libopus", "-b:a", "64k", oggPath]);
        await ctx.replyWithVoice(new InputFile(oggPath));
        await fs.unlink(oggPath).catch(() => {});
      } catch (convErr) {
        console.warn("TG 语音转码失败，回退为发送音频文件：", convErr);
        await ctx.replyWithAudio(new InputFile(audioPath));
      }
      await fs.unlink(audioPath).catch(() => {});
    }
  } catch (err) {
    console.warn("TG 语音合成失败：", err instanceof Error ? err.message : err);
  }
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

// ---------- bot ----------
export function registerBot(bot: Bot<BotContext>): void {
  bot.catch((err) => {
    console.error("Telegram bot error:", err);
  });

  bot.use(session({ initial: (): BotSessionData => ({ voiceEnabled: false }) }));

  bot.command("start", async (ctx) => {
    const character = await currentCharacter(ctx);
    const name = character?.name ?? "（未选择，发送 /list 选择）";
    await ctx.reply(
      `👋 你好，我是数字人私聊助手。\n\n` +
        `当前数字人：${name}\n` +
        `语音回复：${ctx.session.voiceEnabled ? "开 🔊" : "关 🔇"}\n\n` +
        `常用命令：\n` +
        `/list 查看数字人\n` +
        `/select 切换数字人\n` +
        `/voice 开关语音回复\n` +
        `/new 创建数字人\n` +
        `/edit 编辑数字人\n` +
        `/delete 删除数字人\n` +
        `/reset 清空当前对话\n` +
        `/help 查看全部命令`
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `命令一览：\n` +
        `/start 欢迎与状态\n` +
        `/list 列出数字人\n` +
        `/select <序号或ID> 切换当前数字人\n` +
        `/voice 开关语音回复\n` +
        `/new 对话式创建数字人\n` +
        `/edit 对话式编辑（先选人）\n` +
        `/delete <序号> 删除数字人\n` +
        `/reset 清空与当前数字人的对话\n` +
        `/cancel 取消正在进行的创建/编辑\n\n` +
        `直接发文字即可聊天；发语音消息会自动转写并回复（语音开启时朗读）。`
    );
  });

  bot.command("list", async (ctx) => {
    const { text, keyboard } = await listHumansKeyboard(ctx);
    await ctx.reply(text, { reply_markup: keyboard });
  });

  bot.command("select", async (ctx) => {
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

  bot.command("reset", async (ctx) => {
    await clearSession(chatSessionId(ctx));
    await ctx.reply("已清空与当前数字人的对话记忆。");
  });

  bot.command("cancel", async (ctx) => {
    ctx.session.create = undefined;
    ctx.session.createStep = undefined;
    ctx.session.editId = undefined;
    ctx.session.editField = undefined;
    await ctx.reply("已取消当前操作。");
  });

  bot.command("new", async (ctx) => {
    ctx.session.create = {};
    ctx.session.createStep = "name";
    await ctx.reply("开始创建数字人。\n第一步：请发送她的【名字】（例如：林夕）。");
  });

  bot.command("edit", async (ctx) => {
    const { text, keyboard } = await listHumansKeyboard(ctx);
    ctx.session.editId = undefined;
    ctx.session.editField = undefined;
    await ctx.reply(`请选择要编辑的数字人：\n${text}`, { reply_markup: keyboard });
  });

  bot.command("delete", async (ctx) => {
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
        const url = await saveAvatar(ctx, fileId);
        ctx.session.create.avatarUrl = url;
        ctx.session.createStep = "voice";
        await ctx.reply("头像已保存。请选择音色：", { reply_markup: voiceKeyboard() });
        return;
      }
      if (ctx.session.editId && ctx.session.editField === "avatarUrl") {
        const url = await saveAvatar(ctx, fileId);
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

  // ---------- voice messages ----------
  bot.on("message:voice", async (ctx) => {
    const fileId = ctx.message.voice.file_id;
    let oggPath: string | undefined;
    try {
      oggPath = await downloadToTemp(ctx, fileId, "ogg");
      const { base64, mime } = await oggToWavBase64(oggPath);
      oggPath = undefined;
      const text = await transcribeSpeechAudio({ audioBase64: base64, mimeType: mime });
      if (!text) {
        return ctx.reply("没听清，能再发一次吗？");
      }
      await ctx.reply(`🎙 识别：${text}`);
      const character = await currentCharacter(ctx);
      if (!character) {
        return ctx.reply("请先用 /list 选择一个数字人。");
      }
      const result = await runChat({
        sessionId: chatSessionId(ctx),
        message: text,
        characterId: character.id
      });
      await replyWithTextAndVoice(ctx, result.text, result.character);
    } catch (err) {
      console.error("voice handling failed:", err);
      await ctx.reply("语音处理失败：需要服务器安装 ffmpeg，或请用文字聊天。");
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
      const character = await currentCharacter(ctx);
      if (!character) {
        return ctx.reply("请先用 /list 选择一个数字人再聊天。");
      }
      const result = await runChat({
        sessionId: chatSessionId(ctx),
        message: text,
        characterId: character.id
      });
      await replyWithTextAndVoice(ctx, result.text, result.character);
    } catch (err) {
      console.error("text handling failed:", err);
      await ctx.reply("处理失败，请稍后再试。");
    }
  });
}

export async function startTelegramBot(token: string): Promise<void> {
  if (!token) return;
  BOT_TOKEN = token;
  const bot = new Bot<BotContext>(token);
  registerBot(bot);

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
