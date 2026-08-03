import { FormEvent, ReactNode, useEffect, useState } from "react";
import {
  Brain,
  Image as ImageIcon,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  CreateHumanRequest,
  DigitalHuman,
  Emotion,
  EmotionProfile,
  MimoAudioModel,
  UserMemory,
  createDigitalHuman,
  deleteDigitalHuman,
  deleteUserMemory,
  clearSessionHistory,
  getUserMemory,
  resolveMediaUrl,
  saveUserMemory,
  updateDigitalHuman,
  uploadAvatarFile
} from "../services/api";
import { ConfirmDialog } from "./ConfirmDialog";
import chinaCities from "../data/china-cities.json";

type CityLocation = { province: string; city: string; latitude: number; longitude: number };

// ============ 常量（从 ChatPanel 迁移） ============
const PUBLIC_ASSET_BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const defaultAvatarUrl = `${PUBLIC_ASSET_BASE}assets/avatars/linxingwan.png`;

// 长期记忆（按角色独立）；编辑数字人时加载并随表单保存。
const EMPTY_MEMORY: UserMemory = {
  displayName: "",
  preferredName: "",
  preferences: "",
  importantFacts: "",
  boundaries: "",
  relationshipNotes: ""
};

// MiMo mimo-v2.5-tts 官方可选音色
const MIMO_VOICE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "mimo_default", label: "MiMo-默认" },
  { id: "冰糖", label: "冰糖" },
  { id: "茉莉", label: "茉莉" }
];

const MIMO_AUDIO_MODELS: Array<{ id: MimoAudioModel; label: string; desc: string }> = [
  { id: "mimo-v2.5-tts", label: "预置精品音色", desc: "使用内置精品音色合成语音" },
  { id: "mimo-v2.5-tts-voicedesign", label: "文本设计音色", desc: "用一段文字描述生成专属音色" },
  { id: "mimo-v2.5-tts-voiceclone", label: "音频复刻音色", desc: "上传音频样本复刻任意声音" }
];

const moods = ["neutral", "happy", "sad", "surprise", "wink", "angry", "love"] as const;
const relationshipModes: Array<"sweet" | "flirty" | "playful" | "mature"> = ["sweet", "flirty", "playful", "mature"];
type LocalEmotion = (typeof moods)[number];

const moodLabelMap: Record<(typeof moods)[number], string> = {
  neutral: "平静",
  happy: "开心",
  sad: "难过",
  surprise: "惊讶",
  wink: "俏皮",
  angry: "生气",
  love: "爱意"
};

const relationshipModeLabelMap: Record<(typeof relationshipModes)[number], string> = {
  sweet: "甜蜜陪伴",
  flirty: "暧昧撩人",
  playful: "轻松调皮",
  mature: "成熟直率"
};

interface NewCharacterForm {
  name: string;
  description: string;
  avatarUrl: string;
  voiceProvider: "openai" | "azure" | "local" | "mimo";
  voice: string;
  audioModel: MimoAudioModel;
  voiceId: string;
  stylePrompt: string;
  voiceDesignPrompt: string;
  voiceCloneSample: string;
  defaultMood: (typeof moods)[number];
  emotionProfile: string;
  avatarType: "image" | "video";
  avatarVideoProfile: string;
  personalityTagline: string;
  relationshipMode: (typeof relationshipModes)[number];
  telegramBotToken: string;
  location: CityLocation | null;
  proactive: {
    enabled: boolean;
    timePoints: string[];
    mode: "always" | "smart" | "probability";
    voiceEnabled?: boolean;
    probability?: number;
    timePointProbabilities?: Record<string, number>;
  };
}

function defaultForm(): NewCharacterForm {
  return {
    name: "",
    description: "",
    avatarUrl: defaultAvatarUrl,
    voiceProvider: "mimo",
    voice: "冰糖",
    audioModel: "mimo-v2.5-tts",
    voiceId: "冰糖",
    stylePrompt: "",
    voiceDesignPrompt: "",
    voiceCloneSample: "",
    defaultMood: "neutral",
    emotionProfile: "{}",
    avatarType: "image",
    avatarVideoProfile: "{}",
    personalityTagline: "",
    relationshipMode: "sweet",
    telegramBotToken: "",
    location: null,
    proactive: { enabled: false, timePoints: [], mode: "always", voiceEnabled: false }
  };
}

