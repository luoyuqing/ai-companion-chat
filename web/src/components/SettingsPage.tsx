import { useEffect, useState } from "react";
import { ArrowLeft, Cpu, Volume2 } from "lucide-react";
import {
  getSettings,
  updateSettings,
  fetchLlmModels,
  type SystemSettings,
  type SystemSettingsInput
} from "../services/api";

type SectionKey = "llm" | "tts";

const SECTIONS: Array<{ key: SectionKey; label: string; Icon: typeof Cpu }> = [
  { key: "llm", label: "LLM 接口", Icon: Cpu },
  { key: "tts", label: "TTS 语音", Icon: Volume2 }
];

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [active, setActive] = useState<SectionKey>("llm");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // LLM 表单状态
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmSupportsVision, setLlmSupportsVision] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmApiKeyTouched, setLlmApiKeyTouched] = useState(false);

  // TTS 表单状态
  const [ttsApiKey, setTtsApiKey] = useState("");
  const [ttsApiKeyTouched, setTtsApiKeyTouched] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getSettings();
        setSettings(data);
        setLlmBaseUrl(data.llm.baseUrl || "");
        setLlmModel(data.llm.model || "");
        setLlmSupportsVision(Boolean(data.llm.supportsVision));
      } catch (err) {
        setError(err instanceof Error ? err.message : "加载设置失败");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setStatus(null);
    try {
      const { models: list } = await fetchLlmModels(llmBaseUrl, llmApiKeyTouched ? llmApiKey : "");
      setModels(list);
      setStatus(list.length ? `已拉取 ${list.length} 个模型` : "接口可用，但未返回模型列表");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "拉取模型失败");
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const input: SystemSettingsInput = {
        llm: {
          baseUrl: llmBaseUrl,
          model: llmModel,
          supportsVision: llmSupportsVision,
          ...(llmApiKeyTouched ? { apiKey: llmApiKey } : {})
        },
        tts: {
          ...(ttsApiKeyTouched ? { apiKey: ttsApiKey } : {})
        }
      };
      const updated = await updateSettings(input);
      setSettings(updated);
      setLlmApiKeyTouched(false);
      setTtsApiKeyTouched(false);
      setLlmApiKey("");
      setTtsApiKey("");
      setStatus("设置已保存");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="settings-shell">
        <p>加载中…</p>
      </section>
    );
  }

  return (
    <section className="settings-shell">
      <header className="topbar chat-topbar">
        <div>
          <p className="brand-tag">SYSTEM SETTINGS</p>
          <h1>系统设置</h1>
          <p>配置全局接口。后续菜单项将在此扩展。</p>
        </div>
        <div className="chat-top-actions">
          <button type="button" className="ghost-btn" onClick={onBack}>
            <ArrowLeft size={16} /> 返回聊天
          </button>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-sidebar">
          {SECTIONS.map((s) => {
            const Icon = s.Icon;
            return (
              <button
                key={s.key}
                type="button"
                className={`settings-nav-item ${active === s.key ? "active" : ""}`}
                onClick={() => setActive(s.key)}
              >
                <Icon size={16} /> {s.label}
              </button>
            );
          })}
        </nav>

        <div className="settings-content">
          {error ? <p className="error">{error}</p> : null}

          {active === "llm" && (
            <div className="settings-card">
              <h2>LLM 接口（OpenAI 兼容）</h2>
              <p className="settings-hint">配置对话大模型，支持任意 OpenAI 兼容的 Base URL。</p>

              <label className="settings-field">
                <span className="settings-label">Base URL</span>
                <input
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="https://your-endpoint/v1"
                />
              </label>

              <label className="settings-field">
                <span className="settings-label">
                  API Key
                  {settings?.llm.hasApiKey ? <em className="settings-saved">已保存</em> : null}
                </span>
                <input
                  type="password"
                  value={llmApiKey}
                  onChange={(e) => {
                    setLlmApiKey(e.target.value);
                    setLlmApiKeyTouched(true);
                  }}
                  placeholder={settings?.llm.hasApiKey ? "已配置，留空则不修改" : "输入 API Key"}
                />
              </label>

              <div className="settings-field">
                <span className="settings-label">模型</span>
                <div className="settings-model-row">
                  <input
                    list="llm-models"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="选择或输入模型名，如 gpt-4o-mini"
                  />
                  <datalist id="llm-models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <button type="button" className="ghost-btn" onClick={handleFetchModels} disabled={fetchingModels}>
                    {fetchingModels ? "拉取中…" : "拉取模型清单"}
                  </button>
                </div>
                {models.length ? (
                  <div className="settings-model-chips">
                    {models.map((m) => (
                      <button key={m} type="button" className="settings-chip" onClick={() => setLlmModel(m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={llmSupportsVision}
                  onChange={(e) => setLlmSupportsVision(e.target.checked)}
                />
                <span>该模型支持图片识别（多模态）</span>
              </label>
            </div>
          )}

          {active === "tts" && settings && (
            <div className="settings-card">
              <h2>TTS 语音模型</h2>
              <p className="settings-hint">
                语音服务固定使用小米 MiMo，仅可配置密钥。此密钥同时用于语音合成（TTS）、声音设计、声音克隆与语音识别（ASR），改一处全部生效。
              </p>

              <div className="settings-readonly">
                <div>
                  <span>服务商</span>
                  <strong>小米 MiMo</strong>
                </div>
                <div>
                  <span>Base URL</span>
                  <strong>{settings.tts.baseUrl}</strong>
                </div>
                <div>
                  <span>默认模型</span>
                  <strong>{settings.tts.model}（仅数字人未单独配置音频模型时使用，可被每个数字人的语音设置覆盖）</strong>
                </div>
              </div>

              <label className="settings-field">
                <span className="settings-label">
                  MiMo API Key（TTS + ASR 共用）
                  {settings.tts.hasApiKey ? <em className="settings-saved">已保存</em> : null}
                </span>
                <input
                  type="password"
                  value={ttsApiKey}
                  onChange={(e) => {
                    setTtsApiKey(e.target.value);
                    setTtsApiKeyTouched(true);
                  }}
                  placeholder={settings.tts.hasApiKey ? "已配置，留空则不修改" : "输入 MiMo API Key"}
                />
              </label>
            </div>
          )}

          <div className="settings-save-bar">
            <span
              className={
                status
                  ? status.includes("失败")
                    ? "settings-status-error"
                    : "settings-status-ok"
                  : "settings-status-hidden"
              }
            >
              {status}
            </span>
            <button type="button" className="settings-save-btn" onClick={handleSave} disabled={saving}>
              {saving ? "保存中…" : "保存更改"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
