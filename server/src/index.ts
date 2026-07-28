import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import express, { Response } from "express";
import cors from "cors";

import { askAssistant, streamAssistant, StreamChunk } from "./services/llm";
import { synthesizeSpeech } from "./services/tts";
import { transcribeSpeechAudio } from "./services/transcription";
import { inferEmotion } from "./services/emotion";
import { appendToSession, buildSessionContext, clearSession, importSession, loadSession, updateSessionMeta } from "./services/session";
import {
  AvatarRenderMode,
  ChatRequestBody,
  ChatMessage,
  ChatResponse,
  RelationshipMode,
  DigitalHumanConfig,
  EmotionProfile,
  SessionContext
} from "./types";

// 数据层与对话编排统一复用 core 模块，避免网页端与 Telegram 端逻辑分叉
import { runChat, buildModelHistory, generateMemoryForSession, isSummaryModeEnabled, maybeSummarize } from "./core/chat";
import {
  applyCharacterPatch,
  AUDIO_DIR,
  AVATAR_DIR,
  CUSTOM_FILE,
  DATA_DIR,
  deleteCustomHumanById,
  deleteModelFileByName,
  ensureRelationshipMode,
  ensureSupportedMood,
  getCharacters,
  HumanOverrides,
  loadCustomHumans,
  loadHumanOverrides,
  MAX_AVATAR_BYTES,
  MAX_MODEL_BYTES,
  MODEL_DIR,
  normalizeAvatarType,
  normalizeExpressionProfile,
  normalizeHistory,
  normalizeRelationshipMode,
  OVERRIDE_FILE,
  resolveCharacter,
  sanitizeAvatarFileName,
  sanitizeModelFileName,
  STATIC_ASSETS_DIR,
  writeCustomHumans,
  writeHumanOverrides
} from "./core/data";
import { startTelegramBot } from "./telegram/bot";

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST;
const WEB_APP_URL = process.env.WEB_APP_URL?.trim() || "http://127.0.0.1:5173";

app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.get("/api/digital-humans", async (_req, res) => {
  const humans = await getCharacters();
  res.json({ humans });
});

