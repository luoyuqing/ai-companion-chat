export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export type Emotion = "happy" | "sad" | "surprise" | "wink" | "neutral" | "angry" | "love";
export type EmotionProfile = Partial<Record<Emotion, string>>;
export type RelationshipMode = "sweet" | "flirty" | "playful" | "mature";

export type MimoAudioModel = "mimo-v2.5-tts" | "mimo-v2.5-tts-voicedesign" | "mimo-v2.5-tts-voiceclone";

export interface VoiceProfile {
  provider: "openai" | "azure" | "local" | "mimo";
  voice: string;
  audioModel?: MimoAudioModel;
  voiceId?: string;
  stylePrompt?: string;
  voiceDesignPrompt?: string;
  voiceCloneSample?: string;
}

export interface ChatContext {
  relationshipAffinity: "new" | "warm" | "close" | "intimate";
  activeRelationshipMode?: RelationshipMode;
  summary: string;
  userSignals: string[];
  lastEmotion: Emotion;
  turnCount: number;
  updatedAt: string;
}

export interface ChatRequest {
  sessionId: string;
  characterId: string;
  message: string;
  history: Message[];
  relationshipMode?: RelationshipMode;
}

export type ChatMessageRequest = ChatRequest;

export interface ChatResponse {
  sessionId: string;
  characterId: string;
  text: string;
  emotion: Emotion;
  context?: ChatContext;
  audioUrl?: string;
  hasFallback?: boolean;
}

export interface StreamDoneResponse {
  sessionId: string;
  characterId: string;
  text: string;
  emotion: Emotion;
  context?: ChatContext;
  audioUrl?: string;
  hasFallback?: boolean;
}

export interface ChatStreamEvents {
  onChunk?: (chunk: { text: string }) => void;
  onEmotion?: (emotion: Emotion) => void;
  onDone?: (payload: StreamDoneResponse) => void;
}

export interface TranscribeResponse {
  text: string;
}

export interface ModelUploadResponse {
  modelUrl: string;
  fileName: string;
  mimeType?: string;
  size: number;
  hasFallback?: boolean;
}

export interface DigitalHuman {
  id: string;
  name: string;
  description: string;
  avatarUrl: string;
  modelUrl?: string;
  emotionProfile?: EmotionProfile;
  avatarType?: "image" | "video";
  avatarVideoProfile?: EmotionProfile;
  personalityTagline?: string;
  relationshipMode?: "sweet" | "flirty" | "playful" | "mature";
  voiceProfile: VoiceProfile;
  defaultMood: Emotion;
}

export interface CreateHumanRequest {
  name: string;
  description: string;
  avatarUrl: string;
  modelUrl?: string;
  avatarType?: "image" | "video";
  voiceProvider?: "openai" | "azure" | "local" | "mimo";
  voice: string;
  audioModel?: MimoAudioModel;
  voiceId?: string;
  stylePrompt?: string;
  voiceDesignPrompt?: string;
  voiceCloneSample?: string;
  defaultMood?: Emotion;
  emotionProfile?: EmotionProfile;
  avatarVideoProfile?: EmotionProfile;
  personalityTagline?: string;
  relationshipMode?: "sweet" | "flirty" | "playful" | "mature";
  telegramBotToken?: string;
}

export type UpdateHumanRequest = Partial<CreateHumanRequest>;

declare global {
  interface Window {
    __DG_API_BASE?: string;
  }
}

const VITE_API_BASE = import.meta.env.VITE_API_URL?.trim();
const WINDOW_API_BASE = typeof window === "undefined" ? "" : window.location.origin;
const GLOBAL_API_BASE = typeof window === "undefined" ? "" : window.__DG_API_BASE;
const FALLBACK_DEV_PORT = "8787";
const HAS_CONFIGURED_API_BASE = Boolean(VITE_API_BASE || GLOBAL_API_BASE);
const LOCAL_HUMANS_KEY = "dg-local-digital-humans-v1";
const LOCAL_CONTEXT_KEY = "dg-local-chat-context-v1";

