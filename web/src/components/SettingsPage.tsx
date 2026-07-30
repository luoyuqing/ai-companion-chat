import { Eye, EyeOff, KeyRound, Lock, RefreshCw, Save, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { DigitalHumanManager } from "./DigitalHumanManager";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  DigitalHuman,
  PromptSettings,
  SystemSettings,
  changeSettingsPassword,
  clearSettingsToken,
  fetchLlmModels,
  fetchSettings,
  hasSettingsToken,
  resetPromptSettings,
  restartService,
  saveSettings,
  settingsLogin,
  settingsLogout
} from "../services/api";

/**
 * 系统设置页（带二次密码验证）。
 * 安全设计：
 * - 未通过密码验证前，本组件只渲染密码输入框，不发起任何设置数据请求；
 *   后端所有 /api/settings* 接口在无令牌时一律 401，前端任何手段都读不到配置。
 * - 令牌只保存在内存（不落 localStorage/sessionStorage），刷新页面即需重新输入密码。
 */

type Tab = "humans" | "llm" | "tts" | "photo" | "prompts" | "security" | "service";

const PROMPT_FIELDS: Array<{ key: keyof Omit<PromptSettings, "sceneHints">; label: string; rows?: number }> = [
  { key: "globalSystem", label: "全局系统提示词", rows: 10 },
  { key: "relationshipStyleTemplate", label: "关系风格模板（{vibe} 占位）", rows: 2 },
  { key: "characterTemplate", label: "角色信息模板（{name} {description} 占位）", rows: 2 },
  { key: "voiceRules", label: "语音开启时的语音标签规则", rows: 6 },
  { key: "noVoiceRules", label: "语音关闭时的规则", rows: 2 },
  { key: "adultConfirmedRules", label: "成人模式（已确认）规则", rows: 8 },
  { key: "adultUnconfirmedRules", label: "成人模式（未确认）规则", rows: 2 },
  { key: "summaryPrompt", label: "长期记忆总结提示词", rows: 8 }
];

const SCENE_FIELDS: Array<{ key: keyof PromptSettings["sceneHints"]; label: string }> = [
  { key: "daily", label: "日常陪伴" },
  { key: "date", label: "虚拟约会" },
  { key: "comfort", label: "情绪安慰" },
  { key: "flirty", label: "暧昧（未确认成人）" },
  { key: "flirtyAdult", label: "亲密 18+（已确认）" },
  { key: "bedtime", label: "睡前陪伴" }
];

