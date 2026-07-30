import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
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
  ProactiveConfig,
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
import { startProactiveScheduler } from "./telegram/proactive";
import { getUserMemory, saveUserMemory, deleteUserMemory } from "./services/userMemory";
import { publicSystemConfig, saveSystemConfig, getLlmConfig, resetPrompts, type SystemConfigInput } from "./core/config";
import { getPromptConfig } from "./core/prompts";
import { requireSettingsAuth, settingsAuthChangePassword, settingsAuthLogin, settingsAuthLogout } from "./core/settings-auth";

// 规范化主动推送配置：限制最多 3 个时间点，模式只能是 always/smart。
function normalizeProactive(input: unknown): ProactiveConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const p = input as Record<string, unknown>;
  const timePoints = Array.isArray(p.timePoints)
    ? (p.timePoints as unknown[]).filter((t) => typeof t === "string").slice(0, 3).map(String)
    : [];
  return {
    enabled: Boolean(p.enabled),
    timePoints,
    mode: p.mode === "smart" ? "smart" : "always"
  };
}

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST;
const WEB_APP_URL = process.env.WEB_APP_URL?.trim() || "http://127.0.0.1:5173";

app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.get("/api/digital-humans", async (_req, res) => {
  const humans = await getCharacters();
  // 剥离敏感凭证：telegramBotToken 绝不返回给前端，避免泄露
  const safe = humans.map(({ telegramBotToken, ...rest }) => rest);
  res.json({ humans: safe });
});

// ---------- 系统设置二次密码验证 ----------
// 登录接口本身免鉴权（声明在中间件之前）；其余 /api/settings* 一律需要 x-settings-token
app.post("/api/settings/auth", settingsAuthLogin);
app.use("/api/settings", requireSettingsAuth);
app.post("/api/settings/auth/logout", settingsAuthLogout);
app.post("/api/settings/auth/password", settingsAuthChangePassword);

// ---------- 系统设置（可扩展：后续菜单/配置项统一挂载到 GET /api/settings） ----------
app.get("/api/settings", (_req, res) => {
  const base = publicSystemConfig();
  res.json({ ...base, prompts: getPromptConfig() });
});

app.put("/api/settings", (req, res) => {
  const body = (req.body || {}) as SystemConfigInput;
  try {
    saveSystemConfig({ llm: body.llm, tts: body.tts, prompts: body.prompts });
    res.json({ ...publicSystemConfig(), prompts: getPromptConfig() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "保存设置失败" });
  }
});

app.post("/api/settings/prompts/reset", (_req, res) => {
  try {
    resetPrompts();
    res.json({ ...publicSystemConfig(), prompts: getPromptConfig() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "重置提示词失败" });
  }
});

