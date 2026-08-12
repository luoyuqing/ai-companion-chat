const API_BASE = process.env.API_BASE || "http://localhost:8787";

function deriveHostCandidates(apiBase) {
  const candidates = [apiBase];

  if (!apiBase.startsWith("http://") && !apiBase.startsWith("https://")) {
    return [apiBase];
  }

  try {
    const url = new URL(apiBase);
    const host = url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const protocol = url.protocol;

    const pushCandidate = (nextHost) => {
      const next = `${protocol}//${nextHost}:${port}`;
      if (!candidates.includes(next)) {
        candidates.push(next);
      }
    };

    if (host === "127.0.0.1") {
      pushCandidate("localhost");
      pushCandidate("[::1]");
    }
    if (host === "localhost") {
      pushCandidate("127.0.0.1");
      pushCandidate("[::1]");
    }
  } catch {
    return candidates;
  }

  return candidates;
}

function apiBases() {
  const base = process.env.API_BASE || API_BASE;

  if (process.env.API_BASE) {
    return deriveHostCandidates(base);
  }

  return [
    "http://[::1]:8787",
    "http://127.0.0.1:8787",
    API_BASE
  ];
}

async function requestHealth(apiBase) {
  const res = await fetch(`${apiBase}/healthz`);
  if (!res.ok) {
    throw new Error(`/healthz 返回状态: ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  if (body?.ok !== true) {
    throw new Error("/healthz 响应字段不符合预期");
  }
  console.log("✓ 健康检查通过");
}

async function requestHumans(apiBase) {
  const res = await fetch(`${apiBase}/api/digital-humans`);
  if (!res.ok) {
    throw new Error(`/api/digital-humans 返回状态: ${res.status}`);
  }
  const body = await res.json();
  if (!Array.isArray(body?.humans) || body.humans.length === 0) {
    throw new Error("/api/digital-humans 未返回数字人列表");
  }
  console.log(`✓ 数字人列表返回正常（${body.humans.length}个）`);
}

async function requestChat(apiBase) {
  const res = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "先聊几句，测试下",
      characterId: "lina",
      sessionId: `verify-${Date.now()}`,
      history: []
    })
  });

  if (!res.ok) {
    throw new Error(`/api/chat 返回状态: ${res.status}`);
  }
  const body = await res.json();
  if (!body?.text || !body?.characterId) {
    throw new Error("/api/chat 响应不完整");
  }
  console.log("✓ /api/chat 可用");
}

async function requestChatStream(apiBase) {
  const res = await fetch(`${apiBase}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "继续聊，我想听你更甜一点",
      characterId: "lina",
      sessionId: `verify-stream-${Date.now()}`,
      history: []
    })
  });

  if (!res.ok) {
    throw new Error(`/api/chat/stream 返回状态: ${res.status}`);
  }
  if (!res.body) {
    throw new Error("/api/chat/stream 未返回流式内容");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let hasEmotionEvent = false;
  let hasDoneEvent = false;

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
      if (!dataLine) continue;

      const event = eventLine ? eventLine.replace("event:", "").trim() : "message";
      let payload;
      try {
        payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
      } catch {
        continue;
      }

      if (event === "chunk" && typeof payload.text === "string" && payload.text.length > 0) {
        chunkCount += 1;
      }
      if (event === "emotion" && typeof payload.emotion === "string") {
        hasEmotionEvent = true;
      }
      if (event === "done" && typeof payload.text === "string" && typeof payload.emotion === "string") {
        hasDoneEvent = true;
      }
    }
  }

  if (!hasDoneEvent || chunkCount <= 0) {
    throw new Error("/api/chat/stream 缺少 done/chunk 事件");
  }
  if (!hasEmotionEvent) {
    throw new Error("/api/chat/stream 缺少 emotion 事件");
  }
  console.log("✓ /api/chat/stream 可用");
}

async function requestCreateHumanAndContext(apiBase) {
  const createRes = await fetch(`${apiBase}/api/digital-humans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `verify-${Date.now()}`,
      description: "自动化验收专用数字人",
      avatarUrl: "/assets/avatars/lina.svg",
      voiceProvider: "local",
      voice: "nova",
      defaultMood: "neutral",
      relationshipMode: "sweet"
    })
  });

  if (!createRes.ok) {
    throw new Error(`/api/digital-humans 返回状态: ${createRes.status}`);
  }
  const createPayload = await createRes.json();
  const created = createPayload?.human;
  if (!created?.id || created?.voiceProfile?.provider !== "local") {
    throw new Error("数字人创建结果缺少语音提供商信息");
  }

  const sessionId = `verify-context-${Date.now()}`;
  const firstChatRes = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "先聊一下你今天的心情",
      sessionId,
      characterId: created.id
    })
  });
  if (!firstChatRes.ok) {
    throw new Error(`/api/chat 返回状态: ${firstChatRes.status}`);
  }
  await firstChatRes.json();

  const sessionRes = await fetch(`${apiBase}/api/session/${encodeURIComponent(sessionId)}`);
  if (!sessionRes.ok) {
    throw new Error("/api/session/ 查询失败");
  }
  const sessionRecord = await sessionRes.json();
  if (!sessionRecord?.context?.relationshipAffinity) {
    throw new Error("/api/session/ 未返回关系上下文");
  }
  if (!Array.isArray(sessionRecord?.history) || sessionRecord.history.length < 2) {
    throw new Error("/api/session/ 历史记录未持久化到位");
  }

  const secondChatRes = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "我刚才说的你记得吗",
      sessionId,
      characterId: created.id
    })
  });
  if (!secondChatRes.ok) {
    throw new Error("/api/chat（复用会话）返回状态异常");
  }
  await secondChatRes.json();

  await fetch(`${apiBase}/api/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE"
  }).catch(() => {});

  const cleanupRes = await fetch(`${apiBase}/api/digital-humans/${encodeURIComponent(created.id)}`, {
    method: "DELETE"
  });
  if (!cleanupRes.ok) {
    console.log("⚠️  自动验收数字人未能清理，请检查自定义数字人列表是否仍有 verify 人设。");
  }

  console.log("✓ 数字人创建与会话记忆闭环可用");
}

async function main() {
  const bases = apiBases();
  let lastErr = null;

  try {
    for (const base of bases) {
      try {
        await requestHealth(base);
        await requestHumans(base);
        await requestChat(base);
        await requestChatStream(base);
        await requestCreateHumanAndContext(base);
        console.log(`验收通过：服务端栈可运行（${base}）`);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      throw lastErr;
    }
  } catch (err) {
    console.error(`验收失败：${err?.message || err}`);
    process.exit(1);
  }
}

main();
