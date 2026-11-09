/* A股工具集 Service Worker —— 只缓存图标，页面永远走网络
   目的 1：满足 PWA 可安装条件（含 fetch 处理器），使「添加到主屏幕」进入 standalone 全屏
   目的 2：HTML / JSON 绝不落缓存。看板是「云端改完即生效」的形态，
           一旦把 HTML 写进缓存，手机就会长期显示改动前的旧页面
           （2026-11-06 财经快讯已删除但手机上仍在，即此坑）。
   版本策略：每次前端结构性改动，把 缓存名 的版本号 +1，旧缓存随 activate 清空。 */
const 缓存名 = "astock-static-v29";

/* 仅这些后缀允许入缓存；其余（html / json / 接口响应）一律直连网络 */
const 可缓存后缀 = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff2"];

function 可缓存(url) {
  try {
    const 路径 = new URL(url).pathname.toLowerCase();
    if (路径.endsWith("/") || 路径.endsWith(".html") || 路径.endsWith(".json") || 路径 === "/sw.js") return false;
    return 可缓存后缀.some((后缀) => 路径.endsWith(后缀));
  } catch (e) {
    return false;
  }
}

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
  /* 只接管同源 GET 的静态资源；跨域（云函数调用）、写请求、页面与数据全部放行 */
  if (请求.method !== "GET" || !请求.url.startsWith(self.location.origin)) return;
  if (!可缓存(请求.url)) return;

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
