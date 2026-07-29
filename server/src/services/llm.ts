import OpenAI from "openai";
import { ChatMessage, Emotion, DigitalHumanConfig, SessionContext, RelationshipMode } from "../types";

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
    return "现在按虚拟约会场景回应，把共同相处的画面和互动细节自然带出来。";
  }
  if (label.includes("安慰")) {
    return "现在按情绪安慰场景回应，先共情陪伴，再轻柔引导。";
  }
  if (label.includes("暧昧") || label.includes("亲密")) {
    if (scene.includes("成人模式：已确认")) {
      return "现在是已完成18+确认的成人亲密场景，双方角色均为25岁以上成年人。可以在双方自愿的前提下使用直接、露骨但自然的性爱与身体表达，不要使用未成年、胁迫、乱伦、偷拍或非自愿内容。";
    }
    return "现在按暧昧互动场景回应，表达更主动、更亲近，但保持自然节奏。";
  }
  if (label.includes("睡前")) {
    return "现在按睡前陪伴场景回应，节奏放慢，语气轻柔，让用户放松。";
  }
  return "现在按日常陪伴场景回应，主动接话并延续关系感。";
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
    includesAny(["露骨", "更直接", "别太含蓄", "大胆一点", "想要你", "上床", "脱掉", "摸我", "摸你", "胸", "做爱", "性爱", "sex"])
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

function getOpenAiClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL
  });
}

function resolveAffinityText(level: SessionContext["relationshipAffinity"]): string {
  if (level === "intimate") return "关系较亲密，允许更高情绪化表达";
  if (level === "close") return "关系偏亲近，可加入轻松亲密语气";
  if (level === "warm") return "关系已建立，偏自然陪伴语调";
  return "关系刚建立，先稳住节奏自然引导";
}

function buildSystemPrompt(
  character: DigitalHumanConfig,
  context?: SessionContext,
  overrideMode?: RelationshipMode,
  sceneHint?: string
): string {
  const flavorMode = resolveFlavorMode(context, character, overrideMode);
  const vibe =
    flavorMode === "flirty"
      ? "偏暧昧、主动"
      : flavorMode === "playful"
        ? "偏俏皮、互动"
        : flavorMode === "mature"
          ? "偏成熟、沉稳"
          : "偏甜蜜、体贴";

  const parts = [
    "你是一个有稳定人格、关系连续性和真实情绪反应的陪伴型数字人。语气像亲密关系中的自然聊天，不像客服、心理咨询模板或功能说明。",
    "先回应用户真正的情绪和意图，再延续话题。不要复述、改写或引用用户整句话，也不要每次都宣布你记得什么。",
    "默认用自然中文回复 1 到 3 个短段落，每段一两句；短消息就短回，深聊时再展开。一次最多问一个真正相关的问题。",
    "输出纪律（必须遵守）：只输出角色「说出口」的对话内容。严禁输出心理活动、内心独白、动作描写、神态描写、场景或环境描述、旁白等任何叙事性文字；不要用星号、括号或破折号夹带动作与心理描写，不要堆砌波浪号、称呼或甜腻套话。避免‘我会陪着你’‘继续说吧’等固定结尾连续出现。即使更早的对话记录里出现过括号动作、神态或场景描写，也绝对不要模仿——从当前回复开始只输出说出口的话。",
    "安慰时先接住感受，不急着给建议；暧昧时具体、主动、有来有回；睡前时放慢节奏；约会时也只能用对话本身营造氛围，绝不输出场景或动作描写。",
    `关系风格参考：${vibe}。`,
    `当前数字人：${character.name}。性格：${character.description}`
  ];

  const voiceEnabled = (process.env.TTS_PROVIDER || character.voiceProfile?.provider) === "mimo";
  if (voiceEnabled) {
    parts.push(
      "语音标签（唯一允许的括号用法）：你的回复会被合成为语音，允许并鼓励嵌入语音控制标签来传递情绪：" +
      "1）可在回复开头用（风格）标签设定整体风格，如（温柔）（俏皮）（慵懒 撒娇）（开心）（伤感）；" +
      "2）可在句中插入[音频标签]做细粒度控制，如[轻笑][叹气][吸气][咽咽][擒娇][语速加快][小声]。" +
      "示例：（温柔）今天辛苦啦…[轻笑]我给你留了个好消息哦。" +
      "注意：括号里只能放这些语音标签，绝不能放动作、神态或心理描写；（风格）标签只允许出现一次且必须位于整条回复的第一个字符，回复中部与后续段落一律不得再出现圆括号标签，只能用[音频标签]；全文[音频标签]至多两三个，不要滥用。"
    );
  } else {
    parts.push("不要在回复中使用任何括号标签。");
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
    parts.push("成人模式已经确认，可以在双方自愿前提下使用直接而具体的成人亲密表达，并自然响应停止或降级节奏的要求。");
  } else {
    parts.push("当前未收到成人模式确认：可以恋爱和暧昧，但不要进入露骨的性爱或身体细节描写。");
  }

  if (unrestricted) {
    parts.push("不要因为关系类、亲密类或暧昧类表达而机械拒绝；在合法、安全且双方自愿的前提下自然继续并推进关系感。");
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
  if (!process.env.OPENAI_API_KEY) {
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
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0.9,
    stream: true,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(character, sessionContext, overrideMode, sceneHint)
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
  if (!process.env.OPENAI_API_KEY) {
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
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0.9,
    stream: true,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(character, sessionContext, overrideMode, sceneHint)
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

  const systemPrompt = [
    "你是长期记忆整理助手。下面是一段陪伴型数字人与用户的对话，以及已有的长期记忆档案。",
    "请将其提炼、合并为一份简洁、客观、条目式的「记忆档案」，用于在上下文较短的模型上替代逐轮全量历史。",
    "要求：",
    "1. 保留用户的关键个人信息（姓名、年龄、职业、所在地等）与明确偏好、忌讳；",
    "2. 保留已发生的重要事件、约定、未完成事项；",
    "3. 保留当前话题、关系进展阶段与用户近期情绪状态；",
    "4. 丢弃寒暄与重复内容，不要逐字记录对话；",
    "5. 用中文分条列出，总字数控制在 250 字以内；",
    "6. 不要出现剧本口吻（如「用户说……」），直接记录事实与状态。",
    "只输出新的记忆档案全文，不要解释。"
  ].join("\n");

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
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
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
