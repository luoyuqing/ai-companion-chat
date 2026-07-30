import { useEffect, useState } from "react";
import { Emotion, EmotionProfile, resolveMediaUrl } from "../services/api";

interface AvatarProps {
  emotion: Emotion;
  speaking: boolean;
  avatarUrl: string;
  name?: string;
  emotionProfile?: EmotionProfile;
  avatarType?: "image" | "video";
  avatarVideoProfile?: EmotionProfile;
  interaction?: "hug" | "hand" | "whisper" | "comfort" | "goodnight" | null;
}

function resolveEmotionImage(profile: EmotionProfile | undefined, emotion: Emotion): string | null {
  if (!profile) return null;
  const image = profile[emotion];
  return image && String(image).trim() ? String(image) : null;
}

function resolveEmotionVideo(profile: EmotionProfile | undefined, emotion: Emotion): string | null {
  if (!profile) return null;
  const video = profile[emotion];
  return video && String(video).trim() ? String(video) : null;
}

const expressionByEmotion: Record<Emotion, string> = {
  happy: "O(≧▽≦)O",
  sad: "(╥﹏╥)",
  surprise: "(⊙_⊙)",
  wink: "(￣▽￣)ゞ",
  neutral: "(•ᴗ•)",
  angry: "(；￣Д￣)",
  love: "(❤ω❤)"
};

const classByEmotion: Record<Emotion, string> = {
  happy: "face happy",
  sad: "face sad",
  surprise: "face surprise",
  wink: "face wink",
  neutral: "face neutral",
  angry: "face angry",
  love: "face love"
};

function makeStatusText(emotion: Emotion) {
  switch (emotion) {
    case "happy":
      return "开心";
    case "sad":
      return "难过";
    case "surprise":
      return "惊讶";
    case "wink":
      return "俏皮";
    case "neutral":
      return "平静";
    case "angry":
      return "不满";
    case "love":
      return "甜蜜";
  }
}

function interactionGlyph(interaction: AvatarProps["interaction"]) {
  if (interaction === "hug") return "♥";
  if (interaction === "hand") return "✦";
  if (interaction === "whisper") return "···";
  if (interaction === "comfort") return "◌";
  if (interaction === "goodnight") return "☾";
  return "";
}

export function Avatar({
  emotion,
  speaking,
  avatarUrl,
  name = "数字人",
  emotionProfile,
  avatarType,
  avatarVideoProfile,
  interaction = null
}: AvatarProps) {
  const emotionImageRaw = resolveEmotionImage(emotionProfile, emotion);
  const emotionImage = resolveMediaUrl(emotionImageRaw || undefined);
  const resolvedAvatar = resolveMediaUrl(avatarUrl);
  const shouldShowVideo = avatarType === "video";
  const emotionVideo = shouldShowVideo ? resolveMediaUrl(resolveEmotionVideo(avatarVideoProfile, emotion) || undefined) : undefined;
  const [lipBeat, setLipBeat] = useState(false);

  useEffect(() => {
    if (!speaking) {
      setLipBeat(false);
      return;
    }

    const timer = setInterval(() => {
      setLipBeat((value) => !value);
    }, 170);

    return () => {
      clearInterval(timer);
      setLipBeat(false);
    };
  }, [speaking]);

  return (
    <div
      className={`avatar emotion-${emotion} ${speaking ? "speaking" : ""} ${interaction ? `interaction-${interaction}` : ""}`}
      data-avatar-mode="2d"
    >
      <div className="avatar-topline">
        <div>
          <div className="avatar-name">{name}</div>
          <div className="avatar-presence"><span /> 在线陪你</div>
        </div>
        <div className="headphone" aria-hidden="true">🎧</div>
      </div>
      <div className="portrait-stage">
        <img className="portrait" src={resolvedAvatar || avatarUrl} alt={name} />
        <div className="portrait-emotion" aria-label={`${makeStatusText(emotion)}表情`}>
          {emotionVideo ? (
            <video
              key={`${emotion}-${emotionVideo}`}
              className={`face-video ${speaking ? "talking" : ""} ${lipBeat ? "lip-open" : "lip-close"}`}
              src={emotionVideo}
              autoPlay
              muted
              loop
              playsInline
            />
          ) : emotionImage ? (
            <img
              className={`face-image ${speaking ? "talking" : ""} ${lipBeat ? "lip-open" : "lip-close"}`}
              src={emotionImage}
              alt={`${emotion} 表情`}
            />
          ) : (
            <div
              className={`${classByEmotion[emotion]} ${speaking ? "talking" : ""} ${lipBeat ? "lip-open" : "lip-close"}`}
            >
              {expressionByEmotion[emotion]}
            </div>
          )}
        </div>
        {interaction ? <div className="interaction-effect" aria-hidden="true">{interactionGlyph(interaction)}</div> : null}
        <div className="portrait-caption">
          <span>{makeStatusText(emotion)}</span>
          <small>{speaking ? "正在对你说话" : "正在听你"}</small>
        </div>
      </div>
    </div>
  );
}