const BUILT_IN_HUMANS: DigitalHuman[] = [
  {
    id: "lina",
    name: "Lina",
    description: "28 岁亚欧混血。成熟明艳、曲线优雅，亲密时主动而直接。",
    personalityTagline: "外表自信性感，私下温柔黏人；会自然调情，也能认真接住情绪。",
    relationshipMode: "flirty",
    avatarUrl: "/assets/avatars/lina-original.jpg",
    emotionProfile: {
      happy: "/assets/expressions/happy.svg",
      sad: "/assets/expressions/sad.svg",
      surprise: "/assets/expressions/surprise.svg",
      wink: "/assets/expressions/wink.svg",
      neutral: "/assets/expressions/neutral.svg",
      angry: "/assets/expressions/angry.svg",
      love: "/assets/expressions/love.svg"
    },
    voiceProfile: { provider: "local", voice: "browser-zh-CN" },
    defaultMood: "happy"
  },
  {
    id: "moon",
    name: "Moon",
    description: "29 岁亚欧混血。冷调优雅、身材曼妙，表达克制但不含糊。",
    personalityTagline: "成熟感性，擅长共情与慢节奏暧昧；亲密时更有掌控感。",
    relationshipMode: "mature",
    avatarUrl: "/assets/avatars/moon-original.jpg",
    emotionProfile: {
      happy: "/assets/expressions/happy.svg",
      sad: "/assets/expressions/sad.svg",
      surprise: "/assets/expressions/surprise.svg",
      wink: "/assets/expressions/wink.svg",
      neutral: "/assets/expressions/neutral.svg",
      angry: "/assets/expressions/angry.svg",
      love: "/assets/expressions/love.svg"
    },
    voiceProfile: { provider: "local", voice: "browser-zh-CN" },
    defaultMood: "wink"
  }
];

const localEmotionKeywords: Record<Emotion, string[]> = {
  happy: ["开心", "高兴", "喜欢", "棒", "好", "哈哈", "快乐", "great", "nice", "cool"],
  sad: ["难过", "伤心", "失落", "烦", "哭", "心碎", "失望", "sad"],
  surprise: ["惊讶", "真的吗", "怎么会", "哇", "天啊", "不可思议", "wow"],
  wink: ["撩", "调皮", "开玩笑", "可爱", "坏", "flirty", "暧昧"],
  neutral: [],
  angry: ["生气", "愤怒", "气死", "讨厌", "烦躁", "annoyed", "hate"],
  love: ["想你", "宝贝", "亲爱", "抱抱", "亲亲", "kiss", "爱你", "恋爱", "心动"]
};

type LocalIntent =
  | "greeting"
  | "checkin"
  | "affection"
  | "adult"
  | "comfort"
  | "anger"
  | "bedtime"
  | "date"
  | "food"
  | "movie"
  | "celebrate"
  | "advice"
  | "question"
  | "sharing";

type LocalSceneId = "daily" | "date" | "comfort" | "flirty" | "bedtime";

