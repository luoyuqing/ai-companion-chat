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

export interface RunningHubConfig {
  /** RunningHub 生图接口 Bearer Key（设置页可配置，亦可走 RUNNINGHUB_API_KEY 环境变量） */
  apiKey: string;
  /** 生图触发词（只要消息包含其中任一子串即触发生图）。至少需保留一个。 */
  triggerWords: string[];
  /** 生图超时时间（秒，范围 10–600）。超时后数字人不再等待照片，直接按聊天上下文回复一条消息。 */
  timeoutSec: number;
}

/**
 * 渠道总开关（与角色级开关取「AND」——两者都为真该渠道才实际运行）。
 * 设计目的：既能一键全关某渠道，也能按角色灰度，两个诉求共存。
 */
export interface ChannelsConfig {
  /**
   * Telegram 渠道总开关。默认 **false**（2026-09 迁移 Matrix 后默认关闭）。
   * 关闭时 grammy 不启动任何 polling、主动推送的 TG 路由短路；代码全保留，改回 true + 重启即完整恢复。
   * 可用环境变量 TELEGRAM_ENABLED 覆盖默认值。
   */
  telegramEnabled: boolean;
  /** Matrix 渠道总开关。默认 true。可用环境变量 MATRIX_ENABLED 覆盖默认值。 */
  matrixEnabled: boolean;
  /** Matrix 默认 homeserver（角色未单独填写 matrixHomeserver 时使用）。 */
  matrixHomeserverDefault: string;
}

/** 脚本/环境变量解析布尔值："1"/"true"/"yes"/"on" 为真（大小写不敏感），其余为假 */
function envBool(value: string | undefined, fallback: boolean): boolean {
  const v = envString(value).toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

export interface SystemConfig {
  llm: LlmConfig;
  tts: TtsConfig;
  runningHub: RunningHubConfig;
  channels: ChannelsConfig;
  // 扩展位：后续新增的菜单/配置项统一挂载到根级字段，保持向后兼容
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: unknown;
}

export type PublicSystemConfig = Omit<SystemConfig, "llm" | "tts" | "runningHub"> & {
  llm: LlmConfig & { hasApiKey: boolean };
  tts: TtsConfig & { hasApiKey: boolean };
  runningHub: { hasApiKey: boolean; triggerWords: string[]; timeoutSec: number };
};

const CONFIG_FILE = path.join(DATA_DIR, "system-config.json");

// TTS 写死为小米 MiMo，这些字段用户不可改
const MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const MIMO_TTS_MODEL = "mimo-v2.5-tts";
const MIMO_DEFAULT_VOICE = "冰糖";

/** Matrix 默认 homeserver（自建 tuwunel，X2 盒子经 CF 隧道对外） */
const DEFAULT_MATRIX_HOMESERVER = "https://matrix.3585616.xyz";

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
    },
    runningHub: {
      apiKey: envString(process.env.RUNNINGHUB_API_KEY),
      triggerWords: ["拍张照"],
      timeoutSec: 120
    },
    channels: {
      // 迁移 Matrix 后 TG 默认关闭；需要回退时改这里（或设 TELEGRAM_ENABLED=true）
      telegramEnabled: envBool(process.env.TELEGRAM_ENABLED, false),
      matrixEnabled: envBool(process.env.MATRIX_ENABLED, true),
      matrixHomeserverDefault: envString(process.env.MATRIX_HOMESERVER) || DEFAULT_MATRIX_HOMESERVER
    }
  };
}

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

function deepMergeRunningHub(base: RunningHubConfig, override?: Partial<RunningHubConfig>): RunningHubConfig {
  if (!override) return base;
  // 触发词：仅当传入非空数组时才覆盖；空数组/缺失则保留现有值（保证至少留一个）
  const triggerWords =
    Array.isArray(override.triggerWords) && override.triggerWords.length > 0
      ? override.triggerWords.map((w) => String(w).trim()).filter(Boolean)
      : base.triggerWords;
  // 超时：仅当传入正数（number 或能解析为正数的 string）时才覆盖
  let timeoutSec = base.timeoutSec;
  if (typeof override.timeoutSec === "number" && override.timeoutSec > 0) {
    timeoutSec = override.timeoutSec;
  } else if (typeof override.timeoutSec === "string" && Number(override.timeoutSec) > 0) {
    timeoutSec = Number(override.timeoutSec);
  }
  return {
    apiKey: override.apiKey !== undefined ? String(override.apiKey) : base.apiKey,
    triggerWords,
    timeoutSec
  };
}

