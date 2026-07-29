import OpenAI from "openai";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { getTtsConfig, getLlmConfig } from "../core/config";

function getOpenAiClient(): OpenAI | null {
  const apiKey = getLlmConfig().apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  return new OpenAI({
    apiKey,
    baseURL: getLlmConfig().baseUrl || process.env.OPENAI_BASE_URL || undefined
  });
}

function resolveWorkspaceRoot() {
  return path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
}

function normalizeMimeType(mimeType?: string) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("m4a")) return "m4a";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("opus")) return "opus";
  return "mp3";
}

export async function transcribeSpeechAudio(options: {
  audioBase64: string;
  mimeType?: string;
  language?: string;
}): Promise<string> {
  const { audioBase64, mimeType, language } = options;

  const payload = String(audioBase64 || "").replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  if (!payload) {
    throw new Error("语音内容为空");
  }

  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) {
    throw new Error("语音内容为空");
  }

  const provider = (process.env.ASR_PROVIDER || "openai").toLowerCase();
  if (provider === "mimo") {
    return await transcribeWithMimo(buffer, mimeType);
  }

  const client = getOpenAiClient();
  if (!client) {
    throw new Error("OPENAI_API_KEY 未配置，无法进行语音转写");
  }

  const ext = normalizeMimeType(mimeType);
  const workspaceRoot = resolveWorkspaceRoot();
  const speechDir = path.join(workspaceRoot, "server", "data", "audio", "incoming");
  await fsp.mkdir(speechDir, { recursive: true });
  const tempFilename = `dg-transcribe-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
  const tempFilePath = path.join(speechDir, tempFilename);

  await fsp.writeFile(tempFilePath, buffer);

  let transcript = "";
  const stream = fs.createReadStream(tempFilePath);
  try {
    const result = (await client.audio.transcriptions.create({
      file: stream,
      model: "whisper-1",
      language: language || "zh"
    })) as string | { text?: string };
    if (typeof result === "string") {
      transcript = result.trim();
    } else {
      transcript = String((result as { text?: string }).text || "").trim();
    }
  } finally {
    stream.destroy();
    await fsp.unlink(tempFilePath).catch(() => {});
  }

  if (!transcript) {
    throw new Error("未识别出语音文本");
  }

  return transcript;
}

async function transcribeWithMimo(buffer: Buffer, mimeType?: string): Promise<string> {
  const cfg = getTtsConfig();
  const apiKey = cfg.apiKey || process.env.MIMO_API_KEY;
  if (!apiKey) {
    throw new Error("MIMO_API_KEY 未配置，无法进行语音转写");
  }

  const baseURL = cfg.baseUrl || process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1";
  const model = process.env.MIMO_ASR_MODEL || "mimo-v2.5-asr";
  const fmt = mimeType && mimeType.toLowerCase().includes("mp3")
    ? "mp3"
    : mimeType && mimeType.toLowerCase().includes("wav")
      ? "wav"
      : "wav";
  const mime = fmt === "wav" ? "audio/wav" : "audio/mpeg";
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: dataUrl, format: fmt }
            }
          ]
        }
      ],
      asr_options: { language: "auto" }
    })
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "mimo asr failed");
    throw new Error(`MiMo ASR 调用失败: ${message}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    throw new Error("未识别出语音文本");
  }
  return text;
}
