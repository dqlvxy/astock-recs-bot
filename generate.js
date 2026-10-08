// generate.js —— 每日 14:30 定时入口（稳健版）：判交易日 → 跑 runStable → 存档
//
// 存档目标（自动降级）：
//   ① 若配了 CF_* 凭据（KV 权限）→ 写 Cloudflare KV
//   ② 否则 → 写本地 recs.json（含近 12 期历史，供 Pages 静态托管 / jsdelivr 读取）
//
// recs.json 结构（前端契约）：
//   { ok:true, updated:"2026-10-08 14:32", count:N, recs:[ { date, gen_time, picks:[...] }, ... ] }
//
// KV key（当 ① 可用时）：
//   astock_recs_stable  —— 最新一期存档（供前端 后端地址 拉取）
//   astock_recs_history —— 历史期数组（近 12 期，用于跨期去重）
import { runStable, 今日键, 是周末, 是休市日 } from "./engine.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const 有KV凭据 = !!(CF_API_TOKEN && CF_ACCOUNT_ID && CF_KV_NAMESPACE_ID);

const 存档文件 = process.env.RECS_FILE || "recs.json";

function kvUrl(key) {
  return `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${key}`;
}
async function 读KV(key) {
  if (!有KV凭据) return null;
  try {
    const r = await fetch(kvUrl(key), { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
    if (!r.ok) return null;
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  } catch (e) {
    return null;
  }
}
async function 写KV(key, val) {
  const r = await fetch(kvUrl(key), {
    method: "PUT",
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(val),
  });
  const j = await r.json();
  if (!j.success) throw new Error(`KV 写入失败(${key}): ` + JSON.stringify(j));
}

/* ── 本地文件存档（无 KV 权限时的主路径）── */
function 读本地存档() {
  try {
    if (!existsSync(存档文件)) return { ok: true, recs: [] };
    const raw = JSON.parse(readFileSync(存档文件, "utf-8"));
    if (raw && Array.isArray(raw.recs)) return raw;
    if (Array.isArray(raw)) return { ok: true, recs: raw };
    return { ok: true, recs: [] };
  } catch (e) {
    return { ok: true, recs: [] };
  }
}
function 写本地存档(recs) {
  const 包 = {
    ok: true,
    updated: new Date().toLocaleString("sv-SE").replace("T", " "),
    count: recs.length,
    recs,
  };
  writeFileSync(存档文件, JSON.stringify(包, null, 2), "utf-8");
  return 包;
}

/* 取「最近 N 个交易日」的日期键集合（排除今天），假期/周末跳过不计入。 */
function 近N交易日(N, 今日, 是周末Fn, 是休市日Fn) {
  const 集 = {};
  let 步 = 0, 兜 = 0;
  const d = new Date(String(今日).replace(/-/g, "/") + " 12:00:00");
  if (isNaN(d.getTime())) return 集;
  while (步 < N && 兜++ < 400) {
    d.setDate(d.getDate() - 1);
    const 周 = d.getDay();
    if (周 === 0 || 周 === 6) continue;
    const k = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
    if (是休市日Fn && 是休市日Fn(k)) continue;
    集[k] = 1; 步++;
  }
  return 集;
}

/* 从历史里取「最近 3 个交易日（排除今天）」已推过的股票 code，用于跨期去重。 */
function 组装近3期已推码(历史, 今日, 是周末Fn, 是休市日Fn) {
  const 集 = {};
  const 交易日集 = 近N交易日(3, 今日, 是周末Fn, 是休市日Fn);
  let 池 = (历史 || []).filter((g) => g && g.date && g.date !== 今日);
  const 有交集 = 池.some((g) => 交易日集[g.date]);
  if (有交集) {
    池 = 池.filter((g) => 交易日集[g.date]);
  } else {
    池 = 池.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
  }
  池.forEach((g) => (g.picks || []).forEach((x) => { if (x && x.code) 集[String(x.code)] = 1; }));
  return 集;
}

/* 精简一条存档记录（去掉大字段，保留前端展示所需） */
function 精简期(g) {
  return {
    date: g.date,
    gen_time: g.gen_time || "",
    picks: (g.picks || []).map((x) => ({
      code: x.code, name: x.name, prob: x.prob, score: x.score,
      buy_price: x.buy_price, stop_loss: x.stop_loss, industry: x.industry,
      buy_type: x.buy_type, reasons: x.reasons, tech: x.tech,
      is_main: x.is_main, mode: x.mode,
    })),
  };
}

async function main() {
  const 今日 = 今日键();
  if (是周末() || 是休市日(今日)) {
    console.log(`今日 ${今日} 非交易日，跳过生成（存档保留上一交易日推荐）`);
    return;
  }

  /* 读历史：优先 KV，其次本地文件 */
  let 历史 = null;
  if (有KV凭据) 历史 = await 读KV("astock_recs_history");
  if (!历史) 历史 = 读本地存档().recs;

  const 已推码集 = 组装近3期已推码(历史, 今日, 是周末, 是休市日);
  console.log(`开始生成 ${今日} 稳健版荐股…（近 3 个交易日已推 ${Object.keys(已推码集).length} 只，将排除）`);

  const res = await runStable((p, m) => console.log(`  [${p}%] ${m}`), 已推码集);
  console.log(`引擎完成：date=${res.date} empty=${res.empty} picks=${(res.picks || []).length}`);

  /* 空仓：不写空记录（保留上一交易日），避免前端读到空结果 */
  if (res.empty || !res.picks || !res.picks.length) {
    console.log("⚠️ 本期空仓，存档保持上一交易日不变");
    return;
  }

  const 新期 = 精简期(res);
  const 新历史 = (Array.isArray(历史) ? 历史 : [])
    .filter((g) => g && g.date !== 新期.date)
    .concat([新期])
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-12);

  if (有KV凭据) {
    await 写KV("astock_recs_stable", res);
    await 写KV("astock_recs_history", 新历史);
    console.log(`✅ 已写入 KV：stable + history（共 ${新历史.length} 期）`);
  } else {
    const 包 = 写本地存档(新历史);
    console.log(`✅ 已写入 ${存档文件}：${包.count} 期，最新 date=${新期.date} picks=${新期.picks.length}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
