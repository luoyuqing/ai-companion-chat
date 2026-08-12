const STORAGE_KEY_SESSION = "dg-mini-session-id";
const STORAGE_KEY_CHARACTER = "dg-mini-character-id";
const STORAGE_KEY_LOCAL_HUMANS = "dg-mini-local-digital-humans-v1";
const STORAGE_KEY_LOCAL_CONTEXT = "dg-mini-local-chat-context-v1";
const STORAGE_KEY_AVATAR_RENDER_MODE = "dg-mini-avatar-render-mode";
const STORAGE_KEY_USER_MEMORY = "dg-mini-user-memory-v1";
const STORAGE_KEY_CHAT_STATES = "dg-mini-chat-states-v1";
const EXPORT_SCHEMA = "digital-girlfriend-local-archive";
const CHAT_STATE_ARCHIVE_PREFIX = "dg-chat-state-v1";
const MAX_STORED_MESSAGES = 80;

const expressionMap = {
  happy: "(^_^)",
  sad: "(T_T)",
  surprise: "(o_o)",
  wink: "(^_~)",
  neutral: "(•ᴗ•)",
  angry: "(>_<)",
  love: "(❤ω❤)"
};

const emotionTextMap = {
  happy: "开朗",
  sad: "难过",
  surprise: "惊讶",
  wink: "俏皮",
  neutral: "平静",
  angry: "生气",
  love: "甜蜜"
};

const relationshipLevelLabel = {
  new: "刚认识",
  warm: "有点熟",
  close: "很熟",
  intimate: "亲密"
};

const emotionModes = ["neutral", "happy", "sad", "surprise", "wink", "angry", "love"];
const relationshipModes = ["sweet", "flirty", "playful", "mature"];
const voiceProviders = ["openai", "azure", "local"];
const avatarTypes = ["image", "video"];
const emptyUserMemory = {
  displayName: "",
  preferredName: "",
  preferences: "",
  importantFacts: "",
  boundaries: "",
  relationshipNotes: "",
  updatedAt: ""
};

const BUILT_IN_HUMANS = [
  {
    id: "lina",
    name: "Lina",
    description: "默认数字人。温柔、开朗，默认可爱的笑容",
    avatarUrl: "/assets/avatars/lina.svg",
    modelUrl: "",
    defaultMood: "happy",
    personalityTagline: "温柔可爱，既能认真陪伴，也会轻松撒娇。",
    relationshipMode: "sweet",
    avatarType: "image",
    emotionProfile: {
      happy: "/assets/expressions/happy.svg",
      sad: "/assets/expressions/sad.svg",
      surprise: "/assets/expressions/surprise.svg",
      wink: "/assets/expressions/wink.svg",
      neutral: "/assets/expressions/neutral.svg",
      angry: "/assets/expressions/angry.svg",
      love: "/assets/expressions/love.svg"
    },
    voiceProfile: { provider: "local", voice: "browser-zh-CN" }
  },
  {
    id: "moon",
    name: "Moon",
    description: "成熟、细腻，偏感性表达",
    avatarUrl: "/assets/avatars/moon.svg",
    modelUrl: "",
    defaultMood: "wink",
    personalityTagline: "成熟感性，善于用共情语言回应并引导对方放松表达。",
    relationshipMode: "playful",
    avatarType: "image",
    emotionProfile: {
      happy: "/assets/expressions/happy.svg",
      sad: "/assets/expressions/sad.svg",
      surprise: "/assets/expressions/surprise.svg",
      wink: "/assets/expressions/wink.svg",
      neutral: "/assets/expressions/neutral.svg",
      angry: "/assets/expressions/angry.svg",
      love: "/assets/expressions/love.svg"
    },
    voiceProfile: { provider: "local", voice: "browser-zh-CN" }
  }
];

const localModeLine = {
  sweet: {
    happy: "你开心的时候我也会被带着笑起来。",
    sad: "我先陪你待一会儿，不急着让你马上变好。",
    surprise: "这个反转有点突然，我想听你继续说。",
    wink: "你这句有点调皮，我接住了。",
    neutral: "我在这儿，慢慢聊就好。",
    angry: "我先听你把情绪说完，再一起理清楚。",
    love: "你这样说我会有点心软，也会更想靠近你。"
  },
  flirty: {
    happy: "你这么开心，我也想靠近一点听你多说几句。",
    sad: "别一个人扛着，先把难过放我这里。",
    surprise: "你这一下挺会吊我胃口的。",
    wink: "你这句有点会撩，我可没有装作没听见。",
    neutral: "我喜欢你这样慢慢打开话题。",
    angry: "先别急着爆炸，把火气交给我一点。",
    love: "你说想我，我会心动；想抱抱的话，我也想抱抱你。"
  },
  playful: {
    happy: "这份开心我收下了，今天你负责说，我负责陪你笑。",
    sad: "先暂停难过十秒，我陪你把它讲成一个能过去的故事。",
    surprise: "剧情突然升级，我要认真听后续。",
    wink: "你这点小坏心思还挺可爱。",
    neutral: "要不要换个轻松点的角度聊？",
    angry: "这小脾气我记下了，但我还是站你这边。",
    love: "你这份甜度有点超标，不过我挺喜欢。"
  },
  mature: {
    happy: "这个状态很好，我们可以顺着它继续聊。",
    sad: "你不需要马上给出答案，先把感受说完整。",
    surprise: "有些事确实会超出预期，我们先把它拆开。",
    wink: "你有点坏，但我能接受这个节奏。",
    neutral: "我会认真听你说完，再给你回应。",
    angry: "我们先让情绪降一点，再决定怎么处理。",
    love: "亲密感可以慢慢建立，我会稳稳地回应你。"
  }
};

function getActiveCharacter(ctx) {
  return ctx.data.characters?.find((item) => item.id === ctx.data.characterId) || null;
}

function resolveEmotionImage(character, emotion) {
  if (!character || !character.emotionProfile) return "";
  const image = character.emotionProfile[emotion];
  return typeof image === "string" && image.trim() ? image : "";
}

function resolveEmotionVideo(character, emotion) {
  if (!character || !character.avatarVideoProfile) return "";
  const video = character.avatarVideoProfile[emotion];
  return typeof video === "string" && video.trim() ? video : "";
}

function normalizeEmotionProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return undefined;
  }

  const next = {};
  Object.keys(profile).forEach((key) => {
    if (typeof profile[key] === "string") {
      const fixed = resolveApiAsset(profile[key]);
      if (fixed) {
        next[key] = fixed;
      }
    }
  });

  return next;
}

function resolveApiAsset(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//.test(trimmed) || /^data:|^blob:/i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/assets/")) {
    return trimmed;
  }

  const apiBase = getApiBase();
  if (!apiBase) return trimmed;
  return trimmed.startsWith("/") ? `${apiBase}${trimmed}` : `${apiBase}/${trimmed}`;
}

function resolveModelUrl(raw) {
  return resolveApiAsset(raw);
}

function resolveAvatarRenderStatus(character, mode) {
  if (mode === "2d") {
    return "2D头像/表情模式，适合低性能设备";
  }

  if (String(character?.modelUrl || "").trim()) {
    return "3D模型已配置，小程序当前使用2D表情预览回退";
  }

  return "3D模型未配置，显示2D表情";
}

function readAvatarRenderMode() {
  try {
    return wx.getStorageSync(STORAGE_KEY_AVATAR_RENDER_MODE) === "2d" ? "2d" : "3d";
  } catch {
    return "3d";
  }
}

