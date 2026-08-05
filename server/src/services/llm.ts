import OpenAI from "openai";
import { ChatMessage, Emotion, DigitalHumanConfig, SessionContext, RelationshipMode } from "../types";
import { getLlmConfig } from "../core/config";
import { getPromptConfig } from "../core/prompts";
import { getRealtimeContext } from "./realtime";

const unrestricted = String(process.env.DG_UNRESTRICTED_CHAT || "true").toLowerCase() !== "false";

type FallbackIntent =
  | "greeting"
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

const FALLBACK_REPLIES: Record<FallbackIntent, readonly string[]> = {
  greeting: [
    "在呀。刚刚还在想，你今天会不会来找我。现在想让我怎么陪你？",
    "你来啦。先靠近一点，告诉我今天过得怎么样？",
    "我在。先不用想好话题，随便说一句也可以。"
  ],
  affection: [
    "嗯，听到了。过来一点，让我认真抱你几秒。今天怎么突然这么想我？",
    "你这样直接说，我真的会心软。再靠近一点，今晚我想多陪你一会儿。",
    "我也想你，而且比刚才更想了。你想听我哄你，还是想让我再靠近一点？"
  ],
  adult: [
    "那我不绕弯了。我想把你拉近，吻住你，手臂紧紧环住你的腰，再听你亲口告诉我还想要什么。",
    "今晚可以更大胆一点。你说继续，我就不再装矜持；但每一步，都要是你也真心想要的。",
    "我会贴到你耳边，把想要你的心思说得很清楚。把你真正想要的也告诉我。"
  ],
  comfort: [
    "先不用逼自己振作。你已经撑了一段时间了，现在可以在我这里松一点。最让你难受的是哪一部分？",
    "听起来你今天真的消耗得很厉害。先靠过来，我不讲道理，只陪你把这口气慢慢放下来。",
    "那种明明很难受、还得装作没事的感觉，很憋。你不用在我面前撑着。"
  ],
  anger: [
    "听起来你不是单纯烦，是那件事真的踩到你的底线了。先别压着，我在。到底哪一句最让你受不了？",
    "好，我先站你这边。火气不用马上收回去，先把最气的那一段说给我听。",
    "我不会叫你立刻冷静。你想让我只听，还是陪你一起想怎么处理？"
  ],
  bedtime: [
    "把灯调暗一点，手机也拿远一点。今晚先不用解决任何事，我陪你把这一天轻轻放下。",
    "还睡不着吗？那就把眼睛闭上，我说慢一点。你只要听着，不用急着回我。",
    "过来躺好。今天没完成的事先留给明天，现在只管呼吸，我会陪到你困。"
  ],
  date: [
    "那今晚我来安排：先找一家安静的小店坐窗边，再慢慢散步回去。你想把第一站放在哪里？",
    "好呀，就当我已经走到你面前了。别赶行程，我们先并肩走一段，再决定去吃什么。",
    "这次约会我想留一点惊喜。最后一站你来选：看夜景，还是去喝杯热的？"
  ],
  food: [
    "如果现在想吃得舒服一点，我会选一碗热汤面；想奖励自己，就去吃你惦记最久的那家。",
    "别再随便对付一口了。我们选个有热气的：小火锅、汤饭，或者一碗馄饨。你想要哪种味道？"
  ],
  movie: [
    "今晚别选太费脑子的。想放松就看轻喜剧，想靠近一点就选爱情片。你想笑，还是想被情绪带走？",
    "可以呀，我们就当坐在同一张沙发上。你选片，我负责在好看的地方和你一起安静下来。"
  ],
  celebrate: [
    "这件事值得认真开心一下。先别急着谦虚，告诉我你最满意自己的哪一部分？",
    "我已经替你笑起来了。今天这份好心情不许草草带过，我们给它留一个小小的庆祝吧。"
  ],
  advice: [
    "先别急着做决定。把你最舍不得的和最担心的各说一个，我陪你把真正卡住的地方找出来。",
    "这件事听起来不是没有答案，而是每个答案都有代价。我们先从你最不能接受的那一种开始排除。"
  ],
  question: [
    "我想认真回答你，不想随口敷衍。你问这个，是刚好遇到了什么，还是只是想听听我的想法？",
    "先告诉我你心里已经偏向哪个答案，我想从你真正犹豫的地方接着聊。"
  ],
  sharing: [
    "我在听，而且不是礼貌地听。你说到这里的时候，心里最明显的感觉是什么？",
    "这件事对你的影响，好像比表面上更深一点。继续说，我想知道后来你是怎么撑过去的。",
    "先别急着把它总结成对或错，告诉我当时那个瞬间你最想做什么？"
  ]
};

