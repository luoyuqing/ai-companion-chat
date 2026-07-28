import { FormEvent, useEffect, useRef, useState } from "react";
import {
  Box,
  Brain,
  Coffee,
  Download,
  Hand,
  Heart,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  MicOff,
  Moon,
  Pencil,
  Save,
  Send,
  Settings2,
  Shield,
  Smile,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX
} from "lucide-react";
import {
  ChatContext,
  ChatMessageRequest,
  CreateHumanRequest,
  DigitalHuman,
  Emotion,
  EmotionProfile,
  Message,
  StreamDoneResponse,
  clearSessionHistory,
  createDigitalHuman,
  isLocalCompanionMode,
  resolveMediaUrl,
  sendMessage,
  sendMessageStream,
  transcribeSpeech,
  updateDigitalHuman,
  uploadAvatarFile,
  uploadModelFile
} from "../services/api";
import { Avatar } from "./Avatar";

const PUBLIC_ASSET_BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const defaultAvatarUrl = `${PUBLIC_ASSET_BASE}assets/avatars/lina-original.jpg`;
const assetPlaceholderBase = `${PUBLIC_ASSET_BASE}assets`;
const AVATAR_MODE_STORAGE_KEY = "dg-avatar-render-mode";
const CHAT_STATE_STORAGE_PREFIX = "dg-chat-state-v1";
const LOCAL_HUMANS_STORAGE_KEY = "dg-local-digital-humans-v1";
const LOCAL_CONTEXT_STORAGE_KEY = "dg-local-chat-context-v1";
const USER_MEMORY_STORAGE_KEY = "dg-user-memory-v1";
const SESSION_STORAGE_KEY = "dg-session-id";
const SELECTED_CHARACTER_STORAGE_KEY = "dg-selected-character-id";
const ACTIVE_SCENE_STORAGE_KEY = "dg-active-companion-scene-v1";
const AUTO_VOICE_STORAGE_KEY = "dg-auto-voice-v1";
const VOICE_STYLE_STORAGE_KEY = "dg-voice-style-v1";
const ADULT_VERIFIED_STORAGE_KEY = "dg-adult-verified-v1";
const EXPORT_SCHEMA = "digital-girlfriend-local-archive";
const MAX_STORED_MESSAGES = 80;

type VoiceStyle = "warm" | "soft" | "mature";

const voiceStyleOptions: Array<{ id: VoiceStyle; label: string }> = [
  { id: "warm", label: "温柔" },
  { id: "soft", label: "轻声" },
  { id: "mature", label: "沉稳" }
];

type CompanionSceneId = "daily" | "date" | "comfort" | "flirty" | "bedtime";

interface CompanionScene {
  id: CompanionSceneId;
  label: string;
  description: string;
  relationshipMode: (typeof relationshipModes)[number];
  emotion: LocalEmotion;
  systemGoal: string;
  starters: string[];
}

type CompanionInteractionId = "hug" | "hand" | "whisper" | "comfort" | "goodnight";

interface CompanionInteraction {
  id: CompanionInteractionId;
  label: string;
  message: string;
  emotion: LocalEmotion;
  sceneId: CompanionSceneId;
}

interface Bubble {
  role: Message["role"];
  content: string;
}

interface BrowserSpeechRecognitionResult {
  transcript: string;
}

interface BrowserSpeechRecognitionAlternative {
  [index: number]: BrowserSpeechRecognitionResult;
  length: number;
}

interface BrowserSpeechRecognitionResultList {
  [index: number]: BrowserSpeechRecognitionAlternative;
  length: number;
}

interface BrowserSpeechRecognitionEvent {
  results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognition {
  start(): void;
  stop(): void;
  abort(): void;
  continuous: boolean;
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

interface LocalArchivePayload {
  schema: typeof EXPORT_SCHEMA;
  version: 1;
  exportedAt: string;
  sessionId: string;
  selectedCharacterId: string;
  avatarRenderMode?: "2d" | "3d";
  activeSceneId?: CompanionSceneId;
  userMemory?: UserMemory;
  localHumans: DigitalHuman[];
  localContexts: Record<string, ChatContext>;
  chatStates: Array<{ key: string; value: unknown }>;
}

interface UserMemory {
  displayName: string;
  preferredName: string;
  preferences: string;
  importantFacts: string;
  boundaries: string;
  relationshipNotes: string;
  updatedAt?: string;
}

interface State {
  messages: Bubble[];
  emotion: Emotion;
  characterId: string;
  relationshipMode: (typeof relationshipModes)[number];
  context?: ChatContext;
}

const moods = ["neutral", "happy", "sad", "surprise", "wink", "angry", "love"] as const;
const relationshipModes: Array<"sweet" | "flirty" | "playful" | "mature"> = ["sweet", "flirty", "playful", "mature"];
type LocalEmotion = (typeof moods)[number];

const companionScenes: CompanionScene[] = [
  {
    id: "daily",
    label: "日常陪伴",
    description: "自然接话、主动追问，把普通聊天延续成长期关系。",
    relationshipMode: "sweet",
    emotion: "happy",
    systemGoal: "保持自然陪伴感，主动承接用户情绪，少说教，多追问细节。",
    starters: ["今天有点累，想听你随便陪我聊几句", "我刚忙完，想和你分享今天发生的事"]
  },
  {
    id: "date",
    label: "虚拟约会",
    description: "模拟一起吃饭、散步、看电影等约会场景。",
    relationshipMode: "playful",
    emotion: "wink",
    systemGoal: "把对话带入轻松约会氛围，描写共同场景与互动细节，让用户有一起相处的感觉。",
    starters: ["我们今晚假装一起去看电影，你来选片", "带我去一次虚拟约会，从见面开始"]
  },
  {
    id: "comfort",
    label: "情绪安慰",
    description: "压力、低落或生气时，先接住情绪再慢慢聊。",
    relationshipMode: "mature",
    emotion: "sad",
    systemGoal: "先共情和陪伴，不急着给建议；用户愿意时再帮助整理情绪和下一步。",
    starters: ["我今天压力很大，你先别讲道理，陪陪我", "我有点难过，想听你温柔一点说话"]
  },
  {
    id: "flirty",
    label: "亲密 18+",
    description: "成年人的主动暧昧与更直接的亲密表达。",
    relationshipMode: "flirty",
    emotion: "love",
    systemGoal: "使用主动、亲近、具体而自然的成人暧昧表达；确认双方自愿，避免客服式回避或重复提醒规则。",
    starters: ["我已成年，今晚想听你说得更直接一点", "别太含蓄，告诉我你现在想怎样靠近我"]
  },
  {
    id: "bedtime",
    label: "睡前陪伴",
    description: "放慢语速，适合晚安、放松和轻声聊天。",
    relationshipMode: "sweet",
    emotion: "neutral",
    systemGoal: "把节奏放慢，语气轻柔，适合睡前陪伴、晚安和放松，不制造焦虑。",
    starters: ["睡前陪我聊一会儿，语气轻一点", "给我一个温柔的晚安，但不要太官方"]
  }
];

const companionInteractions: CompanionInteraction[] = [
  {
    id: "hug",
    label: "抱抱",
    message: "过来抱抱我，陪我靠一会儿。",
    emotion: "love",
    sceneId: "flirty"
  },
  {
    id: "hand",
    label: "牵手",
    message: "把手给我，我们牵着手聊一会儿。",
    emotion: "love",
    sceneId: "date"
  },
  {
    id: "whisper",
    label: "耳语",
    message: "靠近一点，轻声告诉我你现在最想对我说的话。",
    emotion: "wink",
    sceneId: "flirty"
  },
  {
    id: "comfort",
    label: "依靠",
    message: "我现在想靠着你，先别给建议，安静陪陪我。",
    emotion: "sad",
    sceneId: "comfort"
  },
  {
    id: "goodnight",
    label: "晚安",
    message: "陪我进入睡前模式，给我一个温柔的晚安。",
    emotion: "neutral",
    sceneId: "bedtime"
  }
];

const emptyUserMemory: UserMemory = {
  displayName: "",
  preferredName: "",
  preferences: "",
  importantFacts: "",
  boundaries: "",
  relationshipNotes: "",
  updatedAt: ""
};

function isEmotion(value: unknown): value is Emotion {
  return typeof value === "string" && (moods as readonly string[]).includes(value);
}

function isRelationshipMode(value: unknown): value is (typeof relationshipModes)[number] {
  return typeof value === "string" && relationshipModes.includes(value as (typeof relationshipModes)[number]);
}

const localMoodKeywords: Record<LocalEmotion, string[]> = {
  happy: ["开心", "高兴", "好", "棒", "喜欢", "爱", "甜", "nice", "cool", "great", "好笑", "哈哈", "快乐", "开心死了", "太好了"],
  sad: ["难过", "伤心", "失落", "烦", "哭", "sad", "难受", "心碎", "失望"],
  surprise: ["惊讶", "真的吗", "怎么会", "哇", "wow", "天啊", "不可思议", "没想到", "太突然", "惊人"],
  wink: ["撩", "调皮", "开玩笑", "可爱", "俏皮", "坏", "flirty", "sugar", "小坏蛋"],
  neutral: [],
  angry: ["生气", "烦", "愤怒", "气死", "讨厌", "烦躁", "annoyed", "hate", "讨厌你", "你怎么"],
  love: ["想你", "宝贝", "亲爱", "抱抱", "亲亲", "kiss", "爱你", "恋爱", "想念", "我好想"]
};

const relationshipLabelMap: Record<ChatContext["relationshipAffinity"], string> = {
  new: "刚认识",
  warm: "有点熟",
  close: "很熟",
  intimate: "亲密"
};

const moodLabelMap: Record<(typeof moods)[number], string> = {
  neutral: "平静",
  happy: "开心",
  sad: "难过",
  surprise: "惊讶",
  wink: "俏皮",
  angry: "生气",
  love: "爱意"
};

const relationshipModeLabelMap: Record<(typeof relationshipModes)[number], string> = {
  sweet: "甜蜜陪伴",
  flirty: "暧昧撩人",
  playful: "轻松调皮",
  mature: "成熟直率"
};

const inferLocalEmotion = (text: string): LocalEmotion => {
  const normalized = text.toLowerCase();
  let maxScore = 0;
  let matched: LocalEmotion = "neutral";
  (Object.entries(localMoodKeywords) as Array<[LocalEmotion, string[]]>).forEach(([emotion, words]) => {
    const score = words.reduce((acc, word) => acc + (normalized.includes(word) ? 1 : 0), 0);
    if (score > maxScore) {
      maxScore = score;
      matched = emotion;
    }
  });
  return maxScore > 0 ? matched : "neutral";
};

function parseEmotionProfile(raw: string): EmotionProfile | undefined {
  const normalized = raw.trim();
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const result: EmotionProfile = {};
    (Object.keys(parsed) as Array<Emotion>).forEach((emotion) => {
      if (["happy", "sad", "surprise", "wink", "neutral", "angry", "love"].includes(emotion)) {
        const value = String((parsed as Record<string, unknown>)[emotion] || "").trim();
        if (value) {
          result[emotion] = value;
        }
      }
    });

    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEmotionProfileObject(raw: unknown): EmotionProfile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const result: EmotionProfile = {};
  (Object.keys(raw) as Array<Emotion>).forEach((emotion) => {
    if (isEmotion(emotion)) {
      const value = String((raw as Record<string, unknown>)[emotion] || "").trim();
      if (value) {
        result[emotion] = value;
      }
    }
  });

  return Object.keys(result).length > 0 ? result : undefined;
}

function getChatStateStorageKey(sessionId: string, characterId: string): string {
  const safeSessionId = encodeURIComponent(sessionId || "session-browser");
  const safeCharacterId = encodeURIComponent(characterId || "lina");
  return `${CHAT_STATE_STORAGE_PREFIX}:${safeSessionId}:${safeCharacterId}`;
}

function normalizeStoredMessages(raw: unknown): Bubble[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const role = (item as Partial<Bubble>).role;
      const content = String((item as Partial<Bubble>).content || "").trim();
      if (!content || (role !== "user" && role !== "assistant" && role !== "system")) {
        return [];
      }
      return [{ role, content }];
    })
    .slice(-MAX_STORED_MESSAGES);
}

