import { ArrowRight, AppWindow, Camera, MessageCircle, Settings, Smartphone, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPage } from "./components/SettingsPage";
import { DEFAULT_CHARACTER_ID, DigitalHuman, fetchHumans } from "./services/api";


type ViewMode = "landing" | "chat";
type DeferredInstallPrompt = {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const CHARACTER_STORAGE_KEY = "dg-selected-character-id";

const FEATURE_CARDS = [
  {
    emoji: "✨",
    title: "情绪驱动",
    description: "实时识别用户语气，动态切换数字人表情与语气，聊天更像对话。"
  },
  {
    emoji: "🎤",
    title: "语音一体",
    description: "支持文本与语音输入，语音回复可直接听见，更像「真人陪伴」体验。"
  },
  {
    emoji: "🎭",
    title: "多数字人配置",
    description: "创建 / 切换数字人，支持图片与视频形象、语音个性与关系风格设置。"
  },
  {
    emoji: "🚀",
    title: "三端统一",
    description: "同一后端 API，支持网站、微信小程序、iOS 三端并行体验。"
  }
];

export default function App() {
  const [characters, setCharacters] = useState<Array<DigitalHuman>>([]);
  const [sessionId, setSessionId] = useState(() => {
    if (typeof window === "undefined") return "session-browser";
    const existing = window.localStorage.getItem("dg-session-id");
    if (existing) return existing;
    const generated = `session-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem("dg-session-id", generated);
    return generated;
  });
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(CHARACTER_STORAGE_KEY)?.trim() || "";
  });
  const [error, setError] = useState<string | null>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<DeferredInstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "chat";
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "landing") {
      return "landing";
    }
    if (params.get("view") === "chat" || window.location.pathname === "/chat" || window.location.hash === "#chat") {
      return "chat";
    }
    return "chat";
  });

  const wechatMiniLink = import.meta.env.VITE_WECHAT_MINI_LINK || "";
  const wechatMiniQrcode = import.meta.env.VITE_WECHAT_MINI_QRCODE || "";
  const iosAppLink = import.meta.env.VITE_IOS_APP_LINK || "";
  const iosInstallHint = import.meta.env.VITE_IOS_INSTALL_HINT || "";

  useEffect(() => {
    (async () => {
      try {
        const data = await fetchHumans();
        setCharacters(data.humans);
        const normalizedSavedId = selectedCharacterId || "";
        const found = data.humans.find((item: DigitalHuman) => item.id === normalizedSavedId);
        if (found) {
          return;
        }
        if (data.humans[0]?.id) {
          setSelectedCharacterId(data.humans[0].id);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(CHARACTER_STORAGE_KEY, data.humans[0].id);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "初始化失败");
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedCharacterId) {
      window.localStorage.setItem(CHARACTER_STORAGE_KEY, selectedCharacterId);
    }
  }, [selectedCharacterId]);

  const syncUrlMode = (nextMode: ViewMode) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (nextMode === "chat") {
      url.searchParams.set("view", "chat");
    } else {
      url.searchParams.set("view", "landing");
    }
    window.history.replaceState({}, "", url.toString());
  };

  const enterChat = () => {
    setViewMode("chat");
    syncUrlMode("chat");
  };

  const backLanding = () => {
    setViewMode("landing");
    syncUrlMode("landing");
  };

  const handleCharacterChange = (nextId: string) => {
    setSelectedCharacterId(nextId);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(CHARACTER_STORAGE_KEY, nextId);
    }
  };

  // 数字人列表统一由「设置页 → 数字人管理」维护，这里只做状态同步与选中兜底
  const applyCharacters = (next: DigitalHuman[]) => {
    setCharacters(next);
    if (!next.length) return;
    const stillExists = next.some((item) => item.id === selectedCharacterId);
    if (!stillExists) {
      handleCharacterChange(next[0].id);
    }
  };

  const resetSession = () => {
    if (typeof window === "undefined") return;
    const newSessionId = `session-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem("dg-session-id", newSessionId);
    setSessionId(newSessionId);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true);
    if (standalone) {
      setInstalled(true);
      setShowIosInstallHint(false);
    }

    const isIos = /iPhone|iPad|iPod/i.test(window.navigator.userAgent || "");
    const isWechat = /MicroMessenger/i.test(window.navigator.userAgent || "");
    setShowIosInstallHint(isIos && !isWechat && !standalone);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      const evt = event as Event & { prompt?: () => void; userChoice?: Promise<{ outcome: "accepted" | "dismissed" }> };
      if (!evt.prompt || !evt.userChoice) {
        return;
      }

      setDeferredPrompt({
        prompt: () => {
          evt.prompt?.();
          return Promise.resolve();
        },
        userChoice: evt.userChoice
      });
    };

    const onAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const installPwa = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === "accepted") {
      setInstalled(true);
      setDeferredPrompt(null);
    }
  };

  const installHintBlock = (
    <div className="install-actions">
      {!installed && deferredPrompt ? (
        <button className="install-btn" type="button" onClick={installPwa}>
          安装网页版（可直接进入）
        </button>
      ) : null}
      {!installed && showIosInstallHint && !deferredPrompt ? (
        <p className="install-hint">iPhone 端请在 Safari 打开后，点底部「分享」→「添加到主屏幕」。</p>
      ) : null}
      {installed ? <p className="install-state">网页版已安装</p> : null}
      {(wechatMiniLink || wechatMiniQrcode) ? (
        <p className="install-cross">
          <span>小程序：</span>
          {wechatMiniLink ? <a href={wechatMiniLink}>打开小程序</a> : null}
          {wechatMiniQrcode ? <a href={wechatMiniQrcode}>体验二维码</a> : null}
        </p>
      ) : null}
      {(iosAppLink || iosInstallHint) ? (
        <p className="install-cross">
          <span>iOS：</span>
          {iosAppLink ? <a href={iosAppLink}>打开 App</a> : null}
          {iosInstallHint ? <span>{iosInstallHint}</span> : null}
        </p>
      ) : null}
    </div>
  );

  const chatContent = (
    <section className="chat-shell">
      <header className="topbar chat-topbar">
        <div>
          <p className="brand-tag">PRIVATE COMPANION</p>
          <h1>AI伴聊</h1>
          <p>今晚，也有人认真听你说话。</p>
        </div>
        <div className="chat-top-actions">
          <button type="button" className="ghost-btn" onClick={() => setShowSettings(true)}>
            <Settings size={16} /> 系统设置
          </button>
          <button type="button" className="ghost-btn" onClick={backLanding}>
            <AppWindow size={16} /> 返回产品页
          </button>
        </div>
      </header>
      {installHintBlock}
      {error ? (
        <p className="error">错误：{error}</p>
      ) : characters.length === 0 ? (
        <p>正在加载数字人...</p>
      ) : (
        <ChatPanel
          characters={characters}
          sessionId={sessionId}
          selectedCharacterId={selectedCharacterId || characters[0]?.id || DEFAULT_CHARACTER_ID}
          onResetSession={resetSession}
          onCharacterChange={handleCharacterChange}
        />
      )}
    </section>
  );

  const landingContent = (
    <section className="landing-shell">
      <header className="hero">
        <p className="brand-tag">Digital Girlfriend × Product Design</p>
        <h1>一键启动你的数字人陪伴体验</h1>
        <p className="hero-subtitle">
          产品化聊天体验，支持情绪联动、语音回放和多端入口。网页体验即可快速发布，后续接入微信小程序和 iOS。
        </p>
        <div className="hero-cta">
          <button type="button" onClick={enterChat}>
            <MessageCircle size={16} /> 立即体验聊天
            <ArrowRight size={16} />
          </button>
          {installHintBlock}
        </div>
      </header>

      <section className="feature-grid">
        {FEATURE_CARDS.map((card) => (
          <article className="feature-card" key={card.title}>
            <p className="feature-emoji">{card.emoji}</p>
            <h2>{card.title}</h2>
            <p>{card.description}</p>
          </article>
        ))}
      </section>

      <section className="flow-shell">
        <h2>产品流程</h2>
        <ol className="flow-steps">
          <li>启动后端 API（默认 8787）并配置前端入口。</li>
          <li>在网页端进行真实对话：数字人选择、语音输入、情绪变化。</li>
          <li>复用同一后端数据给小程序与 iOS，实现三端体验一致。</li>
        </ol>
        <div className="platform-icons">
          <span><Smartphone size={16} /> Web</span>
          <span><Camera size={16} /> 小程序</span>
          <span><AppWindow size={16} /> iOS</span>
          <span><Sparkles size={16} /> 多数字人可扩展</span>
        </div>
      </section>

      <section className="launch-strip">
        <p>
          后端已支持 `POST /api/chat`、`GET /api/digital-humans`、流式输出与语音回放；页面默认兼容 API 端口与前端端口联调。
        </p>
      </section>
    </section>
  );

  return (
    <main className="container">
      {viewMode === "landing" ? landingContent : chatContent}
      {showSettings ? (
        <SettingsPage
          onClose={() => setShowSettings(false)}
          characters={characters}
          onCharactersChange={applyCharacters}
        />
      ) : null}
    </main>
  );
}
