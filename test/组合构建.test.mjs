/* 组合构建 · 确定性单测（第 5 层三维评分 + 基本面一票否决均删除后）
   运行：node test/组合构建.test.mjs
   覆盖：① 排序以 S 级（双金共振）优先 ② 形态分为加分项之和 ③ 概率落在 55~88
        ④ 基本面不再参与选股（无财务数据 / 亏损票照常保留） ⑤ buy_type 双金优先
        ⑥ 跨期去重与行业分散 ⑦ 双金单期限量 2 只 */
import { buildPicks } from "../engine.js";

let 通过 = 0, 失败 = 0;
function 断言(名, 条件, 备注) {
  if (条件) { 通过++; console.log("  ✅", 名, 备注 ? "｜" + 备注 : ""); }
  else { 失败++; console.log("  ❌", 名, 备注 ? "｜" + 备注 : ""); }
}

function 造Hard(code, name, 额外) {
  return Object.assign({
    p: { code, name, price: 10, chg: 2, vr: 2, turn: 5, fmv: 100, hybk: "制造业" },
    ma5: 10, ma10: 9.8, ma30: 9.5, redDays: 5, h20: 11,
    涨停回调: null, 强势延续: null, 红柱加长: true, 近5涨幅: 3,
    金叉序: 0, 均线金叉序: 0, 底背离: false, 背离: {}, 双金: null, kdj: null, 双金均线替代: false,
  }, 额外 || {});
}

const 双金明细 = { 翻红序: 2, 前绿: 12, 低位值: 18.2, 聚合间距: 4.1, 当前间距: 22.5, K: 42.1, D: 30.5, J: 65.3 };

console.log("一、排序与等级");
{
  const hard = [
    造Hard("600001", "普通甲", { 金叉序: 3 }),
    造Hard("600002", "双金乙", { 双金: 双金明细 }),
    造Hard("600003", "普通丙", {}),
  ];
  const picks = buildPicks(hard, [], {}, 5);
  断言("返回 3 只", picks.length === 3, "实际 " + picks.length);
  断言("S 级（双金）排第一", picks[0].code === "600002", "第一名 " + picks[0].name + " / tier=" + picks[0].tier);
  断言("双金票 buy_type = 双金共振(B7)", picks[0].buy_type === "双金共振(B7)", picks[0].buy_type);
  断言("双金票 tier_name = 最高等级", picks[0].tier_name === "最高等级", picks[0].tier_name);
  断言("共振明细透传", !!picks[0].共振 && picks[0].共振.K === 42.1, JSON.stringify(picks[0].共振));
}

console.log("二、形态分 = 加分项之和（无三维加权）");
{
  const hard = [造Hard("600001", "主线+金叉", { 金叉序: 3 })];
  const picks = buildPicks(hard, ["制造业"], {}, 5);
  /* 主线 +5、MACD 金叉 +2 → 7 */
  断言("主线+金叉 = 7 分", picks[0].score === 7, "实际 " + picks[0].score);
  断言("scores 已置空（三维评分已删）", picks[0].scores === null, JSON.stringify(picks[0].scores));
  断言("scores_detail 无 tech/msg/fund 明细", !picks[0].scores_detail.tech && !picks[0].scores_detail.msg && !picks[0].scores_detail.fund, Object.keys(picks[0].scores_detail).join(","));
  断言("reasons.fund 已置空（不再取财务）", picks[0].reasons.fund === "", JSON.stringify(picks[0].reasons.fund));
}

console.log("三、概率落在 55~88 且随形态分单调");
{
  const a = buildPicks([造Hard("600001", "零加分")], [], {}, 5)[0];
  const b = buildPicks([造Hard("600002", "双金", { 双金: 双金明细 })], [], {}, 5)[0];
  断言("零加分 = 55", a.prob === 55, "实际 " + a.prob);
  断言("双金（+6）= 61.6", b.prob === 61.6, "实际 " + b.prob);
  断言("概率不超 88", [a, b].every((x) => x.prob <= 88));
}

console.log("四、基本面一票否决已删除（财务不参与选股）");
{
  /* 旧版此处应全部剔除；新版只按技术面+量价选，三只都必须保留 */
  const 票 = [
    造Hard("600001", "无财务数据"),
    造Hard("600002", "亏损票", { hybk: "软件" }),
    造Hard("600003", "净利下滑", { hybk: "医药" }),
  ];
  const picks = buildPicks(票, [], {}, 5);
  断言("无财务数据的票保留", picks.some((x) => x.code === "600001"));
  断言("亏损票保留（不再一票否决）", picks.some((x) => x.code === "600002"));
  断言("净利同比为负也保留", picks.some((x) => x.code === "600003"));
  断言("三只全留", picks.length === 3, "实际 " + picks.length);
}

console.log("五、跨期去重与行业分散");
{
  /* 4 只票：剔除 1 只跨期票后仍有 3 只，不触发「不足 3 只则放开跨期」的兜底 */
  const hard = [
    造Hard("600001", "制造业甲", { hybk: "制造业", 金叉序: 3 }),
    造Hard("600002", "制造业乙", { hybk: "制造业" }),
    造Hard("600003", "软件丙", { hybk: "软件" }),
    造Hard("600004", "医药丁", { hybk: "医药" }),
  ];
  const picks = buildPicks(hard, [], { 600001: 1 }, 5);
  断言("跨期已推票被剔除", !picks.some((x) => x.code === "600001"), picks.map((x) => x.code).join(","));
  const 兜底 = buildPicks(hard.slice(0, 3), [], { 600001: 1, 600002: 1 }, 5);
  断言("剔除后不足 3 只 → 放开跨期限制（兜底不空仓）", 兜底.length === 3, "实际 " + 兜底.length);
  const 分散 = buildPicks(hard, [], {}, 1);
  断言("每行业最多 1 只（取 1 只）", 分散.length === 1, "实际 " + 分散.length);
}

console.log("六、双金单期限量 2 只");
{
  const hard = ["600001", "600002", "600003"].map((c, i) =>
    造Hard(c, "双金" + i, { 双金: 双金明细, p: { code: c, name: "双金" + i, price: 10, chg: 2, vr: 2, turn: 5, fmv: 100, hybk: "行业" + i } })
  );
  const picks = buildPicks(hard, [], {}, 5);
  断言("3 只双金只取 2 只", picks.length === 2, "实际 " + picks.length);
  断言("留下的都是 S 级", picks.every((x) => x.tier === "S"));
}

console.log("\n结果：" + 通过 + " 通过 / " + 失败 + " 失败");
process.exit(失败 ? 1 : 0);
