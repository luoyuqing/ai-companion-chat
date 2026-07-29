import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DigitalHumanConfig } from "../types";
import { getTtsConfig, getLlmConfig } from "../core/config";

function getOpenAiClient(): OpenAI | null {
  const apiKey = getLlmConfig().apiKey || process.env.OPENAI_TTS_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: getLlmConfig().baseUrl || process.env.OPENAI_TTS_BASE_URL || process.env.OPENAI_BASE_URL || undefined
  });
}

async function writeAudioBuffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const workspaceRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
  const audioDir = path.join(workspaceRoot, "server", "data", "audio");
  await fs.mkdir(audioDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;
  const outputPath = path.join(audioDir, filename);
  const data = buffer instanceof ArrayBuffer ? Buffer.from(buffer) : Buffer.from(buffer);
  await fs.writeFile(outputPath, data);
  return `/audio/${filename}`;
}

async function synthesizeWithOpenAI(text: string, character: DigitalHumanConfig): Promise<string | undefined> {
  const client = getOpenAiClient();
  if (!client) {
    return undefined;
  }

  const mp3 = await client.audio.speech.create({
    model: process.env.OPENAI_TTS_MODEL || "tts-1-hd",
    voice: character.voiceProfile.voice,
    input: text,
    speed: 0.96
  });

  return await writeAudioBuffer(await mp3.arrayBuffer());
}

async function synthesizeWithMimo(text: string, character: DigitalHumanConfig): Promise<string | undefined> {
  const cfg = getTtsConfig();
  const apiKey = cfg.apiKey || process.env.MIMO_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  const baseURL = cfg.baseUrl || process.env.MIMO_BASE_URL || "https://api.xiaomimimo.com/v1";
  const profile = character.voiceProfile || { provider: "mimo", voice: "mimo_default" };
  const audioModel = profile.audioModel || cfg.model || process.env.MIMO_TTS_MODEL || "mimo-v2.5-tts";
  const format = "mp3";
  const defaultStylePrompt = "请用自然、温柔、贴合语境的语气朗读下面的内容，保持中文口语节奏。";

  let userContent = defaultStylePrompt;
  let audio: Record<string, unknown> = { format };

  if (audioModel === "mimo-v2.5-tts-voicedesign") {
    const designPrompt = (profile.voiceDesignPrompt || "").trim();
    userContent = designPrompt || "一位温柔自然的中文女声，语速适中，亲切有温度，像在轻声讲述。";
    audio = { format };
  } else if (audioModel === "mimo-v2.5-tts-voiceclone") {
    const cloneSample = (profile.voiceCloneSample || "").trim();
    if (!cloneSample) {
      console.warn("voiceclone 模式未提供音频样本，回退到预置音色");
      audio = { format, voice: profile.voiceId || profile.voice || "mimo_default" };
    } else {
      audio = { format, voice: cloneSample };
    }
    userContent = (profile.stylePrompt || "").trim() || defaultStylePrompt;
  } else {
    const voice = profile.voiceId || profile.voice || "mimo_default";
    audio = { format, voice };
    userContent = (profile.stylePrompt || "").trim() || defaultStylePrompt;
  }

  const requestBody = JSON.stringify({
    model: audioModel,
    messages: [
      {
        role: "user",
        content: userContent
      },
      {
        role: "assistant",
        content: text
      }
    ],
    audio
  });

  const maxAttempts = 3;
  let lastError: Error = new Error("MiMo TTS 调用失败");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json"
        },
        body: requestBody
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "mimo tts failed");
        throw new Error(`MiMo TTS 调用失败: ${message}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { audio?: { data?: string } } }>;
      };
      const b64 = data?.choices?.[0]?.message?.audio?.data;
      if (!b64) {
        throw new Error("MiMo TTS 未返回音频数据");
      }

      return await writeAudioBuffer(Buffer.from(b64, "base64"));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        console.warn(`MiMo TTS 第${attempt}次调用失败（${lastError.message}），1.5秒后重试...`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }
  throw lastError;
}

function escapeSsml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function synthesizeWithAzure(text: string, character: DigitalHumanConfig): Promise<string | undefined> {
  const apiKey = process.env.AZURE_TTS_KEY;
  const endpoint = process.env.AZURE_TTS_ENDPOINT;

  if (!apiKey || !endpoint) {
    return undefined;
  }

  const response = await fetch(`${endpoint}/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
      "User-Agent": "digital-girlfriend-platform"
    },
    body: `<speak version="1.0" xml:lang="zh-CN"><voice xml:lang="zh-CN" xml:gender="Female" name="${escapeSsml(character.voiceProfile.voice || "zh-CN-XiaoxiaoNeural")}"><prosody rate="-5%" pitch="+2%">${escapeSsml(text)}</prosody></voice></speak>`
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "azure tts failed");
    throw new Error(`Azure TTS failed: ${message}`);
  }

  const buffer = await response.arrayBuffer();
  return await writeAudioBuffer(buffer);
}

export async function synthesizeSpeech(
  text: string,
  character: DigitalHumanConfig
): Promise<string | undefined> {
  const provider = process.env.TTS_PROVIDER || character.voiceProfile?.provider || getTtsConfig().provider || "openai";
  if (provider === "mimo") {
    try {
      return await synthesizeWithMimo(text, character);
    } catch (error) {
      console.warn("MiMo TTS 调用失败，前端将使用浏览器语音", error instanceof Error ? error.message : error);
      return undefined;
    }
  }
  if (provider === "azure") {
    try {
      return await synthesizeWithAzure(text, character);
    } catch (error) {
      console.warn("Azure TTS 调用失败，回退到 OpenAI");
      return await synthesizeWithOpenAI(text, character);
    }
  }

  if (provider === "local") {
    return undefined;
  }

  try {
    return await synthesizeWithOpenAI(text, character);
  } catch (error) {
    console.warn("OpenAI TTS 调用失败，前端将使用浏览器语音", error instanceof Error ? error.message : error);
    return undefined;
  }
}