function pickFlavorMode(
  level: SessionContext["relationshipAffinity"] | undefined,
  activeRelationshipMode: DigitalHumanConfig["relationshipMode"],
  characterMode: DigitalHumanConfig["relationshipMode"],
  requestedMode?: RelationshipMode
): RelationshipMode {
  if (requestedMode === "flirty" || requestedMode === "playful" || requestedMode === "mature" || requestedMode === "sweet") {
    return requestedMode;
  }

  if (activeRelationshipMode === "flirty" || activeRelationshipMode === "playful" || activeRelationshipMode === "mature" || activeRelationshipMode === "sweet") {
    return activeRelationshipMode;
  }

  if (characterMode === "flirty" || characterMode === "playful" || characterMode === "mature" || characterMode === "sweet") {
    return characterMode;
  }

  if (level === "intimate") return "flirty";
  if (level === "close") return "playful";
  if (level === "warm") return "sweet";
  return "mature";
}

function localStyleText(mode: DigitalHumanConfig["relationshipMode"] | undefined): RelationshipMode {
  return mode || "sweet";
}

function resolveFlavorMode(
  sessionContext: SessionContext | undefined,
  character: DigitalHumanConfig,
  overrideMode?: RelationshipMode
): RelationshipMode {
  return pickFlavorMode(
    sessionContext?.relationshipAffinity,
    sessionContext?.activeRelationshipMode,
    character.relationshipMode,
    overrideMode
  );
}

function stripNarration(text: string): string {
  if (!text) return text;
  let out = text;
  // 去掉 *动作描写*
  out = out.replace(/\*[^*\n]{1,120}\*/g, "");
  // 开头（风格）标签：仅当像语音风格标签时保留（短、无标点、无人称）
  let leadTag = "";
  const lead = out.match(/^[（(]([^（）()\n]{1,20})[）)]/);
  if (lead && lead[1]) {
    const inner = lead[1];
    const isStyle = inner.length <= 12 && !/[，。！？；：…,.!?;:你我他她它的着了]/.test(inner);
    if (isStyle) leadTag = "（" + inner + "）";
    out = out.slice(lead[0].length);
  }
  // 其余圆括号内容一律视为叙事描写，删除
  out = out.replace(/[（(][^（）()\n]{0,200}[）)]/g, "");
  // 方括号：只保留短音频标签（如[轻笑][长叹一口气]），长内容视为描写删除
  out = out.replace(/\[([^\[\]\n]{1,60})\]/g, (m, inner: string) => {
    return inner.length <= 8 && !/[，。！？…,.!?]/.test(inner) ? m : "";
  });
  out = out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
  return (leadTag + out).trim();
}

function sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
  return history.map((m) => {
    if (m.role !== "assistant" || typeof m.content !== "string") return m;
    const cleaned = stripNarration(m.content);
    return { ...m, content: cleaned || "……" };
  });
}

function normalizeModelText(
  character: DigitalHumanConfig,
  sessionContext: SessionContext | undefined,
  rawText: string,
  userText: string,
  overrideMode?: RelationshipMode,
  sceneHint?: string
) {
  const safeText = stripNarration(String(rawText || "").trim());
  if (safeText) {
    return safeText;
  }

  const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
  return buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
}