function fromCharacter(c: DigitalHuman): NewCharacterForm {
  return {
    name: c.name || "",
    description: c.description || "",
    avatarUrl: c.avatarUrl || defaultAvatarUrl,
    voiceProvider: "mimo",
    voice: c.voiceProfile?.voice || "冰糖",
    audioModel: (c.voiceProfile?.audioModel as MimoAudioModel) || "mimo-v2.5-tts",
    voiceId: c.voiceProfile?.voiceId || "冰糖",
    stylePrompt: c.voiceProfile?.stylePrompt || "",
    voiceDesignPrompt: c.voiceProfile?.voiceDesignPrompt || "",
    voiceCloneSample: c.voiceProfile?.voiceCloneSample || "",
    defaultMood: (moods as readonly string[]).includes(c.defaultMood || "")
      ? (c.defaultMood as LocalEmotion)
      : "neutral",
    emotionProfile: c.emotionProfile ? JSON.stringify(c.emotionProfile) : "{}",
    avatarType: c.avatarType === "video" ? "video" : "image",
    avatarVideoProfile: c.avatarVideoProfile ? JSON.stringify(c.avatarVideoProfile) : "{}",
    personalityTagline: c.personalityTagline || "",
    relationshipMode: relationshipModes.includes((c.relationshipMode || "sweet") as (typeof relationshipModes)[number])
      ? (c.relationshipMode as (typeof relationshipModes)[number])
      : "sweet",
    telegramBotToken: "",
    location: c.location
      ? { province: c.location.province, city: c.location.city, latitude: c.location.latitude, longitude: c.location.longitude }
      : null,
    proactive: c.proactive
      ? {
          enabled: Boolean(c.proactive.enabled),
          timePoints: Array.isArray(c.proactive.timePoints) ? c.proactive.timePoints.slice(0, 3) : [],
          mode: c.proactive.mode === "smart" ? "smart" : c.proactive.mode === "probability" ? "probability" : "always",
          voiceEnabled: Boolean(c.proactive.voiceEnabled),
          probability: typeof c.proactive.probability === "number" ? c.proactive.probability : undefined,
          timePointProbabilities: c.proactive.timePointProbabilities ? { ...c.proactive.timePointProbabilities } : undefined
        }
      : { enabled: false, timePoints: [], mode: "always", voiceEnabled: false }
  };
}

function parseEmotionProfile(raw: string): EmotionProfile | undefined {
  const normalized = raw.trim();
  if (!normalized) return undefined;
  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const result: EmotionProfile = {};
    (Object.keys(parsed) as Array<Emotion>).forEach((emotion) => {
      if (["happy", "sad", "surprise", "wink", "neutral", "angry", "love"].includes(emotion)) {
        const value = String((parsed as Record<string, unknown>)[emotion] || "").trim();
        if (value) result[emotion] = value;
      }
    });
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(blob);
  });
}

function buildPayload(form: NewCharacterForm): CreateHumanRequest {
  const emotionProfile = parseEmotionProfile(form.emotionProfile);
  const avatarVideoProfile = parseEmotionProfile(form.avatarVideoProfile);
  const effectiveVoice =
    form.audioModel === "mimo-v2.5-tts"
      ? form.voiceId || "冰糖"
      : form.voice.trim() || "mimo_default";
  const payload: CreateHumanRequest = {
    name: form.name.trim(),
    description: form.description.trim(),
    avatarUrl: form.avatarUrl.trim(),
    avatarType: form.avatarType,
    voiceProvider: form.voiceProvider,
    voice: effectiveVoice,
    audioModel: form.audioModel,
    voiceId: form.audioModel === "mimo-v2.5-tts" ? form.voiceId : undefined,
    stylePrompt: form.audioModel === "mimo-v2.5-tts" ? form.stylePrompt : undefined,
    voiceDesignPrompt: form.audioModel === "mimo-v2.5-tts-voicedesign" ? form.voiceDesignPrompt : undefined,
    voiceCloneSample: form.audioModel === "mimo-v2.5-tts-voiceclone" ? form.voiceCloneSample : undefined,
    defaultMood: form.defaultMood,
    personalityTagline: form.personalityTagline.trim(),
    relationshipMode: form.relationshipMode,
    telegramBotToken: form.telegramBotToken.trim() || undefined,
    ...(form.location
      ? {
          location: {
            province: form.location.province,
            city: form.location.city,
            latitude: form.location.latitude,
            longitude: form.location.longitude
          }
        }
      : {}),
    proactive: {
      enabled: form.proactive.enabled,
      timePoints: form.proactive.timePoints.filter((t) => !!t).slice(0, 3),
      mode: form.proactive.mode,
      voiceEnabled: form.proactive.voiceEnabled,
      ...(typeof form.proactive.probability === "number" ? { probability: form.proactive.probability } : {}),
      ...(form.proactive.timePointProbabilities && Object.keys(form.proactive.timePointProbabilities).length
        ? {
            timePointProbabilities: Object.fromEntries(
              Object.entries(form.proactive.timePointProbabilities).filter(([k]) =>
                form.proactive.timePoints.includes(k)
              )
            )
          }
        : {})
    },
    ...(emotionProfile ? { emotionProfile } : {}),
    ...(avatarVideoProfile ? { avatarVideoProfile } : {})
  };
  return payload;
}