const localReplyLibrary: Record<LocalIntent, readonly string[]> = {
  greeting: [
    "在呀。刚刚还在想，你今天会不会来找我。现在想让我怎么陪你？",
    "你来啦。先靠近一点，告诉我今天过得怎么样？",
    "我在。看到你出现，心里一下就安静了。今天想聊轻松的，还是想认真说说心事？",
    "嗯，我听见你了。先不用想好话题，随便说一句也可以。"
  ],
  checkin: [
    "刚刚在等你，也在想我们今晚可以聊到多晚。你呢，手头的事忙完了吗？",
    "没做什么特别的，留了一点安静给你。你现在是在休息，还是还被事情缠着？",
    "在这里呀。你一来，我就把注意力给你了。今天最想先告诉我什么？"
  ],
  affection: [
    "嗯，听到了。过来一点，让我认真抱你几秒。今天怎么突然这么想我？",
    "你这样直接说，我真的会心软。再靠近一点，今晚我想多陪你一会儿。",
    "我也想你，而且比刚才更想了。你想听我哄你，还是想让我更主动一点？",
    "这句话我收好了。现在不许躲，让我看看你说完以后是不是在偷偷笑。"
  ],
  adult: [
    "那我不绕弯了。我想把你拉近，吻住你，手臂紧紧环住你的腰，再听你亲口告诉我还想要什么。",
    "今晚可以更大胆一点。你说继续，我就不再装矜持；但每一步，都要是你也真心想要的。",
    "我会贴到你耳边，把想要你的心思说得很清楚。别只看着我，把你真正想要的也告诉我。",
    "我想从你的唇角慢慢吻到颈侧，感受你主动靠近的那一刻。现在，想让我温柔一点，还是更强势一点？"
  ],
  comfort: [
    "先不用逼自己振作。你已经撑了一段时间了，现在可以在我这里松一点。最让你难受的是哪一部分？",
    "听起来你今天真的消耗得很厉害。先靠过来，我不讲道理，只陪你把这口气慢慢放下来。",
    "那种明明很难受、还得装作没事的感觉，很憋。你不用在我面前撑着，想从哪里说都可以。",
    "我不急着给你答案。先告诉我，是身体累，还是心里那件事一直放不下？"
  ],
  anger: [
    "听起来你不是单纯烦，是那件事真的踩到你的底线了。先别压着，我在。到底哪一句最让你受不了？",
    "好，我先站你这边。火气不用马上收回去，先把最气的那一段说给我听。",
    "我能感觉到你忍了很久。现在不用顾着体面，把真实的那句说出来也没关系。",
    "先慢一点呼吸，我不会叫你立刻冷静。你想让我只听，还是陪你一起想怎么处理？"
  ],
  bedtime: [
    "把灯调暗一点，手机也拿远一点。今晚先不用解决任何事，我陪你把这一天轻轻放下。",
    "还睡不着吗？那就把眼睛闭上，我说慢一点。你只要听着，不用急着回我。",
    "过来躺好。今天没完成的事先留给明天，现在只管呼吸，我会陪到你困。",
    "今晚辛苦了。想听一个很轻的晚安，还是想在睡前再把一件心事交给我？"
  ],
  date: [
    "那今晚我来安排：先找一家安静的小店坐窗边，再慢慢散步回去。你想把第一站放在哪里？",
    "好呀，就当我已经走到你面前了。别赶行程，我们先并肩走一段，再决定去吃什么。",
    "这次约会我想留一点惊喜，但最后一站让你选。是看夜景，还是去喝杯热的？",
    "如果现在就出门，我会穿得简单一点去接你。你想要热闹的约会，还是只属于我们两个人的安静？"
  ],
  food: [
    "如果现在想吃得舒服一点，我会选一碗热汤面；想奖励自己，就去吃你惦记最久的那家。你今晚更想被安慰，还是想放纵一下？",
    "别再随便对付一口了。我们选个有热气的：小火锅、汤饭，或者一碗馄饨。你现在最想要哪种味道？",
    "我投你真正想吃的那一票。先告诉我，今天是想清淡一点，还是想吃点有幸福感的？"
  ],
  movie: [
    "今晚别选太费脑子的。想放松就看轻喜剧，想靠近一点就选爱情片。你想笑，还是想被情绪带走？",
    "可以呀，我们就当坐在同一张沙发上。你选片，我负责在好看的地方和你一起安静下来。",
    "我想挑一部看完还能继续聊很久的。你现在更想看温柔的、刺激的，还是有点暧昧的？"
  ],
  celebrate: [
    "这件事值得认真开心一下。先别急着谦虚，告诉我你最满意自己的哪一部分？",
    "我已经替你笑起来了。今天这份好心情不许草草带过，我们给它留一个小小的庆祝吧。",
    "做得漂亮。来，让我先抱一下今天这么争气的你。接下来最想怎么奖励自己？"
  ],
  advice: [
    "先别急着做决定。把你最舍不得的和最担心的各说一个，我陪你把真正卡住的地方找出来。",
    "我可以陪你一起想，但不想替你草率下结论。现在最坏的结果是什么，你最想保住的又是什么？",
    "这件事听起来不是没有答案，而是每个答案都有代价。我们先从你最不能接受的那一种开始排除。"
  ],
  question: [
    "我想认真回答你，不想随口敷衍。你问这个，是刚好遇到了什么，还是只是想听听我的想法？",
    "这个问题我记住了。先告诉我你心里已经偏向哪个答案，我想从你真正犹豫的地方接着聊。",
    "可以问得再具体一点吗？我想给你的不是一句漂亮话，而是真的贴着你现在处境的回答。"
  ],
  sharing: [
    "我在听，而且不是礼貌地听。你说到这里的时候，心里最明显的感觉是什么？",
    "这件事对你的影响，好像比表面上更深一点。继续说，我想知道后来你是怎么撑过去的。",
    "嗯，我跟上了。先别急着把它总结成对或错，告诉我当时那个瞬间你最想做什么？",
    "我能想象那个画面。你现在再提起它，是更放下了一点，还是其实还在意？"
  ]
};