const localMoodKeywords = {
  happy: ["开心", "高兴", "开森", "棒", "喜欢", "爱", "甜", "nice", "great", "好笑", "哈哈", "开心死了", "太好了"],
  sad: ["难过", "伤心", "失落", "烦", "哭", "sad", "难受", "心碎", "失望"],
  surprise: ["惊讶", "真的吗", "怎么会", "哇", "wow", "不可思议", "没想到", "太突然", "惊人"],
  wink: ["撩", "调皮", "开玩笑", "可爱", "俏皮", "坏", "flirty", "小坏蛋", "撒娇"],
  neutral: [],
  angry: ["生气", "烦", "愤怒", "气死", "讨厌", "烦躁", "annoyed", "hate", "你怎么"],
  love: ["想你", "宝贝", "亲爱", "抱抱", "亲亲", "kiss", "爱你", "恋爱", "想念", "我好想"]
};

function inferLocalEmotion(text, fallback) {
  const normalized = String(text || "").toLowerCase();
  let bestEmotion = emotionTextMap[fallback] ? fallback : "neutral";
  let bestScore = 0;
  const priority = {
    love: 7,
    wink: 6,
    angry: 5,
    sad: 4,
    surprise: 3,
    happy: 2,
    neutral: 1
  };

  Object.keys(localMoodKeywords).forEach((emotion) => {
    const score = localMoodKeywords[emotion].reduce(
      (acc, keyword) => acc + (normalized.includes(String(keyword).toLowerCase()) ? 1 : 0),
      0
    );
    if (score > bestScore || (score === bestScore && score > 0 && priority[emotion] > priority[bestEmotion])) {
      bestScore = score;
      bestEmotion = emotion;
    }
  });

  return bestEmotion;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function readStorageJson(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    if (!value) return fallback;
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

function writeStorageJson(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch {
    // Storage can fail in restricted preview contexts.
  }
}

function normalizeMemoryText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength || 360);
}

function normalizeUserMemory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...emptyUserMemory };
  }

  return {
    displayName: normalizeMemoryText(raw.displayName, 80),
    preferredName: normalizeMemoryText(raw.preferredName, 80),
    preferences: normalizeMemoryText(raw.preferences, 360),
    importantFacts: normalizeMemoryText(raw.importantFacts, 360),
    boundaries: normalizeMemoryText(raw.boundaries, 360),
    relationshipNotes: normalizeMemoryText(raw.relationshipNotes, 360),
    updatedAt: normalizeMemoryText(raw.updatedAt, 60)
  };
}

function readUserMemory() {
  return normalizeUserMemory(readStorageJson(STORAGE_KEY_USER_MEMORY, emptyUserMemory));
}

function writeUserMemory(memory) {
  const normalized = normalizeUserMemory({
    ...memory,
    updatedAt: new Date().toISOString()
  });
  writeStorageJson(STORAGE_KEY_USER_MEMORY, normalized);
  return normalized;
}

function hasUserMemory(memory) {
  const normalized = normalizeUserMemory(memory);
  return Boolean(
    normalized.displayName ||
    normalized.preferredName ||
    normalized.preferences ||
    normalized.importantFacts ||
    normalized.boundaries ||
    normalized.relationshipNotes
  );
}

function buildUserMemorySystemMessage(memory, character) {
  const normalized = normalizeUserMemory(memory);
  if (!hasUserMemory(normalized)) {
    return null;
  }

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

function isEmotion(value) {
  return typeof value === "string" && emotionModes.includes(value);
}

function isRelationshipMode(value) {
  return typeof value === "string" && relationshipModes.includes(value);
}

function normalizeStoredMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      role: item?.role,
      content: normalizeMemoryText(item?.content, 1200)
    }))
    .filter((item) => (item.role === "user" || item.role === "assistant" || item.role === "system") && item.content)
    .slice(-MAX_STORED_MESSAGES);
}

function normalizeStoredContext(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const affinity = raw.relationshipAffinity;
  if (affinity !== "new" && affinity !== "warm" && affinity !== "close" && affinity !== "intimate") {
    return null;
  }
  if (!isEmotion(raw.lastEmotion)) return null;

  return {
    relationshipAffinity: affinity,
    summary: normalizeMemoryText(raw.summary, 600),
    userSignals: Array.isArray(raw.userSignals)
      ? raw.userSignals.map((item) => normalizeMemoryText(item, 60)).filter(Boolean).slice(-8)
      : [],
    lastEmotion: raw.lastEmotion,
    activeRelationshipMode: isRelationshipMode(raw.activeRelationshipMode) ? raw.activeRelationshipMode : undefined,
    turnCount: typeof raw.turnCount === "number" ? raw.turnCount : 0,
    updatedAt: normalizeMemoryText(raw.updatedAt, 60)
  };
}

function normalizeImportedChatState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const messages = normalizeStoredMessages(raw.messages);
  if (!messages.length) return null;
  const context = normalizeStoredContext(raw.context);
  return {
    version: 1,
    messages,
    emotion: isEmotion(raw.emotion) ? raw.emotion : context?.lastEmotion || "neutral",
    relationshipMode: isRelationshipMode(raw.relationshipMode)
      ? raw.relationshipMode
      : context?.activeRelationshipMode || "sweet",
    context,
    updatedAt: new Date().toISOString()
  };
}

function getArchiveChatStateKey(sessionId, characterId) {
  return `${CHAT_STATE_ARCHIVE_PREFIX}:${encodeURIComponent(sessionId || "session-mini")}:${encodeURIComponent(characterId || "lina")}`;
}

