// dryrun.js —— 策略演练（2026-10-16 新增）
//
// 用途：跑一遍完整选股流程（含全市场扫描 + 日K + 技术面过滤 + 打分），
//   但**不写任何存档文件**（recs.json / KV 一概不动），仅输出——
//   ① hardFilter 各阶段剔除统计（量化「金叉选股 / 死叉排除 / 底顶背离」新规则的影响）
//   ② 最终选股结果（含 buy_type 标注，可见 B4 金叉买 / B5 底背离买 是否命中）
//
// 触发：.github/workflows/dryrun.yml 手动 dispatch（不参与定时，不影响生产链路）
import { runStable, 过滤统计 } from "./engine.js";

const res = await runStable((p, m) => console.log(`  [${p}%] ${m}`), {});

console.log("\n=== 过滤统计（hardFilter 各阶段剔除数）===");
console.log(JSON.stringify(过滤统计.本次, null, 1));

console.log("\n=== 演练选股结果（未写档）===");
console.log(
  JSON.stringify(
    {
      date: res.date,
      empty: !!res.empty,
      空仓原因: res.空仓原因 || null,
      温度: res.temperature == null ? null : res.temperature,
      picks: (res.picks || []).map((p) => ({
        code: p.code, name: p.name, score: p.score, prob: p.prob,
        buy_type: p.buy_type, price: p.buy_price,
      })),
    },
    null,
    1
  )
);
console.log("\n✅ 演练结束（未写任何文件；生产存档由 generate.js 的定时任务负责）");
