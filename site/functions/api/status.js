// Cloudflare Pages Functions —— 选股运行状态接口（/api/status）
//
// 起因（2026-10-22 用户实测）：看板顶部亮「⚠ 数据过期 · 距今天8天」。
//   根因：/api/status 从未有 functions 实现，前端 getData 只能吃 EMBED 里
//   构建时烧录的静态快照（result_date 停在打包日 2026-10-14），误报过期；
//   而真实数据（recs/today/watch 经各自代理或 jsDelivr）全部新鲜。
//
// 方案：本函数服务端代理 GitHub raw 的 recs.json，取最新期日期作为权威状态：
//   result_date / last_run = 荐股存档最新交易日（归一化 YYYY-MM-DD）。
//   边缘缓存 60 秒（状态为慢变量）。
//
// 铁律（同 data.js/recs.js）：任何路径都返回 application/json，绝不抛错——
//   抛错会被 Pages SPA 回退成 HTML，前端 r.json() 炸出误报。
//   上游不可达时返回 ok:true + result_date:null（前端据此走云端 recs 判时效）。

const 仓库 = "dqlvxy/astock-recs-bot";
const 分支 = "main";
const 主源URL = "https://raw.githubusercontent.com/" + 仓库 + "/" + 分支 + "/recs.json";
const 备源URL = "https://cdn.jsdelivr.net/gh/" + 仓库 + "@" + 分支 + "/recs.json";

const 超时毫秒 = 6000;
const 缓存键 = "https://astock-board-9t0.pages.dev/api/status#cache";
const 缓存秒 = 60;

/* "20261021" → "2026-10-21"；已是带横线格式或空则原样返回 */
function 归一化日期(串) {
  const s = String(串 || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
}

async function 取上游(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(超时毫秒),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.recs) || !j.recs.length) return null;
    let 最新 = "";
    for (const g of j.recs) {
      if (g && g.date && String(g.date) > 最新) 最新 = String(g.date);
    }
    const 日 = 归一化日期(最新);
    return 日 ? { 期数: j.recs.length, 日 } : null;
  } catch (e) {
    return null;
  }
}

async function 读缓存() {
  try {
    const c = await caches.default.match(缓存键);
    if (!c) return null;
    return await c.json();
  } catch (e) {
    return null;
  }
}

async function 写缓存(出) {
  try {
    const r = new Response(JSON.stringify(出), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=" + 缓存秒,
      },
    });
    await caches.default.put(缓存键, r.clone());
  } catch (e) {}
}

function 出响应(出) {
  return new Response(JSON.stringify(出), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export async function onRequest() {
  try {
    const 缓存 = await 读缓存();
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    const 缓存新鲜 = 缓存 && 缓存.日 && Date.now() - 缓存时间 < 缓存秒 * 1000;
    if (缓存新鲜) return 出响应(缓存);

    let 命中 = await 取上游(主源URL);
    if (!命中) 命中 = await 取上游(备源URL);

    if (命中) {
      const 出 = {
        ok: true,
        embed: false,
        running: false,
        error: null,
        last_run: 命中.日,
        result_date: 命中.日,
        期数: 命中.期数,
        源: "GitHub raw(边缘代理)",
        缓存于: new Date().toISOString(),
      };
      await 写缓存(出);
      return 出响应(出);
    }

    /* 上游全失败：回退过期缓存（stale 也优于无数据），再无则空状态 */
    if (缓存 && 缓存.日) {
      return 出响应({ ...缓存, stale: true });
    }
    return 出响应({
      ok: true, embed: false, running: false, error: null,
      last_run: null, result_date: null,
      源: "上游不可达（前端应按云端荐股存档判时效）",
    });
  } catch (e) {
    /* 兜底中的兜底：缓存里翻旧账，再不行返回空状态 JSON —— 绝不抛错 */
    try {
      const 缓存 = await 读缓存();
      if (缓存 && 缓存.日) return 出响应({ ...缓存, stale: true });
    } catch (e2) {}
    return 出响应({
      ok: true, embed: false, running: false, error: null,
      last_run: null, result_date: null,
      源: "服务端异常:" + String((e && e.message) || e).slice(0, 60),
    });
  }
}