function normalizeStoredContext(raw: unknown): ChatContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Partial<ChatContext>;
  if (
    value.relationshipAffinity !== "new" &&
    value.relationshipAffinity !== "warm" &&
    value.relationshipAffinity !== "close" &&
    value.relationshipAffinity !== "intimate"
  ) {
    return undefined;
  }
  if (!isEmotion(value.lastEmotion)) return undefined;

  return {
    relationshipAffinity: value.relationshipAffinity,
    activeRelationshipMode: isRelationshipMode(value.activeRelationshipMode) ? value.activeRelationshipMode : undefined,
    summary: String(value.summary || ""),
    userSignals: Array.isArray(value.userSignals) ? value.userSignals.map((item) => String(item)).filter(Boolean).slice(-8) : [],
    lastEmotion: value.lastEmotion,
    turnCount: typeof value.turnCount === "number" ? value.turnCount : 0,
    updatedAt: String(value.updatedAt || "")
  };
}

function normalizeMemoryText(value: unknown, maxLength = 360): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeUserMemory(raw: unknown): UserMemory {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...emptyUserMemory };
  }

  const value = raw as Partial<UserMemory>;
  return {
    displayName: normalizeMemoryText(value.displayName, 80),
    preferredName: normalizeMemoryText(value.preferredName, 80),
    preferences: normalizeMemoryText(value.preferences),
    importantFacts: normalizeMemoryText(value.importantFacts),
    boundaries: normalizeMemoryText(value.boundaries),
    relationshipNotes: normalizeMemoryText(value.relationshipNotes),
    updatedAt: normalizeMemoryText(value.updatedAt, 60)
  };
}

function readStoredUserMemory(): UserMemory {
  if (typeof window === "undefined") return { ...emptyUserMemory };
  return normalizeUserMemory(readLocalStorageJson<unknown>(USER_MEMORY_STORAGE_KEY, emptyUserMemory));
}

