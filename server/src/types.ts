export type Emotion = "happy" | "sad" | "surprise" | "wink" | "neutral" | "angry" | "love";

export type EmotionProfile = Partial<Record<Emotion, string>>;

export type AvatarRenderMode = "image" | "video";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** 消息写入时间（Unix 毫秒），由 appendToSession 自动附加，用于让模型感知历史消息的真实发生时刻。 */
  ts?: number;
}

export type RelationshipAffinity = "new" | "warm" | "close" | "intimate";

export type RelationshipMode = "sweet" | "flirty" | "playful" | "mature";

export type MimoAudioModel = "mimo-v2.5-tts" | "mimo-v2.5-tts-voicedesign" | "mimo-v2.5-tts-voiceclone";

export interface SessionContext {
  relationshipAffinity: RelationshipAffinity;
  summary: string;
  userSignals: string[];
  lastEmotion: Emotion;
  activeRelationshipMode?: RelationshipMode;
  turnCount: number;
  updatedAt: string;
}

/** 数字人所在地理位置（用于获取她当地的真实时间与天气）。 */
export interface CharacterLocation {
  /** 省份，如 "广东省" */
  province: string;
  /** 城市，如 "深圳" */
  city: string;
  /** 纬度（小数度） */
  latitude: number;
  /** 经度（小数度） */
  longitude: number;
}

export interface DigitalHumanConfig {
  id: string;
  name: string;
  description: string;
  avatarUrl: string;
  modelUrl?: string;
  emotionProfile?: EmotionProfile;
  avatarType?: AvatarRenderMode;
  avatarVideoProfile?: EmotionProfile;
  personalityTagline?: string;
  relationshipMode?: RelationshipMode;
  /** 数字人所在地理位置（设置后聊天会注入她当地的真实时间/天气）。 */
  location?: CharacterLocation;
  voiceProfile: {
    provider: "openai" | "azure" | "local" | "mimo";
    voice: string;
    audioModel?: MimoAudioModel;
    voiceId?: string;
    stylePrompt?: string;
    voiceDesignPrompt?: string;
    voiceCloneSample?: string;
  };
  defaultMood: Emotion;
  // 专属 Telegram 机器人 token：配置后该数字人会以独立 bot 身份运行（一角色一机器人）。
  // 注意：此字段为敏感凭证，后端在返回给前端的角色列表中会主动剥离，编辑时留空表示不修改。
  telegramBotToken?: string;
  // 聊天禁忌：约束主动生成内容与对话风格，生成主动消息时作为硬性边界。
  chatTaboos?: string;
  // 主动推送配置：配置专属 TG bot 后，可让数字人主动给主人发消息。
  proactive?: ProactiveConfig;
}

// 主动推送模式：always=到点必发；smart=根据人设/关系/上下文由模型判断是否发；probability=按概率掷骰决定本分钟是否发。
export type ProactiveMode = "always" | "smart" | "probability";

export interface ProactiveConfig {
  enabled: boolean;
  // 最多 3 个时间点，格式 "HH:MM"（24 小时制，按 Asia/Shanghai 时区解释）
  timePoints: string[];
  mode: ProactiveMode;
  // 主动推送是否附带语音（复用 MiMo TTS）。默认关闭，避免每条定时消息都消耗语音额度。
  voiceEnabled?: boolean;
  // probability 模式下全局默认概率（1-100，按百分比），不填则视为 100（必发）。
  probability?: number;
  // 各时间点单独概率覆盖，key 为 "HH:MM"，值 1-100。优先级高于 probability。
  timePointProbabilities?: Record<string, number>;
}

export interface ChatRequestBody {
  sessionId?: string;
  message: string;
  characterId?: string;
  history?: ChatMessage[];
  relationshipMode?: RelationshipMode;
}

export interface ChatResponse {
  sessionId: string;
  characterId: string;
  text: string;
  emotion: Emotion;
  context?: SessionContext;
  audioBase64?: string;
  audioUrl?: string;
}