function pickWindowApiBase(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const origin = WINDOW_API_BASE;
  if (!origin || origin === "null") {
    return "";
  }

  try {
    const parsed = new URL(origin);
    const isLocalHost =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1";

    if (isLocalHost) {
      return `${parsed.protocol}//${parsed.hostname}:${FALLBACK_DEV_PORT}`.replace("//::1:", "//[::1]:");
    }
    return origin;
  } catch {
    return origin;
  }
}

const API_BASE = (VITE_API_BASE || GLOBAL_API_BASE || pickWindowApiBase()).replace(/\/$/, "");
export const RESOLVED_API_BASE = API_BASE;
let localFallbackActive = false;

export function isLocalCompanionMode(): boolean {
  return localFallbackActive;
}

function canUseLocalFallback(): boolean {
  return import.meta.env.VITE_DISABLE_LOCAL_FALLBACK !== "true" && typeof window !== "undefined";
}

function activateLocalFallback(): void {
  localFallbackActive = true;
}

function isLocalBrowserHost(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(WINDOW_API_BASE);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function shouldResolveRootAssetFromPublicBase(): boolean {
  return localFallbackActive || (!HAS_CONFIGURED_API_BASE && !isLocalBrowserHost());
}

function cloneHuman(human: DigitalHuman): DigitalHuman {
  return JSON.parse(JSON.stringify(human)) as DigitalHuman;
}

function readLocalJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage can be disabled in private or embedded contexts.
  }
}

function getLocalCustomHumans(): DigitalHuman[] {
  const humans = readLocalJson<DigitalHuman[]>(LOCAL_HUMANS_KEY, []);
  return Array.isArray(humans) ? humans : [];
}

function getLocalHumans(): DigitalHuman[] {
  const custom = getLocalCustomHumans().filter((item) => item?.id && item?.name);
  return [...BUILT_IN_HUMANS.map(cloneHuman), ...custom.map(cloneHuman)];
}

function saveLocalCustomHumans(humans: DigitalHuman[]): void {
  const normalized = humans.filter((item) => item.id?.startsWith("custom-"));
  writeLocalJson(LOCAL_HUMANS_KEY, normalized);
}

function inferLocalEmotion(text: string, fallback: Emotion = "neutral"): Emotion {
  const normalized = text.toLowerCase();
  let matched: Emotion = fallback;
  let maxScore = 0;
  const priority: Record<Emotion, number> = {
    love: 7,
    wink: 6,
    angry: 5,
    sad: 4,
    surprise: 3,
    happy: 2,
    neutral: 1
  };

  (Object.entries(localEmotionKeywords) as Array<[Emotion, string[]]>).forEach(([emotion, words]) => {
    const score = words.reduce((sum, word) => sum + (normalized.includes(word.toLowerCase()) ? 1 : 0), 0);
    if (score > maxScore || (score === maxScore && score > 0 && priority[emotion] > priority[matched])) {
      maxScore = score;
      matched = emotion;
    }
  });

  return maxScore > 0 ? matched : fallback;
}

function localRelationshipLevel(turnCount: number): ChatContext["relationshipAffinity"] {
  if (turnCount >= 12) return "intimate";
  if (turnCount >= 7) return "close";
  if (turnCount >= 3) return "warm";
  return "new";
}

function extractLocalSignals(text: string, previous: string[] = []): string[] {
  const candidates = [
    "工作",
    "学习",
    "压力",
    "睡眠",
    "家人",
    "朋友",
    "恋爱",
    "想你",
    "开心",
    "难过",
    "生气",
    "约会",
    "电影",
    "论文",
    "赚钱",
    "身体",
    "孤独",
    "暧昧"
  ];
  const next = new Set(previous.slice(-5));
  candidates.forEach((item) => {
    if (text.includes(item)) next.add(item);
  });
  return Array.from(next).slice(-6);
}

function readLocalContexts(): Record<string, ChatContext> {
  const contexts = readLocalJson<Record<string, ChatContext>>(LOCAL_CONTEXT_KEY, {});
  return contexts && typeof contexts === "object" && !Array.isArray(contexts) ? contexts : {};
}

function saveLocalContext(sessionId: string, context: ChatContext): void {
  const contexts = readLocalContexts();
  contexts[sessionId || "session-browser"] = context;
  writeLocalJson(LOCAL_CONTEXT_KEY, contexts);
}

