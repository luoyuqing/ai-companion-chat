import { Eye, EyeOff, KeyRound, Lock, RefreshCw, Save, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  fetchStatsOverview,
  hasSettingsToken,
  resetCharacterStatsApi,
  resetPromptSettings,
  restartService,
  saveSettings,
  settingsLogin,
  settingsLogout,
  settingsInit,
  type StatsChannelCount,
  type StatsOverview
} from "../services/api";

/**
 * 系统设置页（带二次密码验证）。
 * 安全设计：
 * - 未通过密码验证前，本组件只渲染密码输入框，不发起任何设置数据请求；
 *   后端所有 /api/settings* 接口在无令牌时一律 401，前端任何手段都读不到配置。
 * - 令牌只保存在内存（不落 localStorage/sessionStorage），刷新页面即需重新输入密码。
 */

type Tab = "humans" | "ai" | "prompts" | "security" | "service" | "stats";

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
  const [needInit, setNeedInit] = useState(false); // 首次部署：后端尚未设置密码
  const [initPwd, setInitPwd] = useState("");
  const [initPwd2, setInitPwd2] = useState("");

  const [tab, setTab] = useState<Tab>("humans");
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error" | "info">("info");
  const flashTimer = useRef<number | null>(null);
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
  const [rhTriggerWords, setRhTriggerWords] = useState("");
  const [rhTimeoutSec, setRhTimeoutSec] = useState("120");

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
    setRhTriggerWords((data.runningHub?.triggerWords || []).join("\n"));
    setRhTimeoutSec(String(data.runningHub?.timeoutSec ?? 120));
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
      const msg = err instanceof Error ? err.message : "验证失败";
      // 后端 503：设置密码尚未初始化 → 切换到首次设密表单
      if (msg.includes("未初始化")) {
        setNeedInit(true);
      } else {
        setAuthError(msg);
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const submitInit = async () => {
    if (authBusy) return;
    if (initPwd.trim().length < 4) {
      setAuthError("密码至少 4 位");
      return;
    }
    if (initPwd !== initPwd2) {
      setAuthError("两次输入的密码不一致");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      await settingsInit(initPwd.trim());
      setInitPwd("");
      setInitPwd2("");
      setNeedInit(false);
      setUnlocked(true);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "设置失败");
    } finally {
      setAuthBusy(false);
    }
  }

  const flash = (text: string, type: "success" | "error" | "info" = "info") => {
    setNotice(text);
    setNoticeType(type);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setNotice(null), 2800);
  };

  const markSaved = (key: string) => {
    setSavedKey(key);
    window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1800);
  };

  const guard = async (key: string, fn: () => Promise<void>) => {
    if (saving) return;
    setSaving(key);
    try {
      await fn();
    } catch (err) {
      if (err instanceof Error && err.message === "SETTINGS_UNAUTHORIZED") {
        setUnlocked(false);
      } else {
        flash(err instanceof Error ? err.message : "操作失败", "error");
      }
    } finally {
      setSaving(null);
    }
  };

  /** 保存按钮文案：进行中 / 已成功 / 默认 */
  const saveLabel = (key: string, idle: string, savingText = "保存中...") =>
    saving === key ? savingText : savedKey === key ? "✓ 已保存" : idle;

  const saveLlm = () =>
    guard("llm", async () => {
      const data = await saveSettings({
        llm: {
          baseUrl: llmBaseUrl.trim(),
          model: llmModel.trim(),
          supportsVision: llmVision,
          ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {})
        }
      });
      applySettings(data);
      markSaved("llm");
      flash("LLM 配置已保存", "success");
    });

  const saveTts = () =>
    guard("tts", async () => {
      if (!ttsApiKey.trim()) {
        flash("未输入新的 API Key，无需保存", "info");
        return;
      }
      const data = await saveSettings({ tts: { apiKey: ttsApiKey.trim() } });
      applySettings(data);
      markSaved("tts");
      flash("TTS 密钥已保存", "success");
    });

  const saveRh = () =>
    guard("rh", async () => {
      const words = rhTriggerWords
        .split(/[\n,，]/)
        .map((w) => w.trim())
        .filter(Boolean);
      if (words.length === 0) {
        flash("至少需要保留一个触发词", "info");
        return;
      }
      const timeoutSec = Math.max(10, Math.min(600, Number(rhTimeoutSec) || 120));
      const payload: { apiKey?: string; triggerWords: string[]; timeoutSec: number } = {
        triggerWords: words,
        timeoutSec
      };
      if (rhApiKey.trim()) payload.apiKey = rhApiKey.trim();
      const data = await saveSettings({ runningHub: payload });
      applySettings(data);
      markSaved("rh");
      flash(rhApiKey.trim() ? "生图设置已保存" : "触发词 / 超时已保存", "success");
    });

  const savePrompts = () =>
    guard("prompts", async () => {
      if (!prompts) return;
      const data = await saveSettings({ prompts });
      applySettings(data);
      markSaved("prompts");
      flash("提示词已保存", "success");
    });

  const doResetPrompts = () =>
    guard("resetPrompts", async () => {
      const data = await resetPromptSettings();
      applySettings(data);
      markSaved("resetPrompts");
      flash("提示词已恢复默认", "success");
    });

  const doRestartService = () =>
    guard("restart", async () => {
      const data = await restartService();
      flash(data.message || "重启指令已下发", "success");
    });

  const pullModels = async () => {
    if (modelsBusy) return;
    setModelsBusy(true);
    try {
      const models = await fetchLlmModels(llmBaseUrl.trim() || undefined, llmApiKey.trim() || undefined);
      setModelOptions(models);
      if (models.length === 0) flash("拉取成功但模型列表为空", "info");
    } catch (err) {
      if (err instanceof Error && err.message === "SETTINGS_UNAUTHORIZED") {
        setUnlocked(false);
      } else {
        flash(err instanceof Error ? err.message : "拉取模型失败", "error");
      }
    } finally {
      setModelsBusy(false);
    }
  };

  const doChangePassword = () =>
    guard("password", async () => {
      if (newPwd.length < 4) {
        flash("新密码至少 4 位", "info");
        return;
      }
      if (newPwd !== newPwd2) {
        flash("两次输入的新密码不一致", "info");
        return;
      }
      await changeSettingsPassword(oldPwd, newPwd);
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
      // 改密后后端令牌全部作废，回到锁定态
      clearSettingsToken();
      setUnlocked(false);
      flash("密码已修改，请用新密码重新解锁", "success");
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
          {needInit ? (
            <>
              <h2>设置访问密码</h2>
              <p className="settings-lock-tip">这是首次部署，请为系统设置页设置一个访问密码（至少 4 位）。设置后其他接手者都用此密码进入设置页。</p>
              <div className="settings-lock-form">
                <div className="settings-pwd-wrap">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={initPwd}
                    autoFocus
                    placeholder="新密码（至少 4 位）"
                    onChange={(e) => setInitPwd(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitInit();
                    }}
                  />
                  <button type="button" className="settings-pwd-eye" onClick={() => setShowPassword((v) => !v)} aria-label="显示/隐藏密码">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="settings-pwd-wrap">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={initPwd2}
                    placeholder="再次确认密码"
                    onChange={(e) => setInitPwd2(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitInit();
                    }}
                  />
                </div>
                <button type="button" className="settings-primary-btn" disabled={authBusy || !initPwd.trim() || !initPwd2.trim()} onClick={() => void submitInit()}>
                  <ShieldCheck size={16} /> {authBusy ? "设置中..." : "设置密码"}
                </button>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
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
          <button type="button" className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI 接口配置</button>
          <button type="button" className={tab === "prompts" ? "active" : ""} onClick={() => setTab("prompts")}>提示词</button>
          <button type="button" className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}>安全</button>
          <button type="button" className={tab === "service" ? "active" : ""} onClick={() => setTab("service")}>重启服务</button>
          <button type="button" className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>聊天统计</button>
        </nav>

        {loadError ? <p className="settings-error">{loadError}</p> : null}

        {tab === "humans" ? (
          <div className="settings-body">
            <DigitalHumanManager
              characters={characters}
              onCharactersChange={onCharactersChange}
              notify={(msg, type) => flash(msg, type)}
            />
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
                <button type="button" className="settings-primary-btn danger" disabled={saving !== null} onClick={() => setConfirmRestart(true)}>
                <Server size={16} /> {saveLabel("restart", "重启服务", "重启中...")}
              </button>
            </section>
          </div>
        ) : tab === "stats" ? (
          <StatsTab characters={characters} notify={flash} />
        ) : !settings ? (
          <p className="settings-loading">正在加载设置...</p>
        ) : (
          <div className="settings-body">
            {tab === "ai" ? (
              <section className="settings-section">
                <h3 className="settings-subtitle">LLM 模型</h3>
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
                <button type="button" className="settings-primary-btn" disabled={saving !== null} onClick={() => void saveLlm()}>
                  <Save size={16} /> {saveLabel("llm", "保存 LLM 配置")}
                </button>
              </section>
            ) : null}

            {tab === "ai" ? (
              <section className="settings-section">
                <h3 className="settings-subtitle">语音 TTS</h3>
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
                <button type="button" className="settings-primary-btn" disabled={saving !== null} onClick={() => void saveTts()}>
                  <Save size={16} /> {saveLabel("tts", "保存 TTS 密钥")}
                </button>
              </section>
            ) : null}

            {tab === "ai" ? (
              <section className="settings-section">
                <h3 className="settings-subtitle">生图 RunningHub</h3>
                <label className="settings-field">
                  <span>RunningHub API Key（{settings.runningHub?.hasApiKey ? "已配置，留空表示不修改" : "未配置"}）</span>
                  <input
                    type="password"
                    value={rhApiKey}
                    onChange={(e) => setRhApiKey(e.target.value)}
                    placeholder={settings.runningHub?.hasApiKey ? "••••••••（留空保持不变）" : "32 位 API Key"}
                  />
                </label>

                <label className="settings-field">
                  <span>生图触发词（每行一个，或英文逗号分隔；至少保留一个）</span>
                  <textarea
                    rows={3}
                    value={rhTriggerWords}
                    onChange={(e) => setRhTriggerWords(e.target.value)}
                    placeholder={"拍张照\n来张写真\n摆个 pose"}
                  />
                </label>
                <p className="settings-lock-tip">
                  只要 Telegram 消息里包含其中任一子串即触发生图（按数字人隔离：各自头像/会话/Bot）。例如用户发「姐姐拍张照」就会触发。
                </p>

                <label className="settings-field">
                  <span>生图超时时间（秒，10–600）：超时后数字人不再等照片，直接按聊天上下文回复一条</span>
                  <input
                    type="number"
                    min={10}
                    max={600}
                    value={rhTimeoutSec}
                    onChange={(e) => setRhTimeoutSec(e.target.value)}
                  />
                </label>

                <p className="settings-lock-tip">
                  触发后数字人只会提示「去拍张照，稍等」，期间你发任何消息她都不回复（记为未读）；照片生成后（或接口报错/超时）她再根据等待期累积的消息统一回复一条，模拟「忙完拍照回来再看未读」的真实场景。
                </p>
                <button type="button" className="settings-primary-btn" disabled={saving !== null} onClick={() => void saveRh()}>
                  <Save size={16} /> {saveLabel("rh", "保存生图设置")}
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
                  <button type="button" className="settings-primary-btn" disabled={saving !== null} onClick={() => void savePrompts()}>
                    <Save size={16} /> {saveLabel("prompts", "保存提示词")}
                  </button>
                  <button type="button" className="ghost-btn danger" disabled={saving !== null} onClick={() => setConfirmReset(true)}>
                    <RefreshCw size={14} /> {saving === "resetPrompts" ? "恢复中..." : savedKey === "resetPrompts" ? "✓ 已恢复" : "恢复默认"}
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
                <button type="button" className="settings-primary-btn" disabled={saving !== null || !oldPwd || !newPwd} onClick={() => void doChangePassword()}>
                  <KeyRound size={16} /> {saveLabel("password", "修改密码")}
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

      {notice ? (
        <div className={`settings-toast ${noticeType}`} role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

// ---------- 聊天统计 Tab ----------

type StatsRange = "7" | "30" | "all";

interface StatsRow {
  id: string;
  name: string;
  avatarUrl: string;
  chat: StatsChannelCount;
  photo: StatsChannelCount;
  dailyChat: Record<string, number>;
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 根据区间构造折线图序列（升序）；7/30 天强制补齐缺失日期为 0。 */
function buildSeries(dailyChat: Record<string, number>, range: StatsRange): Array<{ date: string; count: number }> {
  if (range === "all") {
    return Object.keys(dailyChat)
      .sort()
      .map((date) => ({ date, count: dailyChat[date] || 0 }));
  }
  const days = range === "7" ? 7 : 30;
  const out: Array<{ date: string; count: number }> = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = fmtDate(d);
    out.push({ date: key, count: dailyChat[key] || 0 });
  }
  return out;
}

function StatsChart({ series }: { series: Array<{ date: string; count: number }> }) {
  const W = 600;
  const H = 170;
  const padL = 30;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const n = series.length;
  const maxCount = Math.max(1, ...series.map((s) => s.count));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xAt = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1));
  const yAt = (c: number) => padT + plotH - (c / maxCount) * plotH;
  const linePath =
    n <= 1
      ? ""
      : series.map((s, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)} ${yAt(s.count).toFixed(1)}`).join(" ");
  const areaPath =
    n <= 1
      ? ""
      : `${linePath} L${xAt(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L${xAt(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

  // 仅在两端与中点显示日期标签，避免拥挤
  const labelIdx = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter((v, idx, arr) => arr.indexOf(v) === idx);

  return (
    <svg className="stats-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="每日聊天折线图">
      {/* 基准网格线 */}
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} className="stats-grid" />
      <line x1={padL} y1={padT + plotH / 2} x2={W - padR} y2={padT + plotH / 2} className="stats-grid" />
      {/* 面积填充 + 折线 */}
      {areaPath ? <path d={areaPath} className="stats-area" /> : null}
      {linePath ? <path d={linePath} className="stats-line" fill="none" /> : null}
      {series.map((s, i) => (
        <circle key={i} cx={xAt(i)} cy={yAt(s.count)} r={n > 40 ? 1.2 : 2.4} className="stats-dot" />
      ))}
      {/* Y 轴峰值标注 */}
      <text x={padL} y={padT + 2} className="stats-axis stats-axis-y">{maxCount}</text>
      {/* X 轴日期 */}
      {labelIdx.map((i) => (
        <text key={i} x={xAt(i)} y={H - 8} className="stats-axis stats-axis-x" textAnchor="middle">
          {series[i].date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

function StatsLegend() {
  return (
    <div className="stats-legend">
      <span className="stats-legend-dot" />
      每日对话轮次
    </div>
  );
}

function StatsTab({
  characters,
  notify
}: {
  characters: DigitalHuman[];
  notify: (msg: string, type?: "success" | "error" | "info") => void;
}) {
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<StatsRange>("7");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmResetId, setConfirmResetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchStatsOverview();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载统计失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 合并数字人列表与统计（缺失统计的显示 0）；TG 活跃角色靠前
  const rows: StatsRow[] = characters.map((dh) => {
    const s = stats?.characters.find((c) => c.id === dh.id);
    return {
      id: dh.id,
      name: dh.name,
      avatarUrl: dh.avatarUrl,
      chat: s?.chat ?? { web: 0, tg: 0 },
      photo: s?.photo ?? { web: 0, tg: 0 },
      dailyChat: s?.dailyChat ?? {}
    };
  });
  rows.sort((a, b) => b.chat.tg - a.chat.tg || b.chat.web - a.chat.web);

  // 全部角色每日聊天合并（总览趋势图）
  const overviewDaily: Record<string, number> = {};
  for (const row of rows) {
    for (const date of Object.keys(row.dailyChat)) {
      overviewDaily[date] = (overviewDaily[date] || 0) + row.dailyChat[date];
    }
  }
  const overviewSeries = buildSeries(overviewDaily, range);

  async function doReset(id: string) {
    setBusy(true);
    try {
      await resetCharacterStatsApi(id);
      notify("已重置该数字人的统计", "success");
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : "重置失败", "error");
    } finally {
      setBusy(false);
      setConfirmResetId(null);
    }
  }

  return (
    <div className="settings-body">
      <section className="settings-section">
        <h3 className="settings-subtitle">总览</h3>
        <div className="stats-overview">
          <div className="stats-overview-card">
            <div className="stats-overview-num">{stats ? stats.totalChat : "—"}</div>
            <div className="stats-overview-label">总对话轮次</div>
            {stats ? (
              <div className="stats-overview-split">
                网页 {stats.characters.reduce((a, c) => a + c.chat.web, 0)} · TG {stats.characters.reduce((a, c) => a + c.chat.tg, 0)}
              </div>
            ) : null}
          </div>
          <div className="stats-overview-card">
            <div className="stats-overview-num">{stats ? stats.totalPhoto : "—"}</div>
            <div className="stats-overview-label">总生图次数</div>
            {stats ? (
              <div className="stats-overview-split">
                网页 {stats.characters.reduce((a, c) => a + c.photo.web, 0)} · TG {stats.characters.reduce((a, c) => a + c.photo.tg, 0)}
              </div>
            ) : null}
          </div>
        </div>
        {stats ? (
          <div className="stats-overview-chart">
            <div className="stats-legend">
              <span className="stats-legend-dot" />
              全部角色每日对话（{range === "7" ? "近 7 天" : range === "30" ? "近 30 天" : "全部"}）
            </div>
            <StatsChart series={overviewSeries} />
          </div>
        ) : null}
        <p className="settings-lock-tip">
          统计按「消息轮次」累计（每发一条消息 +1），生图仅 Telegram 端支持。清除记忆/聊天<strong>不会</strong>清除统计；删除整个数字人或单角色「重置统计」才会清零。
        </p>
      </section>

      <section className="settings-section">
        <div className="stats-range-row">
          <h3 className="settings-subtitle">按数字人</h3>
          <div className="stats-range-btns">
            <button type="button" className={range === "7" ? "active" : ""} onClick={() => setRange("7")}>近 7 天</button>
            <button type="button" className={range === "30" ? "active" : ""} onClick={() => setRange("30")}>近 30 天</button>
            <button type="button" className={range === "all" ? "active" : ""} onClick={() => setRange("all")}>全部</button>
          </div>
        </div>

        {loading ? <p className="settings-loading">正在加载统计...</p> : null}
        {error ? <p className="settings-error">{error}</p> : null}

        <div className="stats-grid-cards">
          {rows.map((row) => {
            const totalChat = row.chat.web + row.chat.tg;
            const totalPhoto = row.photo.web + row.photo.tg;
            const expanded = expandedId === row.id;
            const series = buildSeries(row.dailyChat, range);
            const hasData = series.some((s) => s.count > 0);
            return (
              <div className={`stats-card ${expanded ? "expanded" : ""}`} key={row.id}>
                <div className="stats-card-head">
                  <div className="stats-card-id">
                    {row.avatarUrl ? <img src={row.avatarUrl} alt={row.name} className="stats-card-avatar" /> : null}
                    <div className="stats-card-name">{row.name}</div>
                  </div>
                  <button
                    type="button"
                    className="stats-reset-icon"
                    title="重置该数字人的统计"
                    aria-label="重置统计"
                    disabled={busy || totalChat === 0}
                    onClick={() => setConfirmResetId(row.id)}
                  >
                    ↺
                  </button>
                </div>
                <div className="stats-card-metrics">
                  <span>对话 <b>{totalChat}</b></span>
                  <span>生图 <b>{totalPhoto}</b></span>
                  <span className="stats-card-sub">网页 {row.chat.web} · TG {row.chat.tg}</span>
                </div>
                <div className="stats-card-actions">
                  <button type="button" className="ghost-btn" disabled={busy} onClick={() => setExpandedId(expanded ? null : row.id)}>
                    {expanded ? "收起趋势" : "查看趋势"}
                  </button>
                </div>
                {expanded ? (
                  <div className="stats-card-chart">
                    {hasData ? (
                      <>
                        <StatsLegend />
                        <StatsChart series={series} />
                      </>
                    ) : <p className="stats-empty">该区间暂无聊天数据</p>}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmDialog
        open={confirmResetId !== null}
        title="重置统计"
        message={"确认清空该数字人的全部聊天/生图统计？\n此操作不可撤销。"}
        confirmText="重置"
        danger
        onConfirm={() => confirmResetId !== null && void doReset(confirmResetId)}
        onCancel={() => setConfirmResetId(null)}
      />
    </div>
  );
}