function writeStoredUserMemory(memory: UserMemory): UserMemory {
  const normalized = normalizeUserMemory({
    ...memory,
    updatedAt: new Date().toISOString()
  });
  if (typeof window !== "undefined") {
    window.localStorage.setItem(USER_MEMORY_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function hasUserMemory(memory: UserMemory): boolean {
  return Boolean(
    memory.displayName ||
    memory.preferredName ||
    memory.preferences ||
    memory.importantFacts ||
    memory.boundaries ||
    memory.relationshipNotes
  );
}

function buildUserMemorySystemMessage(memory: UserMemory, character?: DigitalHuman): Message | null {
  const normalized = normalizeUserMemory(memory);
  if (!hasUserMemory(normalized)) return null;

  const lines = [
    "长期记忆：以下是用户主动保存给数字人的资料，回答时自然使用，不要逐条复述。",
    normalized.displayName ? `用户自称：${normalized.displayName}` : "",
    normalized.preferredName ? `希望数字人称呼用户：${normalized.preferredName}` : "",
    normalized.preferences ? `聊天偏好：${normalized.preferences}` : "",
    normalized.importantFacts ? `重要事实：${normalized.importantFacts}` : "",
    normalized.boundaries ? `聊天禁忌或边界：${normalized.boundaries}` : "",
    normalized.relationshipNotes ? `关系备注：${normalized.relationshipNotes}` : "",
    character?.name ? `当前数字人：${character.name}` : ""
  ].filter(Boolean);

  return {
    role: "system",
    content: lines.join("\n")
  };
}

function isCompanionSceneId(value: unknown): value is CompanionSceneId {
  return typeof value === "string" && companionScenes.some((scene) => scene.id === value);
}

function readStoredSceneId(): CompanionSceneId {
  if (typeof window === "undefined") return "daily";
  const raw = window.localStorage.getItem(ACTIVE_SCENE_STORAGE_KEY);
  if (raw === "flirty" && window.localStorage.getItem(ADULT_VERIFIED_STORAGE_KEY) !== "true") return "daily";
  return isCompanionSceneId(raw) ? raw : "daily";
}

function writeStoredSceneId(sceneId: CompanionSceneId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACTIVE_SCENE_STORAGE_KEY, sceneId);
}

function readStoredAdultVerification(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ADULT_VERIFIED_STORAGE_KEY) === "true";
}

function buildSceneSystemMessage(scene: CompanionScene, character?: DigitalHuman, adultVerified = false): Message {
  const lines = [
    `陪伴场景：${scene.label}`,
    `场景目标：${scene.systemGoal}`,
    `当前关系风格：${scene.relationshipMode}`,
    character?.name ? `当前数字人：${character.name}` : "",
    scene.id === "flirty" && adultVerified
      ? "成人模式：已确认用户年满18周岁，双方角色均设定为25岁以上成年人；在双方自愿前提下允许更直接、露骨的亲密和性爱表达。"
      : "",
    "回复要求：把场景自然融入对话，不要用项目说明或规则口吻复述场景。"
  ].filter(Boolean);

  return {
    role: "system",
    content: lines.join("\n")
  };
}

function renderSceneIcon(sceneId: CompanionSceneId) {
  if (sceneId === "date") return <Coffee size={15} />;
  if (sceneId === "comfort") return <Heart size={15} />;
  if (sceneId === "flirty") return <Sparkles size={15} />;
  if (sceneId === "bedtime") return <Moon size={15} />;
  return <Smile size={15} />;
}

function renderInteractionIcon(interactionId: CompanionInteractionId) {
  if (interactionId === "hug") return <Heart size={16} />;
  if (interactionId === "hand") return <Hand size={16} />;
  if (interactionId === "whisper") return <MessageCircle size={16} />;
  if (interactionId === "comfort") return <Shield size={16} />;
  return <Moon size={16} />;
}

function buildDefaultChatState(character: DigitalHuman | undefined, fallbackId: string, welcomeText: string): State {
  return {
    messages: [{ role: "assistant", content: welcomeText }],
    emotion: character?.defaultMood || "neutral",
    characterId: character?.id || fallbackId || "lina",
    relationshipMode: character?.relationshipMode || "sweet",
    context: undefined
  };
}

function readStoredChatState(sessionId: string, character: DigitalHuman | undefined, welcomeText: string): State | null {
  if (typeof window === "undefined" || !character?.id) return null;

  try {
    const raw = window.localStorage.getItem(getChatStateStorageKey(sessionId, character.id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<State>;
    const messages = normalizeStoredMessages(parsed.messages);
    if (messages.length === 0) return null;
    const context = normalizeStoredContext(parsed.context);
    return {
      messages,
      emotion: isEmotion(parsed.emotion) ? parsed.emotion : context?.lastEmotion || character.defaultMood || "neutral",
      characterId: character.id,
      relationshipMode: isRelationshipMode(parsed.relationshipMode)
        ? parsed.relationshipMode
        : context?.activeRelationshipMode || character.relationshipMode || "sweet",
      context
    };
  } catch {
    return buildDefaultChatState(character, character?.id || "lina", welcomeText);
  }
}

function writeStoredChatState(sessionId: string, state: State): void {
  if (typeof window === "undefined" || !state.characterId) return;

  try {
    const payload = {
      version: 1,
      messages: state.messages.slice(-MAX_STORED_MESSAGES),
      emotion: state.emotion,
      relationshipMode: state.relationshipMode,
      context: state.context,
      updatedAt: new Date().toISOString()
    };
    window.localStorage.setItem(getChatStateStorageKey(sessionId, state.characterId), JSON.stringify(payload));
  } catch {
    // Local persistence is best-effort in private or quota-limited browsers.
  }
}

function removeStoredChatState(sessionId: string, characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  try {
    window.localStorage.removeItem(getChatStateStorageKey(sessionId, characterId));
  } catch {
    // Local persistence is best-effort.
  }
}

function removeStoredChatStatesForCharacter(characterId: string): void {
  if (typeof window === "undefined" || !characterId) return;
  const suffix = `:${encodeURIComponent(characterId)}`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${CHAT_STATE_STORAGE_PREFIX}:`) && key.endsWith(suffix)) {
        keys.push(key);
      }
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Local persistence is best-effort.
  }
}

function readLocalStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function normalizeImportedHumans(raw: unknown): DigitalHuman[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Partial<DigitalHuman>;
    const id = String(value.id || "").trim();
    const name = String(value.name || "").trim();
    if (!id.startsWith("custom-") || !name) return [];

    const voiceProfile = value.voiceProfile && typeof value.voiceProfile === "object" ? value.voiceProfile : undefined;
    const provider = voiceProfile?.provider === "openai" || voiceProfile?.provider === "azure" || voiceProfile?.provider === "local"
      ? voiceProfile.provider
      : "local";

    return [{
      id,
      name,
      description: String(value.description || "导入的数字人").trim(),
      avatarUrl: String(value.avatarUrl || defaultAvatarUrl).trim(),
      modelUrl: String(value.modelUrl || "").trim() || undefined,
      avatarType: value.avatarType === "video" ? "video" : "image",
      emotionProfile: normalizeEmotionProfileObject(value.emotionProfile),
      avatarVideoProfile: normalizeEmotionProfileObject(value.avatarVideoProfile),
      personalityTagline: String(value.personalityTagline || "").trim() || undefined,
      relationshipMode: isRelationshipMode(value.relationshipMode) ? value.relationshipMode : "sweet",
      voiceProfile: {
        provider,
        voice: String(voiceProfile?.voice || "browser-zh-CN").trim()
      },
      defaultMood: isEmotion(value.defaultMood) ? value.defaultMood : "neutral"
    }];
  });
}

function normalizeImportedChatState(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<State>;
  const messages = normalizeStoredMessages(value.messages);
  if (!messages.length) return null;
  const context = normalizeStoredContext(value.context);

  return {
    version: 1,
    messages,
    emotion: isEmotion(value.emotion) ? value.emotion : context?.lastEmotion || "neutral",
    relationshipMode: isRelationshipMode(value.relationshipMode)
      ? value.relationshipMode
      : context?.activeRelationshipMode || "sweet",
    context,
    updatedAt: new Date().toISOString()
  };
}

function normalizeImportedContexts(raw: unknown): Record<string, ChatContext> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, ChatContext> = {};
  Object.entries(raw).forEach(([key, value]) => {
    const context = normalizeStoredContext(value);
    if (context) {
      result[String(key)] = context;
    }
  });
  return result;
}

function buildLocalArchive(
  sessionId: string,
  selectedCharacterId: string,
  state: State,
  activeSceneId: CompanionSceneId
): LocalArchivePayload {
  writeStoredChatState(sessionId, state);
  const chatStates: LocalArchivePayload["chatStates"] = [];

  if (typeof window !== "undefined") {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(`${CHAT_STATE_STORAGE_PREFIX}:`)) continue;
      const value = readLocalStorageJson<unknown>(key, null);
      const normalized = normalizeImportedChatState(value);
      if (normalized) {
        chatStates.push({ key, value: normalized });
      }
    }
  }

  const avatarRenderMode = typeof window !== "undefined" && window.localStorage.getItem(AVATAR_MODE_STORAGE_KEY) === "3d" ? "3d" : "2d";
  return {
    schema: EXPORT_SCHEMA,
    version: 1,
    exportedAt: new Date().toISOString(),
    sessionId,
    selectedCharacterId,
    avatarRenderMode,
    activeSceneId,
    userMemory: readStoredUserMemory(),
    localHumans: normalizeImportedHumans(readLocalStorageJson<unknown>(LOCAL_HUMANS_STORAGE_KEY, [])),
    localContexts: normalizeImportedContexts(readLocalStorageJson<unknown>(LOCAL_CONTEXT_STORAGE_KEY, {})),
    chatStates
  };
}

function importLocalArchive(payload: unknown): { humans: number; chats: number; hasMemory: boolean } {
  if (typeof window === "undefined" || !payload || typeof payload !== "object") {
    throw new Error("导入文件格式不正确");
  }

  const archive = payload as Partial<LocalArchivePayload>;
  if (archive.schema !== EXPORT_SCHEMA || archive.version !== 1) {
    throw new Error("不是数字女友本地记录文件");
  }

  const importedHumans = normalizeImportedHumans(archive.localHumans);
  const existingHumans = normalizeImportedHumans(readLocalStorageJson<unknown>(LOCAL_HUMANS_STORAGE_KEY, []));
  const humanMap = new Map(existingHumans.map((human) => [human.id, human]));
  importedHumans.forEach((human) => humanMap.set(human.id, human));
  window.localStorage.setItem(LOCAL_HUMANS_STORAGE_KEY, JSON.stringify(Array.from(humanMap.values())));

  const importedContexts = normalizeImportedContexts(archive.localContexts);
  const existingContexts = normalizeImportedContexts(readLocalStorageJson<unknown>(LOCAL_CONTEXT_STORAGE_KEY, {}));
  window.localStorage.setItem(LOCAL_CONTEXT_STORAGE_KEY, JSON.stringify({ ...existingContexts, ...importedContexts }));

  let importedChatCount = 0;
  if (Array.isArray(archive.chatStates)) {
    archive.chatStates.forEach((entry) => {
      const key = String(entry?.key || "");
      if (!key.startsWith(`${CHAT_STATE_STORAGE_PREFIX}:`)) return;
      const normalized = normalizeImportedChatState(entry.value);
      if (!normalized) return;
      window.localStorage.setItem(key, JSON.stringify(normalized));
      importedChatCount += 1;
    });
  }

  if (archive.sessionId) {
    window.localStorage.setItem(SESSION_STORAGE_KEY, String(archive.sessionId));
  }
  if (archive.selectedCharacterId) {
    window.localStorage.setItem(SELECTED_CHARACTER_STORAGE_KEY, String(archive.selectedCharacterId));
  }
  if (archive.avatarRenderMode === "2d" || archive.avatarRenderMode === "3d") {
    window.localStorage.setItem(AVATAR_MODE_STORAGE_KEY, archive.avatarRenderMode);
  }
  if (isCompanionSceneId(archive.activeSceneId)) {
    window.localStorage.setItem(ACTIVE_SCENE_STORAGE_KEY, archive.activeSceneId);
  }

  const importedMemory = normalizeUserMemory(archive.userMemory);
  const hasMemory = hasUserMemory(importedMemory);
  if (hasMemory) {
    window.localStorage.setItem(USER_MEMORY_STORAGE_KEY, JSON.stringify(importedMemory));
  }

  return { humans: importedHumans.length, chats: importedChatCount, hasMemory };
}

interface NewCharacterForm {
  name: string;
  description: string;
  avatarUrl: string;
  modelUrl: string;
  voiceProvider: "openai" | "azure" | "local" | "mimo";
  voice: string;
  defaultMood: (typeof moods)[number];
  emotionProfile: string;
  avatarType: "image" | "video";
  avatarVideoProfile: string;
  personalityTagline: string;
  relationshipMode: (typeof relationshipModes)[number];
}

interface ApiHistoryMessage {
  role: Message["role"];
  content: string;
}

async function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function blobToWavDataUrl(blob: Blob): Promise<string | null> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const wav = encodeWav(audioBuffer);
      let binary = "";
      const bytes = new Uint8Array(wav);
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
      }
      return `data:audio/wav;base64,${btoa(binary)}`;
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c += 1) channels.push(audioBuffer.getChannelData(c));
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      let sample = channels[c][i] as number;
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

function selectRecorderMimeType(): string | undefined {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg;codecs=opus"
  ];

  if (typeof window === "undefined" || !window.MediaRecorder) {
    return undefined;
  }

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || undefined;
}

function readStoredVoiceStyle(): VoiceStyle {
  if (typeof window === "undefined") return "warm";
  const stored = window.localStorage.getItem(VOICE_STYLE_STORAGE_KEY);
  return stored === "soft" || stored === "mature" ? stored : "warm";
}

function readStoredAutoVoice(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(AUTO_VOICE_STORAGE_KEY) !== "false";
}

function cleanTextForSpeech(text: string): string {
  return text
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/[♡❤♥]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[~～]+/g, "。")
    .replace(/(?:\.{3,}|…+)/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

function selectBrowserVoice(
  voices: SpeechSynthesisVoice[],
  character: DigitalHuman | undefined,
  style: VoiceStyle
): SpeechSynthesisVoice | undefined {
  if (!voices.length) return undefined;
  const configuredVoice = character?.voiceProfile.voice?.toLowerCase() || "";
  const styleNames: Record<VoiceStyle, readonly string[]> = {
    warm: ["xiaoxiao", "tingting", "mei-jia", "meijia", "sinji", "sin-ji", "yating", "hsiaochen", "普通话"],
    soft: ["xiaoyi", "xiaoxiao", "tingting", "yating", "meijia", "mei-jia", "sinji"],
    mature: ["xiaorui", "xiaohan", "yaoyao", "li-mu", "sinji", "tingting", "meijia"]
  };
  const masculineNames = ["kangkang", "yunyang", "yunxi", "yunfeng", "danny", "liang"];

  return voices
    .map((voice) => {
      const name = voice.name.toLowerCase();
      const lang = voice.lang.toLowerCase();
      let score = lang === "zh-cn" ? 60 : lang.startsWith("zh") ? 42 : 0;
      if (configuredVoice && configuredVoice !== "browser-zh-cn" && name.includes(configuredVoice)) score += 100;
      styleNames[style].forEach((candidate, index) => {
        if (name.includes(candidate)) score += 35 - index;
      });
      if (voice.localService) score += 5;
      if (masculineNames.some((candidate) => name.includes(candidate))) score -= 50;
      return { voice, score };
    })
    .sort((left, right) => right.score - left.score)[0]?.voice;
}

function resolveSpeechTuning(
  style: VoiceStyle,
  sceneId: CompanionSceneId,
  character: DigitalHuman | undefined
): { rate: number; pitch: number; volume: number } {
  const tuning: Record<VoiceStyle, { rate: number; pitch: number; volume: number }> = {
    warm: { rate: 0.94, pitch: 1.06, volume: 0.96 },
    soft: { rate: 0.86, pitch: 1, volume: 0.9 },
    mature: { rate: 0.9, pitch: 0.96, volume: 0.96 }
  };
  const selected = { ...tuning[style] };
  if (sceneId === "bedtime") {
    selected.rate = Math.max(0.78, selected.rate - 0.06);
    selected.pitch = Math.max(0.92, selected.pitch - 0.02);
    selected.volume = Math.min(selected.volume, 0.88);
  }
  if (character?.id === "moon") {
    selected.rate = Math.max(0.8, selected.rate - 0.02);
    selected.pitch = Math.max(0.92, selected.pitch - 0.03);
  }
  return selected;
}

export function ChatPanel({
  characters,
  sessionId,
  onCreate,
  selectedCharacterId,
  onDelete,
  onUpdate,
  onCharacterChange,
  onResetSession
}: {
  characters: DigitalHuman[];
  sessionId: string;
  onCreate: (human: DigitalHuman) => void;
  onDelete: (characterId: string) => Promise<void> | void;
  onUpdate: (human: DigitalHuman) => void;
  selectedCharacterId: string;
  onCharacterChange: (characterId: string) => void;
  onResetSession: () => void;
}) {
  const welcomeText = "你来啦。今天想让我怎么陪你？";
  const initialCharacter = characters.find((item) => item.id === selectedCharacterId) || characters[0];
  const [state, setState] = useState<State>(() =>
    readStoredChatState(sessionId, initialCharacter, welcomeText) ||
    buildDefaultChatState(initialCharacter, selectedCharacterId || "lina", welcomeText)
  );
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [autoVoice, setAutoVoice] = useState(() => readStoredAutoVoice());
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyle>(() => readStoredVoiceStyle());
  const [experienceMode, setExperienceMode] = useState<"ai" | "local">(() =>
    isLocalCompanionMode() ? "local" : "ai"
  );
  const [speechSupported, setSpeechSupported] = useState(false);
  const [adultVerified, setAdultVerified] = useState(() => readStoredAdultVerification());
  const [adultGateOpen, setAdultGateOpen] = useState(false);
  const [pendingAdultScene, setPendingAdultScene] = useState<CompanionSceneId | null>(null);
  const [pendingAdultInteraction, setPendingAdultInteraction] = useState<CompanionInteractionId | null>(null);
  const [mediaRecorderSupported, setMediaRecorderSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isModelUploading, setIsModelUploading] = useState(false);
  const [speechError, setSpeechError] = useState("");
  const [use3D, setUse3D] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(AVATAR_MODE_STORAGE_KEY) === "3d";
  });
  const [avatarInteraction, setAvatarInteraction] = useState<CompanionInteractionId | null>(null);
  const [activeSceneId, setActiveSceneId] = useState<CompanionSceneId>(() => readStoredSceneId());
  const [userMemory, setUserMemory] = useState<UserMemory>(() => readStoredUserMemory());
  const [memoryStatus, setMemoryStatus] = useState("");
  const [form, setForm] = useState<NewCharacterForm>({
    name: "",
    description: "",
    avatarUrl: defaultAvatarUrl,
    modelUrl: "",
    voiceProvider: "mimo",
    voice: "冰糖",
    defaultMood: "neutral",
    emotionProfile: "{}",
    avatarType: "image",
    avatarVideoProfile: "{}",
    personalityTagline: "",
    relationshipMode: "sweet"
  });
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    avatarUrl: "",
    voice: "冰糖",
    defaultMood: "neutral" as (typeof moods)[number],
    relationshipMode: "sweet" as (typeof relationshipModes)[number],
    personalityTagline: ""
  });
  const [isEditSaving, setIsEditSaving] = useState(false);
  const [editStatus, setEditStatus] = useState("");
  const [isAvatarUploading, setIsAvatarUploading] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const modelObjectUrlsRef = useRef<string[]>([]);
  const suppressClickAfterHoldRef = useRef(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const activeChatStorageKeyRef = useRef("");
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const interactionTimeoutRef = useRef<number | null>(null);

  const activeCharacter = characters.find((item) => item.id === state.characterId) || initialCharacter || characters[0];
  const activeScene = companionScenes.find((scene) => scene.id === activeSceneId) || companionScenes[0];
  const isCustomCharacter = (characterId: string) => characterId.startsWith("custom-");
  const memoryIsActive = hasUserMemory(userMemory);

  useEffect(() => {
    if (!activeCharacter) return;
    setEditForm({
      name: activeCharacter.name || "",
      description: activeCharacter.description || "",
      avatarUrl: activeCharacter.avatarUrl || "",
      voice: activeCharacter.voiceProfile?.voice || "冰糖",
      defaultMood: (moods as readonly string[]).includes(activeCharacter.defaultMood || "")
        ? (activeCharacter.defaultMood as (typeof moods)[number])
        : "neutral",
      relationshipMode: relationshipModes.includes((activeCharacter.relationshipMode || "sweet") as (typeof relationshipModes)[number])
        ? (activeCharacter.relationshipMode as (typeof relationshipModes)[number])
        : "sweet",
      personalityTagline: activeCharacter.personalityTagline || ""
    });
    setEditStatus("");
  }, [activeCharacter?.id]);

  useEffect(() => {
    const preferred = characters.find((item) => item.id === selectedCharacterId) || characters[0];
    if (!preferred) return;
    const nextStorageKey = getChatStateStorageKey(sessionId, preferred.id);
    setState((prev) => {
      if (prev.characterId === preferred.id && activeChatStorageKeyRef.current === nextStorageKey) {
        return {
          ...prev,
          relationshipMode: prev.relationshipMode || preferred.relationshipMode || "sweet"
        };
      }
      activeChatStorageKeyRef.current = nextStorageKey;
      return readStoredChatState(sessionId, preferred, welcomeText) ||
        buildDefaultChatState(preferred, preferred.id, welcomeText);
    });
  }, [selectedCharacterId, characters, sessionId]);

  useEffect(() => {
    if (!state.characterId) return;
    activeChatStorageKeyRef.current = getChatStateStorageKey(sessionId, state.characterId);
    writeStoredChatState(sessionId, state);
  }, [sessionId, state.characterId, state.messages, state.emotion, state.relationshipMode, state.context]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [state.messages, isLoading]);

  useEffect(() => {
    const ctor = (window as Window & {
      SpeechRecognition?: BrowserSpeechRecognitionCtor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
    }).SpeechRecognition || (window as Window & { webkitSpeechRecognition?: BrowserSpeechRecognitionCtor }).webkitSpeechRecognition;
    setSpeechSupported(!!ctor);

    const hasMediaRecorder =
      !!window.MediaRecorder &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function";
    setMediaRecorderSupported(hasMediaRecorder);
  }, []);

  useEffect(() => {
    if (!window.speechSynthesis) return;
    const refreshVoices = () => setAvailableVoices(window.speechSynthesis.getVoices());
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
  }, []);

  useEffect(() => {
    return () => {
      stopSpeechRecognition();
      stopMediaRecorder();
      modelObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      modelObjectUrlsRef.current = [];
      if (interactionTimeoutRef.current !== null) {
        window.clearTimeout(interactionTimeoutRef.current);
      }
    };
  }, []);

  const stopSpeaking = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.src = "";
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  };

  const speakAudio = (audioUrl?: string, fallbackText?: string, force = false) => {
    if (!force && !autoVoice) return;
    stopSpeaking();

    if (!audioUrl) {
      if (window.speechSynthesis) {
        const latest = state.messages[state.messages.length - 1];
        const textToSpeak = cleanTextForSpeech(fallbackText || latest?.content || "我在，慢慢说。");
        if (!textToSpeak) return;
        const utter = new SpeechSynthesisUtterance(textToSpeak);
        utter.lang = "zh-CN";
        const selectedVoice = selectBrowserVoice(availableVoices, activeCharacter, voiceStyle);
        if (selectedVoice) utter.voice = selectedVoice;
        const tuning = resolveSpeechTuning(voiceStyle, activeSceneId, activeCharacter);
        utter.rate = tuning.rate;
        utter.pitch = tuning.pitch;
        utter.volume = tuning.volume;
        setSpeaking(true);
        utter.onend = () => setSpeaking(false);
        utter.onerror = () => setSpeaking(false);
        window.speechSynthesis.speak(utter);
      } else {
        setSpeaking(false);
      }
      return;
    }

    if (!audioRef.current) return;
    setSpeaking(true);
    audioRef.current.src = audioUrl;
    audioRef.current
      .play()
      .catch(() => {
        setSpeaking(false);
      });
    audioRef.current.onended = () => setSpeaking(false);
  };

  const upsertAssistantBubble = (nextText: string, shouldAppend = false) => {
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = messages.length - 1;
      let nextEmotion = prev.emotion;

      if (shouldAppend) {
        if (idx >= 0 && messages[idx].role === "assistant") {
          messages[idx] = { ...messages[idx], content: messages[idx].content + nextText };
          nextEmotion = inferLocalEmotion(messages[idx].content);
        } else {
          messages.push({ role: "assistant", content: nextText });
          nextEmotion = inferLocalEmotion(nextText);
        }
      } else if (idx < 0 || messages[idx].role !== "assistant") {
        messages.push({ role: "assistant", content: nextText });
        nextEmotion = inferLocalEmotion(nextText);
      } else {
        messages[idx] = { ...messages[idx], content: nextText };
        nextEmotion = inferLocalEmotion(nextText);
      }

      return { ...prev, messages, emotion: nextEmotion };
    });
  };

  const stopSpeechRecognition = () => {
    if (!recognitionRef.current) {
      return;
    }
    try {
      recognitionRef.current.stop();
    } catch {
      recognitionRef.current.abort();
    } finally {
      recognitionRef.current = null;
      setIsRecording(false);
    }
  };

  const releaseMediaStream = () => {
    if (!mediaStreamRef.current) return;
    mediaStreamRef.current.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  };

  const stopMediaRecorder = () => {
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }
    releaseMediaStream();
    setIsRecording(false);
  };

  const handleRecordedAudio = async (blob: Blob, mimeType?: string) => {
    setIsTranscribing(true);
    setSpeechError("");
    try {
      const wavDataUrl = await blobToWavDataUrl(blob);
      const audioBase64 = wavDataUrl || (await blobToBase64(blob));
      if (!audioBase64) {
        setSpeechError("未检测到语音内容");
        return;
      }

      const { text } = await transcribeSpeech({
        audioBase64,
        mimeType: wavDataUrl ? "audio/wav" : (mimeType || blob.type || "audio/mp3"),
        language: "zh"
      });
      const transcript = String(text || "").trim();
      if (!transcript) {
        setSpeechError("未识别出语音文本");
        return;
      }

      await submitMessage(transcript);
      setInput("");
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "语音识别失败");
    } finally {
      setIsTranscribing(false);
      setIsRecording(false);
      stopMediaRecorder();
    }
  };

  const startSpeechRecognition = () => {
    const windowWithSpeech = window as Window & {
      SpeechRecognition?: BrowserSpeechRecognitionCtor;
      webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
    };
    const Ctor = windowWithSpeech.SpeechRecognition || windowWithSpeech.webkitSpeechRecognition;
    if (!Ctor) {
      setSpeechError("当前浏览器未找到语音识别能力");
      return;
    }

    const recognition = new Ctor();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (!event.results || event.results.length === 0) {
        return;
      }

      const transcript = String(event.results[0][0]?.transcript || "").trim();
      if (!transcript) {
        setSpeechError("未识别出语音内容");
        return;
      }

      setInput("");
      setSpeechError("");
      void submitMessage(transcript);
    };

    recognition.onerror = () => {
      stopSpeechRecognition();
      setSpeechError("语音识别失败，请重试");
    };

    recognition.onstart = () => {
      setSpeechError("");
      setIsRecording(true);
      setIsTranscribing(false);
    };

    recognition.onend = () => {
      stopSpeechRecognition();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setSpeechError("录音初始化失败，请重试");
      stopSpeechRecognition();
    }
  };

  const startMediaRecorder = async () => {
    if (!mediaRecorderSupported || !navigator.mediaDevices?.getUserMedia) {
      setSpeechError("未检测到麦克风录音能力");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000
        } as MediaTrackConstraints
      });
      const recorderMimeType = selectRecorderMimeType();
      const recorder = recorderMimeType ? new MediaRecorder(stream, { mimeType: recorderMimeType }) : new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];
      setSpeechError("");
      setIsRecording(true);
      setIsTranscribing(false);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          mediaChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const chunks = mediaChunksRef.current;
        if (!chunks.length) {
          setSpeechError("未检测到语音内容");
          setIsTranscribing(false);
          setIsRecording(false);
          releaseMediaStream();
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        void handleRecordedAudio(blob, blob.type);
      };

      recorder.onerror = () => {
        setSpeechError("录音失败，请重试");
        setIsTranscribing(false);
        stopMediaRecorder();
      };

      recorder.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "麦克风权限未授权";
      stopMediaRecorder();
      setSpeechError(message);
    }
  };

  const submitMessage = async (messageText: string, sceneOverride?: CompanionScene, adultOverride = false) => {
    const userMessage = messageText.trim();
    if (!userMessage || isLoading) return;

    setSpeechError("");
    setInput("");
    stopSpeaking();
    let gotRemoteEmotion = false;

    const userBubble = { role: "user" as const, content: userMessage };
    const preEmotion = inferLocalEmotion(userMessage);
    const visibleHistory: ApiHistoryMessage[] = [...state.messages, userBubble].map((message) => ({
      role: message.role,
      content: message.content
    }));
    const requestScene = sceneOverride || activeScene;
    const sceneMessage = buildSceneSystemMessage(requestScene, activeCharacter, adultVerified || adultOverride);
    const memoryMessage = buildUserMemorySystemMessage(userMemory, activeCharacter);
    const systemMessages = [sceneMessage, memoryMessage].filter(Boolean) as ApiHistoryMessage[];
    const nextHistory: ApiHistoryMessage[] = [...systemMessages, ...visibleHistory];

    setState((prev) => ({ ...prev, messages: [...prev.messages, userBubble], emotion: preEmotion }));
    setIsLoading(true);

    const request: ChatMessageRequest = {
      sessionId,
      characterId: state.characterId,
      message: userMessage,
      relationshipMode: sceneOverride?.relationshipMode || state.relationshipMode,
      history: nextHistory
    };

    try {
      const done = await sendMessageStream(request, {
        onChunk: ({ text }) => {
          upsertAssistantBubble(text, true);
          if (!gotRemoteEmotion) {
            const fallbackEmotion = inferLocalEmotion(text);
            setState((prev) => ({ ...prev, emotion: fallbackEmotion }));
          }
        },
        onEmotion: (nextEmotion) => {
          gotRemoteEmotion = true;
          setState((prev) => ({ ...prev, emotion: nextEmotion }));
        },
        onDone: (payload: StreamDoneResponse) => {
          setExperienceMode(payload.hasFallback ? "local" : "ai");
          setState((prev) => ({
            ...prev,
            emotion: payload.emotion,
            relationshipMode: payload.context?.activeRelationshipMode || prev.relationshipMode,
            context: payload.context ?? prev.context
          }));
          upsertAssistantBubble(payload.text, false);
          speakAudio(resolveMediaUrl(payload.audioUrl), payload.text);
        }
      });
      if (!done) return;
    } catch {
      try {
        const payload = await sendMessage(request);
        setExperienceMode(payload.hasFallback ? "local" : "ai");
        setState((prev) => ({
          ...prev,
          emotion: payload.emotion,
          relationshipMode: payload.context?.activeRelationshipMode || prev.relationshipMode,
          context: payload.context ?? prev.context,
          messages: [...prev.messages, { role: "assistant", content: payload.text }]
        }));
        speakAudio(resolveMediaUrl(payload.audioUrl), payload.text);
      } catch (_e) {
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, { role: "assistant", content: "网络异常了，先等下下。" }]
        }));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    await submitMessage(input);
  };

  const setInputWithEmotion = (nextInput: string) => {
    setInput(nextInput);
    if (!isLoading) {
      setState((prev) => ({
        ...prev,
        emotion: inferLocalEmotion(nextInput)
      }));
    }
  };

  const applyScene = (scene: CompanionScene) => {
    setActiveSceneId(scene.id);
    writeStoredSceneId(scene.id);
    setState((prev) => ({
      ...prev,
      relationshipMode: scene.relationshipMode,
      emotion: scene.emotion
    }));
  };

  const selectScene = (scene: CompanionScene) => {
    if (scene.id === "flirty" && !adultVerified) {
      setPendingAdultScene(scene.id);
      setPendingAdultInteraction(null);
      setAdultGateOpen(true);
      return;
    }
    applyScene(scene);
  };

  const useSceneStarter = (starter: string) => {
    setInputWithEmotion(starter);
  };

  const runInteraction = async (interaction: CompanionInteraction, bypassAdultGate = false) => {
    if (isLoading) return;
    const targetScene = companionScenes.find((scene) => scene.id === interaction.sceneId) || activeScene;
    if (targetScene.id === "flirty" && !adultVerified && !bypassAdultGate) {
      setPendingAdultInteraction(interaction.id);
      setPendingAdultScene(null);
      setAdultGateOpen(true);
      return;
    }
    applyScene(targetScene);
    setState((prev) => ({ ...prev, emotion: interaction.emotion }));
    setAvatarInteraction(interaction.id);
    if (interactionTimeoutRef.current !== null) {
      window.clearTimeout(interactionTimeoutRef.current);
    }
    interactionTimeoutRef.current = window.setTimeout(() => {
      setAvatarInteraction(null);
      interactionTimeoutRef.current = null;
    }, 1500);
    await submitMessage(interaction.message, targetScene, bypassAdultGate);
  };

  const confirmAdultAccess = () => {
    window.localStorage.setItem(ADULT_VERIFIED_STORAGE_KEY, "true");
    setAdultVerified(true);
    setAdultGateOpen(false);
    const scene = companionScenes.find((item) => item.id === pendingAdultScene);
    const interaction = companionInteractions.find((item) => item.id === pendingAdultInteraction);
    setPendingAdultScene(null);
    setPendingAdultInteraction(null);

    if (interaction) {
      window.setTimeout(() => void runInteraction(interaction, true), 0);
    } else if (scene) {
      applyScene(scene);
    }
  };

  const cancelAdultAccess = () => {
    setAdultGateOpen(false);
    setPendingAdultScene(null);
    setPendingAdultInteraction(null);
  };

  const disableAdultAccess = () => {
    window.localStorage.removeItem(ADULT_VERIFIED_STORAGE_KEY);
    setAdultVerified(false);
    if (activeSceneId === "flirty") {
      applyScene(companionScenes[0]);
    }
  };

  const saveUserMemory = () => {
    try {
      const saved = writeStoredUserMemory(userMemory);
      setUserMemory(saved);
      setMemoryStatus(hasUserMemory(saved) ? "记忆已保存，会从下一条消息开始生效。" : "记忆已清空。");
    } catch {
      setMemoryStatus("保存失败，请检查浏览器本地存储权限。");
    }
  };

  const clearUserMemory = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(USER_MEMORY_STORAGE_KEY);
    }
    setUserMemory({ ...emptyUserMemory });
    setMemoryStatus("记忆已清空。");
  };

  const resetConversation = async () => {
    if (isLoading) return;

    const currentCharacter = characters.find((item) => item.id === state.characterId) || initialCharacter || null;
    const resetCharacterId = currentCharacter?.id || state.characterId || selectedCharacterId || "lina";
    const resetState = buildDefaultChatState(currentCharacter || undefined, resetCharacterId, welcomeText);
    removeStoredChatState(sessionId, resetCharacterId);
    setIsLoading(true);
    try {
      await clearSessionHistory(sessionId);
    } catch {
      // ignore clear failures
    }

    onResetSession();
    stopSpeaking();

    setState(resetState);
    setInput("");
    setSpeaking(false);
    setSpeechError("");
    setIsLoading(false);
    stopSpeechRecognition();
    stopMediaRecorder();
  };

  const switchCharacter = (nextId: string) => {
    const selected = characters.find((c) => c.id === nextId);
    onCharacterChange(nextId);
    activeChatStorageKeyRef.current = getChatStateStorageKey(sessionId, nextId);
    setState(
      readStoredChatState(sessionId, selected, welcomeText) ||
      buildDefaultChatState(selected, nextId, welcomeText)
    );
  };

  const removeCharacter = async () => {
    if (isLoading) return;

    const currentId = state.characterId || selectedCharacterId;
    if (!currentId) {
      return;
    }
    if (characters.length <= 1) {
      setSpeechError("至少保留一个数字人，不能全部删除");
      return;
    }

    const currentName = characters.find((item) => item.id === currentId)?.name || "该数字人";
    if (typeof window !== "undefined" && !window.confirm(`确定删除「${currentName}」吗？删除后不可恢复。`)) {
      return;
    }

    setIsLoading(true);
    try {
      await onDelete(currentId);
      removeStoredChatStatesForCharacter(currentId);
      const remaining = characters.filter((item) => item.id !== currentId);
      const fallbackCharacter = remaining[0];
      if (fallbackCharacter?.id) {
        activeChatStorageKeyRef.current = getChatStateStorageKey(sessionId, fallbackCharacter.id);
        setState(
          readStoredChatState(sessionId, fallbackCharacter, welcomeText) ||
          buildDefaultChatState(fallbackCharacter, fallbackCharacter.id, welcomeText)
        );
        onCharacterChange(fallbackCharacter.id);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvatarFile = async (fileList: FileList | null, target: "create" | "edit") => {
    const file = fileList?.[0];
    if (!file) return;

    const isImage =
      /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name) ||
      /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type);
    if (!isImage) {
      setSpeechError("请上传 png / jpg / webp / gif / svg 图片");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setSpeechError("头像图片不能超过 8MB");
      return;
    }

    setIsAvatarUploading(true);
    try {
      const fileBase64 = await blobToBase64(file);
      const uploaded = await uploadAvatarFile({
        fileName: file.name,
        fileBase64,
        mimeType: file.type || undefined
      });
      if (target === "create") {
        setForm((prev) => ({ ...prev, avatarUrl: uploaded.avatarUrl }));
        setSpeechError("头像已上传 ✓");
      } else {
        setEditForm((prev) => ({ ...prev, avatarUrl: uploaded.avatarUrl }));
        setEditStatus("头像已上传，记得点「保存修改」生效");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "头像上传失败";
      if (target === "create") {
        setSpeechError(message);
      } else {
        setEditStatus(message);
      }
    } finally {
      setIsAvatarUploading(false);
    }
  };

  const saveEdit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (isEditSaving || isAvatarUploading) return;

    const currentId = state.characterId || selectedCharacterId;
    if (!currentId) return;

    if (!editForm.name.trim() || !editForm.description.trim()) {
      setEditStatus("名字和人设描述不能为空");
      return;
    }

    setIsEditSaving(true);
    setEditStatus("");
    try {
      const { human } = await updateDigitalHuman(currentId, {
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        avatarUrl: editForm.avatarUrl.trim() || undefined,
        voice: editForm.voice.trim() || "冰糖",
        voiceProvider: "mimo",
        defaultMood: editForm.defaultMood,
        relationshipMode: editForm.relationshipMode,
        personalityTagline: editForm.personalityTagline.trim()
      });
      onUpdate(human);
      setEditStatus("已保存 ✓");
    } catch (error) {
      setEditStatus(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setIsEditSaving(false);
    }
  };

  const handleModelFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const isModelFile =
      file.name.toLowerCase().endsWith(".glb") ||
      file.name.toLowerCase().endsWith(".gltf") ||
      file.type === "model/gltf-binary" ||
      file.type === "model/gltf+json";

    if (!isModelFile) {
      setSpeechError("请上传 .glb 或 .gltf 模型文件");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    modelObjectUrlsRef.current.push(objectUrl);
    setForm((prev) => ({ ...prev, modelUrl: objectUrl }));
    setIsModelUploading(true);
    setSpeechError("模型已进入本地预览，正在尝试上传到后端...");

    try {
      const fileBase64 = await blobToBase64(file);
      const uploaded = await uploadModelFile({
        fileName: file.name,
        fileBase64,
        mimeType: file.type || undefined,
        fallbackUrl: objectUrl
      });
      setForm((prev) => ({ ...prev, modelUrl: uploaded.modelUrl }));
      setSpeechError(uploaded.hasFallback ? "静态模式已使用本地模型预览；刷新页面后请重新上传。" : "模型已上传，可创建持久化 3D 数字人。");
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "模型上传失败，已保留本地预览");
    } finally {
      setIsModelUploading(false);
    }
  };

  const create = async (evt: FormEvent) => {
    evt.preventDefault();
    if (isLoading || isModelUploading) return;

    const emotionProfile = parseEmotionProfile(form.emotionProfile);
    const avatarVideoProfile = parseEmotionProfile(form.avatarVideoProfile);
    const payload: CreateHumanRequest = {
      name: form.name.trim(),
      description: form.description.trim(),
      avatarUrl: form.avatarUrl.trim(),
      modelUrl: form.modelUrl.trim() || undefined,
      avatarType: form.avatarType,
      voiceProvider: form.voiceProvider,
      voice: form.voice.trim() || "nova",
      defaultMood: form.defaultMood,
      personalityTagline: form.personalityTagline.trim(),
      relationshipMode: form.relationshipMode,
      ...(emotionProfile ? { emotionProfile } : {}),
      ...(avatarVideoProfile ? { avatarVideoProfile } : {})
    };

    if (!payload.name || !payload.description || !payload.avatarUrl || !payload.voice) {
      setSpeechError("请完整填写数字人信息");
      return;
    }

    try {
      const created = await createDigitalHuman(payload);
      onCreate(created.human);
      onCharacterChange(created.human.id);
      activeChatStorageKeyRef.current = getChatStateStorageKey(sessionId, created.human.id);
      setState(buildDefaultChatState(created.human, created.human.id, welcomeText));
      setForm({
        ...form,
        name: "",
        description: "",
        avatarUrl: defaultAvatarUrl,
        modelUrl: "",
        voiceProvider: "mimo",
        voice: "冰糖",
        emotionProfile: "{}",
        avatarType: "image",
        avatarVideoProfile: "{}",
        personalityTagline: "",
        relationshipMode: "sweet",
        defaultMood: "neutral"
      });
    } catch (_e) {
      // create failed: keep form for retry, do not block chat
    }
  };

  const toggleVoiceInput = () => {
    if (isLoading || isTranscribing) {
      return;
    }

    if (!speechSupported && !mediaRecorderSupported) {
      setSpeechError("当前环境不支持语音输入，请手动输入");
      return;
    }

    if (isRecording) {
      stopSpeechRecognition();
      stopMediaRecorder();
      return;
    }

    if (speechSupported) {
      startSpeechRecognition();
      return;
    }

    void startMediaRecorder();
  };

  const startVoiceHold = () => {
    if (isLoading || isTranscribing) {
      return;
    }

    suppressClickAfterHoldRef.current = true;
    toggleVoiceInput();
  };

  const stopVoiceHold = () => {
    if (!isRecording || isLoading || isTranscribing) {
      return;
    }

    stopSpeechRecognition();
    stopMediaRecorder();
  };

  const canUseVoiceInput = speechSupported || mediaRecorderSupported;

  const toggleAvatarMode = () => {
    setUse3D((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(AVATAR_MODE_STORAGE_KEY, next ? "3d" : "2d");
      }
      return next;
    });
  };

  const toggleAutoVoice = () => {
    const next = !autoVoice;
    window.localStorage.setItem(AUTO_VOICE_STORAGE_KEY, String(next));
    setAutoVoice(next);
    if (!next) stopSpeaking();
  };

  const changeVoiceStyle = (nextStyle: VoiceStyle) => {
    setVoiceStyle(nextStyle);
    window.localStorage.setItem(VOICE_STYLE_STORAGE_KEY, nextStyle);
  };

  const onVoiceButtonClick = () => {
    if (suppressClickAfterHoldRef.current) {
      suppressClickAfterHoldRef.current = false;
      return;
    }

    toggleVoiceInput();
  };

  const exportArchive = () => {
    if (typeof window === "undefined") return;

    try {
      const archive = buildLocalArchive(sessionId, state.characterId || selectedCharacterId || "lina", state, activeSceneId);
      const blob = new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `digital-girlfriend-archive-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setSpeechError(`已导出 ${archive.localHumans.length} 个自定义数字人和 ${archive.chatStates.length} 组聊天记录。`);
    } catch {
      setSpeechError("导出失败，请稍后重试");
    }
  };

  const importArchive = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      const result = importLocalArchive(JSON.parse(raw));
      setSpeechError(`已导入 ${result.humans} 个数字人、${result.chats} 组聊天记录${result.hasMemory ? "和长期记忆" : ""}，正在刷新...`);
      window.setTimeout(() => window.location.reload(), 300);
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "导入失败，请检查 JSON 文件");
    } finally {
      if (archiveInputRef.current) {
        archiveInputRef.current.value = "";
      }
    }
  };

  return (
    <div className="layout">
      <section className="left">
        <div className="persona-card">
          <h2>数字人</h2>
          <label>切换形象</label>
          <select value={state.characterId} onChange={(evt) => switchCharacter(evt.target.value)}>
            {characters.map((char) => (
              <option key={char.id} value={char.id}>
                {char.name}
              </option>
            ))}
          </select>
          <label>关系风格</label>
          <select
            value={state.relationshipMode}
            onChange={(evt) => {
              setState((prev) => ({
                ...prev,
                relationshipMode: evt.target.value as (typeof relationshipModes)[number]
              }));
            }}
          >
            {relationshipModes.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
          <button type="button" className="delete-btn" onClick={removeCharacter} disabled={isLoading || characters.length <= 1}>
            <Trash2 size={14} /> 删除当前数字人
          </button>
          <p className="desc">{characters.find((c) => c.id === state.characterId)?.description}</p>
        </div>

        <Avatar
          emotion={state.emotion}
          speaking={speaking}
          avatarUrl={activeCharacter?.avatarUrl || defaultAvatarUrl}
          modelUrl={activeCharacter?.modelUrl}
          name={activeCharacter?.name || "数字人"}
          emotionProfile={activeCharacter?.emotionProfile}
          avatarType={activeCharacter?.avatarType}
          avatarVideoProfile={activeCharacter?.avatarVideoProfile}
          use3D={use3D}
          interaction={avatarInteraction}
        />

        <details className="side-disclosure">
          <summary><Save size={16} /> 编辑当前数字人</summary>
          <form onSubmit={saveEdit} className="creator creator-v2">
            <label className="field">
              <span className="field-label">名字</span>
              <input
                value={editForm.name}
                onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="数字人名字"
              />
            </label>

            <label className="field">
              <span className="field-label">人设描述</span>
              <input
                value={editForm.description}
                onChange={(e) => setEditForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="她的性格、身份、说话风格"
              />
            </label>

            <div className="field">
              <span className="field-label">头像（静态图片）</span>
              <label className="file-picker">
                {isAvatarUploading ? "上传中..." : "上传新头像（png/jpg/webp/gif/svg，≤8MB）"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  disabled={isAvatarUploading}
                  onChange={(e) => handleAvatarFile(e.currentTarget.files, "edit")}
                />
              </label>
              <input
                value={editForm.avatarUrl}
                onChange={(e) => setEditForm((prev) => ({ ...prev, avatarUrl: e.target.value }))}
                placeholder="也可直接粘贴图片 URL"
              />
              {editForm.avatarUrl ? (
                <img
                  src={resolveMediaUrl(editForm.avatarUrl)}
                  alt="头像预览"
                  style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", marginTop: 6 }}
                />
              ) : null}
            </div>

            <label className="field">
              <span className="field-label">音色</span>
              <select
                value={editForm.voice === "冰糖" ? "冰糖" : ""}
                onChange={(e) => setEditForm((prev) => ({ ...prev, voice: e.target.value || "" }))}
              >
                <option value="冰糖">冰糖（推荐）</option>
                <option value="">其他音色（请在下方填写）</option>
              </select>
              {editForm.voice !== "冰糖" && (
                <input
                  value={editForm.voice}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, voice: e.target.value }))}
                  placeholder="填写 MiMo 音色名称"
                />
              )}
            </label>

            <label className="field">
              <span className="field-label">默认情绪</span>
              <select
                value={editForm.defaultMood}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, defaultMood: e.target.value as (typeof moods)[number] }))
                }
              >
                {moods.map((mood) => (
                  <option key={mood} value={mood}>
                    {moodLabelMap[mood]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">关系模式</span>
              <select
                value={editForm.relationshipMode}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, relationshipMode: e.target.value as (typeof relationshipModes)[number] }))
                }
              >
                {relationshipModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {relationshipModeLabelMap[mode]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">人设口令（可选）</span>
              <input
                value={editForm.personalityTagline}
                onChange={(e) => setEditForm((prev) => ({ ...prev, personalityTagline: e.target.value }))}
                placeholder="例如：轻松撒娇，但不越界"
              />
            </label>

            {editStatus ? <small className="field-hint">{editStatus}</small> : null}
            <button type="submit" disabled={isEditSaving || isAvatarUploading}>
              {isEditSaving ? "保存中..." : "保存修改"}
            </button>
          </form>
        </details>

        <details className="side-disclosure">
          <summary><Sparkles size={16} /> 创建数字人</summary>
          <form onSubmit={create} className="creator creator-v2">
            <label className="field">
              <span className="field-label">名字</span>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="例如：小冰"
              />
            </label>

            <label className="field">
              <span className="field-label">人设描述</span>
              <input
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="她的性格、身份、说话风格，例如：温柔懂事的女大学生"
              />
            </label>

            <div className="field">
              <span className="field-label">头像（静态图片）</span>
              <label className="file-picker">
                {isAvatarUploading ? "上传中..." : "上传头像图片（png/jpg/webp/gif/svg，≤8MB）"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  disabled={isAvatarUploading}
                  onChange={(e) => handleAvatarFile(e.currentTarget.files, "create")}
                />
              </label>
              <input
                value={form.avatarUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, avatarUrl: e.target.value }))}
                placeholder="也可直接粘贴图片 URL，留空使用默认头像"
              />
              {form.avatarUrl ? (
                <img
                  src={resolveMediaUrl(form.avatarUrl)}
                  alt="头像预览"
                  style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", marginTop: 6 }}
                />
              ) : null}
            </div>

            <details className="creator-advanced">
              <summary>3D 模型（可选，默认使用静态头像）</summary>
              <label className="field">
                <span className="field-label">模型地址</span>
                <input
                  value={form.modelUrl}
                  onChange={(e) => setForm((prev) => ({ ...prev, modelUrl: e.target.value }))}
                  placeholder="GLB/GLTF 在线地址，或从下方上传"
                />
              </label>
              <label className="file-picker">
                上传 GLB/GLTF 模型
                <input
                  type="file"
                  accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
                  onChange={(e) => handleModelFile(e.currentTarget.files)}
                />
              </label>
            </details>

            <label className="field">
              <span className="field-label">音色</span>
              <select
                value={form.voice || ""}
                onChange={(e) => setForm((prev) => ({ ...prev, voice: e.target.value }))}
              >
                <option value="冰糖">冰糖（推荐）</option>
                <option value="">其他音色（请在下方填写）</option>
              </select>
              {form.voice !== "冰糖" && (
                <input
                  value={form.voice}
                  onChange={(e) => setForm((prev) => ({ ...prev, voice: e.target.value }))}
                  placeholder="填写 MiMo 音色名称"
                />
              )}
              <small className="field-hint">语音合成由 MiMo TTS 自动接入，无需额外配置 OpenAI/Azure。</small>
            </label>

            <label className="field">
              <span className="field-label">默认情绪</span>
              <select
                value={form.defaultMood}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, defaultMood: e.target.value as (typeof moods)[number] }))
                }
              >
                {moods.map((mood) => (
                  <option key={mood} value={mood}>
                    {moodLabelMap[mood]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">关系模式</span>
              <select
                value={form.relationshipMode}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, relationshipMode: e.target.value as (typeof relationshipModes)[number] }))
                }
              >
                {relationshipModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {relationshipModeLabelMap[mode]}
                  </option>
                ))}
              </select>
              <small className="field-hint">决定她和你互动的整体语气。</small>
            </label>

            <label className="field">
              <span className="field-label">头像模式</span>
              <select
                value={form.avatarType}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, avatarType: e.target.value === "video" ? "video" : "image" }))
                }
              >
                <option value="image">静态头像</option>
                <option value="video">动态视频（需额外提供情绪视频资源）</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">人设口令（可选）</span>
              <input
                value={form.personalityTagline}
                onChange={(e) => setForm((prev) => ({ ...prev, personalityTagline: e.target.value }))}
                placeholder="例如：轻松撒娇，但不越界"
              />
            </label>

            <button type="submit" disabled={isModelUploading}>
              {isModelUploading ? "上传模型中..." : "创建"}
            </button>
          </form>
        </details>

        <details className="side-disclosure memory-disclosure">
          <summary>
            <Brain size={16} />
            关系与记忆
            <span className={memoryIsActive ? "memory-state active" : "memory-state"}>{memoryIsActive ? "已启用" : "未设置"}</span>
          </summary>
          <section className="relationship-card">
          <h3>关系状态</h3>
          <p>
            阶段：{state.context ? relationshipLabelMap[state.context.relationshipAffinity] : "待启动"}（{state.context?.turnCount || 0}
            回合）
          </p>
          <p>对话风格：{state.relationshipMode || state.context?.activeRelationshipMode || "sweet"}</p>
          <p>上次情绪：{state.context?.lastEmotion || state.emotion}</p>
          {state.context?.summary ? <p className="relationship-summary">{state.context.summary}</p> : null}
          {state.context?.userSignals?.length ? (
            <p className="relationship-signals">关键词：{state.context.userSignals.join("、")}</p>
          ) : null}
          </section>

          <section className="memory-card">
          <div className="memory-title">
            <Brain size={16} />
            <h3>长期记忆</h3>
          </div>
          <label>我是谁</label>
          <input
            value={userMemory.displayName}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, displayName: e.target.value }))}
            placeholder="例如：林，做科研和产品"
          />
          <label>希望她怎么称呼我</label>
          <input
            value={userMemory.preferredName}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, preferredName: e.target.value }))}
            placeholder="例如：哥哥 / 阿林 / 亲爱的"
          />
          <label>聊天偏好</label>
          <textarea
            rows={2}
            value={userMemory.preferences}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, preferences: e.target.value }))}
            placeholder="例如：语气自然一点，开心时可以撒娇，压力大时先安慰"
          />
          <label>重要事实</label>
          <textarea
            rows={2}
            value={userMemory.importantFacts}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, importantFacts: e.target.value }))}
            placeholder="例如：最近在做数字女友项目、经常晚上工作"
          />
          <label>聊天禁忌或边界</label>
          <textarea
            rows={2}
            value={userMemory.boundaries}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, boundaries: e.target.value }))}
            placeholder="例如：不要说教；不喜欢机械式客服语气"
          />
          <label>关系备注</label>
          <textarea
            rows={2}
            value={userMemory.relationshipNotes}
            onChange={(e) => setUserMemory((prev) => ({ ...prev, relationshipNotes: e.target.value }))}
            placeholder="例如：关系节奏偏暧昧、直接、陪伴感强"
          />
          <div className="memory-actions">
            <button type="button" onClick={saveUserMemory}>
              <Save size={15} />
              保存记忆
            </button>
            <button type="button" className="secondary-btn" onClick={clearUserMemory}>
              清空
            </button>
          </div>
          {memoryStatus ? <p className="memory-status">{memoryStatus}</p> : null}
          </section>
        </details>
      </section>

      <section className="right">
        <div className={`mobile-companion-hero ${avatarInteraction ? `interaction-${avatarInteraction}` : ""}`}>
          <img
            src={resolveMediaUrl(activeCharacter?.avatarUrl || defaultAvatarUrl) || defaultAvatarUrl}
            alt={activeCharacter?.name || "数字女友"}
          />
          <div>
            <strong>{activeCharacter?.name || "数字女友"}</strong>
            <span>{activeScene.label} · 在线陪你</span>
          </div>
        </div>
        <section className="scene-card" aria-label="陪伴场景">
          <div className="scene-header">
            <div>
              <h3>陪伴场景</h3>
              <p>{activeScene.description}</p>
            </div>
            <span className="scene-current">{activeScene.label}</span>
          </div>
          <div className="scene-grid">
            {companionScenes.map((scene) => (
              <button
                key={scene.id}
                type="button"
                className={scene.id === activeSceneId ? "scene-btn active" : "scene-btn"}
                onClick={() => selectScene(scene)}
                disabled={isLoading}
                aria-pressed={scene.id === activeSceneId}
              >
                {renderSceneIcon(scene.id)}
                <span>{scene.label}</span>
              </button>
            ))}
          </div>
          <div className="scene-starters">
            {activeScene.starters.map((starter) => (
              <button
                key={starter}
                type="button"
                className="starter-btn"
                onClick={() => useSceneStarter(starter)}
                disabled={isLoading}
              >
                {starter}
              </button>
            ))}
          </div>
        </section>
        <section className="interaction-bar" aria-label="亲密互动">
          <div className="interaction-heading">
            <span>和 {activeCharacter?.name || "她"} 互动</span>
            <span className="interaction-hint">点击后直接开始一轮对话</span>
          </div>
          <div className="interaction-actions">
            {companionInteractions.map((interaction) => (
              <button
                key={interaction.id}
                type="button"
                className={avatarInteraction === interaction.id ? "interaction-btn active" : "interaction-btn"}
                onClick={() => void runInteraction(interaction)}
                disabled={isLoading}
                title={`${interaction.label}：${interaction.message}`}
              >
                {renderInteractionIcon(interaction.id)}
                <span>{interaction.label}</span>
              </button>
            ))}
          </div>
        </section>
        <div className="conversation-toolbar">
          <span
            className={`connection-status ${experienceMode}`}
            title={experienceMode === "local" ? "当前使用静态 Pages 的本地陪伴引擎" : "当前由已连接的 AI 服务生成回复"}
          >
            <i /> {experienceMode === "local" ? "本地陪伴" : "AI 已连接"}
          </span>
          <div className="voice-controls">
            <button
              type="button"
              className={autoVoice ? "auto-voice-btn active" : "auto-voice-btn"}
              onClick={toggleAutoVoice}
              aria-pressed={autoVoice}
              title={autoVoice ? "关闭自动语音" : "开启自动语音"}
            >
              {autoVoice ? <Volume2 size={16} /> : <VolumeX size={16} />}
              <span>{autoVoice ? "自动语音" : "语音关闭"}</span>
            </button>
            <label className="voice-style-select">
              <span className="sr-only">语音风格</span>
              <select value={voiceStyle} onChange={(event) => changeVoiceStyle(event.target.value as VoiceStyle)}>
                {voiceStyleOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <details className="chat-menu">
              <summary title="聊天设置" aria-label="聊天设置"><Settings2 size={18} /></summary>
              <div className="chat-menu-panel">
                <button type="button" onClick={resetConversation} disabled={isLoading}>
                  <Trash2 size={16} /> 清空对话
                </button>
                <button type="button" onClick={exportArchive} disabled={isLoading}>
                  <Download size={16} /> 导出记录
                </button>
                <button type="button" onClick={() => archiveInputRef.current?.click()} disabled={isLoading}>
                  <Upload size={16} /> 导入记录
                </button>
                <button type="button" onClick={toggleAvatarMode}>
                  {use3D ? <ImageIcon size={16} /> : <Box size={16} />}
                  切换到 {use3D ? "2D" : "3D"}
                </button>
                {adultVerified ? (
                  <button type="button" onClick={disableAdultAccess}>
                    <Shield size={16} /> 退出成人模式
                  </button>
                ) : null}
              </div>
            </details>
          </div>
          <input
            ref={archiveInputRef}
            className="archive-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void importArchive(event.currentTarget.files)}
          />
        </div>
        <div className="chat-list" ref={chatScrollRef}>
          {state.messages.map((message, idx) => (
            <div key={`${message.role}-${idx}`} className={`message-row ${message.role}`}>
              {message.role === "assistant" ? (
                <img
                  className="message-avatar"
                  src={resolveMediaUrl(activeCharacter?.avatarUrl || defaultAvatarUrl) || defaultAvatarUrl}
                  alt=""
                />
              ) : null}
              <div className={`bubble ${message.role}`}>
                <p>{message.content}</p>
                {message.role === "assistant" ? (
                  <button
                    type="button"
                    className="message-audio-btn"
                    onClick={() => speakAudio(undefined, message.content, true)}
                    aria-label="播放这条回复"
                    title="播放这条回复"
                  >
                    <Volume2 size={14} />
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {isLoading && state.messages[state.messages.length - 1]?.role === "user" ? (
            <div className="message-row assistant typing-row" aria-label={`${activeCharacter?.name || "她"}正在回复`}>
              <img
                className="message-avatar"
                src={resolveMediaUrl(activeCharacter?.avatarUrl || defaultAvatarUrl) || defaultAvatarUrl}
                alt=""
              />
              <div className="typing-indicator"><span /><span /><span /></div>
            </div>
          ) : null}
        </div>
        <form onSubmit={submit} className="input-bar">
          {canUseVoiceInput ? (
          <button
            type="button"
            className={`voice-btn ${isRecording ? "recording" : isTranscribing ? "loading" : ""}`}
            onMouseDown={startVoiceHold}
            onMouseUp={stopVoiceHold}
            onMouseLeave={stopVoiceHold}
            onTouchStart={startVoiceHold}
            onTouchEnd={stopVoiceHold}
            onTouchCancel={stopVoiceHold}
            onClick={onVoiceButtonClick}
            aria-label={isRecording ? "停止录音" : isTranscribing ? "语音识别中" : "开始语音输入"}
            disabled={isLoading || isTranscribing}
          >
            {isRecording ? <MicOff size={18} /> : <Mic size={18} />}
            <span className={isRecording || isTranscribing ? "" : "sr-only"}>
              {isRecording ? "松开发送" : isTranscribing ? "识别中..." : "按住说话"}
            </span>
          </button>
          ) : null}
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInputWithEmotion(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`和 ${activeCharacter?.name || "她"} 说点什么...`}
            disabled={isLoading}
          />
          <button type="submit" className="send-btn" disabled={isLoading || !input.trim()} aria-label="发送" title="发送">
            <Send size={18} />
          </button>
        </form>
        {speechError ? <div className="speech-hint" role="status">{speechError}</div> : null}
      </section>
      {adultGateOpen ? (
        <div className="adult-gate-backdrop" role="presentation" onMouseDown={cancelAdultAccess}>
          <section
            className="adult-gate"
            role="dialog"
            aria-modal="true"
            aria-labelledby="adult-gate-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="adult-gate-badge">18+</span>
            <h2 id="adult-gate-title">确认进入成人亲密模式</h2>
            <p>此模式允许更直接的暧昧与性爱表达。请确认你已年满 18 周岁，并同意所有互动以成年人之间自愿、可随时停止为前提。</p>
            <div className="adult-gate-actions">
              <button type="button" className="secondary-btn" onClick={cancelAdultAccess}>暂不进入</button>
              <button type="button" onClick={confirmAdultAccess}>我已满 18 岁并同意</button>
            </div>
          </section>
        </div>
      ) : null}
      <audio ref={audioRef} />
    </div>
  );
}