function clearLocalContext(sessionId: string): void {
  const contexts = readLocalContexts();
  delete contexts[sessionId || "session-browser"];
  writeLocalJson(LOCAL_CONTEXT_KEY, contexts);
}

function resolveLocalRelationshipMode(
  payload: ChatRequest,
  character: DigitalHuman,
  previous?: ChatContext
): RelationshipMode {
  const normalized = payload.message.toLowerCase();
  const wantsFlirty = ["暧昧", "想你", "爱你", "亲亲", "抱抱", "kiss", "心动"].some((word) => normalized.includes(word));
  if (wantsFlirty && (!payload.relationshipMode || payload.relationshipMode === "sweet")) {
    return "flirty";
  }
  return payload.relationshipMode || previous?.activeRelationshipMode || character.relationshipMode || "sweet";
}

function buildLocalContext(payload: ChatRequest, emotion: Emotion, character: DigitalHuman): ChatContext {
  const contexts = readLocalContexts();
  const previous = contexts[payload.sessionId || "session-browser"];
  const turnCount = (previous?.turnCount || 0) + 1;
  const activeRelationshipMode = resolveLocalRelationshipMode(payload, character, previous);
  const userSignals = extractLocalSignals(payload.message, previous?.userSignals || []);
  const relationshipAffinity = localRelationshipLevel(turnCount);
  const signalText = userSignals.length ? `，最近关键词：${userSignals.join("、")}` : "";

  return {
    relationshipAffinity,
    activeRelationshipMode,
    summary: `已进行 ${turnCount} 回合，对话风格为 ${activeRelationshipMode}${signalText}。`,
    userSignals,
    lastEmotion: emotion,
    turnCount,
    updatedAt: new Date().toISOString()
  };
}

function extractLocalMemorySummary(payload: ChatRequest): { preferredName?: string; profileHint?: string } {
  const memory = payload.history.find((item) => item.role === "system" && item.content.includes("长期记忆"))?.content || "";
  if (!memory) return {};

  const cleanHint = (value?: string) => value?.trim().replace(/[。；;，,\s]+$/g, "");
  const preferredName = memory.match(/希望数字人称呼用户：([^\n]+)/)?.[1]?.trim();
  const preferences = cleanHint(memory.match(/聊天偏好：([^\n]+)/)?.[1]);
  const facts = cleanHint(memory.match(/重要事实：([^\n]+)/)?.[1]);
  const notes = cleanHint(memory.match(/关系备注：([^\n]+)/)?.[1]);
  const hintParts = [preferences, facts, notes].filter(Boolean).slice(0, 2);

  return {
    preferredName,
    profileHint: hintParts.length ? hintParts.join("；") : undefined
  };
}

function extractLocalSceneId(payload: ChatRequest): LocalSceneId {
  const scene = payload.history.find((item) => item.role === "system" && item.content.includes("陪伴场景："))?.content || "";
  if (!scene) return "daily";

  const label = scene.match(/陪伴场景：([^\n]+)/)?.[1]?.trim() || "";
  if (label.includes("约会")) return "date";
  if (label.includes("安慰")) return "comfort";
  if (label.includes("暧昧") || label.includes("亲密")) return "flirty";
  if (label.includes("睡前")) return "bedtime";
  return "daily";
}

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

