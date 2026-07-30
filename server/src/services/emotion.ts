import { Emotion } from "../types";

const moodKeywords: Record<Emotion, string[]> = {
  happy: ["开心", "高兴", "好耶", "哈哈", "喜欢", "爱", "甜", "好棒", "太好了", "nice", "love", "happy", "great", "awesome"],
  sad: ["难过", "伤心", "失落", "抱怨", "cry", "sad", "难受", "伤心"],
  surprise: ["惊讶", "wow", "真的吗", "不敢相信", "太神了", "惊喜", "wow", "amazing", "unexpected"],
  wink: ["调皮", "坏", "开玩笑", "撩", "flirty", "wink", "tease", "撒娇", "wink"],
  angry: ["生气", "气死", "讨厌", "烦", "愤怒", "气死我了", "angry", "annoyed"],
  love: ["想你", "宝贝", "亲爱", "抱抱", "我的心", "lovely", "kiss", "hug", "love"],
  neutral: []
};

export function inferEmotion(text: string, fallback: Emotion = "neutral"): Emotion {
  const normalized = text.toLowerCase();
  let maxScore = 0;
  let detected: Emotion = fallback;

  for (const [emotion, words] of Object.entries(moodKeywords) as Array<[Emotion, string[]]>) {
    const score = words.reduce((acc, word) => acc + (normalized.includes(word) ? 1 : 0), 0);
    if (score > maxScore) {
      maxScore = score;
      detected = emotion;
    }
  }

  if (maxScore === 0) {
    return fallback;
  }

  return detected;
}