export function SettingsPage({
  onClose,
  characters,
  onCharactersChange
}: {
  onClose: () => void;
  characters: DigitalHuman[];
  onCharactersChange: (next: DigitalHuman[]) => void;
}) {
  const [unlocked, setUnlocked] = useState(hasSettingsToken());
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("humans");
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  // LLM 表单
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmVision, setLlmVision] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);

  // TTS 表单
  const [ttsApiKey, setTtsApiKey] = useState("");

  // 生图（RunningHub）表单
  const [rhApiKey, setRhApiKey] = useState("");

  // 提示词表单
  const [prompts, setPrompts] = useState<PromptSettings | null>(null);

  // 修改密码表单
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");

  const applySettings = (data: SystemSettings) => {
    setSettings(data);
    setLlmBaseUrl(data.llm.baseUrl || "");
    setLlmModel(data.llm.model || "");
    setLlmVision(Boolean(data.llm.supportsVision));
    setLlmApiKey("");
    setTtsApiKey("");
    setRhApiKey("");
    setPrompts(data.prompts);
  };

  const loadSettings = async () => {
    try {
      setLoadError(null);
      const data = await fetchSettings();
      applySettings(data);
    } catch (err) {
      if (err instanceof Error && err.message === "SETTINGS_UNAUTHORIZED") {
        setUnlocked(false);
        return;
      }
      setLoadError(err instanceof Error ? err.message : "加载设置失败");
    }
  };

  useEffect(() => {
    if (unlocked) void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  const submitPassword = async () => {
    if (!password.trim() || authBusy) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await settingsLogin(password.trim());
      setPassword("");
      setUnlocked(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "验证失败");
    } finally {
      setAuthBusy(false);
    }
  };

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 2500);
  };

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err instanceof Error && err.message === "SETTINGS_UNAUTHORIZED") {
        setUnlocked(false);
      } else {
        flash(err instanceof Error ? err.message : "操作失败");
      }
    } finally {
      setBusy(false);
    }
  };

  const saveLlm = () =>
    guard(async () => {
      const data = await saveSettings({
        llm: {
          baseUrl: llmBaseUrl.trim(),
          model: llmModel.trim(),
          supportsVision: llmVision,
          ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {})
        }
      });
      applySettings(data);
      flash("LLM 配置已保存");
    });

  const saveTts = () =>
    guard(async () => {
      if (!ttsApiKey.trim()) {
        flash("未输入新的 API Key，无需保存");
        return;
      }
      const data = await saveSettings({ tts: { apiKey: ttsApiKey.trim() } });
      applySettings(data);
      flash("TTS 密钥已保存");
    });

  const saveRh = () =>
    guard(async () => {
      if (!rhApiKey.trim()) {
        flash("未输入新的 API Key，无需保存");
        return;
      }
      const data = await saveSettings({ runningHub: { apiKey: rhApiKey.trim() } });
      applySettings(data);
      flash("RunningHub 密钥已保存");
    });

  const savePrompts = () =>
    guard(async () => {
      if (!prompts) return;
      const data = await saveSettings({ prompts });
      applySettings(data);
      flash("提示词已保存");
    });

  const doResetPrompts = () =>
    guard(async () => {
      const data = await resetPromptSettings();
      applySettings(data);
      flash("提示词已恢复默认");
    });

  const doRestartService = () =>
    guard(async () => {
      const data = await restartService();
      flash(data.message || "重启指令已下发");
    });

  const pullModels = async () => {
    if (modelsBusy) return;
    setModelsBusy(true);
    try {
      const models = await fetchLlmModels(llmBaseUrl.trim() || undefined, llmApiKey.trim() || undefined);
      setModelOptions(models);
      if (models.length === 0) flash("拉取成功但模型列表为空");
    } catch (err) {
      if (err instanceof Error && err.message === "SETTINGS_UNAUTHORIZED") {
        setUnlocked(false);
      } else {
        flash(err instanceof Error ? err.message : "拉取模型失败");
      }
    } finally {
      setModelsBusy(false);
    }
  };

  const doChangePassword = () =>
    guard(async () => {
      if (newPwd.length < 4) {
        flash("新密码至少 4 位");
        return;
      }
      if (newPwd !== newPwd2) {
        flash("两次输入的新密码不一致");
        return;
      }
      await changeSettingsPassword(oldPwd, newPwd);
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
      // 改密后后端令牌全部作废，回到锁定态
      clearSettingsToken();
      setUnlocked(false);
      flash("密码已修改，请用新密码重新解锁");
    });

  const lockAndClose = async () => {
    try {
      await settingsLogout();
    } catch {
      /* 忽略登出失败 */
    }
    clearSettingsToken();
    onClose();
  };

  // ---------- 密码门 ----------
  if (!unlocked) {
    return (
      <div className="settings-overlay" role="dialog" aria-modal="true">
        <div className="settings-lock-card">
          <button type="button" className="settings-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
          <div className="settings-lock-icon">
            <Lock size={28} />
          </div>
          <h2>系统设置已锁定</h2>
          <p className="settings-lock-tip">请输入设置密码。密码由服务器校验，未验证前无法读取任何系统配置。</p>
          <div className="settings-lock-form">
            <div className="settings-pwd-wrap">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                autoFocus
                placeholder="设置密码"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitPassword();
                }}
              />
              <button type="button" className="settings-pwd-eye" onClick={() => setShowPassword((v) => !v)} aria-label="显示/隐藏密码">
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button type="button" className="settings-primary-btn" disabled={authBusy || !password.trim()} onClick={() => void submitPassword()}>
              <ShieldCheck size={16} /> {authBusy ? "验证中..." : "解锁"}
            </button>
          </div>
          {authError ? <p className="settings-error">{authError}</p> : null}
        </div>
      </div>
    );
  }

  // ---------- 已解锁 ----------
  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-card">
        <header className="settings-header">
          <h2>
            <ShieldCheck size={18} /> 系统设置
          </h2>
          <div className="settings-header-actions">
            <button type="button" className="ghost-btn" onClick={() => void lockAndClose()}>
              <Lock size={14} /> 锁定并关闭
            </button>
          </div>
        </header>

        <nav className="settings-tabs">
          <button type="button" className={tab === "humans" ? "active" : ""} onClick={() => setTab("humans")}>数字人管理</button>
          <button type="button" className={tab === "llm" ? "active" : ""} onClick={() => setTab("llm")}>LLM 模型</button>
          <button type="button" className={tab === "tts" ? "active" : ""} onClick={() => setTab("tts")}>语音 TTS</button>
          <button type="button" className={tab === "photo" ? "active" : ""} onClick={() => setTab("photo")}>生图 RunningHub</button>
          <button type="button" className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>提示词</button>
          <button type="button" className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>安全</button>
          <button type="button" className={tab === "service" ? "active" : ""} onClick={() => setTab("service")}>重启服务</button>
        </nav>

        {notice ? <p className="settings-notice">{notice}</p> : null}
        {loadError ? <p className="settings-error">{loadError}</p> : null}

        {tab === "humans" ? (
          <div className="settings-body">
            <DigitalHumanManager characters={characters} onCharactersChange={onCharactersChange} />
          </div>
        ) : tab === "service" ? (
          <div className="settings-body">
            <section className="settings-section">
              <h3 className="settings-subtitle">
                <Server size={16} /> 重启后端服务
              </h3>
              <p className="settings-lock-tip">
                修改数字人的 Telegram 专属机器人 Token 后，新的 bot 仅在<strong>服务启动时</strong>加载，必须重启后端服务才能生效；其余配置（LLM / TTS / 提示词 / 长期记忆 / 会话）均为运行时热更新，无需重启。
              </p>
              <p className="settings-lock-tip">
                点击下方按钮将执行 <code>sudo systemctl restart digital-girlfriend</code>。重启过程约需 5 秒，期间服务短暂不可用；重启后内存中的解锁令牌失效，需重新输入设置密码。
              </p>
              <button type="button" className="settings-primary-btn danger" disabled={busy} onClick={() => setConfirmRestart(true)}>
                <Server size={16} /> 重启服务
              </button>
            </section>
          </div>
        ) : !settings ? (
          <p className="settings-loading">正在加载设置...</p>
        ) : (
          <div className="settings-body">
            {tab === "llm" ? (
              <section className="settings-section">
                <label className="settings-field">
                  <span>Base URL（OpenAI 兼容）</span>
                  <input value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://xxx/v1" />
                </label>
                <label className="settings-field">
                  <span>API Key（{settings.llm.hasApiKey ? "已配置，留空表示不修改" : "未配置"}）</span>
                  <input type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} placeholder={settings.llm.hasApiKey ? "••••••••（留空保持不变）" : "sk-..."} />
                </label>
                <label className="settings-field">
                  <span>模型</span>
                  <div className="settings-model-row">
                    <input value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="模型名，如 ds" list="settings-model-options" />
                    <datalist id="settings-model-options">
                      {modelOptions.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <button type="button" className="ghost-btn" disabled={modelsBusy} onClick={() => void pullModels()}>
                      <RefreshCw size={14} className={modelsBusy ? "spin" : ""} /> 拉取模型列表
                    </button>
                  </div>
                </label>
                {modelOptions.length > 0 ? (
                  <label className="settings-field">
                    <span>从列表选择（共 {modelOptions.length} 个）</span>
                    <select value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                      <option value="">-- 选择模型 --</option>
                      {modelOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="settings-check">
                  <input type="checkbox" checked={llmVision} onChange={(e) => setLlmVision(e.target.checked)} />
                  <span>该模型支持图片识别（多模态）</span>
                </label>
                <button type="button" className="settings-primary-btn" disabled={busy} onClick={() => void saveLlm()}>
                  <Save size={16} /> 保存 LLM 配置
                </button>
              </section>
            ) : null}

            {tab === "tts" ? (
              <section className="settings-section">
                <label className="settings-field">
                  <span>服务商（固定小米 MiMo，不可修改）</span>
                  <input value={`${settings.tts.provider} · ${settings.tts.baseUrl}`} readOnly disabled />
                </label>
                <label className="settings-field">
                  <span>TTS 模型（固定）/ 默认音色</span>
                  <input value={`${settings.tts.model} · ${settings.tts.voice}`} readOnly disabled />
                </label>
                <label className="settings-field">
                  <span>API Key（{settings.tts.hasApiKey ? "已配置，留空表示不修改" : "未配置"}）</span>
                  <input type="password" value={ttsApiKey} onChange={(e) => setTtsApiKey(e.target.value)} placeholder={settings.tts.hasApiKey ? "••••••••（留空保持不变）" : "sk-..."} />
                </label>
                <button type="button" className="settings-primary-btn" disabled={busy} onClick={() => void saveTts()}>
                  <Save size={16} /> 保存 TTS 密钥
                </button>
              </section>
            ) : null}

            {tab === "photo" ? (
              <section className="settings-section">
                <label className="settings-field">
                  <span>RunningHub API Key（{settings.runningHub?.hasApiKey ? "已配置，留空表示不修改" : "未配置"}）</span>
                  <input
                    type="password"
                    value={rhApiKey}
                    onChange={(e) => setRhApiKey(e.target.value)}
                    placeholder={settings.runningHub?.hasApiKey ? "••••••••（留空保持不变）" : "32 位 API Key"}
                  />
                </label>
                <p className="settings-lock-tip">
                  用于在 Telegram 聊天中发送「拍张照」时调用 RunningHub 生图：以该数字人头像为输入，生成写实照片回传。密钥仅保存在服务器 system-config.json，不会回传前端。
                </p>
                <button type="button" className="settings-primary-btn" disabled={busy} onClick={() => void saveRh()}>
                  <Save size={16} /> 保存 RunningHub 密钥
                </button>
              </section>
            ) : null}

            {tab === "prompts" && prompts ? (
              <section className="settings-section">
                {PROMPT_FIELDS.map((field) => (
                  <label className="settings-field" key={field.key}>
                    <span>{field.label}</span>
                    <textarea
                      rows={field.rows || 4}
                      value={prompts[field.key]}
                      onChange={(e) => setPrompts({ ...prompts, [field.key]: e.target.value })}
                    />
                  </label>
                ))}
                <h3 className="settings-subtitle">场景提示词</h3>
                {SCENE_FIELDS.map((field) => (
                  <label className="settings-field" key={field.key}>
                    <span>{field.label}</span>
                    <textarea
                      rows={3}
                      value={prompts.sceneHints[field.key]}
                      onChange={(e) =>
                        setPrompts({ ...prompts, sceneHints: { ...prompts.sceneHints, [field.key]: e.target.value } })
                      }
                    />
                  </label>
                ))}
                <div className="settings-btn-row">
                  <button type="button" className="settings-primary-btn" disabled={busy} onClick={() => void savePrompts()}>
                    <Save size={16} /> 保存提示词
                  </button>
                  <button type="button" className="ghost-btn danger" disabled={busy} onClick={() => setConfirmReset(true)}>
                    <RefreshCw size={14} /> 恢复默认
                  </button>
                </div>
              </section>
            ) : null}

            {tab === "security" ? (
              <section className="settings-section">
                <h3 className="settings-subtitle">
                  <KeyRound size={16} /> 修改设置密码
                </h3>
                <label className="settings-field">
                  <span>原密码</span>
                  <input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} />
                </label>
                <label className="settings-field">
                  <span>新密码（至少 4 位）</span>
                  <input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} />
                </label>
                <label className="settings-field">
                  <span>确认新密码</span>
                  <input type="password" value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)} />
                </label>
                <button type="button" className="settings-primary-btn" disabled={busy || !oldPwd || !newPwd} onClick={() => void doChangePassword()}>
                  <KeyRound size={16} /> 修改密码
                </button>
                <p className="settings-lock-tip">说明：密码由后端加盐哈希存储与校验，改密后所有已解锁的会话立即失效；解锁令牌只存内存，刷新页面即需重新输入。</p>
              </section>
            ) : null}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="恢复默认提示词"
        message={"确认恢复所有提示词为默认值？\n你的自定义修改将被清除，且不可撤销。"}
        confirmText="恢复默认"
        danger
        onConfirm={() => {
          setConfirmReset(false);
          void doResetPrompts();
        }}
        onCancel={() => setConfirmReset(false)}
      />
      <ConfirmDialog
        open={confirmRestart}
        title="重启后端服务"
        message={"确认重启后端服务？\n重启期间服务会短暂中断（约 5 秒），重启后需重新输入设置密码。\n修改数字人 Telegram 专属 bot Token 后必须重启才能生效。"}
        confirmText="重启服务"
        danger
        onConfirm={() => {
          setConfirmRestart(false);
          void doRestartService();
        }}
        onCancel={() => setConfirmRestart(false)}
      />
    </div>
  );
}
