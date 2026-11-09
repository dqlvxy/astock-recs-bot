// Cloudflare Pages Functions —— 云端数据边缘代理（通用，白名单）
// 浏览器请求看板自身域名下的 /api/data?f=today.json，由本函数在 CF 边缘服务端代取再回传。
//
// 起因（2026-10-15）：jsDelivr @main 分支地址会被边缘节点长期缓存旧版本，
//   实测出现「云端已产出新字段（yaogu_potential / temperature 补齐项），
//   但看板读到的仍是旧文件」——用户看到的是过期数据。
//   与 /api/recs 同源代理同因同解：服务端直拉 GitHub raw（无 CDN 缓存）。
//
// 覆盖文件（白名单，禁止任意路径）：recs.json（荐股存档）· today.json（全模块快照，含妖股/温度）
//   · watch.json（自选行情）· review_log.json（云端复盘逐期明细）· params.json（复盘统计+自适应引擎参数）
//
// 铁律（同 fund.js/recs.js）：任何路径都返回 application/json，绝不抛错——
//   抛错会被 Pages SPA 回退成 HTML，前端 r.json() 炸出「无数据」误报。

const 仓库 = "dqlvxy/astock-recs-bot";
const 分支 = "main";
const 白名单 = ["recs.json", "today.json", "watch.json", "review_log.json", "params.json"];

const 超时毫秒 = 8000;
const 缓存键前缀 = "https://astock-board-9t0.pages.dev/api/data#";
const 缓存秒 = 30; /* 边缘缓存 30 秒；失败时允许回退过期缓存并标 stale */

function 主源(文件) {
  return "https://raw.githubusercontent.com/" + 仓库 + "/" + 分支 + "/" + 文件;
}
function 备源(文件) {
  return "https://cdn.jsdelivr.net/gh/" + 仓库 + "@" + 分支 + "/" + 文件;
}

async function 取上游(url, 轮次) {
  const 打散 = 轮次 ? (url.indexOf("?") < 0 ? "?t=" : "&t=") + Date.now() : "";
  try {
    const r = await fetch(url + 打散, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(超时毫秒),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    return null;
  }
}

async function 读缓存(文件) {
  try {
    const c = await caches.default.match(缓存键前缀 + 文件);
    if (!c) return null;
    const j = await c.json();
    return j && typeof j === "object" ? j : null;
  } catch (e) {
    return null;
  }
}

async function 写缓存(文件, 出) {
  try {
    const r = new Response(JSON.stringify(出), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + 缓存秒 },
    });
    await caches.default.put(缓存键前缀 + 文件, r.clone());
  } catch (e) {}
}

function 出响应(出, 边缘缓存) {
  return new Response(JSON.stringify(出), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": 边缘缓存 ? "public, max-age=30" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequest(context) {
  const 文件 = (new URL(context.request.url).searchParams.get("f") || "today.json").trim();
  if (白名单.indexOf(文件) < 0) {
    return 出响应({ ok: false, 源: "不在白名单", rows: [] }, false);
  }
  try {
    const 缓存 = await 读缓存(文件);
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    const 缓存新鲜 = 缓存 && Date.now() - 缓存时间 < 缓存秒 * 1000;
    if (缓存新鲜) return 出响应(缓存.数据, false);

    /* 主源 raw（新鲜）→ 换 cache-bust 重试 → 备用 jsDelivr → 再重试 */
    let 命中 = await 取上游(主源(文件), 0);
    if (!命中) 命中 = await 取上游(主源(文件), 1);
    if (!命中) 命中 = await 取上游(备源(文件), 0);
    if (!命中) 命中 = await 取上游(备源(文件), 1);

    if (命中) {
      const 出 = { ok: true, 源: "GitHub raw(边缘代理)", 文件, 缓存于: new Date().toISOString(), 数据: 命中 };
      await 写缓存(文件, 出);
      return 出响应(出, false);
    }
    if (缓存) {
      return 出响应({ ok: true, 源: 缓存.源 + "(边缘缓存)", 文件, 缓存于: 缓存.缓存于, stale: true, 数据: 缓存.数据 }, true);
    }
    return 出响应({ ok: false, 源: "服务端代理全部上游失败", 文件, 数据: null }, false);
  } catch (e) {
    try {
      const 缓存 = await 读缓存(文件);
      if (缓存) return 出响应({ ok: true, 源: 缓存.源 + "(边缘缓存)", 文件, 缓存于: 缓存.缓存于, stale: true, 数据: 缓存.数据 }, true);
    } catch (e2) {}
    return 出响应({ ok: false, 源: "服务端代理异常:" + String((e && e.message) || e).slice(0, 60), 文件, 数据: null }, false);
  }
}