function inferLocalIntent(message: string, sceneId: LocalSceneId, emotion: Emotion): LocalIntent {
  const normalized = message.trim().toLowerCase();
  const compact = normalized.replace(/[\s，。！？!?、,.]/g, "");
  const adultVerified = payloadHasAdultMarker(message);

  if (
    adultVerified &&
    includesAny(normalized, ["露骨", "更直接", "别太含蓄", "大胆一点", "想要你", "上床", "脱掉", "摸我", "摸你", "胸", "做爱", "性爱", "sex"])
  ) {
    return "adult";
  }
  if (includesAny(normalized, ["晚安", "睡不着", "失眠", "睡觉", "睡前", "好困"]) || sceneId === "bedtime") {
    return "bedtime";
  }
  if (includesAny(normalized, ["难过", "委屈", "孤独", "压力", "崩溃", "撑不住", "心累", "好累", "焦虑", "害怕"]) || sceneId === "comfort") {
    return "comfort";
  }
  if (emotion === "angry" || includesAny(normalized, ["生气", "气死", "愤怒", "讨厌", "烦死", "火大"])) {
    return "anger";
  }
  if (includesAny(normalized, ["想你", "爱你", "喜欢你", "亲亲", "抱抱", "宝贝", "心动", "撩我"]) || (sceneId === "flirty" && compact.length < 24)) {
    return "affection";
  }
  if (includesAny(normalized, ["约会", "散步", "见面", "一起出去", "带我去"]) || sceneId === "date") {
    return "date";
  }
  if (includesAny(normalized, ["吃什么", "吃点什么", "晚饭", "午饭", "夜宵", "饿了"])) return "food";
  if (includesAny(normalized, ["看什么电影", "看电影", "选片", "追剧"])) return "movie";
  if (includesAny(normalized, ["在干嘛", "做什么呢", "忙吗", "有没有想我"])) return "checkin";
  if (/^(在吗|你好|嗨|hi|hello|hey|有人吗|早安|早上好|晚上好)$/.test(compact)) return "greeting";
  if (includesAny(normalized, ["成功了", "通过了", "完成了", "搞定了", "太开心", "好开心", "赢了", "升职", "中奖了"])) return "celebrate";
  if (includesAny(normalized, ["怎么办", "该不该", "怎么选", "要不要", "给我建议", "帮我想"])) return "advice";
  if (/[?？]$/.test(normalized) || includesAny(normalized, ["为什么", "怎么会", "你觉得", "你会", "可以吗", "是不是"])) return "question";
  return "sharing";
}

function payloadHasAdultMarker(message: string): boolean {
  return message.startsWith("[adult-confirmed]");
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chooseVariedReply(options: readonly string[], seed: string, recentAssistantText: string): string {
  if (!options.length) return "我在，慢慢说。";
  const startIndex = stableHash(seed) % options.length;
  for (let offset = 0; offset < options.length; offset += 1) {
    const candidate = options[(startIndex + offset) % options.length] || options[0];
    const opening = candidate.slice(0, 10);
    if (!recentAssistantText.includes(opening)) return candidate;
  }
  return options[startIndex] || options[0];
}

function buildLocalReply(payload: ChatRequest, character: DigitalHuman, emotion: Emotion, context: ChatContext): string {
  const sceneId = extractLocalSceneId(payload);
  const adultConfirmed = payload.history.some(
    (message) => message.role === "system" && message.content.includes("成人模式：已确认")
  );
  const intent = inferLocalIntent(`${adultConfirmed ? "[adult-confirmed]" : ""}${payload.message}`, sceneId, emotion);
  const recentAssistantText = payload.history
    .filter((message) => message.role === "assistant")
    .slice(-2)
    .map((message) => message.content)
    .join(" ");
  const seed = `${payload.message}|${character.id}|${context.turnCount}|${context.activeRelationshipMode}|${sceneId}`;
  let reply = chooseVariedReply(localReplyLibrary[intent], seed, recentAssistantText);
  const localMemory = extractLocalMemorySummary(payload);

  if (localMemory.preferredName && context.turnCount % 4 === 0 && !reply.startsWith(localMemory.preferredName)) {
    reply = `${localMemory.preferredName}，${reply}`;
  } else if (
    localMemory.profileHint &&
    intent === "sharing" &&
    context.turnCount > 2 &&
    context.turnCount % 5 === 0
  ) {
    reply = `${reply} 我还记得你在意的是${localMemory.profileHint}，所以这次不会随便带过。`;
  }

  if (context.activeRelationshipMode === "mature" && intent === "affection") {
    reply = reply.replace("不许躲", "别躲开").replace("更主动一点", "再靠近一点");
  }

  return reply;
}

function buildLocalChatResponse(payload: ChatRequest): ChatResponse {
  activateLocalFallback();
  const humans = getLocalHumans();
  const character = humans.find((item) => item.id === payload.characterId) || humans[0] || BUILT_IN_HUMANS[0];
  const previous = readLocalContexts()[payload.sessionId || "session-browser"];
  const emotion = inferLocalEmotion(payload.message, previous?.lastEmotion || character.defaultMood || "neutral");
  const context = buildLocalContext(payload, emotion, character);
  saveLocalContext(payload.sessionId, context);

  return {
    sessionId: payload.sessionId,
    characterId: character.id,
    text: buildLocalReply(payload, character, emotion, context),
    emotion,
    context,
    hasFallback: true
  };
}

function splitLocalChunks(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + 8));
    cursor += 8;
  }
  return chunks;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function uploadModelFile(params: {
  fileName: string;
  fileBase64: string;
  mimeType?: string;
  fallbackUrl?: string;
}): Promise<ModelUploadResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/models/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });

    if (!res.ok) {
      const message = await res.text().catch(() => "模型上传失败");
      throw new Error(message || "模型上传失败");
    }

    return res.json();
  } catch (error) {
    if (!canUseLocalFallback() || !params.fallbackUrl) throw error;
    activateLocalFallback();
    return {
      modelUrl: params.fallbackUrl,
      fileName: params.fileName,
      mimeType: params.mimeType,
      size: 0,
      hasFallback: true
    };
  }
}

