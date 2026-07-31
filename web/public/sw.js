const CACHE_VERSION = "v4";
const CACHE_NAME = `ai-companion-chat-${CACHE_VERSION}`;
const APP_SCOPE = new URL(self.registration.scope);

const STATIC_PATHS = [
  "",
  "index.html",
  "manifest.webmanifest",
  "assets/avatars/lina-original.jpg",
  "assets/avatars/moon-original.jpg",
  "assets/expressions/happy.svg",
  "assets/expressions/sad.svg",
  "assets/expressions/surprise.svg",
  "assets/expressions/wink.svg",
  "assets/expressions/neutral.svg",
  "assets/expressions/angry.svg",
  "assets/expressions/love.svg",
  "icons/app-icon.svg",
  "icons/app-icon-180.svg"
];

function scopedUrl(path) {
  return new URL(path.replace(/^\//, ""), APP_SCOPE.href).href;
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isWithinAppScope(url) {
  return isSameOrigin(url) && url.pathname.startsWith(APP_SCOPE.pathname);
}

function isRuntimeStaticAsset(url) {
  return (
    isWithinAppScope(url) &&
    (
      url.pathname.includes("/assets/") ||
      url.pathname.includes("/icons/") ||
      url.pathname.endsWith("/manifest.webmanifest") ||
      url.pathname.endsWith("/sw.js")
    )
  );
}

function isBackendPassthrough(url) {
  return (
    url.pathname.startsWith(`${APP_SCOPE.pathname}api/`) ||
    url.pathname.startsWith(`${APP_SCOPE.pathname}audio/`) ||
    url.pathname.startsWith(`${APP_SCOPE.pathname}models/`)
  );
}

function extractShellAssets(html) {
  const assets = new Set();
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match = attrPattern.exec(html);

  while (match) {
    const raw = match[1];
    const url = new URL(raw, APP_SCOPE.href);
    if (isRuntimeStaticAsset(url)) {
      assets.add(url.href);
    }
    match = attrPattern.exec(html);
  }

  return Array.from(assets);
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = scopedUrl("index.html");
  const shellUrls = STATIC_PATHS.map(scopedUrl);

  await cache.addAll(shellUrls);

  try {
    const response = await fetch(indexUrl, { cache: "no-store" });
    if (!response.ok) {
      return;
    }

    const html = await response.clone().text();
    await cache.put(indexUrl, response);
    await cache.addAll(extractShellAssets(html));
  } catch {
    // The fixed shell URLs above are enough for a basic offline fallback.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    cacheAppShell().then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("ai-companion-chat-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstAppShell(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(scopedUrl("index.html"), response.clone());
    }
    return response;
  } catch {
    return (
      await cache.match(scopedUrl("index.html")) ||
      await cache.match(scopedUrl("")) ||
      Response.error()
    );
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (!isSameOrigin(url) || isBackendPassthrough(url)) {
    return;
  }

  if (request.mode === "navigate" || (isWithinAppScope(url) && request.headers.get("accept")?.includes("text/html"))) {
    event.respondWith(networkFirstAppShell(request));
    return;
  }

  if (isRuntimeStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});