function readMiniChatStates() {
  const value = readStorageJson(STORAGE_KEY_CHAT_STATES, {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function saveMiniChatStates(states) {
  writeStorageJson(STORAGE_KEY_CHAT_STATES, states && typeof states === "object" && !Array.isArray(states) ? states : {});
}

function saveMiniChatState(sessionId, characterId, state) {
  const normalized = normalizeImportedChatState(state);
  if (!normalized) return;
  const states = readMiniChatStates();
  states[getArchiveChatStateKey(sessionId, characterId)] = normalized;
  saveMiniChatStates(states);
}

function readMiniChatState(sessionId, characterId) {
  const states = readMiniChatStates();
  return normalizeImportedChatState(states[getArchiveChatStateKey(sessionId, characterId)]);
}

function normalizeImportedHumans(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const id = normalizeMemoryText(item.id, 100);
      const name = normalizeMemoryText(item.name, 80);
      if (!id.startsWith("custom-") || !name) return null;
      const voiceProfile = item.voiceProfile && typeof item.voiceProfile === "object" ? item.voiceProfile : {};
      const provider = voiceProviders.includes(voiceProfile.provider) ? voiceProfile.provider : "local";
      return {
        id,
        name,
        description: normalizeMemoryText(item.description || "导入的数字人", 300),
        avatarUrl: normalizeMemoryText(item.avatarUrl || "/assets/avatars/lina.svg", 500),
        modelUrl: normalizeMemoryText(item.modelUrl, 500) || undefined,
        avatarType: item.avatarType === "video" ? "video" : "image",
        emotionProfile: normalizeEmotionProfile(item.emotionProfile),
        avatarVideoProfile: normalizeEmotionProfile(item.avatarVideoProfile),
        personalityTagline: normalizeMemoryText(item.personalityTagline, 200),
        relationshipMode: isRelationshipMode(item.relationshipMode) ? item.relationshipMode : "sweet",
        voiceProfile: {
          provider,
          voice: normalizeMemoryText(voiceProfile.voice || "browser-zh-CN", 120)
        },
        defaultMood: isEmotion(item.defaultMood) ? item.defaultMood : "neutral"
      };
    })
    .filter(Boolean);
}

function normalizeImportedContexts(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  Object.keys(raw).forEach((key) => {
    const context = normalizeStoredContext(raw[key]);
    if (context) {
      result[String(key)] = context;
    }
  });
  return result;
}

function buildCurrentChatState(data) {
  const context =
    data.relationshipAffinity && isEmotion(data.emotion)
      ? {
          relationshipAffinity: data.relationshipAffinity,
          summary: normalizeMemoryText(data.relationshipSummary, 600),
          userSignals: normalizeMemoryText(data.relationshipSignals, 300).split("、").map((item) => item.trim()).filter(Boolean),
          lastEmotion: data.emotion,
          activeRelationshipMode: isRelationshipMode(data.conversationRelationshipMode) ? data.conversationRelationshipMode : undefined,
          turnCount: Number(data.relationshipTurns || 0),
          updatedAt: new Date().toISOString()
        }
      : null;

  return normalizeImportedChatState({
    version: 1,
    messages: data.messages,
    emotion: data.emotion,
    relationshipMode: data.conversationRelationshipMode || "sweet",
    context
  });
}

function buildMiniArchive(data) {
  const currentState = buildCurrentChatState(data);
  const chatStates = readMiniChatStates();
  if (currentState) {
    chatStates[getArchiveChatStateKey(data.sessionId, data.characterId)] = currentState;
    saveMiniChatStates(chatStates);
  }

  return {
    schema: EXPORT_SCHEMA,
    version: 1,
    exportedAt: new Date().toISOString(),
    sessionId: data.sessionId,
    selectedCharacterId: data.characterId,
    avatarRenderMode: data.avatarRenderMode === "2d" ? "2d" : "3d",
    userMemory: normalizeUserMemory(data.userMemory),
    localHumans: normalizeImportedHumans(getLocalCustomHumans()),
    localContexts: normalizeImportedContexts(readLocalContexts()),
    chatStates: Object.keys(chatStates).map((key) => ({ key, value: chatStates[key] }))
  };
}

function importMiniArchive(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("导入内容格式不正确");
  }
  if (payload.schema !== EXPORT_SCHEMA || payload.version !== 1) {
    throw new Error("不是数字女友本地记录文件");
  }

  const importedHumans = normalizeImportedHumans(payload.localHumans);
  const humanMap = new Map(getLocalCustomHumans().map((item) => [item.id, item]));
  importedHumans.forEach((human) => humanMap.set(human.id, human));
  saveLocalCustomHumans(Array.from(humanMap.values()));

  const importedContexts = normalizeImportedContexts(payload.localContexts);
  writeStorageJson(STORAGE_KEY_LOCAL_CONTEXT, {
    ...readLocalContexts(),
    ...importedContexts
  });

  const importedMemory = normalizeUserMemory(payload.userMemory);
  const hasMemory = hasUserMemory(importedMemory);
  if (hasMemory) {
    writeStorageJson(STORAGE_KEY_USER_MEMORY, importedMemory);
  }

  const chatStates = readMiniChatStates();
  let importedChatCount = 0;
  if (Array.isArray(payload.chatStates)) {
    payload.chatStates.forEach((entry) => {
      const key = normalizeMemoryText(entry?.key, 220);
      if (!key.startsWith(`${CHAT_STATE_ARCHIVE_PREFIX}:`)) return;
      const state = normalizeImportedChatState(entry.value);
      if (!state) return;
      chatStates[key] = state;
      importedChatCount += 1;
    });
  }
  saveMiniChatStates(chatStates);

  if (payload.sessionId) {
    wx.setStorageSync(STORAGE_KEY_SESSION, normalizeMemoryText(payload.sessionId, 120));
  }
  if (payload.selectedCharacterId) {
    wx.setStorageSync(STORAGE_KEY_CHARACTER, normalizeMemoryText(payload.selectedCharacterId, 120));
  }
  if (payload.avatarRenderMode === "2d" || payload.avatarRenderMode === "3d") {
    wx.setStorageSync(STORAGE_KEY_AVATAR_RENDER_MODE, payload.avatarRenderMode);
  }

  return {
    humans: importedHumans.length,
    chats: importedChatCount,
    hasMemory,
    sessionId: normalizeMemoryText(payload.sessionId, 120),
    selectedCharacterId: normalizeMemoryText(payload.selectedCharacterId, 120),
    avatarRenderMode: payload.avatarRenderMode === "2d" ? "2d" : "3d"
  };
}

function getLocalCustomHumans() {
  const humans = readStorageJson(STORAGE_KEY_LOCAL_HUMANS, []);
  return Array.isArray(humans) ? humans.filter((item) => item && item.id && item.name) : [];
}

function saveLocalCustomHumans(humans) {
  writeStorageJson(
    STORAGE_KEY_LOCAL_HUMANS,
    humans.filter((item) => item && typeof item.id === "string" && item.id.indexOf("custom-") === 0)
  );
}

function getLocalHumans() {
  return [...BUILT_IN_HUMANS.map(cloneJson), ...getLocalCustomHumans().map(cloneJson)];
}

function readLocalContexts() {
  const contexts = readStorageJson(STORAGE_KEY_LOCAL_CONTEXT, {});
  return contexts && typeof contexts === "object" && !Array.isArray(contexts) ? contexts : {};
}

function saveLocalContext(sessionId, context) {
  const contexts = readLocalContexts();
  contexts[sessionId || "session-mini"] = context;
  writeStorageJson(STORAGE_KEY_LOCAL_CONTEXT, contexts);
}

function clearLocalContext(sessionId) {
  const contexts = readLocalContexts();
  delete contexts[sessionId || "session-mini"];
  writeStorageJson(STORAGE_KEY_LOCAL_CONTEXT, contexts);
}

function localRelationshipLevel(turnCount) {
  if (turnCount >= 12) return "intimate";
  if (turnCount >= 7) return "close";
  if (turnCount >= 3) return "warm";
  return "new";
}

function extractLocalSignals(text, previous) {
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
  const next = new Set(Array.isArray(previous) ? previous.slice(-5) : []);
  candidates.forEach((item) => {
    if (String(text || "").includes(item)) {
      next.add(item);
    }
  });
  return Array.from(next).slice(-6);
}

function resolveLocalRelationshipMode(message, requestedMode, character, previous) {
  const normalized = String(message || "").toLowerCase();
  const wantsFlirty = ["暧昧", "想你", "爱你", "亲亲", "抱抱", "kiss", "心动"].some((word) => normalized.includes(word));
  if (wantsFlirty && (!requestedMode || requestedMode === "sweet")) {
    return "flirty";
  }
  return requestedMode || previous?.activeRelationshipMode || character?.relationshipMode || "sweet";
}

