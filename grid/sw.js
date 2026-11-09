/* A股工具集 Service Worker —— 网络优先，离线回退缓存
   目的：满足 PWA 可安装条件（含 fetch 处理器），使「添加到主屏幕」进入 standalone 全屏 */
const 缓存名 = "astock-static-v6";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const 键 = await caches.keys();
    await Promise.all(键.filter((k) => k !== 缓存名).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const 请求 = e.request;
  /* 只接管同源 GET；跨域（云函数调用等）与写请求直接放行 */
  if (请求.method !== "GET" || !请求.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(请求)
      .then((响应) => {
        if (响应 && 响应.status === 200 && 响应.type === "basic") {
          const 副本 = 响应.clone();
          caches.open(缓存名).then((c) => c.put(请求, 副本)).catch(() => {});
        }
        return 响应;
      })
      .catch(() => caches.match(请求))
  );
});
