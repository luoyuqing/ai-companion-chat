import { ChatMessage, DigitalHumanConfig } from "../types";

export type CompanionSceneId = "daily" | "date" | "comfort" | "flirty" | "bedtime";

export interface CompanionScene {
  id: CompanionSceneId;
  label: string;
  description: string;
  relationshipMode: DigitalHumanConfig["relationshipMode"];
  emotion: DigitalHumanConfig["defaultMood"];
  systemGoal: string;
  starters: string[];
}

export type CompanionInteractionId = "hug" | "hand" | "whisper" | "comfort" | "goodnight";

export interface CompanionInteraction {
  id: CompanionInteractionId;
  label: string;
  message: string;
  emotion: DigitalHumanConfig["defaultMood"];
  sceneId: CompanionSceneId;
}

export const COMPANION_SCENES: CompanionScene[] = [
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

export const COMPANION_INTERACTIONS: CompanionInteraction[] = [
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

export type ResponseStyleId = "warm" | "soft" | "mature";

export interface ResponseStyle {
  id: ResponseStyleId;
  label: string;
  instruction: string;
}

export const RESPONSE_STYLES: ResponseStyle[] = [
  { id: "warm", label: "温柔", instruction: "回复时语气温柔体贴，像亲近的人一样自然关心，不过分甜腻。" },
  { id: "soft", label: "轻声", instruction: "回复时节奏放慢、音量感轻柔，适合安静或睡前氛围，句子简短舒缓。" },
  { id: "mature", label: "沉稳", instruction: "回复时成熟稳重，不撒娇不卖乖，给出有分寸的陪伴和看法。" }
];

export function isCompanionSceneId(value: unknown): value is CompanionSceneId {
  return typeof value === "string" && COMPANION_SCENES.some((scene) => scene.id === value);
}

export function getSceneById(id: CompanionSceneId): CompanionScene | undefined {
  return COMPANION_SCENES.find((scene) => scene.id === id);
}

export function getInteractionById(id: string): CompanionInteraction | undefined {
  return COMPANION_INTERACTIONS.find((interaction) => interaction.id === id);
}

export function getDefaultScene(): CompanionScene {
  return COMPANION_SCENES[0]!;
}

export function getDefaultResponseStyle(): ResponseStyle {
  return RESPONSE_STYLES[0]!;
}

export function isResponseStyleId(value: unknown): value is ResponseStyleId {
  return typeof value === "string" && RESPONSE_STYLES.some((style) => style.id === value);
}

export function getResponseStyleById(id: ResponseStyleId): ResponseStyle | undefined {
  return RESPONSE_STYLES.find((style) => style.id === id);
}

/**
 * 构建场景系统消息。网页端与 Telegram bot 共用，保证同一场景下的提示一致。
 */
export function buildSceneSystemMessage(
  scene: CompanionScene,
  character?: DigitalHumanConfig,
  adultVerified = false
): ChatMessage {
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

export function buildStyleSystemMessage(style: ResponseStyle): ChatMessage {
  return {
    role: "system",
    content: `回复语气风格：${style.label}。${style.instruction}`
  };
}
