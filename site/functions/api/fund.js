// Cloudflare Pages Functions —— 资金流边缘代理（三级容灾版）
// 浏览器请求看板自身域名下的 /api/fund，由本函数在 CF 边缘节点服务端代取行情再回传，
// 彻底绕开客户端网络对第三方域名（东财 / 新浪）的拦截。
//
// 容灾设计（2026-10-15，起因：中国电信侧 PoP 直连新浪失败，模块退回涨停封单兜底）：
//   ① 所有上游 fetch 加 6 秒超时，杜绝函数挂起被 fail_open 回退成 HTML（前端 r.json() 炸）;
//   ② 新浪通道失败自动换 cache-bust 参数重试 1 次；
//   ③ caches.default 边缘缓存：固定键缓存成功响应 2 分钟；
//      上游全失败时回退「过期缓存」并标注 stale —— 宁可给用户 2 分钟前的真实数据，
//      也不要退回非资金净流入口径；
//   ④ onRequest 整体 try/catch，任何路径都返回 application/json —— 永远不出错。

const 东财板块URL =
  "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1" +
  "&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f62&fs=m:90+t:2" +
  "&fields=f12,f14,f62,f184,f3";

const 新浪JSONP =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/__cb/MoneyFlow.ssl_bkzj_ssggzj?num=80&sort=netamount&asc=";

const 超时毫秒 = 6000;
const 缓存键 = "https://astock-board-9t0.pages.dev/api/fund#cache";
const 缓存秒 = 120; /* 边缘缓存 2 分钟，失败时允许回退过期缓存 */

async function 取JSONP(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vip.stock.finance.sina.com.cn/moneyflow/" },
    signal: AbortSignal.timeout(超时毫秒),
  });
  if (!r.ok) return null;
  const t = await r.text();
  const m = t.match(/^[^(]*\(([\s\S]*?)\)\s*;?\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

async function 取东财板块() {
  try {
    const r = await fetch(东财板块URL, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" },
      signal: AbortSignal.timeout(超时毫秒),
    });
    const j = await r.json();
    const diff = j && j.data && j.data.diff;
    if (!Array.isArray(diff) || !diff.length) return null;
    let rows;
    if (Array.isArray(diff[0])) rows = diff.map((x) => ({ name: x[1], net: x[2] }));
    else rows = diff.map((x) => ({ name: x.f14, net: x.f62 }));
    return rows.length ? { 口径: "板块", 源: "东方财富(边缘代理)", rows } : null;
  } catch (e) { return null; }
}

/* 新浪 JSONP：正/负双取；任一失败换 cache-bust 参数重试一次（CDN 边缘偶尔给陈旧/空响应） */
async function 取新浪JSONP重试(asc, 轮次) {
  const 打散 = 轮次 ? "&_r=" + Date.now() : "";
  const arr = await 取JSONP(新浪JSONP + asc + 打散);
  if (arr && arr.length) return arr;
  if (!轮次) return 取新浪JSONP重试(asc, 1);
  return null;
}

async function 取新浪个股() {
  try {
    const [正, 负] = await Promise.all([取新浪JSONP重试("0", 0), 取新浪JSONP重试("1", 0)]);
    const 转 = (arr) =>
      (arr || [])
        .filter(
          (x) =>
            x &&
            x.symbol &&
            /^(sh6\d{5}|sz[03]\d{5}|bj[489]\d{5})$/.test(x.symbol) &&
            !/ETF|LOF|基金|转债|国债|指数|债券/.test(x.name)
        )
        .map((x) => ({ name: x.name, code: x.symbol.replace(/^(sh|sz|bj)/, ""), net: parseFloat(x.netamount) || 0 }))
        .filter((x) => x.net !== 0);
    const rows = 转(正).concat(转(负));
    return rows.length ? { 口径: "个股", 源: "新浪财经(边缘代理)", rows } : null;
  } catch (e) { return null; }
}

/* 边缘缓存读写：成功 → 写入；失败 → 回退过期缓存（哪怕 stale 也优于无数据） */
async function 读缓存() {
  try {
    const c = await caches.default.match(缓存键);
    if (!c) return null;
    const j = await c.json();
    return j && j.rows && j.rows.length ? j : null;
  } catch (e) { return null; }
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
    /* 先看边缘缓存：命中且够新（≤2 分钟）直接回，省一次上游 */
    const 缓存 = await 读缓存();
    const 缓存时间 = 缓存 && 缓存.缓存于 ? Date.parse(缓存.缓存于) : 0;
    const 缓存新鲜 = 缓存 && Date.now() - 缓存时间 < 缓存秒 * 1000;
    if (缓存新鲜) return 出响应(缓存, false);

    const 全部 = await Promise.all([取东财板块(), 取新浪个股()]);
    let 命中 = null;
    for (const r of 全部) {
      if (r && r.rows && r.rows.length) { 命中 = r; break; }
    }
    if (命中) {
      const 出 = { 口径: 命中.口径, 源: 命中.源, rows: 命中.rows, 缓存于: new Date().toISOString() };
      await 写缓存(出);
      return 出响应(出, false);
    }

    /* 上游全失败：回退过期缓存并标注 stale（前端会显示快照时间） */
    if (缓存) {
      const 出 = { 口径: 缓存.口径, 源: 缓存.源 + "(边缘缓存)", rows: 缓存.rows, 缓存于: 缓存.缓存于, stale: true };
      return 出响应(出, true);
    }
    return 出响应({ 口径: "无", 源: "服务端代理全部上游失败", rows: [] }, false);
  } catch (e) {
    /* 兜底中的兜底：缓存里翻旧账，再不行返回空 JSON —— 绝不抛错（抛错会被 fail_open 变成 HTML） */
    try {
      const 缓存 = await 读缓存();
      if (缓存) {
        return 出响应(
          { 口径: 缓存.口径, 源: 缓存.源 + "(边缘缓存)", rows: 缓存.rows, 缓存于: 缓存.缓存于, stale: true },
          true
        );
      }
    } catch (e2) {}
    return 出响应({ 口径: "无", 源: "服务端代理异常:" + String(e && e.message || e).slice(0, 60), rows: [] }, false);
  }
}