// ============ 表单辅助组件：可折叠分区 + 概率滑块 ============
function useIsMobile(): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const handler = () => setM(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return m;
}

function FormSection({
  title,
  desc,
  defaultOpen = true,
  children
}: {
  title: string;
  desc?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="dh-section">
      <button
        type="button"
        className="dh-section-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="dh-section-title">{title}</span>
        {desc ? <span className="dh-section-desc">{desc}</span> : null}
        <span className={`dh-section-toggle${open ? " open" : ""}`}>▾</span>
      </button>
      {open ? <div className="dh-section-body">{children}</div> : null}
    </section>
  );
}

function ProbabilitySlider({
  value,
  onChange
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const presets = [20, 40, 60, 80, 100];
  return (
    <div className="prob-field">
      <div className="prob-row">
        <input
          type="range"
          className="prob-slider"
          min={1}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="prob-value">{value}%</span>
      </div>
      <div className="prob-presets">
        {presets.map((p) => (
          <button
            type="button"
            key={p}
            className={`prob-chip${value === p ? " active" : ""}`}
            onClick={() => onChange(p)}
          >
            {p}%
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ 新增 / 编辑 表单（全屏式，非弹框） ============
function CharacterForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onSaved
}: {
  mode: "create" | "edit";
  initial?: DigitalHuman;
  onSubmit: (payload: CreateHumanRequest) => Promise<DigitalHuman>;
  onCancel: () => void;
  onSaved?: (msg: string) => void;
}) {
  const [form, setForm] = useState<NewCharacterForm>(() => (initial ? fromCharacter(initial) : defaultForm()));
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [memory, setMemory] = useState<UserMemory>(() => ({ ...EMPTY_MEMORY }));
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    if (mode === "edit" && initial?.id) {
      getUserMemory(initial.id)
        .then((m) => {
          if (!cancelled) setMemory(m);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [mode, initial?.id]);

  const handleAvatarFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const isImage =
      /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name) ||
      /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i.test(file.type);
    if (!isImage) {
      setStatus("请上传 png / jpg / webp / gif / svg 图片");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setStatus("头像图片不能超过 8MB");
      return;
    }
    setAvatarUploading(true);
    try {
      const fileBase64 = await blobToBase64(file);
      const uploaded = await uploadAvatarFile({ fileName: file.name, fileBase64, mimeType: file.type || undefined });
      setForm((prev) => ({ ...prev, avatarUrl: uploaded.avatarUrl }));
      setStatus("头像已上传 ✓");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "头像上传失败");
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleVoiceCloneFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    const okType =
      ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(file.type) ||
      lower.endsWith(".mp3") ||
      lower.endsWith(".wav");
    if (!okType) {
      setStatus("仅支持 mp3 / wav 格式");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus("音频样本不能超过 10MB");
      return;
    }
    const base64 = await blobToBase64(file);
    const mime = file.type.includes("wav") ? "audio/wav" : "audio/mpeg";
    setForm((prev) => ({ ...prev, voiceCloneSample: `data:${mime};base64,${base64}` }));
  };

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (submitting || avatarUploading) return;
    if (!form.name.trim() || !form.description.trim()) {
      setStatus("名字和人设描述不能为空");
      return;
    }
    const payload = buildPayload(form);
    if (!payload.name || !payload.description || !payload.avatarUrl || !payload.voice) {
      setStatus("请完整填写数字人信息");
      return;
    }
    setSubmitting(true);
    setStatus("");
    try {
      const saved = await onSubmit(payload);
      const hasMemory = Boolean(
        memory.displayName ||
          memory.preferredName ||
          memory.preferences ||
          memory.importantFacts ||
          memory.boundaries ||
          memory.relationshipNotes
      );
      if (hasMemory) {
        try {
          await saveUserMemory(saved.id, memory);
        } catch {
          // 记忆保存失败不影响数字人本身的创建/更新
        }
      }
      const restartHint = form.telegramBotToken.trim()
        ? "（已配置 TG Token，请到「重启服务」重启后生效）"
        : "";
      if (onSaved) {
        // 由父级在列表页展示成功提示并切回列表，避免表单卸载导致提示丢失
        onSaved((mode === "create" ? "已创建数字人 ✓" : "已保存修改 ✓") + restartHint);
      } else {
        setStatus(mode === "create" ? "已创建 ✓" : "已保存 ✓");
        onCancel();
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dh-form-panel">
      <div className="dh-form-head">
        <button type="button" className="dh-back-btn" onClick={onCancel}>
          <X size={16} /> 返回列表
        </button>
        <h3>{mode === "create" ? "新增数字人" : `编辑「${initial?.name || ""}」`}</h3>
      </div>

      <form onSubmit={submit} className="creator creator-v2">
        <FormSection title="基础信息" desc="名字、人设与头像">
          <label className="field">
            <span className="field-label">名字</span>
            <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="例如：小冰" />
          </label>

          <label className="field dh-span-full">
            <span className="field-label">人设描述</span>
            <input
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="她的性格、身份、说话风格，例如：温柔懂事的女大学生"
            />
          </label>

          <div className="field dh-span-full">
            <span className="field-label">头像（静态图片）</span>
            <label className="file-picker">
              {avatarUploading ? "上传中..." : "上传头像图片（png/jpg/webp/gif/svg，≤8MB）"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                disabled={avatarUploading}
                onChange={(e) => handleAvatarFile(e.currentTarget.files)}
              />
            </label>
            <input
              value={form.avatarUrl}
              onChange={(e) => setForm((p) => ({ ...p, avatarUrl: e.target.value }))}
              placeholder="也可直接粘贴图片 URL"
            />
            {form.avatarUrl ? (
              <img
                src={resolveMediaUrl(form.avatarUrl)}
                alt="头像预览"
                style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover", marginTop: 6 }}
              />
            ) : null}
          </div>

          <label className="field">
            <span className="field-label">头像模式</span>
            <select value={form.avatarType} onChange={(e) => setForm((p) => ({ ...p, avatarType: e.target.value === "video" ? "video" : "image" }))}>
              <option value="image">静态头像</option>
              <option value="video">动态视频（需额外提供情绪视频资源）</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">人设口令（可选）</span>
            <input
              value={form.personalityTagline}
              onChange={(e) => setForm((p) => ({ ...p, personalityTagline: e.target.value }))}
              placeholder="例如：轻松撒娇，但不越界"
            />
          </label>
        </FormSection>

        <FormSection title="声音设置" desc="TTS 模型与音色">
          <label className="field">
            <span className="field-label">音频模型</span>
            <select value={form.audioModel} onChange={(e) => setForm((p) => ({ ...p, audioModel: e.target.value as MimoAudioModel }))}>
              {MIMO_AUDIO_MODELS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <small className="field-hint">{MIMO_AUDIO_MODELS.find((o) => o.id === form.audioModel)?.desc}</small>
          </label>

          {form.audioModel === "mimo-v2.5-tts" && (
            <label className="field">
              <span className="field-label">预制音色（必选）</span>
              <select
                value={MIMO_VOICE_OPTIONS.some((o) => o.id === form.voiceId) ? form.voiceId : ""}
                onChange={(e) => setForm((p) => ({ ...p, voiceId: e.target.value || "冰糖" }))}
              >
                {MIMO_VOICE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
          )}

          {form.audioModel === "mimo-v2.5-tts" && (
            <label className="field">
              <span className="field-label">风格描述（可选）</span>
              <input
                value={form.stylePrompt}
                onChange={(e) => setForm((p) => ({ ...p, stylePrompt: e.target.value }))}
                placeholder="自然语言控制语气，例如：温柔轻快、带一点点撒娇"
              />
              <small>会作为 user 消息控制合成语气，留空则使用默认风格。</small>
            </label>
          )}

          {form.audioModel === "mimo-v2.5-tts-voicedesign" && (
            <label className="field">
              <span className="field-label">音色描述（必填）</span>
              <input
                value={form.voiceDesignPrompt}
                onChange={(e) => setForm((p) => ({ ...p, voiceDesignPrompt: e.target.value }))}
                placeholder="描述想要的音色，例如：温柔自然的中文女声，语速适中"
              />
              <small>这段文字会作为音色设计描述传给模型。</small>
            </label>
          )}

          {form.audioModel === "mimo-v2.5-tts-voiceclone" && (
            <label className="field">
              <span className="field-label">音频样本（mp3 / wav，≤10MB）</span>
              <label className="file-picker">
                选择音频样本
                <input type="file" accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav" onChange={(e) => handleVoiceCloneFile(e.currentTarget.files)} />
              </label>
              {form.voiceCloneSample ? (
                <small className="field-hint">已上传样本（{(form.voiceCloneSample.length / 1024 / 1024).toFixed(1)} MB）</small>
              ) : null}
            </label>
          )}
        </FormSection>

        <FormSection title="性格与关系" desc="默认情绪与互动语气">
          <label className="field">
            <span className="field-label">默认情绪</span>
            <select
              value={form.defaultMood}
              onChange={(e) => setForm((p) => ({ ...p, defaultMood: e.target.value as (typeof moods)[number] }))}
            >
              {moods.map((mood) => (
                <option key={mood} value={mood}>{moodLabelMap[mood]}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">关系模式</span>
            <select
              value={form.relationshipMode}
              onChange={(e) => setForm((p) => ({ ...p, relationshipMode: e.target.value as (typeof relationshipModes)[number] }))}
            >
              {relationshipModes.map((mode) => (
                <option key={mode} value={mode}>{relationshipModeLabelMap[mode]}</option>
              ))}
            </select>
            <small className="field-hint">决定她和你互动的整体语气。</small>
          </label>
        </FormSection>

        <FormSection title="连接与位置" desc="专属 Bot 与真实时间/天气">
          <label className="field dh-span-full">
            <span className="field-label">Telegram 专属 Bot Token（可选）</span>
            <input
              value={form.telegramBotToken}
              onChange={(e) => setForm((p) => ({ ...p, telegramBotToken: e.target.value }))}
              placeholder="配置后该数字人以独立 bot 运行；留空=不修改（编辑时清空保存=关闭）"
            />
            <small>配置了专属 bot 才能开启主动推送。</small>
          </label>

          <label className="field dh-span-full">
            <span className="field-label">所在城市（用于感知真实时间 / 天气）</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select
                value={form.location?.province || ""}
                onChange={(e) => {
                  const province = e.target.value;
                  const cities = (chinaCities as Record<string, Array<{ name: string; lat: number; lon: number }>>)[province] || [];
                  const first = cities[0];
                  setForm((p) => ({
                    ...p,
                    location: first ? { province, city: first.name, latitude: first.lat, longitude: first.lon } : null
                  }));
                }}
              >
                <option value="">选择省份</option>
                {(Object.keys(chinaCities) as string[]).map((prov) => (
                  <option key={prov} value={prov}>{prov}</option>
                ))}
              </select>
              <select
                value={form.location?.city || ""}
                disabled={!form.location?.province}
                onChange={(e) => {
                  const cityName = e.target.value;
                  const cities = (chinaCities as Record<string, Array<{ name: string; lat: number; lon: number }>>)[form.location?.province || ""] || [];
                  const city = cities.find((c) => c.name === cityName);
                  if (city && form.location) {
                    setForm((p) => ({
                      ...p,
                      location: { province: form.location!.province, city: city.name, latitude: city.lat, longitude: city.lon }
                    }));
                  }
                }}
              >
                <option value="">选择城市</option>
                {form.location?.province
                  ? ((chinaCities as Record<string, Array<{ name: string; lat: number; lon: number }>>)[form.location.province] || []).map((c) => (
                      <option key={c.name} value={c.name}>{c.name}</option>
                    ))
                  : null}
              </select>
            </div>
            {form.location ? (
              <small className="field-hint">
                已设为 {form.location.province} · {form.location.city}（{form.location.latitude.toFixed(2)}, {form.location.longitude.toFixed(2)}），数字人将感知她当地的真实时间与天气。
              </small>
            ) : (
              <small className="field-hint">设置后，聊天和主动推送会带上她所在地的真实时间/天气/气温。</small>
            )}
          </label>
        </FormSection>

        <FormSection title="主动推送" desc="专属 bot 主动给主人发消息">
          <div className="field dh-span-full">
            <span className="field-label">主动推送开关</span>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={form.proactive.enabled}
                onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, enabled: e.target.checked } }))}
              />
              启用主动推送（专属 bot 主动给主人发消息）
            </label>
          </div>

          {form.proactive.enabled ? (
            <>
              <label className="field dh-span-full">
                <span className="field-label">发送时间点（最多 3 个，按北京时间）</span>
                {form.proactive.timePoints.map((tp, i) => (
                  <div key={i} className="timepoint-row">
                    <input
                      type="time"
                      value={tp}
                      onChange={(e) => {
                        const v = [...form.proactive.timePoints];
                        v[i] = e.target.value;
                        setForm((p) => ({ ...p, proactive: { ...p.proactive, timePoints: v } }));
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const v = form.proactive.timePoints.filter((_, j) => j !== i);
                        setForm((p) => ({ ...p, proactive: { ...p.proactive, timePoints: v } }));
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
                {form.proactive.timePoints.length < 3 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setForm((p) => ({ ...p, proactive: { ...p.proactive, timePoints: [...p.proactive.timePoints, "20:00"] } }))
                    }
                  >
                    ＋ 添加时间点
                  </button>
                ) : null}
              </label>

              <label className="field">
                <span className="field-label">发送模式</span>
                <select
                  value={form.proactive.mode}
                  onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, mode: e.target.value as "always" | "smart" | "probability" } }))}
                >
                  <option value="always">到点必发</option>
                  <option value="smart">智能判断（按人设/关系/上下文决定是否发）</option>
                  <option value="probability">按概率发送（掷骰决定是否发）</option>
                </select>
              </label>

              {form.proactive.mode === "probability" ? (
                <>
                  <label className="field">
                    <span className="field-label">全局发送概率（1–100，按百分比）</span>
                    <ProbabilitySlider
                      value={form.proactive.probability ?? 100}
                      onChange={(v) => setForm((p) => ({ ...p, proactive: { ...p.proactive, probability: v } }))}
                    />
                    <small className="field-hint">到点时按此概率决定是否推送；不填视为必发（100%）。</small>
                  </label>
                  <label className="field dh-span-full">
                    <span className="field-label">各时间点单独概率（可选，覆盖全局）</span>
                    {form.proactive.timePoints.map((tp) => (
                      <div key={tp} className="timepoint-row">
                        <span style={{ minWidth: 48 }}>{tp}</span>
                        <ProbabilitySlider
                          value={form.proactive.timePointProbabilities?.[tp] ?? form.proactive.probability ?? 100}
                          onChange={(v) => {
                            const tpp = { ...(form.proactive.timePointProbabilities || {}) };
                            tpp[tp] = v;
                            setForm((p) => ({ ...p, proactive: { ...p.proactive, timePointProbabilities: tpp } }));
                          }}
                        />
                      </div>
                    ))}
                  </label>
                </>
              ) : null}

              <div className="field dh-span-full">
                <span className="field-label">语音附带</span>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={form.proactive.voiceEnabled}
                    onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, voiceEnabled: e.target.checked } }))}
                  />
                  主动推送附带语音（消耗 MiMo TTS 额度，默认关）
                </label>
              </div>
            </>
          ) : null}
        </FormSection>

        <FormSection title="关系与记忆" desc="按角色独立配置" defaultOpen={!isMobile}>
          <label className="field dh-span-full">
            <span className="field-label">关系备注（A · 关系状态）</span>
            <textarea
              rows={2}
              value={memory.relationshipNotes || ""}
              onChange={(e) => setMemory((p) => ({ ...p, relationshipNotes: e.target.value }))}
              placeholder="例如：关系节奏偏暧昧、直接、陪伴感强"
            />
          </label>
          <label className="field">
            <span className="field-label">我是谁 / 假身份</span>
            <input
              value={memory.displayName || ""}
              onChange={(e) => setMemory((p) => ({ ...p, displayName: e.target.value }))}
              placeholder="例如：林，做科研和产品（可填假身份）"
            />
          </label>
          <label className="field">
            <span className="field-label">希望她怎么称呼我</span>
            <input
              value={memory.preferredName || ""}
              onChange={(e) => setMemory((p) => ({ ...p, preferredName: e.target.value }))}
              placeholder="例如：哥哥 / 阿林 / 亲爱的"
            />
          </label>
          <label className="field dh-span-full">
            <span className="field-label">聊天偏好</span>
            <textarea
              rows={2}
              value={memory.preferences || ""}
              onChange={(e) => setMemory((p) => ({ ...p, preferences: e.target.value }))}
              placeholder="例如：语气自然一点，开心时可以撒娇，压力大时先安慰"
            />
          </label>
          <label className="field dh-span-full">
            <span className="field-label">重要事实</span>
            <textarea
              rows={2}
              value={memory.importantFacts || ""}
              onChange={(e) => setMemory((p) => ({ ...p, importantFacts: e.target.value }))}
              placeholder="例如：最近在做 AI伴聊 项目、经常晚上工作"
            />
          </label>
          <label className="field dh-span-full">
            <span className="field-label">聊天禁忌或边界</span>
            <textarea
              rows={2}
              value={memory.boundaries || ""}
              onChange={(e) => setMemory((p) => ({ ...p, boundaries: e.target.value }))}
              placeholder="例如：不要说教；不喜欢机械式客服语气"
            />
          </label>
        </FormSection>

        {status ? <small className="field-hint">{status}</small> : null}
        <div className="dh-form-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>取消</button>
          <button type="submit" disabled={submitting || avatarUploading}>
            {submitting ? "保存中..." : mode === "create" ? "创建" : "保存修改"}
          </button>
        </div>
      </form>

    </div>
  );
}

