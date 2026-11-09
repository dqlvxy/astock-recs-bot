/* 账户模拟不变量校验（2026-11-09）
   用途：每次 review.js 跑完后过一遍，防止「整手取整 / 费用口径 / 资金滚动」被改坏。
   与 *.test.mjs 的区别：那些是纯函数单测，这份是**产出物校验**——直接读 params.json 的 equity 块验账目守恒。
   跑法：node test/账户模拟校验.mjs */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const 根 = dirname(dirname(fileURLToPath(import.meta.url)));
const 参 = JSON.parse(readFileSync(join(根, "params.json"), "utf8"));
const e = 参.equity;

let 错 = 0;
const 断言 = (名, 条件, 附加 = "") => {
  if (条件) console.log("  ✓", 名, 附加);
  else { console.log("  ✗", 名, 附加); 错++; }
};

if (!e || !Array.isArray(e.日表) || !e.日表.length) {
  console.log("✗ params.json 缺 equity 块——review.js 未跑或版本过旧");
  process.exit(1);
}
const 表 = e.日表;

console.log("一、资金守恒");
const Σ净 = 表.reduce((s, t) => s + t.盈亏, 0);
const Σ费 = 表.reduce((s, t) => s + t.费, 0);
const Σ毛 = 表.reduce((s, t) => s + t.毛盈亏, 0);
断言("Σ日净盈亏 = 期末现金 − 本金", Math.abs(Σ净 - (e.期末现金 - e.本金)) < 0.5);
断言("Σ日费用 = 费用合计", Math.abs(Σ费 - e.费用.合计) < 0.5);
断言("Σ净 = Σ毛 − Σ费", Math.abs(Σ净 - (Σ毛 - Σ费)) < 0.5);
断言("净收益率 = (期末/本金−1)×100", Math.abs(e.净收益率 - (e.期末现金 / e.本金 - 1) * 100) < 0.02);

console.log("二、整手与预算约束");
断言("每期买入额 ≤ 只数×1万", 表.every((t) => t.买入额 <= t.只数 * 10000 + 0.01));
断言("每期总股数都是 100 的整数倍", 表.every((t) => t.股数 % 100 === 0));
断言("无空仓期", 表.every((t) => t.只数 > 0));

console.log("三、净值与现金对应");
断言("净值 = 现金/本金", 表.every((t) => Math.abs(t.净值 - t.现金 / e.本金) < 0.0002));
断言("末条现金 = 期末现金", Math.abs(表[表.length - 1].现金 - e.期末现金) < 0.01);

console.log("四、费用口径（佣金 5+5 / 印花税 0.05% / 过户费 0.001%）");
const 期 = 表[0];
const 估算 = 期.只数 * 10 + 期.买入额 * 0.0005 * 1.01 + 期.买入额 * 2 * 0.00001;
断言("单期费用 ≈ 只数×10 + 印花税 + 过户费", Math.abs(期.费 - 估算) / 估算 < 0.02);
断言("每笔成本 = 15.20 元", e.费率.每笔成本 === 15.2, `实际 ${e.费率.每笔成本}`);
断言("佣金合计 = 笔数×10", Math.abs(e.费用.佣金 - e.总笔数 * 10) < 0.01);

console.log("五、资金滚动约束");
let 现 = e.本金, 越界 = 0;
for (const t of 表) { if (t.买入额 > 现 + 0.01) 越界++; 现 = t.现金; }
断言("任何一期买入额未超过期初现金", 越界 === 0, `越界 ${越界} 期`);

console.log(`\n结果：${错 === 0 ? "全部通过" : 错 + " 项失败"}`);
process.exit(错 ? 1 : 0);