app.post("/api/models/upload", async (req, res) => {
  try {
    const { fileName, fileBase64, mimeType } = (req.body || {}) as {
      fileName?: unknown;
      fileBase64?: unknown;
      mimeType?: unknown;
    };
    const safeName = sanitizeModelFileName(fileName);
    const buffer = decodeBase64Payload(fileBase64);
    const modelUrl = `/models/${safeName}`;

    await fs.mkdir(MODEL_DIR, { recursive: true });
    await fs.writeFile(path.join(MODEL_DIR, safeName), buffer);
    res.status(201).json({
      modelUrl,
      fileName: safeName,
      mimeType: typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined,
      size: buffer.byteLength
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "模型上传失败";
    res.status(400).json({ error: message });
  }
});

app.post("/api/avatars/upload", async (req, res) => {
  try {
    const { fileName, fileBase64, mimeType } = (req.body || {}) as {
      fileName?: unknown;
      fileBase64?: unknown;
      mimeType?: unknown;
    };
    const safeName = sanitizeAvatarFileName(fileName, mimeType);
    const buffer = decodeBase64Payload(fileBase64);
    if (buffer.byteLength > MAX_AVATAR_BYTES) {
      return res.status(400).json({ error: "头像图片不能超过 8MB" });
    }

    await fs.mkdir(AVATAR_DIR, { recursive: true });
    await fs.writeFile(path.join(AVATAR_DIR, safeName), buffer);
    res.status(201).json({
      avatarUrl: `/avatars/${safeName}`,
      fileName: safeName,
      size: buffer.byteLength
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "头像上传失败";
    res.status(400).json({ error: message });
  }
});

app.delete("/api/models/:fileName", async (req, res) => {
  const fileName = String(req.params.fileName || "").trim();
  const deleted = await deleteModelFileByName(fileName);
  if (!deleted) {
    return res.status(404).json({ error: "model file not found" });
  }
  res.json({ ok: true });
});

app.post("/api/digital-humans", async (req, res) => {
  try {
    const {
      name,
      description,
      avatarUrl,
      modelUrl,
      voice,
      voiceProvider,
      defaultMood,
      emotionProfile,
      avatarType,
      avatarVideoProfile,
      personalityTagline,
      relationshipMode
    } = req.body as {
      name?: string;
      description?: string;
      avatarUrl?: string;
      modelUrl?: string;
      voice?: string;
      voiceProvider?: "openai" | "azure" | "local" | "mimo";
      defaultMood?: DigitalHumanConfig["defaultMood"];
      emotionProfile?: EmotionProfile;
      avatarType?: AvatarRenderMode | string;
      avatarVideoProfile?: EmotionProfile;
      personalityTagline?: string;
      relationshipMode?: DigitalHumanConfig["relationshipMode"];
    };

    if (!name || !description || !avatarUrl || !voice) {
      return res.status(400).json({ error: "name、description、avatarUrl、voice 都不能为空" });
    }

    const customs = await loadCustomHumans();
    const created: DigitalHumanConfig = {
      id: `custom-${Date.now()}`,
      name,
      description,
      avatarUrl,
      modelUrl: String(modelUrl || "").trim() || undefined,
      personalityTagline: personalityTagline?.trim() || undefined,
      emotionProfile: normalizeExpressionProfile(emotionProfile),
      avatarType: normalizeAvatarType(avatarType),
      avatarVideoProfile: normalizeExpressionProfile(avatarVideoProfile),
      voiceProfile: { provider: (voiceProvider === "azure" || voiceProvider === "local" || voiceProvider === "mimo" ? voiceProvider : "openai"), voice },
      relationshipMode: ensureRelationshipMode(relationshipMode),
      defaultMood: ensureSupportedMood(defaultMood)
    };
    customs.push(created);
    await writeCustomHumans(customs);
    res.status(201).json({ human: created });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "create digital human failed" });
  }
});

app.patch("/api/digital-humans/:id", async (req, res) => {
  try {
    const characterId = String(req.params.id || "").trim();
    if (!characterId) {
      return res.status(400).json({ error: "digital human id is required" });
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Partial<DigitalHumanConfig> = {};

    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.description === "string" && body.description.trim()) patch.description = body.description.trim();
    if (typeof body.avatarUrl === "string" && body.avatarUrl.trim()) patch.avatarUrl = body.avatarUrl.trim();
    if (typeof body.modelUrl === "string") patch.modelUrl = body.modelUrl.trim() || undefined;
    if (typeof body.personalityTagline === "string") patch.personalityTagline = body.personalityTagline.trim() || undefined;
    if (body.defaultMood !== undefined) patch.defaultMood = ensureSupportedMood(body.defaultMood as string);
    if (body.relationshipMode !== undefined) patch.relationshipMode = ensureRelationshipMode(body.relationshipMode);
    if (body.avatarType !== undefined) patch.avatarType = normalizeAvatarType(body.avatarType);

    const voice = typeof body.voice === "string" ? body.voice.trim() : "";
    const voiceProvider = body.voiceProvider;
    const characters = await getCharacters();
    const current = characters.find((item) => item.id === characterId);
    if (voice || voiceProvider !== undefined) {
      const provider =
        voiceProvider === "azure" || voiceProvider === "local" || voiceProvider === "mimo" || voiceProvider === "openai"
          ? voiceProvider
          : current?.voiceProfile.provider || "mimo";
      patch.voiceProfile = { provider, voice: voice || current?.voiceProfile.voice || "冰糖" };
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "没有可更新的字段" });
    }

    const merged = await applyCharacterPatch(characterId, patch);
    res.json({ human: merged });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "update digital human failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body as ChatRequestBody;
    const message = String(body.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const result = await runChat({
      sessionId: body.sessionId,
      message,
      characterId: body.characterId,
      relationshipMode: normalizeRelationshipMode(body.relationshipMode)
    });

    const emotionFromUser = inferEmotion(message);
    const mergedEmotion = result.emotion || emotionFromUser;
    const audioUrl = await synthesizeSpeech(result.text, result.character);

    const payload: ChatResponse = {
      sessionId: result.sessionId,
      characterId: result.character.id,
      text: result.text,
      emotion: mergedEmotion as ChatResponse["emotion"],
      audioUrl,
      context: result.context
    };
    res.json(payload);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "chat failed" });
  }
});