app.post("/api/settings/llm/models", async (req, res) => {
  const cfg = getLlmConfig();
  const baseUrl = String((req.body as { baseUrl?: string })?.baseUrl || "").trim() || cfg.baseUrl;
  const apiKey = String((req.body as { apiKey?: string })?.apiKey || "").trim() || cfg.apiKey;
  if (!baseUrl || !apiKey) {
    return res.status(400).json({ error: "baseUrl 与 apiKey 必填（可在表单填写，或使用已保存的配置）" });
  }
  try {
    const url = String(baseUrl).replace(/\/+$/, "") + "/models";
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` }
    });
    if (!resp.ok) {
      const message = await resp.text().catch(() => "");
      return res.status(resp.status).json({ error: `拉取模型清单失败：${message.slice(0, 300)}` });
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data || [])
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean);
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "拉取模型清单失败" });
  }
});


// 重启后端服务（如修改数字人 Telegram 专属 bot token 后需重启才能生效）。
// 先向客户端回包，再以 detached 方式延迟执行重启，避免进程被杀前响应未送达、
// 以及重启命令随进程退出而中断。服务名可经 env DG_SERVICE_NAME 覆盖。
const DG_SERVICE_NAME = process.env.DG_SERVICE_NAME || "digital-girlfriend";
app.post("/api/settings/restart-service", (_req, res) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(DG_SERVICE_NAME)) {
    return res.status(500).json({ error: "服务名配置非法" });
  }
  res.json({ ok: true, message: `已下发重启指令，服务「${DG_SERVICE_NAME}」将在数秒后重启` });
  setTimeout(() => {
    try {
      spawn("sudo", ["systemctl", "restart", DG_SERVICE_NAME], { detached: true, stdio: "ignore" }).unref();
    } catch (err) {
      console.error("重启服务失败:", err);
    }
  }, 800);
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
      audioModel,
      voiceId,
      stylePrompt,
      voiceDesignPrompt,
      voiceCloneSample,
      defaultMood,
      emotionProfile,
      avatarType,
      avatarVideoProfile,
      personalityTagline,
      relationshipMode,
      telegramBotToken,
      chatTaboos,
      proactive
    } = req.body as {
      name?: string;
      description?: string;
      avatarUrl?: string;
      modelUrl?: string;
      voice?: string;
      voiceProvider?: "openai" | "azure" | "local" | "mimo";
      audioModel?: DigitalHumanConfig["voiceProfile"]["audioModel"];
      voiceId?: string;
      stylePrompt?: string;
      voiceDesignPrompt?: string;
      voiceCloneSample?: string;
      defaultMood?: DigitalHumanConfig["defaultMood"];
      emotionProfile?: EmotionProfile;
      avatarType?: AvatarRenderMode | string;
      avatarVideoProfile?: EmotionProfile;
      personalityTagline?: string;
      relationshipMode?: DigitalHumanConfig["relationshipMode"];
      telegramBotToken?: string;
    };

    if (!name || !description || !avatarUrl || !voice) {
      return res.status(400).json({ error: "name、description、avatarUrl、voice 都不能为空" });
    }

    const provider = (voiceProvider === "azure" || voiceProvider === "local" || voiceProvider === "mimo" ? voiceProvider : "openai") as DigitalHumanConfig["voiceProfile"]["provider"];

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
      voiceProfile: {
        provider,
        voice,
        audioModel: audioModel || (provider === "mimo" ? "mimo-v2.5-tts" : undefined),
        voiceId: voiceId?.trim() || undefined,
        stylePrompt: stylePrompt?.trim() || undefined,
        voiceDesignPrompt: voiceDesignPrompt?.trim() || undefined,
        voiceCloneSample: voiceCloneSample?.trim() || undefined
      },
      relationshipMode: ensureRelationshipMode(relationshipMode),
      defaultMood: ensureSupportedMood(defaultMood),
      telegramBotToken: telegramBotToken?.trim() || undefined,
      chatTaboos: chatTaboos?.trim() || undefined,
      proactive: normalizeProactive(proactive)
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
    // telegramBotToken：提供非空串则更新专属 bot；提供空串则清除（关闭专属 bot）
    if (typeof body.telegramBotToken === "string") {
      const t = body.telegramBotToken.trim();
      patch.telegramBotToken = t ? t : undefined;
    }
    if (typeof body.chatTaboos === "string") {
      patch.chatTaboos = body.chatTaboos.trim() || undefined;
    }
    if (body.proactive && typeof body.proactive === "object") {
      patch.proactive = normalizeProactive(body.proactive);
    }
    if (body.avatarType !== undefined) patch.avatarType = normalizeAvatarType(body.avatarType);

    const voice = typeof body.voice === "string" ? body.voice.trim() : "";
    const voiceProvider = body.voiceProvider;
    const audioModel = typeof body.audioModel === "string" ? body.audioModel.trim() : undefined;
    const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : undefined;
    const stylePrompt = typeof body.stylePrompt === "string" ? body.stylePrompt : undefined;
    const voiceDesignPrompt = typeof body.voiceDesignPrompt === "string" ? body.voiceDesignPrompt : undefined;
    const voiceCloneSample = typeof body.voiceCloneSample === "string" ? body.voiceCloneSample : undefined;
    const characters = await getCharacters();
    const current = characters.find((item) => item.id === characterId);
    if (voice || voiceProvider !== undefined || audioModel !== undefined || voiceId !== undefined || stylePrompt !== undefined || voiceDesignPrompt !== undefined || voiceCloneSample !== undefined) {
      const provider =
        voiceProvider === "azure" || voiceProvider === "local" || voiceProvider === "mimo" || voiceProvider === "openai"
          ? voiceProvider
          : current?.voiceProfile.provider || "mimo";
      const base = current?.voiceProfile || { provider, voice: "mimo_default" };
      patch.voiceProfile = {
        provider,
        voice: voice || base.voice || "mimo_default",
        audioModel: (audioModel || base.audioModel || (provider === "mimo" ? "mimo-v2.5-tts" : undefined)) as DigitalHumanConfig["voiceProfile"]["audioModel"],
        voiceId: voiceId !== undefined ? voiceId : base.voiceId,
        stylePrompt: stylePrompt !== undefined ? stylePrompt : base.stylePrompt,
        voiceDesignPrompt: voiceDesignPrompt !== undefined ? voiceDesignPrompt : base.voiceDesignPrompt,
        voiceCloneSample: voiceCloneSample !== undefined ? voiceCloneSample : base.voiceCloneSample
      };
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

// 长期记忆（用户与某数字人的关系/记忆资料）——后端唯一真源，跨浏览器/TG 一致。
app.get("/api/user-memory/:characterId", async (req, res) => {
  const characterId = String(req.params.characterId || "").trim();
  if (!characterId) return res.status(400).json({ error: "characterId required" });
  const memory = await getUserMemory(characterId);
  res.json({ memory });
});

app.put("/api/user-memory/:characterId", async (req, res) => {
  try {
    const characterId = String(req.params.characterId || "").trim();
    if (!characterId) return res.status(400).json({ error: "characterId required" });
    const payload = (req.body && (req.body as Record<string, unknown>).memory) || req.body || {};
    const saved = await saveUserMemory(characterId, payload as never);
    res.json({ memory: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "save user memory failed" });
  }
});

// 清除某数字人的长期记忆文件（后端唯一真源）。聊天会话的 AI 记忆档案随会话文件一并清除。
app.delete("/api/user-memory/:characterId", async (req, res) => {
  try {
    const characterId = String(req.params.characterId || "").trim();
    if (!characterId) return res.status(400).json({ error: "characterId required" });
    await deleteUserMemory(characterId);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "delete user memory failed" });
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

app.post("/api/tts", async (req, res) => {
  try {
    const { text, characterId } = (req.body ?? {}) as { text?: string; characterId?: string };
    const trimmed = (text || "").trim();
    if (!trimmed) {
      return res.status(400).json({ error: "text is required" });
    }
    const characters = await getCharacters();
    const character = resolveCharacter(characters, characterId);
    if (!character) {
      return res.status(404).json({ error: "character not found" });
    }
    const audioUrl = await synthesizeSpeech(trimmed, character);
    res.json({ audioUrl });
  } catch (error) {
    console.error("tts synthesize failed", error);
    res.status(500).json({ error: "tts failed" });
  }
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
    <title>AI伴聊 - API 服务提示页</title>
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

// Telegram 机器人：单进程多实例。
// 1) 若配置了 TELEGRAM_BOT_TOKEN，启动一个「通用入口」bot（支持 /select 切换角色）；
// 2) 遍历所有配置了 telegramBotToken 的数字人，各启动一个独立专属 bot（一角色一机器人），
//    角色间记忆按 characterId 隔离，互不影响。
const tgToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
function launchTelegramBots(): void {
  if (tgToken) {
    startTelegramBot(tgToken).catch((err) => {
      console.error("通用入口 Telegram bot 启动失败:", err);
    });
  }
  getCharacters()
    .then((characters) => {
      let launched = 0;
      for (const c of characters) {
        if (c.telegramBotToken && c.telegramBotToken.trim()) {
          startTelegramBot(c.telegramBotToken.trim(), c.id).catch((err) => {
            console.error(`数字人「${c.name}」专属 bot 启动失败:`, err);
          });
          launched++;
        }
      }
      if (launched > 0) console.log(`已启动 ${launched} 个专属数字人 bot`);
    })
    .catch((err) => console.error("加载数字人失败，无法启动专属 bot:", err));
}
launchTelegramBots();
startProactiveScheduler();
