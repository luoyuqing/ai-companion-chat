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