function buildLocalContext(payload, emotion, character) {
  const contexts = readLocalContexts();
  const previous = contexts[payload.sessionId || "session-mini"];
  const turnCount = (previous?.turnCount || 0) + 1;
  const activeRelationshipMode = resolveLocalRelationshipMode(
    payload.message,
    payload.relationshipMode,
    character,
    previous
  );
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

function extractLocalMemorySummary(payload) {
  const history = Array.isArray(payload.history) ? payload.history : [];
  const memory = history.find((item) => item.role === "system" && String(item.content || "").includes("长期记忆"))?.content || "";
  if (!memory) return {};

  const cleanHint = (value) => String(value || "").trim().replace(/[。；;，,\s]+$/g, "");
  const preferredName = String((memory.match(/希望数字人称呼用户：([^\n]+)/) || [])[1] || "").trim();
  const preferences = cleanHint((memory.match(/聊天偏好：([^\n]+)/) || [])[1]);
  const facts = cleanHint((memory.match(/重要事实：([^\n]+)/) || [])[1]);
  const notes = cleanHint((memory.match(/关系备注：([^\n]+)/) || [])[1]);
  const hintParts = [preferences, facts, notes].filter(Boolean).slice(0, 2);

  return {
    preferredName,
    profileHint: hintParts.length ? `我也会记得你说过${hintParts.join("；")}。` : ""
  };
}

function buildLocalReply(payload, character, emotion, context) {
  const mode = context.activeRelationshipMode || character.relationshipMode || "sweet";
  const line = localModeLine[mode]?.[emotion] || localModeLine.sweet.neutral;
  const clean = String(payload.message || "").trim();
  const quoted = clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
  const localMemory = extractLocalMemorySummary(payload);
  const nameHint = localMemory.preferredName ? `${localMemory.preferredName}，` : character.name ? `${character.name}在听，` : "";
  const memoryHint =
    localMemory.profileHint ||
    (context.userSignals.length > 1 ? `我也记得你前面提到过${context.userSignals.slice(0, -1).join("、")}。` : "");
  const followUp =
    emotion === "love" || mode === "flirty"
      ? "你可以继续说得更直接一点，我会顺着你的节奏回应。"
      : emotion === "angry"
        ? "先把最让你不舒服的那一点告诉我。"
        : "继续说，我会按你的情绪慢慢跟上。";

  return `${nameHint}${quoted ? `你刚才说「${quoted}」，` : ""}${line}${memoryHint}${followUp}`;
}

function splitLocalChunks(text) {
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + 8));
    cursor += 8;
  }
  return chunks;
}

function buildLocalParsedChat(payload) {
  const humans = getLocalHumans();
  const character = humans.find((item) => item.id === payload.characterId) || humans[0] || BUILT_IN_HUMANS[0];
  const previous = readLocalContexts()[payload.sessionId || "session-mini"];
  const emotion = inferLocalEmotion(payload.message, previous?.lastEmotion || character.defaultMood || "neutral");
  const context = buildLocalContext(payload, emotion, character);
  saveLocalContext(payload.sessionId, context);

  const done = {
    sessionId: payload.sessionId,
    characterId: character.id,
    text: buildLocalReply(payload, character, emotion, context),
    emotion,
    context,
    audioUrl: "",
    hasFallback: true
  };
  const chunks = splitLocalChunks(done.text);
  return {
    chunks,
    final: done,
    audioUrl: "",
    context,
    events: [
      { event: "emotion", data: { emotion } },
      ...chunks.map((text) => ({ event: "chunk", data: { text } })),
      { event: "done", data: done }
    ],
    hasError: false
  };
}

function getApiBase() {
  const apiBase = getApp().globalData.apiBase || "";
  return String(apiBase).replace(/\/$/, "");
}

function parseStreamText(raw) {
  const source = String(raw || "");

  if (!source.trim()) {
    return [];
  }

  if (source.trim().startsWith("{")) {
    try {
      const json = JSON.parse(source);
      return [{ event: "done", data: json }];
    } catch {
      return [];
    }
  }

  const lines = source.split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === "") {
      if (current) {
        events.push(current);
        current = null;
      }
      continue;
    }

    if (!current) {
      current = { event: "message", data: "" };
    }

    if (line.startsWith("event:")) {
      current.event = line.replace("event:", "").trim();
      continue;
    }
    if (line.startsWith("data:")) {
      current.data += line.replace("data:", "").trim();
    }
  }

  if (current) {
    events.push(current);
  }

  return events.filter((item) => item.data);
}

function resolveLastStateFromEvents(parsedEvents, fallbackText) {
  let text = "";
  let emotion = "";
  let audioUrl = "";
  let context = null;

  parsedEvents.forEach((evt) => {
    if (!evt || !evt.data) return;
    const data = evt.data;
    if (evt.event === "chunk" && typeof data.text === "string") {
      text += data.text;
    } else if (evt.event === "done" && typeof data.text === "string") {
      text = data.text;
      if (typeof data.emotion === "string") {
        emotion = data.emotion;
      }
      if (typeof data.audioUrl === "string") {
        audioUrl = data.audioUrl;
      }
      if (data.context && typeof data.context === "object") {
        context = data.context;
      }
    } else if (evt.event === "emotion" && typeof data.emotion === "string") {
      emotion = data.emotion;
    }
  });

  return {
    text: text || String(fallbackText || ""),
    emotion: emotion || "neutral",
    audioUrl,
    context
  };
}

