// Cloudflare Pages Functions —— 荐股存档边缘代理（recs.json 专用）
// 浏览器请求看板自身域名下的 /api/recs，由本函数在 CF 边缘节点服务端代取再回传。
//
// 起因（2026-10-15 实测事故）：jsDelivr @main 分支地址被边缘节点长期缓存旧版本，
//   15:12 定时版覆盖 17:54 手动补跑版后，部分边缘仍在散发定时版（京能热力版），
//   而远程真身（raw.githubusercontent.com）已是补跑版（金域医学版）——
//   看板「今日持股」会显示用户并未实购的股票，属数据正确性事故。
//   前端原有「哈希+分支」双路取新救不了：哈希地址静态写死不会每日更新。
//
// 方案：本函数服务端直拉 GitHub raw（无 CDN 缓存，永远新鲜），jsDelivr 仅作备用；
//   边缘缓存 30 秒（recs 每日仅更新数次，30 秒足够防刷又不犯陈旧错）。
//
// 铁律（同 fund.js）：任何路径都返回 application/json，绝不抛错——
//   抛错会被 Pages SPA 回退成 HTML，前端 r.json() 炸出「无数据」误报。

const 仓库 = "dqlvxy/astock-recs-bot";
const 分支 = "main";
const 文件 = "recs.json";

const 主源URL = "https://raw.githubusercontent.com/" + 仓库 + "/" + 分支 + "/" + 文件;
const 备源URL = "https://cdn.jsdelivr.net/gh/" + 仓库 + "@" + 分支 + "/" + 文件;

const 超时毫秒 = 6000;
const 缓存键 = "https://astock-board-9t0.pages.dev/api/recs#cache";
const 缓存秒 = 30; /* 边缘缓存 30 秒；失败时允许回退过期缓存并标 stale */

function 校验(j) {
  return j && Array.isArray(j.recs) && j.recs.length;
}

/* 取一个上游 URL；失败换 cache-bust 参数重试一次（边缘偶发陈旧/空响应） */
async function 取上游(url, 轮次) {
  const 打散 = 轮次 ? (url.indexOf("?") < 0 ? "?t=" : "&t=") + Date.now() : "";
  try {
    const r = await fetch(url + 打散, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      signal: AbortSignal.timeout(超时毫秒),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return 校验(j) ? j : null;
  } catch (e) {
    return null;
  }
}

/* 边缘缓存读写：成功 → 写入；全失败 → 回退过期缓存（stale 也优于无数据） */
async function 读缓存() {
  try {
    const c = await caches.default.match(缓存键);
    if (!c) return null;
    const j = await c.json();
    return 校验(j) ? j : null;
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
  try {
    /* 先看边缘缓存：命中且够新（≤30 秒）直接回，省一次上游 */
    const 缓存 = await 读缓存();
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    const 缓存新鲜 = 缓存 && Date.now() - 缓存时间 < 缓存秒 * 1000;
    if (缓存新鲜) return 出响应(缓存, false);

    /* 主源 raw（新鲜）→ 换 cache-bust 重试 → 备用 jsDelivr → 再重试 */
    let 命中 = await 取上游(主源URL, 0);
    if (!命中) 命中 = await 取上游(主源URL, 1);
    if (!命中) 命中 = await 取上游(备源URL, 0);
    if (!命中) 命中 = await 取上游(备源URL, 1);

    if (命中) {
      const 出 = {
        ok: true,
        源: "GitHub raw(边缘代理)",
        recs: 命中.recs,
        count: 命中.count,
        updated: 命中.updated,
        缓存于: new Date().toISOString(),
      };
      await 写缓存(出);
      return 出响应(出, false);
    }

    /* 上游全失败：回退过期缓存并标注 stale（前端照常能用，只是数据稍旧） */
    if (缓存) {
      const 出 = {
        ok: true,
        源: 缓存.源 + "(边缘缓存)",
        recs: 缓存.recs,
        count: 缓存.count,
        updated: 缓存.updated,
        缓存于: 缓存.缓存于,
        stale: true,
      };
      return 出响应(出, true);
    }
    return 出响应({ ok: false, 源: "服务端代理全部上游失败", recs: [] }, false);
  } catch (e) {
    /* 兜底中的兜底：缓存里翻旧账，再不行返回空 JSON —— 绝不抛错 */
    try {
      const 缓存 = await 读缓存();
      if (缓存) {
        return 出响应(
          {
            ok: true,
            源: 缓存.源 + "(边缘缓存)",
            recs: 缓存.recs,
            count: 缓存.count,
            updated: 缓存.updated,
            缓存于: 缓存.缓存于,
            stale: true,
          },
          true
        );
      }
    } catch (e2) {}
    return 出响应(
      { ok: false, 源: "服务端代理异常:" + String((e && e.message) || e).slice(0, 60), recs: [] },
      false
    );
  }
}