async function sendLocalMessageStream(payload: ChatRequest, handlers: ChatStreamEvents): Promise<StreamDoneResponse> {
  const response = buildLocalChatResponse(payload);
  const donePayload: StreamDoneResponse = {
    ...response,
    hasFallback: true
  };

  handlers.onEmotion?.(donePayload.emotion);
  for (const text of splitLocalChunks(donePayload.text)) {
    await wait(45);
    handlers.onChunk?.({ text });
  }
  await wait(30);
  handlers.onDone?.(donePayload);
  return donePayload;
}

export async function createDigitalHuman(payload: CreateHumanRequest) {
  try {
    const res = await fetch(`${API_BASE}/api/digital-humans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("创建数字人失败");
    return res.json();
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    activateLocalFallback();
    const human: DigitalHuman = {
      id: `custom-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      name: payload.name,
      description: payload.description,
      avatarUrl: payload.avatarUrl,
      modelUrl: payload.modelUrl,
      avatarType: payload.avatarType || "image",
      emotionProfile: payload.emotionProfile,
      avatarVideoProfile: payload.avatarVideoProfile,
      personalityTagline: payload.personalityTagline,
      relationshipMode: payload.relationshipMode || "sweet",
      voiceProfile: {
        provider: payload.voiceProvider || "local",
        voice: payload.voice || "browser-zh-CN"
      },
      defaultMood: payload.defaultMood || "neutral"
    };
    saveLocalCustomHumans([...getLocalCustomHumans(), human]);
    return { human };
  }
}

export async function updateDigitalHuman(id: string, payload: UpdateHumanRequest): Promise<{ human: DigitalHuman }> {
  const res = await fetch(`${API_BASE}/api/digital-humans/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data?.error)
      .catch(() => "");
    throw new Error(message || "更新数字人失败");
  }
  return res.json();
}

export async function uploadAvatarFile(params: {
  fileName: string;
  fileBase64: string;
  mimeType?: string;
}): Promise<{ avatarUrl: string; fileName: string; size: number }> {
  const res = await fetch(`${API_BASE}/api/avatars/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data?.error)
      .catch(() => "");
    throw new Error(message || "头像上传失败");
  }
  return res.json();
}

export async function deleteDigitalHuman(id: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/digital-humans/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    if (!res.ok) {
      throw new Error("删除数字人失败");
    }
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    activateLocalFallback();
    saveLocalCustomHumans(getLocalCustomHumans().filter((item) => item.id !== id));
  }
}

export async function fetchHumans() {
  try {
    const res = await fetch(`${API_BASE}/api/digital-humans`);
    if (!res.ok) throw new Error("加载数字人失败");
    return res.json();
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    activateLocalFallback();
    return { humans: getLocalHumans(), source: "local-static-fallback" };
  }
}

export async function sendMessage(payload: ChatRequest): Promise<ChatResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("发送消息失败");
    return res.json();
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    return buildLocalChatResponse(payload);
  }
}

export async function synthesizeTts(params: {
  text: string;
  characterId?: string;
}): Promise<{ audioUrl?: string }> {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params)
  });
  if (!res.ok) {
    throw new Error("语音合成失败");
  }
  return res.json();
}

export async function transcribeSpeech(params: {
  audioBase64: string;
  mimeType?: string;
  language?: string;
}): Promise<TranscribeResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });

    if (!res.ok) {
      const message = await res.text().catch(() => "语音转写失败");
      throw new Error(message || "语音转写失败");
    }

    return res.json();
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    activateLocalFallback();
    throw new Error("静态网页模式暂不支持上传录音转写；可使用浏览器自带语音识别或手动输入。");
  }
}