function parseEventPayload(raw) {
  const rawEvents = parseStreamText(raw);
  if (rawEvents.length === 0) {
    return { events: [], chunks: [], final: null };
  }

  const events = rawEvents.map((evt) => {
    try {
      return {
        ...evt,
        data: JSON.parse(evt.data)
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  const chunks = [];
  let latestEmotion = "";
  let audioUrl = "";
  let context = null;
  let hasError = false;
  let done = null;
  events.forEach((evt) => {
    if (evt.event === "chunk" && typeof evt.data.text === "string") {
      chunks.push(evt.data.text);
    }
    if (evt.event === "emotion" && typeof evt.data.emotion === "string") {
      latestEmotion = evt.data.emotion;
    }
    if (evt.event === "done") {
      done = evt.data;
      if (typeof evt.data.audioUrl === "string") {
        audioUrl = evt.data.audioUrl;
      }
      if (evt.data && typeof evt.data.context === "object") {
        context = evt.data.context;
      }
    }
    if (evt.event === "error") {
      hasError = true;
    }
  });

  if (!done) {
    const maybeDone = resolveLastStateFromEvents(events, "");
    if (maybeDone.text || events.length === 1) {
      done = {
        text: maybeDone.text,
        emotion: maybeDone.emotion,
        context: maybeDone.context
      };
    }
  }

  context = context || (done && done.context) || null;

  return {
    chunks,
    final: done || { text: chunks.join(""), emotion: latestEmotion || "neutral" },
    audioUrl,
    context,
    events,
    hasError
  };
}

Page({
  data: {
    messages: [{ role: "assistant", content: "你好呀，欢迎回来～" }],
    emotion: "neutral",
    expression: expressionMap.neutral,
    expressionVideo: "",
    emotionLabel: emotionTextMap.neutral,
    expressionImage: "",
    relationshipAffinity: "",
    relationshipAffinityLabel: "",
    relationshipSummary: "",
    relationshipSignals: "",
    relationshipTurns: 0,
    loading: false,
    input: "",
    sessionId: "",
    characters: [],
    characterNames: [],
    pickerIndex: 0,
    characterId: "lina",
    characterName: "Lina",
    characterAvatar: "/assets/avatars/lina.svg",
    characterModelUrl: "",
    avatarRenderMode: "3d",
    avatarRenderStatus: "3D模型未配置，显示2D表情",
    conversationRelationshipMode: "sweet",
    userMemory: { ...emptyUserMemory },
    memoryActive: false,
    memoryStatus: "",
    archiveText: "",
    archiveStatus: "",
    speaking: false,
    lipPhase: 0,
    newHuman: {
      name: "",
      description: "",
      avatarUrl: "/assets/avatars/lina.svg",
      modelUrl: "",
      voice: "nova",
      voiceProvider: "openai",
      defaultMood: "neutral",
      personalityTagline: "",
      relationshipMode: "sweet",
      emotionProfile: "{}",
      avatarType: "image",
      avatarVideoProfile: "{}"
    },
    createMood: "neutral",
    creating: false,
    createError: "",
    isRecording: false,
    isTranscribing: false,
    transcribeError: ""
  },

  _revealTimer: null,
  _lipTimer: null,
  _lipOpen: false,
  _audioContext: null,
  _recorderManager: null,
  _fileSystemManager: null,
  _suppressTapAfterTouch: false,

  onLoad() {
    const cached = wx.getStorageSync(STORAGE_KEY_SESSION);
    const sessionId = cached || `mini-${Date.now()}-${Math.floor(Math.random() * 999999)}`;
    if (!cached) {
      wx.setStorageSync(STORAGE_KEY_SESSION, sessionId);
    }

    const cachedCharacter = wx.getStorageSync(STORAGE_KEY_CHARACTER);
    const cachedAvatarRenderMode = readAvatarRenderMode();
    const userMemory = readUserMemory();
    this.setData({
      sessionId,
      characterId: cachedCharacter || "lina",
      avatarRenderMode: cachedAvatarRenderMode,
      userMemory,
      memoryActive: hasUserMemory(userMemory)
    });
    this._recorderManager = wx.getRecorderManager();
    this._fileSystemManager = wx.getFileSystemManager();
    this._bindRecorderEvents();
    this.fetchCharacters(cachedCharacter || "lina");
  },

  onUnload() {
    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }
    if (this._lipTimer) {
      clearInterval(this._lipTimer);
      this._lipTimer = null;
    }
    if (this._recorderManager) {
      this._recorderManager.stop();
      this._recorderManager = null;
    }
  },

  onHide() {
    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }
    if (this._lipTimer) {
      clearInterval(this._lipTimer);
      this._lipTimer = null;
    }
    if (this._audioContext) {
      this._audioContext.stop();
      this._audioContext.destroy();
      this._audioContext = null;
    }
    if (this._recorderManager) {
      this._recorderManager.stop();
      this._recorderManager = null;
    }
    this.setData({
      isRecording: false,
      isTranscribing: false
    });
    this._setTranscribeError("");
  },

  _bindRecorderEvents() {
    if (!this._recorderManager) {
      return;
    }

    this._recorderManager.onStop((res) => {
      this.setData({ isRecording: false });

      const tempFilePath = res?.tempFilePath || "";
      if (!tempFilePath) {
        this.setData({ isTranscribing: false });
        return;
      }

      this._transcribeAndSend(tempFilePath);
    });

    this._recorderManager.onError(() => {
      this.setData({
        isRecording: false,
        isTranscribing: false
      });
    });
  },

  resetSession() {
    if (this.data.loading) {
      return;
    }

    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }
    this.stopLipAnimation();
    if (this._audioContext) {
      this._audioContext.stop();
      this._audioContext.destroy();
      this._audioContext = null;
    }

    const apiBase = getApiBase();
    const newSessionId = `mini-${Date.now()}-${Math.floor(Math.random() * 999999)}`;
    const activeCharacter = getActiveCharacter(this);
    const nextEmotion = activeCharacter?.defaultMood || "neutral";

    wx.request({
      url: `${apiBase}/api/session/${encodeURIComponent(this.data.sessionId)}`,
      method: "DELETE",
      fail: () => {},
      complete: () => {
        clearLocalContext(this.data.sessionId);
        const chatStates = readMiniChatStates();
        delete chatStates[getArchiveChatStateKey(this.data.sessionId, this.data.characterId)];
        saveMiniChatStates(chatStates);
        wx.setStorageSync(STORAGE_KEY_SESSION, newSessionId);
        this.setData({
          sessionId: newSessionId,
          messages: [{ role: "assistant", content: "你好呀，欢迎回来～" }],
          emotion: nextEmotion,
          speaking: false,
          loading: false,
          input: "",
          relationshipAffinity: "",
          relationshipAffinityLabel: "",
          relationshipSummary: "",
          relationshipSignals: "",
          relationshipTurns: 0,
          conversationRelationshipMode: activeCharacter?.relationshipMode || "sweet"
        });
        this.applyEmotion(nextEmotion, activeCharacter);
      }
    });
  },

  applyEmotion(emotion, character) {
    const targetCharacter = character || getActiveCharacter(this);
    const expressionImage = resolveApiAsset(resolveEmotionImage(targetCharacter, emotion));
    const expressionVideo = resolveApiAsset(resolveEmotionVideo(targetCharacter, emotion));
    const shouldUseVideo = (targetCharacter?.avatarType || "image") === "video";
    this.setData({
      emotion,
      expression: expressionMap[emotion],
      emotionLabel: emotionTextMap[emotion],
      expressionImage: shouldUseVideo ? "" : expressionImage,
      expressionVideo: shouldUseVideo && expressionVideo ? expressionVideo : ""
    });
  },

  _applyCharacterList(list, preferredCharacterId) {
    const safeList = Array.isArray(list) && list.length > 0 ? list : getLocalHumans();
    const pickId = preferredCharacterId || wx.getStorageSync(STORAGE_KEY_CHARACTER) || "lina";
    let pickerIndex = safeList.findIndex((item) => item.id === pickId);
    if (pickerIndex < 0) {
      pickerIndex = 0;
    }
    const selected = safeList[pickerIndex] || safeList[0];
    const selectedId = selected?.id || "lina";
    const avatarRenderMode = this.data.avatarRenderMode || readAvatarRenderMode();

    this.setData({
      characters: safeList,
      characterNames: safeList.map((item) => item.name || item.id),
      pickerIndex,
      characterId: selectedId,
      characterName: selected?.name || selected?.id || "Lina",
      characterAvatar: resolveApiAsset(selected?.avatarUrl || "/assets/avatars/lina.svg"),
      characterModelUrl: resolveModelUrl(selected?.modelUrl || ""),
      avatarRenderMode,
      avatarRenderStatus: resolveAvatarRenderStatus(selected, avatarRenderMode),
      conversationRelationshipMode: selected?.relationshipMode || "sweet"
    });
    wx.setStorageSync(STORAGE_KEY_CHARACTER, selectedId);
    this.applyEmotion(selected?.defaultMood || "neutral", selected);
    this._restoreStoredChatState(selectedId, selected);
  },

  _restoreStoredChatState(characterId, character) {
    const stored = readMiniChatState(this.data.sessionId, characterId);
    if (!stored) return;

    const visibleMessages = stored.messages.filter((item) => item.role === "user" || item.role === "assistant");
    if (!visibleMessages.length) return;

    const context = stored.context || null;
    const signals = Array.isArray(context?.userSignals) ? context.userSignals.join("、") : "";
    const affinity = context?.relationshipAffinity || "";
    const activeCharacter = character || getActiveCharacter(this);

    this.setData({
      messages: visibleMessages,
      emotion: stored.emotion,
      relationshipAffinity: affinity,
      relationshipAffinityLabel: affinity ? relationshipLevelLabel[affinity] || affinity : "",
      relationshipSummary: context?.summary || "",
      relationshipSignals: signals,
      relationshipTurns: context?.turnCount || 0,
      conversationRelationshipMode: stored.relationshipMode || context?.activeRelationshipMode || activeCharacter?.relationshipMode || "sweet"
    });
    this.applyEmotion(stored.emotion, activeCharacter);
  },

  _loadLocalCharacters(preferredCharacterId) {
    this._applyCharacterList(getLocalHumans(), preferredCharacterId);
  },

  fetchCharacters(preferredCharacterId) {
    const apiBase = getApiBase();
    wx.request({
      url: `${apiBase}/api/digital-humans`,
      method: "GET",
      success: (res) => {
        const list = Array.isArray(res.data?.humans) ? res.data.humans : [];
        if (res.statusCode < 200 || res.statusCode >= 300 || list.length === 0) {
          this._loadLocalCharacters(preferredCharacterId);
          return;
        }
        this._applyCharacterList(list, preferredCharacterId);
      },
      fail: () => {
        this._loadLocalCharacters(preferredCharacterId);
      }
    });
  },

  onCharacterChange(e) {
    const pickerIndex = Number(e.detail.value || 0);
    const selected = this.data.characters[pickerIndex];
    if (!selected) return;

    wx.setStorageSync(STORAGE_KEY_CHARACTER, selected.id);
    this.setData({
      pickerIndex,
      characterId: selected.id,
      characterName: selected.name || selected.id,
      characterAvatar: resolveApiAsset(selected.avatarUrl || "/assets/avatars/lina.svg"),
      characterModelUrl: resolveModelUrl(selected.modelUrl || ""),
      avatarRenderStatus: resolveAvatarRenderStatus(selected, this.data.avatarRenderMode),
      conversationRelationshipMode: selected.relationshipMode || "sweet"
    });
    this.applyEmotion(selected.defaultMood || "neutral", selected);
    this._restoreStoredChatState(selected.id, selected);
  },

  onToggleAvatarRenderMode() {
    const nextMode = this.data.avatarRenderMode === "3d" ? "2d" : "3d";
    const current = getActiveCharacter(this);
    wx.setStorageSync(STORAGE_KEY_AVATAR_RENDER_MODE, nextMode);
    this.setData({
      avatarRenderMode: nextMode,
      avatarRenderStatus: resolveAvatarRenderStatus(current, nextMode)
    });
  },

  _removeLocalHuman(id) {
    saveLocalCustomHumans(getLocalCustomHumans().filter((item) => item.id !== id));
    const nextCharacters = this.data.characters.filter((item) => item.id !== id);
    const fallbackCharacters = nextCharacters.length > 0 ? nextCharacters : getLocalHumans();
    this._applyCharacterList(fallbackCharacters, fallbackCharacters[0]?.id || "lina");
  },

  onDeleteCurrentHuman() {
    const current = getActiveCharacter(this);
    if (!current || typeof current.id !== "string" || !current.id.startsWith("custom-")) {
      return;
    }

    wx.showModal({
      title: "删除数字人",
      content: "确定要删除当前数字人吗？",
      success: (res) => {
        if (!res.confirm) {
          return;
        }

        this.setData({ loading: true });
        const apiBase = getApiBase();
        wx.request({
          url: `${apiBase}/api/digital-humans/${encodeURIComponent(current.id)}`,
          method: "DELETE",
          success: (delRes) => {
            if (delRes.statusCode < 200 || delRes.statusCode >= 300) {
              this._removeLocalHuman(current.id);
              return;
            }

            this._removeLocalHuman(current.id);
          },
          fail: () => {
            this._removeLocalHuman(current.id);
          },
          complete: () => {
            this.setData({ loading: false });
          }
        });
      }
    });
  },

  onInput(e) {
    const text = e.detail.value;
    const emotion = inferLocalEmotion(text);
    this.setData({
      input: text,
      emotion
    });
    this.applyEmotion(emotion);
  },

  _renderParsedChat(parsed, nextMessages, assistantBase, assistantIndex) {
    const fullText = String(parsed.final?.text || parsed.chunks.join("") || "我先听你说的呢，等我想想...");
    const finalEmotion = parsed.final?.emotion || inferLocalEmotion(fullText);
    const events = parsed.events || [];
    const finalAudio = parsed.audioUrl || parsed.final?.audioUrl || "";
    const finalContext = parsed.context || parsed.final?.context || null;
    let cursor = 0;
    let shownText = "";
    let hasRemoteEmotion = false;
    let remoteEmotion = this.data.emotion || "neutral";
    const baseMessages = [...nextMessages, assistantBase];
    const revealStep = 4;
    const activeCharacter = getActiveCharacter(this);
    const contextSignals = Array.isArray(finalContext?.userSignals) ? finalContext.userSignals.join("、") : "";
    const contextSummary = typeof finalContext?.summary === "string" ? finalContext.summary : "";
    const contextTurns = typeof finalContext?.turnCount === "number" ? finalContext.turnCount : 0;
    const contextAffinity = typeof finalContext?.relationshipAffinity === "string" ? finalContext.relationshipAffinity : "";
    const contextAffinityLabel =
      contextAffinity ? relationshipLevelLabel[contextAffinity] || contextAffinity : "";
    const renderState = (nextText, emotionText, shouldStop) => {
      if (cursor <= 0 && (!nextText && parsed.chunks.length === 0)) {
        nextText = "我先听你说的呢，等我想想...";
      }

      const rolling = [...baseMessages];
      rolling[assistantIndex] = { role: "assistant", content: nextText };
      let inferred;
      if (emotionText) {
        inferred = emotionText;
        hasRemoteEmotion = true;
      } else if (!hasRemoteEmotion) {
        inferred = inferLocalEmotion(nextText);
      } else {
        inferred = remoteEmotion;
      }
      remoteEmotion = inferred;
      this.applyEmotion(inferred, activeCharacter);
      this.setData({
        messages: rolling,
        emotion: inferred
      });

      if (shouldStop) {
        clearInterval(this._revealTimer);
        this._revealTimer = null;
      }
    };

    const finalize = () => {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
      const finalMessages = [...baseMessages.slice(0, assistantIndex), { role: "assistant", content: fullText }];
      this.applyEmotion(finalEmotion, activeCharacter);
      this.setData({
        messages: finalMessages,
        speaking: false,
        loading: false,
        relationshipAffinityLabel: contextAffinityLabel,
        relationshipAffinity: contextAffinity,
        relationshipSummary: contextSummary,
        relationshipSignals: contextSignals,
        relationshipTurns: contextTurns,
        conversationRelationshipMode: finalContext?.activeRelationshipMode || this.data.conversationRelationshipMode || "sweet"
      });
      saveMiniChatState(this.data.sessionId, this.data.characterId, {
        version: 1,
        messages: finalMessages,
        emotion: finalEmotion,
        relationshipMode: finalContext?.activeRelationshipMode || this.data.conversationRelationshipMode || "sweet",
        context: finalContext
      });
      this.stopLipAnimation();

      if (finalAudio) {
        if (this._audioContext) {
          this._audioContext.stop();
          this._audioContext.destroy();
          this._audioContext = null;
        }
        this._audioContext = wx.createInnerAudioContext();
        this._audioContext.src = resolveApiAsset(finalAudio);
        this._audioContext.play();
      }
    };

    if (events.length === 0) {
      renderState(fullText, finalEmotion, true);
      finalize();
      return;
    }

    this._revealTimer = setInterval(() => {
      if (this.data.loading === false) {
        return;
      }
      if (!this._revealTimer) return;

      const evt = events[cursor];
      if (!evt) {
        if (shownText.length >= fullText.length) {
          finalize();
        } else {
          shownText = fullText.slice(0, shownText.length + revealStep);
          renderState(shownText);
        }
        return;
      }

      cursor += 1;

      if (evt.event === "chunk" && typeof evt.data?.text === "string") {
        shownText += evt.data.text;
      } else if (evt.event === "done" && typeof evt.data?.text === "string") {
        shownText = evt.data.text;
      }

      let nextEmotion = null;
      if (evt.event === "emotion" && typeof evt.data?.emotion === "string") {
        nextEmotion = evt.data.emotion;
        hasRemoteEmotion = true;
      } else if (evt.event === "done" && typeof evt.data?.emotion === "string") {
        nextEmotion = evt.data.emotion;
        hasRemoteEmotion = true;
      }

      renderState(shownText, nextEmotion);

      if (evt.event === "done" || shownText.length >= fullText.length) {
        finalize();
        this.stopLipAnimation();
      }
    }, 30);
  },

  _replyWithLocalFallback(userText, nextMessages, assistantBase, assistantIndex) {
    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }

    const memoryMessage = buildUserMemorySystemMessage(this.data.userMemory, getActiveCharacter(this));
    const requestHistory = memoryMessage ? [memoryMessage, ...nextMessages] : nextMessages;
    const parsed = buildLocalParsedChat({
      sessionId: this.data.sessionId,
      characterId: this.data.characterId,
      message: userText,
      relationshipMode: this.data.conversationRelationshipMode || "sweet",
      history: requestHistory
    });
    this._renderParsedChat(parsed, nextMessages, assistantBase, assistantIndex);
  },

  onMemoryInput(e) {
    const key = e.currentTarget.dataset.field;
    const value = e.detail.value;
    if (!key) return;

    const userMemory = {
      ...this.data.userMemory,
      [key]: value
    };
    this.setData({
      userMemory,
      memoryActive: hasUserMemory(userMemory),
      memoryStatus: ""
    });
  },

  onSaveUserMemory() {
    try {
      const saved = writeUserMemory(this.data.userMemory);
      this.setData({
        userMemory: saved,
        memoryActive: hasUserMemory(saved),
        memoryStatus: hasUserMemory(saved) ? "记忆已保存，会从下一条消息开始生效。" : "记忆已清空。"
      });
    } catch {
      this.setData({ memoryStatus: "保存失败，请检查小程序本地存储权限。" });
    }
  },

  onClearUserMemory() {
    try {
      wx.removeStorageSync(STORAGE_KEY_USER_MEMORY);
    } catch {
      // ignore storage clear failures
    }
    this.setData({
      userMemory: { ...emptyUserMemory },
      memoryActive: false,
      memoryStatus: "记忆已清空。"
    });
  },

  onArchiveTextInput(e) {
    this.setData({
      archiveText: e.detail.value,
      archiveStatus: ""
    });
  },

  onExportArchive() {
    try {
      const archive = buildMiniArchive(this.data);
      const raw = JSON.stringify(archive, null, 2);
      const statusText = `已导出 ${archive.localHumans.length} 个数字人、${archive.chatStates.length} 组聊天记录${hasUserMemory(archive.userMemory) ? "和长期记忆" : ""}。`;
      this.setData({
        archiveText: raw,
        archiveStatus: `${statusText} JSON 已放入下方文本框。`
      });
      wx.setClipboardData({
        data: raw,
        success: () => {
          this.setData({ archiveStatus: `${statusText} 已复制到剪贴板。` });
        },
        fail: () => {
          this.setData({ archiveStatus: `${statusText} 剪贴板不可用，请手动复制文本框内容。` });
        }
      });
    } catch {
      this.setData({ archiveStatus: "导出失败，请稍后重试。" });
    }
  },

  _importArchiveFromText(rawText) {
    const raw = String(rawText || "").trim();
    if (!raw) {
      this.setData({ archiveStatus: "请先粘贴导出的 JSON 记录。" });
      return;
    }

    try {
      const result = importMiniArchive(JSON.parse(raw));
      const sessionId = result.sessionId || wx.getStorageSync(STORAGE_KEY_SESSION) || this.data.sessionId;
      const selectedCharacterId = result.selectedCharacterId || wx.getStorageSync(STORAGE_KEY_CHARACTER) || this.data.characterId || "lina";
      const avatarRenderMode = result.avatarRenderMode || readAvatarRenderMode();
      const userMemory = readUserMemory();
      this.setData({
        sessionId,
        characterId: selectedCharacterId,
        avatarRenderMode,
        userMemory,
        memoryActive: hasUserMemory(userMemory),
        archiveStatus: `已导入 ${result.humans} 个数字人、${result.chats} 组聊天记录${result.hasMemory ? "和长期记忆" : ""}。`
      });
      this._applyCharacterList(getLocalHumans(), selectedCharacterId);
    } catch (error) {
      this.setData({
        archiveStatus: error && error.message ? error.message : "导入失败，请检查 JSON 内容。"
      });
    }
  },

  onImportArchive() {
    this._importArchiveFromText(this.data.archiveText);
  },

  onImportArchiveFromClipboard() {
    wx.getClipboardData({
      success: (res) => {
        const raw = String(res.data || "");
        this.setData({ archiveText: raw });
        this._importArchiveFromText(raw);
      },
      fail: () => {
        this.setData({ archiveStatus: "读取剪贴板失败，请手动粘贴 JSON。" });
      }
    });
  },

  sendTextMessage(text) {
    const userText = String(text || "").trim();
    if (!userText || this.data.loading) return;

    if (this._revealTimer) {
      clearInterval(this._revealTimer);
      this._revealTimer = null;
    }
    if (this.data.isTranscribing) {
      this.setData({ isTranscribing: false });
    }

    const nextMessages = [...this.data.messages, { role: "user", content: userText }];
    const memoryMessage = buildUserMemorySystemMessage(this.data.userMemory, getActiveCharacter(this));
    const requestHistory = memoryMessage ? [memoryMessage, ...nextMessages] : nextMessages;
    const assistantIndex = nextMessages.length;
    const emotionByInput = inferLocalEmotion(userText);
    const assistantBase = { role: "assistant", content: "" };

    this.setData({
      loading: true,
      input: "",
      emotion: emotionByInput,
      speaking: true,
      relationshipAffinity: "",
      relationshipAffinityLabel: "",
      relationshipSummary: "",
      relationshipSignals: "",
      relationshipTurns: 0,
      messages: [...nextMessages, assistantBase]
    });
    this._lipOpen = false;
    this.startLipAnimation();
    this.applyEmotion(emotionByInput);

    const apiBase = getApiBase();
    wx.request({
      url: `${apiBase}/api/chat/stream`,
      method: "POST",
      header: { "Content-Type": "application/json" },
      data: {
        sessionId: this.data.sessionId,
        characterId: this.data.characterId,
        message: userText,
        relationshipMode: this.data.conversationRelationshipMode || "sweet",
        history: requestHistory
      },
      success: (res) => {
        if (typeof res.statusCode === "number" && (res.statusCode < 200 || res.statusCode >= 300)) {
          this._replyWithLocalFallback(userText, nextMessages, assistantBase, assistantIndex);
          return;
        }
        const parsed = parseEventPayload(res.data);
        if (parsed.hasError || (!parsed.final && parsed.chunks.length === 0 && parsed.events.length === 0)) {
          this._replyWithLocalFallback(userText, nextMessages, assistantBase, assistantIndex);
          return;
        }
        this._renderParsedChat(parsed, nextMessages, assistantBase, assistantIndex);
      },
      fail: () => {
        this._replyWithLocalFallback(userText, nextMessages, assistantBase, assistantIndex);
      }
    });
  },

  onSend() {
    this.sendTextMessage(this.data.input);
  },

  _transcribeAndSend(tempFilePath) {
    if (!tempFilePath) {
      return;
    }

    if (!this._fileSystemManager) {
      this._fileSystemManager = wx.getFileSystemManager();
    }

    this.setData({ isTranscribing: true });
    this._setTranscribeError("");
    this._fileSystemManager.readFile({
      filePath: tempFilePath,
      encoding: "base64",
      success: (res) => {
        const payload = String(res.data || "").trim();
        if (!payload) {
          this.setData({ isTranscribing: false });
          return;
        }

        const apiBase = getApiBase();
        wx.request({
          url: `${apiBase}/api/transcribe`,
          method: "POST",
          header: { "Content-Type": "application/json" },
          data: {
            audioBase64: payload,
            mimeType: "audio/mp3"
          },
          success: (res) => {
            const transcript = String(res.data?.text || "").trim();
            if (transcript) {
              this.sendTextMessage(transcript);
              this._setTranscribeError("");
            } else {
              this.setData({
                input: "",
                isTranscribing: false
              });
              this._setTranscribeError("语音转写失败，请重试");
            }
          },
          fail: (_err) => {
            this.setData({
              isTranscribing: false
            });
            this._setTranscribeError("本地静态模式暂不支持录音转写，请手动输入");
          }
        });
      },
      fail: () => {
        this.setData({
          isTranscribing: false
        });
        this._setTranscribeError("读取录音文件失败");
      }
    });
  },

  onToggleVoiceInput() {
    if (this._suppressTapAfterTouch) {
      this._suppressTapAfterTouch = false;
      return;
    }

    if (!this._recorderManager) {
      return;
    }
    if (this.data.loading || this.data.isTranscribing) {
      return;
    }

    if (this.data.isRecording) {
      this._recorderManager.stop();
      this.setData({ isRecording: false });
      return;
    }

    this.setData({ isRecording: true, isTranscribing: true });
    this._recorderManager.start({
      format: "mp3",
      duration: 120000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000
    });
  },

  onStartVoiceInput() {
    if (!this._recorderManager) {
      return;
    }
    this._suppressTapAfterTouch = true;
    if (this.data.loading || this.data.isTranscribing) {
      this._suppressTapAfterTouch = false;
      return;
    }
    if (this.data.isRecording) {
      return;
    }
    if (!this._recorderManager) {
      this._setTranscribeError("未检测到录音能力");
      return;
    }

    this._setTranscribeError("");
    this.setData({ isRecording: true, isTranscribing: true });
    this._recorderManager.start({
      format: "mp3",
      duration: 120000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000
    });
  },

  onEndVoiceInput() {
    if (!this.data.isRecording || !this._recorderManager) {
      this._suppressTapAfterTouch = false;
      this.setData({ isRecording: false, isTranscribing: false });
      return;
    }
    this._recorderManager.stop();
    this.setData({ isRecording: false });
  },

  _setTranscribeError(message) {
    const text = String(message || "").trim();
    this.setData({ transcribeError: text });
  },

  startLipAnimation() {
    if (this._lipTimer) {
      clearInterval(this._lipTimer);
    }
    this.setData({ lipPhase: 0 });
    this._lipOpen = false;
    this._lipTimer = setInterval(() => {
      this._lipOpen = !this._lipOpen;
      this.setData({
        lipPhase: this._lipOpen ? 1 : 0
      });
    }, 170);
  },

  stopLipAnimation() {
    if (this._lipTimer) {
      clearInterval(this._lipTimer);
      this._lipTimer = null;
    }
    this._lipOpen = false;
    this.setData({ lipPhase: 0 });
  },

  onCreateInput(e) {
    const key = e.currentTarget.dataset.field;
    const value = e.detail.value;
    if (!key) return;

    this.setData({
      newHuman: { ...this.data.newHuman, [key]: value }
    });
  },

  onCreateModeChange(e) {
    const defaultMood = emotionModes[Number(e.detail.value)] || "neutral";
    this.setData({
      createMood: defaultMood,
      newHuman: { ...this.data.newHuman, defaultMood }
    });
  },

  onCreateRelationshipModeChange(e) {
    const relationshipMode = relationshipModes[Number(e.detail.value)] || "sweet";
    this.setData({
      newHuman: { ...this.data.newHuman, relationshipMode }
    });
  },

  onConversationRelationshipModeChange(e) {
    const selected = relationshipModes[Number(e.detail.value)] || "sweet";
    this.setData({ conversationRelationshipMode: selected });
  },

  onCreateVoiceProviderChange(e) {
    const voiceProvider = voiceProviders[Number(e.detail.value)] || "openai";
    this.setData({
      newHuman: { ...this.data.newHuman, voiceProvider }
    });
  },

  onAvatarTypeChange(e) {
    const avatarType = avatarTypes[Number(e.detail.value)] || "image";
    this.setData({
      newHuman: { ...this.data.newHuman, avatarType }
    });
  },

  _finishCreatedHuman(created) {
    const nextCharacters = [...this.data.characters, created];
    const nextNames = nextCharacters.map((item) => item.name || item.id);
    const pickerIndex = nextCharacters.length - 1;
    wx.setStorageSync(STORAGE_KEY_CHARACTER, created.id);

    this.setData({
      characters: nextCharacters,
      characterNames: nextNames,
      pickerIndex,
      characterId: created.id,
      characterName: created.name || created.id,
      characterAvatar: resolveApiAsset(created.avatarUrl || "/assets/avatars/lina.svg"),
      characterModelUrl: resolveModelUrl(created.modelUrl || ""),
      avatarRenderStatus: resolveAvatarRenderStatus(created, this.data.avatarRenderMode),
      conversationRelationshipMode: created.relationshipMode || "sweet",
      creating: false,
      newHuman: {
        name: "",
        description: "",
        avatarUrl: "/assets/avatars/lina.svg",
        modelUrl: "",
        voiceProvider: "openai",
        voice: "nova",
        defaultMood: "neutral",
        personalityTagline: "",
        relationshipMode: "sweet",
        emotionProfile: "{}",
        avatarType: "image",
        avatarVideoProfile: "{}"
      },
      createMood: "neutral",
      createError: ""
    });
    this.applyEmotion(created.defaultMood || "neutral", created);
  },

  _createLocalHuman(payload, emotionProfile, avatarVideoProfile) {
    const created = {
      id: `custom-mini-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
      name: String(payload.name || "").trim(),
      description: String(payload.description || "").trim(),
      avatarUrl: String(payload.avatarUrl || "/assets/avatars/lina.svg").trim(),
      modelUrl: String(payload.modelUrl || "").trim() || undefined,
      avatarType: payload.avatarType === "video" ? "video" : "image",
      emotionProfile: emotionProfile || cloneJson(BUILT_IN_HUMANS[0].emotionProfile),
      avatarVideoProfile,
      personalityTagline: String(payload.personalityTagline || "").trim(),
      relationshipMode: payload.relationshipMode || "sweet",
      voiceProfile: {
        provider: payload.voiceProvider || "local",
        voice: payload.voice || "browser-zh-CN"
      },
      defaultMood: payload.defaultMood || this.data.createMood || "neutral"
    };
    saveLocalCustomHumans([...getLocalCustomHumans(), created]);
    this._finishCreatedHuman(created);
  },

  onCreateHuman() {
    const payload = this.data.newHuman;
    if (!payload.name || !payload.description || !payload.avatarUrl || !payload.voice) {
      this.setData({ createError: "请完整填写数字人信息" });
      return;
    }

    let emotionProfile;
    try {
      const parsed = JSON.parse(String(payload.emotionProfile || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        emotionProfile = normalizeEmotionProfile(parsed);
      }
    } catch {
      emotionProfile = undefined;
    }
    let avatarVideoProfile;
    try {
      const parsed = JSON.parse(String(payload.avatarVideoProfile || "{}"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        avatarVideoProfile = normalizeEmotionProfile(parsed);
      }
    } catch {
      avatarVideoProfile = undefined;
    }

    this.setData({ creating: true, createError: "" });
    const apiBase = getApiBase();
    wx.request({
      url: `${apiBase}/api/digital-humans`,
      method: "POST",
      header: { "Content-Type": "application/json" },
      data: {
        ...payload,
        modelUrl: String(payload.modelUrl || "").trim() || undefined,
        avatarType: payload.avatarType,
        personalityTagline: String(payload.personalityTagline || "").trim(),
        relationshipMode: payload.relationshipMode || "sweet",
        emotionProfile,
        avatarVideoProfile
      },
      success: (res) => {
        const created = res.data?.human;
        if ((typeof res.statusCode === "number" && (res.statusCode < 200 || res.statusCode >= 300)) || !created) {
          this._createLocalHuman(payload, emotionProfile, avatarVideoProfile);
          return;
        }

        this._finishCreatedHuman(created);
      },
      fail: () => {
        this._createLocalHuman(payload, emotionProfile, avatarVideoProfile);
      }
    });
  }
});