// ============ 卡片式管理主页 ============
export function DigitalHumanManager({
  characters,
  onCharactersChange,
  notify
}: {
  characters: DigitalHuman[];
  onCharactersChange: (next: DigitalHuman[]) => void;
  notify?: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const [view, setView] = useState<"grid" | "create" | "edit">("grid");
  const [editing, setEditing] = useState<DigitalHuman | null>(null);

  // 统一确认弹窗：待删除 / 待清除记忆的数字人 + 弹窗内按钮 loading
  const [pendingDelete, setPendingDelete] = useState<DigitalHuman | null>(null);
  const [pendingClear, setPendingClear] = useState<DigitalHuman | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setView("create");
  };
  const openEdit = (c: DigitalHuman) => {
    setEditing(c);
    setView("edit");
  };
  const back = () => {
    setView("grid");
    setEditing(null);
  };

  // 创建/编辑成功后：统一吐司提示（不依赖表单卸载），并切回列表
  const handleSaved = (msg: string) => {
    notify?.(msg, "success");
    setEditing(null);
    setView("grid");
  };

  const handleCreate = async (payload: CreateHumanRequest): Promise<DigitalHuman> => {
    const created = await createDigitalHuman(payload);
    onCharactersChange([...characters, created.human]);
    return created.human;
  };

  const handleEdit = async (payload: CreateHumanRequest): Promise<DigitalHuman> => {
    if (!editing) throw new Error("缺少编辑对象");
    const { human } = await updateDigitalHuman(editing.id, payload);
    onCharactersChange(characters.map((c) => (c.id === human.id ? human : c)));
    return human;
  };

  const askDelete = (c: DigitalHuman) => {
    if (characters.length <= 1) {
      notify?.("至少保留一个数字人，不能全部删除", "error");
      return;
    }
    setPendingDelete(c);
  };

  const confirmDelete = async () => {
    const c = pendingDelete;
    if (!c) return;
    setConfirmBusy(true);
    try {
      await deleteDigitalHuman(c.id);
      onCharactersChange(characters.filter((x) => x.id !== c.id));
      notify?.(`已删除「${c.name}」`, "success");
    } catch (error) {
      notify?.(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setConfirmBusy(false);
      setPendingDelete(null);
    }
  };

  const askClearMemory = (c: DigitalHuman) => {
    setPendingClear(c);
  };

  const confirmClearMemory = async () => {
    const c = pendingClear;
    if (!c) return;
    setConfirmBusy(true);
    try {
      // 仅清空与该数字人的聊天记录、会话上下文，以及聊天中产生的长期记忆；
      // 数字人本身的配置（显示名 / 禁忌 / 偏好 / 人设）在 custom-humans.json，不在此处清除。
      await clearSessionHistory(`mem-${c.id}`, c.id);
      await deleteUserMemory(c.id);
      notify?.(`已清除「${c.name}」的聊天记录与记忆，已重新开始聊天`, "success");
    } catch (error) {
      notify?.(error instanceof Error ? error.message : "清除记忆失败", "error");
    } finally {
      setConfirmBusy(false);
      setPendingClear(null);
    }
  };

  if (view === "create") {
    return <CharacterForm mode="create" onSubmit={handleCreate} onCancel={back} onSaved={handleSaved} />;
  }
  if (view === "edit") {
    return <CharacterForm mode="edit" initial={editing ?? undefined} onSubmit={handleEdit} onCancel={back} onSaved={handleSaved} />;
  }

  return (
    <div className="dh-manager">
      <div className="dh-manager-head">
        <div>
          <h3>数字人管理</h3>
          <p className="dh-manager-tip">卡片式管理所有数字人：查看全身照与基本信息，编辑、删除或清除记忆。</p>
        </div>
        <button type="button" className="settings-primary-btn" onClick={openCreate}>
          <Plus size={16} /> 新增数字人
        </button>
      </div>

      <div className="dh-grid">
        {characters.map((c) => {
          const img = resolveMediaUrl(c.avatarUrl) || defaultAvatarUrl;
          return (
            <article className="dh-card" key={c.id}>
              <div className="dh-card-img">
                <img
                  src={img}
                  alt={c.name}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = defaultAvatarUrl;
                  }}
                />
              </div>
              <div className="dh-card-body">
                <h4 className="dh-card-name">{c.name}</h4>
                {c.personalityTagline ? <p className="dh-card-tagline">{c.personalityTagline}</p> : null}
                <p className="dh-card-desc">{c.description}</p>
                <div className="dh-card-meta">
                  <span className="dh-meta-chip">{relationshipModeLabelMap[(c.relationshipMode || "sweet") as (typeof relationshipModes)[number]] || "甜蜜陪伴"}</span>
                  {c.proactive?.enabled ? <span className="dh-meta-chip active">主动推送</span> : null}
                </div>
              </div>
              <div className="dh-card-actions">
                <button type="button" className="dh-action edit" onClick={() => openEdit(c)}>
                  <Pencil size={14} /> 编辑
                </button>
                <button type="button" className="dh-action memory" onClick={() => askClearMemory(c)}>
                  <Brain size={14} /> 清除记忆
                </button>
                <button
                  type="button"
                  className="dh-action danger"
                  disabled={characters.length <= 1}
                  onClick={() => askDelete(c)}
                >
                  <Trash2 size={14} /> 删除
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {characters.length === 0 ? (
        <p className="dh-empty">还没有数字人，点击右上角「新增数字人」开始创建。</p>
      ) : null}

      <ConfirmDialog
        open={!!pendingDelete}
        title="删除数字人"
        message={`确定删除「${pendingDelete?.name}」吗？\n删除后不可恢复。`}
        confirmText="删除"
        danger
        busy={confirmBusy}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={!!pendingClear}
        title="清除记忆"
        message={`确定清除「${pendingClear?.name}」的聊天记录与记忆吗？\n将清空与该数字人的全部聊天记录和长期记忆（含 AI 在聊天中记住的内容），相当于重新开始聊天；数字人本身的配置（显示名 / 禁忌 / 偏好 / 人设）会保留。`}
        confirmText="清除记忆"
        danger
        busy={confirmBusy}
        onConfirm={confirmClearMemory}
        onCancel={() => setPendingClear(null)}
      />
    </div>
  );
}
