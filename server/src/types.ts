export type Emotion = "happy" | "sad" | "surprise" | "wink" | "neutral" | "angry" | "love";

export type EmotionProfile = Partial<Record<Emotion, string>>;

export type AvatarRenderMode = "image" | "video";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
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

// 主动推送模式：always=到点必发；smart=根据人设/关系/上下文由模型判断是否发。
export type ProactiveMode = "always" | "smart";

export interface ProactiveConfig {
  enabled: boolean;
  // 最多 3 个时间点，格式 "HH:MM"（24 小时制，按 Asia/Shanghai 时区解释）
  timePoints: string[];
  mode: ProactiveMode;
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
