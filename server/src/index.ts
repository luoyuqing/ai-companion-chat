import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import express, { Response } from "express";
import cors from "cors";

import { askAssistant, streamAssistant, StreamChunk } from "./services/llm";
import { synthesizeSpeech } from "./services/tts";
import { transcribeSpeechAudio } from "./services/transcription";
import { inferEmotion } from "./services/emotion";
import { appendToSession, buildSessionContext, clearSession, loadSession, makeSessionId } from "./services/session";
import {
  AvatarRenderMode,
  ChatRequestBody,
  ChatMessage,
  ChatResponse,
  RelationshipMode,
  DigitalHumanConfig,
  EmotionProfile
} from "./types";

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST;
const WORKSPACE_ROOT = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();

app.use(cors());
app.use(express.json({ limit: "30mb" }));

const DATA_DIR = path.join(WORKSPACE_ROOT, "server", "src", "data");
const CUSTOM_FILE = path.join(DATA_DIR, "custom-humans.json");
const AUDIO_DIR = path.join(WORKSPACE_ROOT, "server", "data", "audio");
const MODEL_DIR = path.join(WORKSPACE_ROOT, "server", "data", "models");
const STATIC_ASSETS_DIR = path.join(WORKSPACE_ROOT, "web", "public", "assets");
const WEB_APP_URL = process.env.WEB_APP_URL?.trim() || "http://127.0.0.1:5173";
const MAX_MODEL_BYTES = 25 * 1024 * 1024;

async function getCharacters(): Promise<DigitalHumanConfig[]> {
  const base = await fs.readFile(path.join(DATA_DIR, "digital-humans.json"), "utf8");
  const baseCharacters = JSON.parse(base) as DigitalHumanConfig[];
  const custom = await loadCustomHumans();
  const normalize = (item: DigitalHumanConfig): DigitalHumanConfig => ({
    ...item,
    avatarType: normalizeAvatarType(item.avatarType),
    emotionProfile: item.emotionProfile,
    avatarVideoProfile: item.avatarVideoProfile
  });
  return [...baseCharacters.map(normalize), ...custom.map(normalize)];
}

async function loadCustomHumans(): Promise<DigitalHumanConfig[]> {
  try {
    const raw = await fs.readFile(CUSTOM_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DigitalHumanConfig[]) : [];
  } catch {
    return [];
  }
}

async function writeCustomHumans(humans: DigitalHumanConfig[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CUSTOM_FILE, JSON.stringify(humans, null, 2), "utf8");
}

async function deleteCustomHumanById(characterId: string): Promise<boolean> {
  const safeId = String(characterId || "").trim();
  if (!safeId) {
    return false;
  }

  const customs = await loadCustomHumans();
  const next = customs.filter((item) => item.id !== safeId);
  if (next.length === customs.length) {
    return false;
  }

  await writeCustomHumans(next);
  return true;
}

async function deleteModelFileByName(fileName: string): Promise<boolean> {
  const safeName = path.basename(String(fileName || "").trim());
  if (!safeName || safeName === "." || safeName === "..") {
    return false;
  }

  try {
    await fs.unlink(path.join(MODEL_DIR, safeName));
    return true;
  } catch {
    return false;
  }
}

function normalizeHistory(history?: ChatMessage[]): ChatMessage[] {
  return (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 1200)
    }))
    .filter((m) => m.content.trim().length > 0);
}

function ensureSupportedMood(mood: string | undefined): DigitalHumanConfig["defaultMood"] {
  if (mood === "happy" || mood === "sad" || mood === "surprise" || mood === "wink" || mood === "neutral" || mood === "angry" || mood === "love") {
    return mood;
  }
  return "neutral";
}

function ensureRelationshipMode(mode: unknown): DigitalHumanConfig["relationshipMode"] {
  if (mode === "flirty" || mode === "playful" || mode === "mature" || mode === "sweet") {
    return mode;
  }
  return "sweet";
}

function normalizeRelationshipMode(mode: unknown): RelationshipMode | undefined {
  if (mode === "flirty" || mode === "playful" || mode === "mature" || mode === "sweet") {
    return mode;
  }
  return undefined;
}

function normalizeExpressionProfile(raw: unknown): EmotionProfile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const normalized: EmotionProfile = {};
  (["happy", "sad", "surprise", "wink", "neutral", "angry", "love"] as const).forEach((emotion) => {
    const maybeUrl = String((raw as Record<string, unknown>)[emotion] || "").trim();
    if (maybeUrl) {
      normalized[emotion] = maybeUrl;
    }
  });

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAvatarType(raw: unknown): AvatarRenderMode {
  return raw === "video" ? "video" : "image";
}

function sanitizeModelFileName(rawName: unknown): string {
  const baseName = path.basename(String(rawName || "model.glb")).trim() || "model.glb";
  const ext = path.extname(baseName).toLowerCase();
  if (ext !== ".glb" && ext !== ".gltf") {
    throw new Error("仅支持 .glb 或 .gltf 模型文件");
  }

  const stem = baseName
    .slice(0, -ext.length)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "model";
  return `${stem}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}${ext}`;
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

function resolveCharacter(characters: DigitalHumanConfig[], selectedId?: string): DigitalHumanConfig | null {
  if (selectedId) {
    return characters.find((c) => c.id === selectedId) ?? null;
  }
  return characters[0] ?? null;
}

function writeSse(res: Response, event: string, payload: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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
      voiceProvider?: "openai" | "azure" | "local";
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
      voiceProfile: { provider: (voiceProvider === "azure" || voiceProvider === "local" ? voiceProvider : "openai"), voice },
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

app.post("/api/chat", async (req, res) => {
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
    const history = body.history?.length ? normalizeHistory(body.history) : (existingSession?.history ?? []);
    const emotionFromUser = inferEmotion(message);
    const context = existingSession?.context;
    const requestedRelationshipMode = normalizeRelationshipMode(body.relationshipMode);
    const answer = await askAssistant(history, character, message, context, requestedRelationshipMode);
    const mergedEmotion = answer.emotion || emotionFromUser;
    const audioUrl = await synthesizeSpeech(answer.text, character);
    const nextContext = buildSessionContext(existingSession, message, answer.text, requestedRelationshipMode);

    await appendToSession(sessionId, { role: "user", content: message }, nextContext);
    await appendToSession(sessionId, { role: "assistant", content: answer.text }, nextContext);

    const payload: ChatResponse = {
      sessionId,
      characterId: character.id,
      text: answer.text,
      emotion: mergedEmotion,
      audioUrl,
      context: nextContext
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
    const history = body.history?.length ? normalizeHistory(body.history) : (existingSession?.history ?? []);

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
    await appendToSession(sessionId, { role: "assistant", content: answer.text }, nextContext);
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

app.delete("/api/digital-humans/:id", async (req, res) => {
  const characterId = String(req.params.id || "").trim();
  if (!characterId) {
    return res.status(400).json({ error: "digital human id is required" });
  }

  const deleted = await deleteCustomHumanById(characterId);
  if (!deleted) {
    return res.status(404).json({ error: "digital human not found or is built-in" });
  }

  res.json({ ok: true });
});

app.use("/audio", express.static(AUDIO_DIR));
app.use("/models", express.static(MODEL_DIR));
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

if (HOST) {
  app.listen(PORT, HOST, () => {
    console.log(`Digital girlfriend API running on ${HOST}:${PORT}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`Digital girlfriend API running on :${PORT}`);
  });
}