app.post("/api/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType, language } = (req.body || {}) as {
      audioBase64?: unknown;
      mimeType?: string;
      language?: string;
    };

    if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
      return res.status(400).json({ error: "audioBase64 为必填项" });
    }

    const text = await transcribeSpeechAudio({
      audioBase64: audioBase64,
      mimeType,
      language
    });
    res.json({ text });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "语音转写失败";
    res.status(500).json({ error: message });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  let aborted = false;
  let wroteResponse = false;
  try {
    const body = req.body as ChatRequestBody;
    const sessionId = body.sessionId || makeSessionId();
    const message = String(body.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const characters = await getCharacters();
    const character = resolveCharacter(characters, body.characterId);
    if (!character) {
      return res.status(500).json({ error: "no digital human configured" });
    }

    const existingSession = await loadSession(sessionId);
    const rawHistory = body.history?.length ? normalizeHistory(body.history) : (existingSession?.history ?? []);

    // 总结模式：只把「记忆档案 + 最近窗口」发给模型，避免短上下文模型超限
    const summaryMode = isSummaryModeEnabled(existingSession?.summaryMode);
    const history = summaryMode
      ? buildModelHistory({ history: rawHistory, summaryMode, memoryFile: existingSession?.memoryFile })
      : rawHistory;

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    req.on("close", () => {
      aborted = true;
    });

    writeSse(res, "meta", { sessionId, characterId: character.id });
    await appendToSession(sessionId, { role: "user", content: message });

    let assistantText = "";
    const onChunk = (chunk: StreamChunk) => {
      if (aborted) return;
      if (chunk.type === "token") {
        assistantText += chunk.text;
        writeSse(res, "chunk", { text: chunk.text });
      } else {
        writeSse(res, "emotion", { emotion: chunk.text });
      }
    };

    const requestedRelationshipMode = normalizeRelationshipMode(body.relationshipMode);
    const answer = await streamAssistant(
      history,
      character,
      message,
      existingSession?.context,
      onChunk,
      requestedRelationshipMode
    );
    if (aborted) {
      return;
    }

    const audioUrl = await synthesizeSpeech(answer.text, character);
    const nextContext = buildSessionContext(existingSession, message, answer.text, requestedRelationshipMode);
    const savedRecord = await appendToSession(sessionId, { role: "assistant", content: answer.text }, nextContext);

    // 总结模式：回合结束后按需重新生成记忆档案
    if (summaryMode) {
      await maybeSummarize(savedRecord, character);
    }
    writeSse(res, "done", {
      sessionId,
      characterId: character.id,
      text: answer.text,
      emotion: answer.emotion,
      context: nextContext,
      audioUrl,
      hasFallback: answer.text.trim().length === 0 || answer.text.trim() !== assistantText.trim()
    });
    wroteResponse = true;
    res.end();
  } catch (error) {
    console.error(error);
    if (!aborted) {
      writeSse(res, "error", { error: "chat stream failed" });
      wroteResponse = true;
      res.end();
    }
  } finally {
    if (!aborted && !wroteResponse && !res.writableEnded) {
      writeSse(res, "error", { error: "chat stream failed" });
      res.end();
    }
  }
});

app.get("/api/session/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId || "");
  const record = await loadSession(sessionId);
  if (!record) {
    return res.status(404).json({ error: "session not found" });
  }
  return res.json(record);
});

app.delete("/api/session/:sessionId", async (req, res) => {
  const sessionId = String(req.params.sessionId || "");
  await clearSession(sessionId);
  res.json({ ok: true });
});

// 导入（恢复）一份会话记忆：用于跨设备/跨服务器备份迁移
app.post("/api/session/:sessionId/import", async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "");
    const { history, context, summaryMode, memoryFile } = (req.body || {}) as {
      history?: unknown;
      context?: unknown;
      summaryMode?: boolean;
      memoryFile?: string;
    };
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: "history 字段必须是数组" });
    }
    const normalized = normalizeHistory(history as ChatMessage[]);
    const record = await importSession(
      sessionId,
      normalized,
      context as SessionContext | undefined,
      { summaryMode, memoryFile }
    );
    return res.json({ ok: true, sessionId: record.sessionId, turns: record.history.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导入记忆失败";
    return res.status(500).json({ error: message });
  }
});