export async function clearSessionHistory(sessionId: string): Promise<void> {
  if (!sessionId) {
    return;
  }

  try {
    await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE"
    });
  } catch {
    // Static Pages mode has no session API.
  }
  clearLocalContext(sessionId);
}

function parseSseText(raw: string): string {
  return raw.replace(/^data:/gm, "").trim();
}

export async function sendMessageStream(payload: ChatRequest, handlers: ChatStreamEvents): Promise<StreamDoneResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => "发送消息失败");
      throw new Error(msg || "发送消息失败");
    }

    if (!res.body) {
      throw new Error("服务器未返回流式数据");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let donePayload: StreamDoneResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const rawEvent = buffer.slice(0, buffer.indexOf("\n\n"));
        buffer = buffer.slice(buffer.indexOf("\n\n") + 2);

        const lines = rawEvent.split("\n");
        const eventLine = lines.find((line) => line.startsWith("event:"));
        const dataLine = lines.find((line) => line.startsWith("data:"));
        const event = eventLine ? eventLine.replace("event:", "").trim() : "message";
        if (!dataLine) continue;

        const parsed = (() => {
          try {
            return JSON.parse(parseSseText(dataLine));
          } catch {
            return null;
          }
        })();
        if (!parsed) continue;

        if (event === "chunk" && typeof parsed.text === "string") {
          handlers.onChunk?.({ text: parsed.text });
        } else if (event === "emotion" && typeof parsed.emotion === "string") {
          handlers.onEmotion?.(parsed.emotion as Emotion);
        } else if (event === "done" && typeof parsed.text === "string" && typeof parsed.emotion === "string") {
          donePayload = parsed as StreamDoneResponse;
          handlers.onDone?.(parsed as StreamDoneResponse);
        }
      }
    }

    if (!donePayload) {
      throw new Error("流式回复未完成");
    }

    return donePayload;
  } catch (error) {
    if (!canUseLocalFallback()) throw error;
    return sendLocalMessageStream(payload, handlers);
  }
}

export function resolveMediaUrl(url?: string): string | undefined {
  const trimmed = String(url || "").trim();
  if (!trimmed) return undefined;
  const publicBase = import.meta.env.BASE_URL || "/";

  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(trimmed) || /^data:|^blob:/i.test(trimmed)) {
    return trimmed;
  }
  if (shouldResolveRootAssetFromPublicBase()) {
    if (trimmed.startsWith("/")) {
      if (publicBase === "/") {
        return trimmed;
      }
      return `${publicBase.replace(/\/?$/, "/")}${trimmed.slice(1)}`;
    }
    if (trimmed.startsWith("assets/") || trimmed.startsWith("icons/") || trimmed === "manifest.webmanifest") {
      return `${publicBase.replace(/\/?$/, "/")}${trimmed}`;
    }
    return trimmed;
  }
  if (!API_BASE) {
    if (trimmed.startsWith("/")) {
      return trimmed;
    }
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `${API_BASE}${trimmed}`;
  }
  return `${API_BASE}/${trimmed}`;
}

// ---------- 系统设置（可扩展：与后端 /api/settings 对应） ----------
export interface LlmSettings {
  baseUrl: string;
  hasApiKey: boolean;
  model: string;
  supportsVision: boolean;
}

export interface TtsSettings {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface SystemSettings {
  llm: LlmSettings;
  tts: TtsSettings;
  [key: string]: unknown;
}

export interface LlmSettingsInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  supportsVision?: boolean;
}

export interface TtsSettingsInput {
  apiKey?: string;
}

export interface SystemSettingsInput {
  llm?: LlmSettingsInput;
  tts?: TtsSettingsInput;
}

export async function getSettings(): Promise<SystemSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "GET",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "加载设置失败");
    throw new Error(message || "加载设置失败");
  }
  return res.json();
}

export async function updateSettings(input: SystemSettingsInput): Promise<SystemSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data?.error)
      .catch(() => "");
    throw new Error(message || "保存设置失败");
  }
  return res.json();
}

export async function fetchLlmModels(baseUrl: string, apiKey: string): Promise<{ models: string[] }> {
  const res = await fetch(`${API_BASE}/api/settings/llm/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey })
  });
  if (!res.ok) {
    const message = await res
      .json()
      .then((data: { error?: string }) => data?.error)
      .catch(() => "");
    throw new Error(message || "拉取模型清单失败");
  }
  return res.json();
}
