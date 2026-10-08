// test-stable.js —— 本地实测稳健版引擎 runStable（真实行情，境外 IP）
import { runStable } from "./engine.js";

const t0 = Date.now();
try {
  const res = await runStable((p, m) => console.log(`  [${p}%] ${m}`));
  console.log("\n===== runStable 结果 =====");
  console.log("ok:", res.ok, "empty:", res.empty, "date:", res.date, "mode:", res.mode);
  console.log("温度:", res.temperature && res.temperature.temp, "主线数:", (res.main_lines || []).length);
  console.log("picks:", res.picks.length);
  if (res.picks.length) {
    console.log("\n--- 前 3 只 ---");
    res.picks.slice(0, 3).forEach((x, i) => {
      console.log(`${i + 1}. ${x.name}(${x.code}) score=${x.score} 置信=${x.prob} 行业=${x.industry} 买点=${x.buy_type} 买价=${x.buy_price} 止损=${x.stop_loss}`);
      console.log("   reasons:", x.reasons && x.reasons.fund);
    });
  } else {
    console.log("空仓原因:", res.空仓原因);
  }
  // 契约字段自检
  const 契约 = ["date", "gen_time", "picks"].every((k) => k in res);
  const pick字段 = res.picks.every((x) => "code" in x && "name" in x && "prob" in x && "score" in x);
  console.log("\n契约字段完整:", 契约, "| pick字段完整:", pick字段, "| 耗时(s):", Math.round((Date.now() - t0) / 100) / 10);
} catch (e) {
  console.error("❌ 引擎失败:", e);
  process.exit(1);
}
