import { FormEvent, useState } from "react";
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
  createDigitalHuman,
  deleteDigitalHuman,
  deleteUserMemory,
  resolveMediaUrl,
  updateDigitalHuman,
  uploadAvatarFile,
  uploadModelFile
} from "../services/api";

// ============ 常量（从 ChatPanel 迁移） ============
const PUBLIC_ASSET_BASE = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
const defaultAvatarUrl = `${PUBLIC_ASSET_BASE}assets/avatars/lina-original.jpg`;

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
  modelUrl: string;
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
  proactive: {
    enabled: boolean;
    timePoints: string[];
    mode: "always" | "smart";
    voiceEnabled?: boolean;
  };
}

function defaultForm(): NewCharacterForm {
  return {
    name: "",
    description: "",
    avatarUrl: defaultAvatarUrl,
    modelUrl: "",
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
    proactive: { enabled: false, timePoints: [], mode: "always", voiceEnabled: false }
  };
}

function fromCharacter(c: DigitalHuman): NewCharacterForm {
  return {
    name: c.name || "",
    description: c.description || "",
    avatarUrl: c.avatarUrl || defaultAvatarUrl,
    modelUrl: c.modelUrl || "",
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
    proactive: c.proactive
      ? {
          enabled: Boolean(c.proactive.enabled),
          timePoints: Array.isArray(c.proactive.timePoints) ? c.proactive.timePoints.slice(0, 3) : [],
          mode: c.proactive.mode === "smart" ? "smart" : "always",
          voiceEnabled: Boolean(c.proactive.voiceEnabled)
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
    modelUrl: form.modelUrl.trim() || undefined,
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
    proactive: {
      enabled: form.proactive.enabled,
      timePoints: form.proactive.timePoints.filter((t) => !!t).slice(0, 3),
      mode: form.proactive.mode,
      voiceEnabled: form.proactive.voiceEnabled
    },
    ...(emotionProfile ? { emotionProfile } : {}),
    ...(avatarVideoProfile ? { avatarVideoProfile } : {})
  };
  return payload;
}

// ============ 新增 / 编辑 表单（全屏式，非弹框） ============
function CharacterForm({
  mode,
  initial,
  onSubmit,
  onCancel
}: {
  mode: "create" | "edit";
  initial?: DigitalHuman;
  onSubmit: (payload: CreateHumanRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<NewCharacterForm>(() => (initial ? fromCharacter(initial) : defaultForm()));
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [modelUploading, setModelUploading] = useState(false);

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

  const handleModelFile = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    const isModelFile =
      file.name.toLowerCase().endsWith(".glb") ||
      file.name.toLowerCase().endsWith(".gltf") ||
      file.type === "model/gltf-binary" ||
      file.type === "model/gltf+json";
    if (!isModelFile) {
      setStatus("请上传 .glb 或 .gltf 模型文件");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setForm((prev) => ({ ...prev, modelUrl: objectUrl }));
    setModelUploading(true);
    setStatus("模型已进入本地预览，正在尝试上传到后端...");
    try {
      const fileBase64 = await blobToBase64(file);
      const uploaded = await uploadModelFile({
        fileName: file.name,
        fileBase64,
        mimeType: file.type || undefined,
        fallbackUrl: objectUrl
      });
      setForm((prev) => ({ ...prev, modelUrl: uploaded.modelUrl }));
      setStatus(uploaded.hasFallback ? "静态模式已使用本地模型预览；刷新页面后请重新上传。" : "模型已上传，可创建持久化 3D 数字人。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "模型上传失败，已保留本地预览");
    } finally {
      setModelUploading(false);
    }
  };

  const submit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (submitting || avatarUploading || modelUploading) return;
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
      await onSubmit(payload);
      setStatus(mode === "create" ? "已创建 ✓" : "已保存 ✓");
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
        <label className="field">
          <span className="field-label">名字</span>
          <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="例如：小冰" />
        </label>

        <label className="field">
          <span className="field-label">人设描述</span>
          <input
            value={form.description}
            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            placeholder="她的性格、身份、说话风格，例如：温柔懂事的女大学生"
          />
        </label>

        <div className="field">
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

        <details className="creator-advanced">
          <summary>3D 模型（可选，默认使用静态头像）</summary>
          <label className="field">
            <span className="field-label">模型地址</span>
            <input
              value={form.modelUrl}
              onChange={(e) => setForm((p) => ({ ...p, modelUrl: e.target.value }))}
              placeholder="GLB/GLTF 在线地址，或从下方上传"
            />
          </label>
          <label className="file-picker">
            上传 GLB/GLTF 模型
            <input
              type="file"
              accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
              onChange={(e) => handleModelFile(e.currentTarget.files)}
            />
          </label>
        </details>

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

        <label className="field">
          <span className="field-label">Telegram 专属 Bot Token（可选）</span>
          <input
            value={form.telegramBotToken}
            onChange={(e) => setForm((p) => ({ ...p, telegramBotToken: e.target.value }))}
            placeholder="配置后该数字人以独立 bot 运行；留空=不修改（编辑时清空保存=关闭）"
          />
          <small>配置了专属 bot 才能开启主动推送。</small>
        </label>

        <label className="field">
          <span className="field-label">主动推送（专属 bot 主动给主人发消息）</span>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={form.proactive.enabled}
              onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, enabled: e.target.checked } }))}
            />
            启用主动推送
          </label>
        </label>

        {form.proactive.enabled ? (
          <>
            <label className="field">
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
                onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, mode: e.target.value as "always" | "smart" } }))}
              >
                <option value="always">到点必发</option>
                <option value="smart">智能判断（按人设/关系/上下文决定是否发）</option>
              </select>
            </label>

            <label className="inline-check">
              <input
                type="checkbox"
                checked={form.proactive.voiceEnabled}
                onChange={(e) => setForm((p) => ({ ...p, proactive: { ...p.proactive, voiceEnabled: e.target.checked } }))}
              />
              主动推送附带语音（消耗 MiMo TTS 额度，默认关）
            </label>
          </>
        ) : null}

        {status ? <small className="field-hint">{status}</small> : null}
        <div className="dh-form-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>取消</button>
          <button type="submit" disabled={submitting || avatarUploading || modelUploading}>
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
  onCharactersChange
}: {
  characters: DigitalHuman[];
  onCharactersChange: (next: DigitalHuman[]) => void;
}) {
  const [view, setView] = useState<"grid" | "create" | "edit">("grid");
  const [editing, setEditing] = useState<DigitalHuman | null>(null);
  const [status, setStatus] = useState("");

  const openCreate = () => {
    setEditing(null);
    setStatus("");
    setView("create");
  };
  const openEdit = (c: DigitalHuman) => {
    setEditing(c);
    setStatus("");
    setView("edit");
  };
  const back = () => {
    setView("grid");
    setEditing(null);
    setStatus("");
  };

  const handleCreate = async (payload: CreateHumanRequest) => {
    const created = await createDigitalHuman(payload);
    onCharactersChange([...characters, created.human]);
    back();
  };

  const handleEdit = async (payload: CreateHumanRequest) => {
    if (!editing) return;
    const { human } = await updateDigitalHuman(editing.id, payload);
    onCharactersChange(characters.map((c) => (c.id === human.id ? human : c)));
    back();
  };

  const handleDelete = async (c: DigitalHuman) => {
    if (characters.length <= 1) {
      setStatus("至少保留一个数字人，不能全部删除");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`确定删除「${c.name}」吗？删除后不可恢复。`)) {
      return;
    }
    try {
      await deleteDigitalHuman(c.id);
      onCharactersChange(characters.filter((x) => x.id !== c.id));
      setStatus(`已删除「${c.name}」`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "删除失败");
    }
  };

  const handleClearMemory = async (c: DigitalHuman) => {
    if (typeof window !== "undefined" && !window.confirm(`确定清除「${c.name}」的全部记忆吗？\n将清空长期记忆（含你配置的显示名/禁忌/偏好等），清空后不可恢复，但数字人本身会保留。`)) {
      return;
    }
    try {
      await deleteUserMemory(c.id);
      setStatus(`已清除「${c.name}」的记忆`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "清除记忆失败");
    }
  };

  if (view === "create") {
    return <CharacterForm mode="create" onSubmit={handleCreate} onCancel={back} />;
  }
  if (view === "edit") {
    return <CharacterForm mode="edit" initial={editing ?? undefined} onSubmit={handleEdit} onCancel={back} />;
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

      {status ? <p className="settings-notice">{status}</p> : null}

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
                <button type="button" className="dh-action memory" onClick={() => void handleClearMemory(c)}>
                  <Brain size={14} /> 清除记忆
                </button>
                <button
                  type="button"
                  className="dh-action danger"
                  disabled={characters.length <= 1}
                  onClick={() => void handleDelete(c)}
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
    </div>
  );
}
