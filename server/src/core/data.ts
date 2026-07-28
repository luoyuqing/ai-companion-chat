import fs from "node:fs/promises";
import path from "node:path";

import {
  AvatarRenderMode,
  ChatMessage,
  DigitalHumanConfig,
  EmotionProfile,
  RelationshipMode
} from "../types";

// 工作区根目录：在 server 目录内运行 tsx 时，cwd 为 server，需回退到仓库根
export const WORKSPACE_ROOT =
  path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();

export const DATA_DIR = path.join(WORKSPACE_ROOT, "server", "src", "data");
export const CUSTOM_FILE = path.join(DATA_DIR, "custom-humans.json");
export const OVERRIDE_FILE = path.join(DATA_DIR, "human-overrides.json");
export const AUDIO_DIR = path.join(WORKSPACE_ROOT, "server", "data", "audio");
export const MODEL_DIR = path.join(WORKSPACE_ROOT, "server", "data", "models");
export const AVATAR_DIR = path.join(WORKSPACE_ROOT, "server", "data", "avatars");
export const STATIC_ASSETS_DIR = path.join(WORKSPACE_ROOT, "web", "public", "assets");
export const MAX_MODEL_BYTES = 25 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 8 * 1024 * 1024;

export type HumanOverrides = {
  overrides: Record<string, Partial<DigitalHumanConfig>>;
  hidden: string[];
};

export async function loadHumanOverrides(): Promise<HumanOverrides> {
  try {
    const raw = await fs.readFile(OVERRIDE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<HumanOverrides>;
    return {
      overrides: parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {},
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.map(String) : []
    };
  } catch {
    return { overrides: {}, hidden: [] };
  }
}

export async function writeHumanOverrides(data: HumanOverrides): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OVERRIDE_FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function getCharacters(): Promise<DigitalHumanConfig[]> {
  const base = await fs.readFile(path.join(DATA_DIR, "digital-humans.json"), "utf8");
  const baseCharacters = JSON.parse(base) as DigitalHumanConfig[];
  const custom = await loadCustomHumans();
  const { overrides, hidden } = await loadHumanOverrides();
  const normalize = (item: DigitalHumanConfig): DigitalHumanConfig => ({
    ...item,
    avatarType: normalizeAvatarType(item.avatarType),
    emotionProfile: item.emotionProfile,
    avatarVideoProfile: item.avatarVideoProfile
  });
  const mergedBase = baseCharacters
    .filter((item) => !hidden.includes(item.id))
    .map((item) => (overrides[item.id] ? { ...item, ...overrides[item.id], id: item.id } : item));
  return [...mergedBase.map(normalize), ...custom.map(normalize)];
}

export async function loadCustomHumans(): Promise<DigitalHumanConfig[]> {
  try {
    const raw = await fs.readFile(CUSTOM_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DigitalHumanConfig[]) : [];
  } catch {
    return [];
  }
}

export async function writeCustomHumans(humans: DigitalHumanConfig[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CUSTOM_FILE, JSON.stringify(humans, null, 2), "utf8");
}

export async function deleteCustomHumanById(characterId: string): Promise<boolean> {
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

export async function deleteModelFileByName(fileName: string): Promise<boolean> {
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

export function normalizeHistory(history?: ChatMessage[]): ChatMessage[] {
  return (history || [])
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({
      role: m.role,
      content: String(m.content || "").slice(0, 1200)
    }))
    .filter((m) => m.content.trim().length > 0);
}

export function ensureSupportedMood(mood: string | undefined): DigitalHumanConfig["defaultMood"] {
  if (mood === "happy" || mood === "sad" || mood === "surprise" || mood === "wink" || mood === "neutral" || mood === "angry" || mood === "love") {
    return mood;
  }
  return "neutral";
}

export function ensureRelationshipMode(mode: unknown): DigitalHumanConfig["relationshipMode"] {
  if (mode === "flirty" || mode === "playful" || mode === "mature" || mode === "sweet") {
    return mode;
  }
  return "sweet";
}

export function normalizeRelationshipMode(mode: unknown): RelationshipMode | undefined {
  if (mode === "flirty" || mode === "playful" || mode === "mature" || mode === "sweet") {
    return mode;
  }
  return undefined;
}

export function normalizeExpressionProfile(raw: unknown): EmotionProfile | undefined {
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

export function normalizeAvatarType(raw: unknown): AvatarRenderMode {
  return raw === "video" ? "video" : "image";
}

export function sanitizeModelFileName(rawName: unknown): string {
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

export const AVATAR_EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg"
};

export function sanitizeAvatarFileName(rawName: unknown, mimeType: unknown): string {
  const baseName = path.basename(String(rawName || "avatar.png")).trim() || "avatar.png";
  let ext = path.extname(baseName).toLowerCase();
  const allowed = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"];
  if (!allowed.includes(ext)) {
    const mimeExt = AVATAR_EXT_BY_MIME[String(mimeType || "").toLowerCase().trim()];
    if (!mimeExt) {
      throw new Error("仅支持 png/jpg/webp/gif/svg 图片文件");
    }
    ext = mimeExt;
  }
  if (ext === ".jpeg") ext = ".jpg";

  const stem = baseName
    .slice(0, baseName.length - path.extname(baseName).length)
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "avatar";
  return `${stem}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}${ext}`;
}

export function decodeBase64Payload(raw: unknown): Buffer {
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

export function resolveCharacter(characters: DigitalHumanConfig[], selectedId?: string): DigitalHumanConfig | null {
  if (selectedId) {
    return characters.find((c) => c.id === selectedId) ?? null;
  }
  return characters[0] ?? null;
}

/**
 * 将 /audio/xxx.mp3 这种 URL 还原为本地磁盘路径，供 Telegraph/本地文件发送使用。
 */
export function audioUrlToPath(audioUrl?: string): string | undefined {
  if (!audioUrl) return undefined;
  const base = path.basename(audioUrl);
  if (!base || base === audioUrl) return undefined;
  return path.join(AUDIO_DIR, base);
}

/**
 * 通用数字人字段补丁：自定义数字人直接改 custom-humans.json，
 * 内置数字人写入 human-overrides.json。返回合并后的完整配置。
 * 同时被 HTTP PATCH 接口与 Telegram bot 复用，避免逻辑重复。
 */
export async function applyCharacterPatch(
  characterId: string,
  patch: Partial<DigitalHumanConfig>
): Promise<DigitalHumanConfig> {
  const safeId = String(characterId || "").trim();
  if (!safeId) {
    throw new Error("digital human id is required");
  }

  const customs = await loadCustomHumans();
  const customIdx = customs.findIndex((item) => item.id === safeId);
  if (customIdx >= 0) {
    customs[customIdx] = { ...customs[customIdx], ...patch, id: safeId } as DigitalHumanConfig;
    await writeCustomHumans(customs);
    return customs[customIdx];
  }

  const base = await fs.readFile(path.join(DATA_DIR, "digital-humans.json"), "utf8");
  const baseCharacters = JSON.parse(base) as DigitalHumanConfig[];
  const baseHuman = baseCharacters.find((item) => item.id === safeId);
  if (!baseHuman) {
    throw new Error("digital human not found");
  }

  const overridesData = await loadHumanOverrides();
  overridesData.overrides[safeId] = { ...(overridesData.overrides[safeId] || {}), ...patch };
  delete (overridesData.overrides[safeId] as Record<string, unknown>).id;
  await writeHumanOverrides(overridesData);
  return { ...baseHuman, ...overridesData.overrides[safeId], id: safeId } as DigitalHumanConfig;
}