function deepMergeChannels(base: ChannelsConfig, override?: Partial<ChannelsConfig>): ChannelsConfig {
  if (!override) return base;
  return {
    // 布尔开关：仅当显式传入布尔值才覆盖，缺省保留 base（避免 undefined 把 TG 静默关掉）
    telegramEnabled:
      typeof override.telegramEnabled === "boolean" ? override.telegramEnabled : base.telegramEnabled,
    matrixEnabled: typeof override.matrixEnabled === "boolean" ? override.matrixEnabled : base.matrixEnabled,
    matrixHomeserverDefault:
      typeof override.matrixHomeserverDefault === "string" && override.matrixHomeserverDefault.trim()
        ? override.matrixHomeserverDefault.trim().replace(/\/+$/, "")
        : base.matrixHomeserverDefault
  };
}

function loadConfig(): SystemConfig {
  const defaults = buildDefaults();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<SystemConfig> & { prompts?: unknown };
      return {
        ...defaults,
        llm: deepMergeLlm(defaults.llm, raw.llm),
        tts: deepMergeTts(defaults.tts, raw.tts),
        runningHub: deepMergeRunningHub(defaults.runningHub, raw.runningHub),
        channels: deepMergeChannels(defaults.channels, raw.channels),
        prompts: raw.prompts
      };
    }
  } catch (err) {
    console.error("[config] 读取 system-config.json 失败，回退到默认值:", err);
  }
  return defaults;
}

export function getSystemConfig(): SystemConfig {
  return loadConfig();
}

export function getLlmConfig(): LlmConfig {
  return getSystemConfig().llm;
}

export function getTtsConfig(): TtsConfig {
  return getSystemConfig().tts;
}

export function getRunningHubConfig(): RunningHubConfig {
  return getSystemConfig().runningHub;
}

export function getChannelsConfig(): ChannelsConfig {
  return getSystemConfig().channels;
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

export interface ChannelsConfigInput {
  telegramEnabled?: boolean;
  matrixEnabled?: boolean;
  matrixHomeserverDefault?: string;
}

export interface SystemConfigInput {
  llm?: LlmConfigInput;
  tts?: TtsConfigInput;
  runningHub?: { apiKey?: string; triggerWords?: string[]; timeoutSec?: number };
  channels?: ChannelsConfigInput;
  /** 用户覆盖的提示词（来自网页端「提示词」设置）。传 undefined 表示保留现有值；传 {} 表示清除覆盖、恢复默认 */
  prompts?: unknown;
}

export function saveSystemConfig(input: SystemConfigInput): SystemConfig {
  const current = getSystemConfig();
  const next: SystemConfig = {
    ...current,
    llm: deepMergeLlm(current.llm, input.llm),
    tts: deepMergeTts(current.tts, input.tts),
    runningHub: deepMergeRunningHub(current.runningHub, input.runningHub),
    channels: deepMergeChannels(current.channels, input.channels)
  };
  // prompts 覆盖：传 undefined 保留现有；传 {} 或具体值则覆盖（含空对象即视为清除自定义）
  if (input.prompts !== undefined) {
    (next as { prompts?: unknown }).prompts = input.prompts;
  }
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

/** 清空用户覆盖的提示词，恢复 PROMPT_DEFAULTS（由 getPromptConfig 在未覆盖时回退） */
export function resetPrompts(): SystemConfig {
  const current = getSystemConfig();
  const next: SystemConfig = { ...current };
  delete (next as { prompts?: unknown }).prompts;
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
    },
    runningHub: {
      hasApiKey: Boolean(cfg.runningHub.apiKey),
      triggerWords: cfg.runningHub.triggerWords,
      timeoutSec: cfg.runningHub.timeoutSec
    },
    // 渠道开关无敏感信息，直接透传（页面据此渲染全局总开关）
    channels: {
      telegramEnabled: cfg.channels.telegramEnabled,
      matrixEnabled: cfg.channels.matrixEnabled,
      matrixHomeserverDefault: cfg.channels.matrixHomeserverDefault
    }
  };
}
