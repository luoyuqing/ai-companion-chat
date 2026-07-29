import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./data";

/**
 * 系统级配置（与具体数字人无关）。
 * 设计目标：可扩展 —— 后续「设置页」新增的菜单/配置项都挂载到根级字段，
 * 后端统一从 system-config.json 读写，前端统一走 /api/settings。
 *
 * 密钥处理：落盘文件含 API Key，已加入 .gitignore（server/src/data/system-config.json）。
 * GET 接口对前端脱敏，只暴露 hasApiKey，绝不回传明文密钥。
 */

export interface LlmConfig {
  /** OpenAI 兼容的 Base URL，例如 https://xxx/v1 */
  baseUrl: string;
  apiKey: string;
  /** 当前选用的模型名 */
  model: string;
  /** 该模型是否支持图片识别（多模态）。当前对话未携带图片，仅作配置保留，后续开启图片输入时作为开关 */
  supportsVision: boolean;
}

export interface TtsConfig {
  /** 当前固定为小米 MiMo，不开放给用户切换 */
  provider: "mimo";
  /** 写死的小米地址，前端只读展示 */
  baseUrl: string;
  apiKey: string;
  /** 写死的小米 TTS 模型，前端只读展示 */
  model: string;
  /** 默认音色（来自 .env，按角色可覆盖） */
  voice: string;
}

export interface SystemConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  // 扩展位：后续新增的菜单/配置项统一挂载到根级字段，保持向后兼容
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: unknown;
}

export type PublicSystemConfig = Omit<SystemConfig, "llm" | "tts"> & {
  llm: LlmConfig & { hasApiKey: boolean };
  tts: TtsConfig & { hasApiKey: boolean };
};

const CONFIG_FILE = path.join(DATA_DIR, "system-config.json");

// TTS 写死为小米 MiMo，这些字段用户不可改
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const MIMO_TTS_MODEL = "mimo-v2.5-tts";
const MIMO_DEFAULT_VOICE = "冰糖";

function envString(value?: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildDefaults(): SystemConfig {
  return {
    llm: {
      baseUrl: envString(process.env.OPENAI_BASE_URL),
      apiKey: envString(process.env.OPENAI_API_KEY),
      model: envString(process.env.OPENAI_MODEL),
      supportsVision: false
    },
    tts: {
      provider: "mimo",
      baseUrl: MIMO_BASE_URL,
      apiKey: envString(process.env.MIMO_API_KEY),
      model: envString(process.env.MIMO_TTS_MODEL) || MIMO_TTS_MODEL,
      voice: envString(process.env.MIMO_TTS_VOICE) || MIMO_DEFAULT_VOICE
    }
  };
}

let cache: SystemConfig | null = null;

function deepMergeLlm(base: LlmConfig, override?: Partial<LlmConfig>): LlmConfig {
  if (!override) return base;
  return {
    baseUrl: typeof override.baseUrl === "string" ? override.baseUrl.trim() : base.baseUrl,
    // apiKey: 提供空字符串表示清除；字段缺失(undefined)表示保留现有值
    apiKey: override.apiKey !== undefined ? String(override.apiKey) : base.apiKey,
    model: typeof override.model === "string" ? override.model.trim() : base.model,
    supportsVision: typeof override.supportsVision === "boolean" ? override.supportsVision : base.supportsVision
  };
}

function deepMergeTts(base: TtsConfig, override?: Partial<TtsConfig>): TtsConfig {
  if (!override) return base;
  return {
    provider: "mimo",
    baseUrl: MIMO_BASE_URL,
    // 仅 apiKey 可用户配置，baseUrl/model/voice 写死
    apiKey: override.apiKey !== undefined ? String(override.apiKey) : base.apiKey,
    model: MIMO_TTS_MODEL,
    voice: base.voice
  };
}

function loadConfig(): SystemConfig {
  const defaults = buildDefaults();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<SystemConfig>;
      return {
        llm: deepMergeLlm(defaults.llm, raw.llm),
        tts: deepMergeTts(defaults.tts, raw.tts)
      };
    }
  } catch (err) {
    console.error("[config] 读取 system-config.json 失败，回退到默认值:", err);
  }
  return defaults;
}

export function getSystemConfig(): SystemConfig {
  if (!cache) cache = loadConfig();
  return cache;
}

export function getLlmConfig(): LlmConfig {
  return getSystemConfig().llm;
}

export function getTtsConfig(): TtsConfig {
  return getSystemConfig().tts;
}

export interface LlmConfigInput {
  baseUrl?: string;
  /** 提供空字符串表示清除；字段缺失表示保留 */
  apiKey?: string;
  model?: string;
  supportsVision?: boolean;
}

export interface TtsConfigInput {
  /** 提供空字符串表示清除；字段缺失表示保留 */
  apiKey?: string;
}

export interface SystemConfigInput {
  llm?: LlmConfigInput;
  tts?: TtsConfigInput;
}

export function saveSystemConfig(input: SystemConfigInput): SystemConfig {
  const current = getSystemConfig();
  const next: SystemConfig = {
    ...current,
    llm: deepMergeLlm(current.llm, input.llm),
    tts: deepMergeTts(current.tts, input.tts)
  };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (err) {
    console.error("[config] 写入 system-config.json 失败:", err);
  }
  return next;
}

/** 对外返回时脱敏密钥，仅暴露是否配置，绝不回传明文 apiKey */
export function publicSystemConfig(): PublicSystemConfig {
  const cfg = getSystemConfig();
  return {
    llm: {
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.model,
      supportsVision: cfg.llm.supportsVision,
      hasApiKey: Boolean(cfg.llm.apiKey)
    },
    tts: {
      provider: cfg.tts.provider,
      baseUrl: cfg.tts.baseUrl,
      model: cfg.tts.model,
      voice: cfg.tts.voice,
      hasApiKey: Boolean(cfg.tts.apiKey)
    }
  };
}
