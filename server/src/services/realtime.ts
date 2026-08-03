import type { DigitalHumanConfig } from "../types";

/**
 * 数字人「现实环境」感知服务。
 *
 * 设计目标：让数字人能感知真实的「当前时间 / 昼夜 / 所在地天气气温」，
 * 避免夏天说冷、夜晚说白天这类与事实相悖的描述。
 *
 * 关键约定：
 * - 时间一律按 Asia/Shanghai（北京时间）。中国全境统一 UTC+8，因此「她当地」= 北京时间，
 *   昼夜由该城市本地小时推导；若以后要支持海外城市，再加一个 IANA 时区字段即可。
 * - 天气用 Open-Meteo（免费、无需 API Key、全球高可用）。按经纬度缓存 15 分钟，接口超时/失败
 *   自动降级为「仅时间」，绝不因为拉天气而阻塞聊天。
 * - 坐标来自角色自己的 location 配置（province/city/latitude/longitude），不在此处维护城市表。
 */

// WMO weather code -> 中文天气描述（Open-Meteo 使用 WMO 编码）
const WMO_WEATHER: Record<number, string> = {
  0: "晴",
  1: "晴间多云",
  2: "多云",
  3: "阴",
  45: "有雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨",
  81: "强阵雨",
  82: "暴雨",
  85: "阵雪",
  86: "强阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹"
};

interface WeatherCacheEntry {
  text: string;
  ts: number;
}

const weatherCache = new Map<string, WeatherCacheEntry>();
const WEATHER_TTL_MS = 15 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 8000;

const REALTIME_TZ = "Asia/Shanghai";

interface ShanghaiParts {
  ymd: string;
  weekday: string;
  hm: string;
  hour: number;
}

function shanghaiNowParts(): ShanghaiParts {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: REALTIME_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hm: `${get("hour")}:${get("minute")}`,
    hour: Number(get("hour"))
  };
}

function periodOf(hour: number): "白天" | "晚上" | "凌晨" {
  if (hour >= 6 && hour < 18) return "白天";
  if (hour >= 18 && hour < 23) return "晚上";
  return "凌晨";
}

async function fetchWeather(lat: number, lon: number): Promise<string | null> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) {
    return cached.text;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&timezone=Asia%2FShanghai`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const cur = json?.current;
    if (!cur) return null;
    const temp = typeof cur.temperature_2m === "number" ? Math.round(cur.temperature_2m) : null;
    const code = Number(cur.weather_code);
    const desc = WMO_WEATHER[code] || "天气";
    const text = `${temp ?? "?"}°C，${desc}`;
    weatherCache.set(cacheKey, { text, ts: Date.now() });
    return text;
  } catch {
    // 超时 / 网络错误：返回 null，由上层降级为仅时间
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成注入到系统提示词的一段「现实环境」文本。
 * 返回 null 表示连时间都不应注入（理论上不会发生，时间本地计算不会失败）。
 *
 * 注入内容示例：
 *   当前时间：2026-08-03 周一 10:30（北京时间，白天）。深圳天气：28°C，多云
 */
export async function getRealtimeContext(character: DigitalHumanConfig): Promise<string | null> {
  const now = shanghaiNowParts();
  const period = periodOf(now.hour);
  const head = `当前时间：${now.ymd} ${now.weekday} ${now.hm}（北京时间，${period}）`;

  const loc = character.location;
  if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") {
    // 未配置地点：仅返回时间，不阻塞
    return head;
  }

  let weather: string | null = null;
  try {
    weather = await fetchWeather(loc.latitude, loc.longitude);
  } catch {
    weather = null;
  }

  if (!weather) {
    // 天气获取失败：仅返回时间，绝不阻塞聊天
    return head;
  }
  return `${head}。${loc.city}天气：${weather}`;
}
