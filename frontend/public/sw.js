/* 뉴스 대시보드 서비스워커.
 *
 * HTTPS(secure context)에서만 등록된다(Tailscale serve 로 제공). LAN http 나 dev
 * 에서는 등록 자체가 스킵되므로 여기 로직은 오프라인 지원용으로만 동작한다.
 *
 * 전략:
 *  - 네비게이션(HTML)  : 네트워크 우선 → 실패 시 캐시된 앱 셸('/'). 오프라인에서도 앱이 열림.
 *  - /api/*           : 네트워크 우선 → 실패 시 마지막으로 받은 응답. 밖/오프라인에서 최근 본 뉴스·노트 열람.
 *  - 그 외 정적 자산   : 캐시 우선 + 백그라운드 갱신(stale-while-revalidate). Vite 해시 파일명이라 자동 캐시.
 *
 * 캐시 버전을 올리면(VERSION) 이전 캐시는 activate 에서 정리된다.
 */
const VERSION = "v1";
const SHELL_CACHE = "shell-" + VERSION;
const API_CACHE = "api-" + VERSION;
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // POST(수집/노트 저장 등)는 항상 네트워크로.

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부(유튜브 썸네일 등)는 브라우저에 위임.

  // 앱 진입(네비게이션): 네트워크 우선, 오프라인이면 캐시된 셸.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/", { ignoreSearch: true }))
    );
    return;
  }

  // API: 네트워크 우선(최신), 실패 시 마지막 응답으로 폴백.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(API_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 정적 자산: 캐시 우선 + 백그라운드 갱신.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
