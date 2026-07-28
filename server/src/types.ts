export type Emotion = "happy" | "sad" | "surprise" | "wink" | "neutral" | "angry" | "love";

export type EmotionProfile = Partial<Record<Emotion, string>>;

export type AvatarRenderMode = "image" | "video";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export type RelationshipAffinity = "new" | "warm" | "close" | "intimate";

export type RelationshipMode = "sweet" | "flirty" | "playful" | "mature";

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
    provider: "openai" | "azure" | "local";
    voice: string;
  };
  defaultMood: Emotion;
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