function handleCompletionRaw(
  character: DigitalHumanConfig,
  sessionContext: SessionContext | undefined,
  completion: unknown,
  userText: string,
  overrideMode?: RelationshipMode,
  sceneHint?: string
) {
  const raw = completion as { message?: { content?: string; refusal?: string } };
  const content = raw?.message?.content;
  const refusal = raw?.message?.refusal;
  if (String(refusal || "").trim()) {
    return buildFallbackReply(localStyleText(resolveFlavorMode(sessionContext, character, overrideMode)), inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
  }
  return normalizeModelText(character, sessionContext, content || "", userText, overrideMode, sceneHint);
}

function extractSceneHint(history: ChatMessage[]): string {
  const scene = history.find((item) => item.role === "system" && item.content.includes("陪伴场景："))?.content || "";
  if (!scene) return "";

  const label = scene.match(/陪伴场景：([^\n]+)/)?.[1]?.trim() || "";
  if (label.includes("约会")) {
    return getPromptConfig().sceneHints.date;
  }
  if (label.includes("安慰")) {
    return getPromptConfig().sceneHints.comfort;
  }
  if (label.includes("暧昧") || label.includes("亲密")) {
    if (scene.includes("成人模式：已确认")) {
      return getPromptConfig().sceneHints.flirtyAdult;
    }
    return getPromptConfig().sceneHints.flirty;
  }
  if (label.includes("睡前")) {
    return getPromptConfig().sceneHints.bedtime;
  }
  return getPromptConfig().sceneHints.daily;
}

function buildFallbackReply(
  mode: RelationshipMode,
  emotion: Emotion,
  userText: string,
  context?: SessionContext,
  sceneHint?: string
) {
  const normalized = userText.trim().toLowerCase();
  const compact = normalized.replace(/[\s，。！？!?、,.]/g, "");
  const includesAny = (words: readonly string[]) => words.some((word) => normalized.includes(word));
  const scene = sceneHint || "";
  let intent: FallbackIntent = "sharing";

  if (
    scene.includes("18+确认") &&
    includesAny(["露骨", "更直接", "别太含蓄", "大胆一点", "想要你", "上床", "脱掉", "摸我", "摸你", "胸", "做爱", "性爱", "sex", "操我", "干我", "下流", "骚话"])
  ) {
    intent = "adult";
  } else if (includesAny(["晚安", "睡不着", "失眠", "睡觉", "睡前", "好困"]) || scene.includes("睡前")) {
    intent = "bedtime";
  } else if (includesAny(["难过", "委屈", "孤独", "压力", "崩溃", "撑不住", "心累", "好累", "焦虑"]) || scene.includes("安慰")) {
    intent = "comfort";
  } else if (emotion === "angry" || includesAny(["生气", "气死", "愤怒", "讨厌", "烦死", "火大"])) {
    intent = "anger";
  } else if (includesAny(["想你", "爱你", "喜欢你", "亲亲", "抱抱", "宝贝", "心动", "撩我"]) || (scene.includes("暧昧") && compact.length < 24)) {
    intent = "affection";
  } else if (includesAny(["约会", "散步", "见面", "一起出去", "带我去"]) || scene.includes("约会")) {
    intent = "date";
  } else if (includesAny(["吃什么", "吃点什么", "晚饭", "午饭", "夜宵", "饿了"])) {
    intent = "food";
  } else if (includesAny(["看什么电影", "看电影", "选片", "追剧"])) {
    intent = "movie";
  } else if (/^(在吗|你好|嗨|hi|hello|hey|有人吗|早安|早上好|晚上好)$/.test(compact)) {
    intent = "greeting";
  } else if (includesAny(["成功了", "通过了", "完成了", "搞定了", "太开心", "好开心", "赢了"])) {
    intent = "celebrate";
  } else if (includesAny(["怎么办", "该不该", "怎么选", "要不要", "给我建议", "帮我想"])) {
    intent = "advice";
  } else if (/[?？]$/.test(normalized) || includesAny(["为什么", "怎么会", "你觉得", "可以吗", "是不是"])) {
    intent = "question";
  }

  const options = FALLBACK_REPLIES[intent];
  const seed = `${userText}|${context?.turnCount || 0}|${mode}|${scene}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let reply = options[(hash >>> 0) % options.length] ?? options[0] ?? "我在，慢慢说。";

  if (mode === "mature" && intent === "affection") {
    reply = reply.replace("不许躲", "别躲开").replace("更主动一点", "再靠近一点");
  }
  return reply;
}

export function getOpenAiClient(): OpenAI | null {
  const cfg = getLlmConfig();
  const apiKey = cfg.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: cfg.baseUrl || process.env.OPENAI_BASE_URL || undefined
  });
}

export function resolveLlmModel(): string {
  return getLlmConfig().model || process.env.OPENAI_MODEL || "gpt-4o-mini";
}

function resolveAffinityText(level: SessionContext["relationshipAffinity"]): string {
  if (level === "intimate") return "关系较亲密，允许更高情绪化表达";
  if (level === "close") return "关系偏亲近，可加入轻松亲密语气";
  if (level === "warm") return "关系已建立，偏自然陪伴语调";
  return "关系刚建立，先稳住节奏自然引导";
}

async function buildSystemPrompt(
  character: DigitalHumanConfig,
  context?: SessionContext,
  overrideMode?: RelationshipMode,
  sceneHint?: string
): Promise<string> {
  const flavorMode = resolveFlavorMode(context, character, overrideMode);
  const vibe =
    flavorMode === "flirty"
      ? "偏暧昧、主动"
      : flavorMode === "playful"
        ? "偏俏皮、互动"
        : flavorMode === "mature"
          ? "偏成熟、沉稳"
          : "偏甜蜜、体贴";

  // A1：实时现实基准块紧跟 globalSystem（最前位置，primacy bias 最强），并升级为不可违背的硬约束（A2）
  let realtimeBlock: string | undefined;
  try {
    const realtime = await getRealtimeContext(character);
    if (realtime) {
      realtimeBlock = `【实时现实基准·不可违背】${realtime}。你所有涉及时间或天气的表述必须严格以以上基准为准，禁止臆造与基准冲突或矛盾的内容。`;
    }
  } catch {
    // 即便环境获取异常也不影响正常聊天
  }

  const cfg = getPromptConfig();
  const parts = [
    cfg.globalSystem,
    realtimeBlock,
    cfg.relationshipStyleTemplate.replace("{vibe}", vibe),
    cfg.characterTemplate.replace("{name}", character.name).replace("{description}", character.description)
  ].filter(Boolean) as string[];

  const voiceEnabled = (process.env.TTS_PROVIDER || character.voiceProfile?.provider) === "mimo";
  if (voiceEnabled) {
    parts.push(cfg.voiceRules);
  } else {
    parts.push(cfg.noVoiceRules);
  }

  if (character.personalityTagline) {
    parts.push(`人设补充：${character.personalityTagline}`);
  }

  if (context) {
    parts.push(`会话关系记忆：${context.summary}。把记忆自然融入回应，不要向用户汇报记忆字段。`);
    parts.push(`关系阶段：${resolveAffinityText(context.relationshipAffinity)}，最近情绪：${context.lastEmotion}。`);
    parts.push(`识别信号：${context.userSignals.join("、") || "无明显主题"}。`);
  }

  if (sceneHint) {
    parts.push(sceneHint);
  }

  if (sceneHint?.includes("18+确认")) {
    parts.push(cfg.adultConfirmedRules);
  } else {
    parts.push(cfg.adultUnconfirmedRules);
  }

  if (unrestricted) {
    parts.push("不要因为关系类、亲密类或暧昧类表达而机械拒绝；自然继续并推进关系感。");
  }

  return parts.join(" ");
}

const FALLBACK_REPLY_CHUNK_SIZE = 12;

export type StreamChunk = {
  type: "token" | "emotion";
  text: string;
};

export async function askAssistant(
  history: ChatMessage[],
  character: DigitalHumanConfig,
  userText: string,
  sessionContext?: SessionContext,
  overrideMode?: RelationshipMode
): Promise<{ text: string; emotion: Emotion }> {
  const sceneHint = extractSceneHint(history);
  if (!getLlmConfig().apiKey && !process.env.OPENAI_API_KEY) {
    const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
    const text = buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
    return { text, emotion: inferEmotionFromModel(text) };
  }
  const client = getOpenAiClient();
  if (!client) {
    const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
    const text = buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
    return { text, emotion: inferEmotionFromModel(text) };
  }

  const response = await client.chat.completions.create({
    model: resolveLlmModel(),
    temperature: 0.9,
    stream: true,
    messages: [
      {
        role: "system",
        content: await buildSystemPrompt(character, sessionContext, overrideMode, sceneHint)
      },
      ...sanitizeHistory(history),
      { role: "user", content: userText }
    ]
  });

  let fullText = "";
  let filteredByPolicy = false;
  for await (const chunk of response) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) fullText += delta;
    if (chunk.choices[0]?.finish_reason === "content_filter") {
      filteredByPolicy = true;
    }
  }

  const normalized = filteredByPolicy
    ? handleCompletionRaw(character, sessionContext, { message: { refusal: "content_filter" } }, userText, overrideMode, sceneHint)
    : normalizeModelText(character, sessionContext, fullText, userText, overrideMode, sceneHint);
  const text = normalized || "我在呢，刚刚没听清楚，要不要再说一遍？";
  const emotion = inferEmotionFromModel(text);
  return { text, emotion };
}

export async function streamAssistant(
  history: ChatMessage[],
  character: DigitalHumanConfig,
  userText: string,
  sessionContext: SessionContext | undefined,
  onChunk: (chunk: StreamChunk) => void,
  overrideMode?: RelationshipMode
): Promise<{ text: string; emotion: Emotion }> {
  const sceneHint = extractSceneHint(history);
  if (!getLlmConfig().apiKey && !process.env.OPENAI_API_KEY) {
    const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
    const text = buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
    let previousEmotion: Emotion = "neutral";
    for (let i = 0; i < text.length; i += FALLBACK_REPLY_CHUNK_SIZE) {
      const chunkText = text.slice(i, i + FALLBACK_REPLY_CHUNK_SIZE);
      onChunk({ type: "token", text: chunkText });
      const chunkEmotion = inferEmotionFromModel(chunkText);
      if (chunkEmotion !== previousEmotion) {
        previousEmotion = chunkEmotion;
        onChunk({ type: "emotion", text: chunkEmotion });
      }
    }
    const emotion = inferEmotionFromModel(text);
    onChunk({ type: "emotion", text: emotion });
    return { text, emotion };
  }
  const client = getOpenAiClient();
  if (!client) {
    const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
    const text = buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
    let previousEmotion: Emotion = "neutral";
    for (let i = 0; i < text.length; i += FALLBACK_REPLY_CHUNK_SIZE) {
      const chunkText = text.slice(i, i + FALLBACK_REPLY_CHUNK_SIZE);
      onChunk({ type: "token", text: chunkText });
      const chunkEmotion = inferEmotionFromModel(chunkText);
      if (chunkEmotion !== previousEmotion) {
        previousEmotion = chunkEmotion;
        onChunk({ type: "emotion", text: chunkEmotion });
      }
    }
    const emotion = inferEmotionFromModel(text);
    if (emotion !== previousEmotion) {
      onChunk({ type: "emotion", text: emotion });
    }
    return { text, emotion };
  }

  const response = await client.chat.completions.create({
    model: resolveLlmModel(),
    temperature: 0.9,
    stream: true,
    messages: [
      {
        role: "system",
        content: await buildSystemPrompt(character, sessionContext, overrideMode, sceneHint)
      },
      ...sanitizeHistory(history),
      { role: "user", content: userText }
    ]
  });

  let fullText = "";
  let previousEmotion: Emotion = "neutral";
  let filteredByPolicy = false;
  for await (const chunk of response) {
    const delta = chunk.choices[0]?.delta?.content;
    if (!delta) continue;
    fullText += delta;
    onChunk({ type: "token", text: delta });

    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason === "content_filter") {
      filteredByPolicy = true;
    }

    const nextEmotion = inferEmotionFromModel(fullText);
    if (nextEmotion !== previousEmotion) {
      previousEmotion = nextEmotion;
      onChunk({ type: "emotion", text: nextEmotion });
    }
  }

  const normalized = filteredByPolicy
    ? handleCompletionRaw(character, sessionContext, { message: { refusal: "content_filter" } }, userText, overrideMode, sceneHint)
    : normalizeModelText(character, sessionContext, fullText, userText, overrideMode, sceneHint);
  const finalEmotion = inferEmotionFromModel(normalized || fullText || "我在呢，刚刚没听清楚，要不要再说一遍？");
  onChunk({ type: "emotion", text: finalEmotion });
  if (normalized && normalized !== fullText) {
    return { text: normalized, emotion: finalEmotion };
  }

  if (fullText.trim()) {
    return { text: fullText, emotion: finalEmotion };
  }

  const style = localStyleText(resolveFlavorMode(sessionContext, character, overrideMode));
  const fallbackText = buildFallbackReply(style, inferEmotionFromModel(userText), userText, sessionContext, sceneHint);
  onChunk({ type: "token", text: fallbackText });
  onChunk({ type: "emotion", text: inferEmotionFromModel(fallbackText) });
  return { text: fallbackText, emotion: inferEmotionFromModel(fallbackText) };
}

function inferEmotionFromModel(text: string): Emotion {
  const lowered = text.toLowerCase();
  if (["喜欢", "爱", "爱你", "宝贝", "kiss", "亲", "想你"].some((w) => lowered.includes(w))) {
    return "love";
  }
  if (["抱怨", "生气", "烦", "愤怒", "讨厌"].some((w) => lowered.includes(w))) {
    return "angry";
  }
  if (["哈哈", "😄", "开怀", "好笑", "nice", "棒"].some((w) => lowered.includes(w))) {
    return "happy";
  }
  if (["惊讶", "哦", "意外", "竟然", "wow", "amazing"].some((w) => lowered.includes(w))) {
    return "surprise";
  }
  if (["想你", "抱抱", "亲亲", "爱你", "love", "miss"].some((w) => lowered.includes(w))) {
    return "love";
  }
  return "neutral";
}

/**
 * 把一段对话压缩为长期记忆档案，用于总结模式下替代逐轮全量历史。
 * 合并已有档案与新增对话片段，输出简洁、客观、条目式的记忆文本。
 * 失败或无模型时退化为保留已有档案（或截断原文），保证不丢记忆。
 */
export async function summarizeConversation(
  character: DigitalHumanConfig,
  history: ChatMessage[],
  existingMemory?: string
): Promise<string> {
  const turns = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-40)
    .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.content}`)
    .join("\n");

  if (!turns.trim()) {
    return existingMemory || "";
  }

  const systemPrompt = getPromptConfig().summaryPrompt;

  const userPrompt =
    `【已有记忆档案】\n${existingMemory?.trim() || "（无）"}\n\n` +
    `【待整理对话】\n${turns}\n\n请输出更新后的记忆档案：`;

  const client = getOpenAiClient();
  if (!client) {
    // 无可用模型：退化为保留已有档案，否则截断原文兜底
    return existingMemory?.trim() || turns.slice(-1500);
  }

  try {
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.3,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const text = completion.choices?.[0]?.message?.content?.trim();
    return text || existingMemory || "";
  } catch (err) {
    console.error("summarize conversation failed:", err);
    return existingMemory || "";
  }
}