// 开关总结模式：开启时立即基于历史生成记忆档案
app.post("/api/session/:sessionId/summary", async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "");
    const { enabled, characterId } = (req.body || {}) as { enabled?: boolean; characterId?: string };
    const flag = Boolean(enabled);
    await updateSessionMeta(sessionId, { summaryMode: flag });

    let memoryFile: string | undefined;
    if (flag) {
      const characters = await getCharacters();
      const character = resolveCharacter(characters, characterId) || characters[0];
      if (character) {
        memoryFile = await generateMemoryForSession(sessionId, character);
      }
    }
    const record = await loadSession(sessionId);
    return res.json({
      ok: true,
      summaryMode: record?.summaryMode ?? flag,
      memoryFile: record?.memoryFile,
      turns: record?.history.length ?? 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "设置总结模式失败";
    return res.status(500).json({ error: message });
  }
});

app.delete("/api/digital-humans/:id", async (req, res) => {
  const characterId = String(req.params.id || "").trim();
  if (!characterId) {
    return res.status(400).json({ error: "digital human id is required" });
  }

  const characters = await getCharacters();
  if (!characters.some((item) => item.id === characterId)) {
    return res.status(404).json({ error: "digital human not found" });
  }
  if (characters.length <= 1) {
    return res.status(400).json({ error: "至少保留一个数字人，不能全部删除" });
  }

  const deleted = await deleteCustomHumanById(characterId);
  if (deleted) {
    return res.json({ ok: true });
  }

  const overridesData = await loadHumanOverrides();
  if (!overridesData.hidden.includes(characterId)) {
    overridesData.hidden.push(characterId);
  }
  delete overridesData.overrides[characterId];
  await writeHumanOverrides(overridesData);
  res.json({ ok: true });
});

app.use("/audio", express.static(AUDIO_DIR));
app.use("/models", express.static(MODEL_DIR));
app.use("/avatars", express.static(AVATAR_DIR));
app.use("/assets", express.static(STATIC_ASSETS_DIR));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  const webUrl = WEB_APP_URL.endsWith("/") ? WEB_APP_URL : `${WEB_APP_URL}/`;
  const safeWebUrl = webUrl.replace(/"/g, "&quot;");
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>数字女友 - API 服务提示页</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        background: #151413;
        color: #f3f7ff;
      }
      .container {
        max-width: 720px;
        margin: 40px auto;
        padding: 24px;
        background: #171e31;
        border: 1px solid #2e4066;
        border-radius: 12px;
      }
      .hint {
        margin: 12px 0;
        font-size: 18px;
      }
      .primary {
        display: inline-block;
        margin-top: 8px;
        padding: 10px 16px;
        background: #2f5fdd;
        color: #fff;
        border-radius: 8px;
        text-decoration: none;
      }
      .muted {
        color: #b7c7e5;
      }
      a {
        color: #7bc0ff;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>你打开的是后端 API 端口</h1>
      <p class="hint">请访问前端入口 <strong>5173</strong> 继续使用聊天体验：</p>
      <a class="primary" href="${safeWebUrl}">请访问 5173</a>
      <p class="muted">如果你已设置其他前端端口，请配置环境变量 WEB_APP_URL。</p>
      <p><a href="${safeWebUrl}">${safeWebUrl}</a></p>
      <p>如需接口健康检查，请访问 <a href="/healthz">/healthz</a>。</p>
    </div>
  </body>
</html>`;
  res.type("html").status(200).send(html);
});

function makeSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function writeSse(res: Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function decodeBase64Payload(raw: unknown): Buffer {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("fileBase64 为必填项");
  }

  const normalized = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const buffer = Buffer.from(normalized, "base64");
  if (!buffer.length) {
    throw new Error("模型文件为空");
  }
  if (buffer.byteLength > MAX_MODEL_BYTES) {
    throw new Error("模型文件不能超过 25MB");
  }
  return buffer;
}

if (HOST) {
  app.listen(PORT, HOST, () => {
    console.log(`Digital girlfriend API running on ${HOST}:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Digital girlfriend API running on :${PORT}`);
  });
}

// Telegram 机器人：配置了 TELEGRAM_BOT_TOKEN 才启动，否则不影响网页端
const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (tgToken) {
  startTelegramBot(tgToken).catch((err) => {
    console.error("Telegram bot failed to start:", err);
  });
}
