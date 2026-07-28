const API_BASE = process.env.API_BASE || process.env.WECHAT_API_BASE || "http://localhost:8787";

function deriveHostCandidates(apiBase) {
  const candidates = [apiBase];

  if (!apiBase.startsWith("http://") && !apiBase.startsWith("https://")) {
    return candidates;
  }

  try {
    const parsed = new URL(apiBase);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const protocol = parsed.protocol;

    const addCandidate = (nextHost) => {
      const candidate = `${protocol}//${nextHost}:${port}`;
      if (!candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    };

    if (host === "localhost") {
      addCandidate("127.0.0.1");
      addCandidate("[::1]");
    }
    if (host === "127.0.0.1") {
      addCandidate("localhost");
    }
  } catch {
    return candidates;
  }

  return candidates;
}

const API_BASES = deriveHostCandidates(API_BASE);

async function requestWithCandidates(path, init, preferredBase) {
  const lastErrs = [];
  const bases = preferredBase ? [preferredBase, ...API_BASES.filter((item) => item !== preferredBase)] : API_BASES;

  for (const base of bases) {
    try {
      return { base, data: await requestJSON(base, path, init) };
    } catch (error) {
      lastErrs.push(`${base}${path} -> ${error?.message || error}`);
      if (base === bases[bases.length - 1]) {
        throw new Error(lastErrs.join("；"));
      }
    }
  }

  throw new Error(lastErrs.join("；"));
}

async function requestJSON(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${path} 请求失败：${res.status} ${text || ""}`.trim());
  }
  return res.json();
}

async function resolveActiveBase() {
  const { base, data } = await requestWithCandidates("/healthz", undefined);
  if (data?.ok !== true) {
    throw new Error(`/healthz 返回异常: ${JSON.stringify(data)}`);
  }
  return base;
}

function makeTinyGlbBase64() {
  const json = JSON.stringify({ asset: { version: "2.0", generator: "digital-girlfriend-verify" } });
  const paddedJson = json.padEnd(Math.ceil(json.length / 4) * 4, " ");
  const jsonBytes = new TextEncoder().encode(paddedJson);
  const totalLength = 12 + 8 + jsonBytes.length;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(jsonBytes, 20);
  return Buffer.from(bytes).toString("base64");
}

async function uploadVerifyModel(apiBase) {
  const { data } = await requestWithCandidates("/api/models/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: `verify-model-${Date.now()}.glb`,
      fileBase64: makeTinyGlbBase64(),
      mimeType: "model/gltf-binary"
    })
  }, apiBase);

  if (!data?.modelUrl || !data?.fileName || typeof data.size !== "number" || data.size <= 0) {
    throw new Error(`模型上传返回异常: ${JSON.stringify(data)}`);
  }

  const fetchRes = await fetch(`${apiBase}${data.modelUrl}`);
  if (!fetchRes.ok) {
    throw new Error(`上传模型静态访问失败：${fetchRes.status}`);
  }

  console.log("✓ 模型上传并可静态访问", data.modelUrl);
  return data;
}

async function cleanupVerifyModel(apiBase, fileName) {
  if (!fileName) return;
  const res = await fetch(`${apiBase}/api/models/${encodeURIComponent(fileName)}`, {
    method: "DELETE"
  });
  if (res.ok) {
    console.log("✓ 模型文件清理成功");
  } else {
    console.log(`⚠️ 模型文件清理失败，状态码 ${res.status}`);
  }
}

async function readStreamEventText(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("stream 响应没有 body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let hasDone = false;
  let hasEmotion = false;
  let donePayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes("\n\n")) {
      const raw = buffer.slice(0, buffer.indexOf("\n\n"));
      buffer = buffer.slice(buffer.indexOf("\n\n") + 2);
      const eventLine = raw.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.replace("event:", "").trim() : "message";
      let payload = null;
      try {
        payload = JSON.parse(dataLine.replace(/^data:\s*/, ""));
      } catch {
        continue;
      }

      if (event === "emotion" && payload?.emotion) {
        hasEmotion = true;
      }
      if (event === "done" && payload?.text && payload?.emotion) {
        hasDone = true;
        donePayload = payload;
      }
    }
  }

  return { hasDone, hasEmotion, donePayload };
}

async function main() {
  const apiBase = await resolveActiveBase();
  const uploadedModel = await uploadVerifyModel(apiBase);
  let characterId = "";
  let sessionId = "";

  try {
    const createdResult = await requestWithCandidates("/api/digital-humans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `verify-loop-${Date.now()}`,
        description: "用于闭环验收",
        avatarUrl: "/assets/avatars/lina.svg",
        modelUrl: uploadedModel.modelUrl,
        voiceProvider: "local",
        voice: "nova",
        defaultMood: "neutral",
        relationshipMode: "sweet"
      })
    }, apiBase);

    const created = createdResult?.data;

    characterId = created?.human?.id || "";
    if (!characterId) {
      throw new Error("创建数字人未返回 human.id");
    }
    if (created?.human?.modelUrl !== uploadedModel.modelUrl) {
      throw new Error("创建数字人未保留 modelUrl");
    }
    console.log("✓ 数字人创建成功", characterId);

    sessionId = `verify-loop-${Date.now()}`;
    const streamRes = await fetch(`${apiBase}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "你好，今天天气很好，聊会儿天吧",
        characterId,
        sessionId,
        history: []
      })
    });
    if (!streamRes.ok) {
      throw new Error(`/api/chat/stream 返回失败：${streamRes.status}`);
    }
    const parsed = await readStreamEventText(streamRes);
    if (!parsed.hasDone) {
      throw new Error("流式返回未收到 done 事件");
    }
    if (!parsed.hasEmotion) {
      throw new Error("流式返回未收到 emotion 事件");
    }
    console.log("✓ 流式返回包含 done + emotion");

    console.log("闭环验收通过");
  } finally {
    if (sessionId) {
      await requestJSON(apiBase, `/api/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE"
      }).then(() => console.log("✓ 会话清理成功")).catch(() => {});
    }

    if (characterId) {
      const delRes = await fetch(`${apiBase}/api/digital-humans/${encodeURIComponent(characterId)}`, {
        method: "DELETE"
      });
      if (!delRes.ok) {
        console.log(`⚠️ 清理数字人失败，状态码 ${delRes.status}`);
      } else {
        console.log("✓ 数字人清理成功");
      }
    }

    await cleanupVerifyModel(apiBase, uploadedModel.fileName);
  }
}

main().catch((err) => {
  console.error(`验收失败：${err?.message || err}`);
  process.exit(1);
});
