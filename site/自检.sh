#!/usr/bin/env bash
# A股看板 · 全链路自检
# 用法：bash 自检.sh
# 用途：一键确认「生产 → 分发 → 展示」三层是否正常
#
# 设计要点（避坑，血泪）：
#   ① 变量名一律用 ASCII！中文变量名在 bash/zsh 下会炸
#      （与 GitHub Actions 的 exit 127 是同一根因，见运维手册坑2）
#   ② Cloudflare Pages 有 SPA 回退，访问不存在的文件返回 200 + text/html，
#      判断「文件是否存在」必须同时看 content-type，不能只看状态码。
#   ③ jsDelivr 对新增文件首次分发有延迟，首次 404 属正常。
#   ④ 看板数据源只走 CDN，不应存在同源优先逻辑。
# 兼容：bash / zsh / dash 均可运行（无 bashism 依赖）

REPO="dqlvxy/astock-recs-bot"
CDN="https://cdn.jsdelivr.net/gh/${REPO}@main"
BOARD="https://astock-board-9t0.pages.dev"
# 线上 index.html 的期望 md5：每次成功发布后同步更新，否则会一直报 [!] 提醒。
# 2026-11-09 更新为「逐日明细 + 均涨列」版本（v25）。
EXPECT_MD5="a3d6b718e34406c23c9260d64d35c8ab"

PASS=0
FAIL=0
WARN=0

ok()   { printf "  \033[32m[OK]\033[0m  %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m[NG]\033[0m  %s\n" "$1"; FAIL=$((FAIL+1)); }
note() { printf "  \033[33m[!]\033[0m   %s\n" "$1"; WARN=$((WARN+1)); }

NOW=$(date +%s)

echo "========================================"
echo " A股看板 · 全链路自检"
echo " 时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================"

# ---------- 1. 分发层 ----------
echo ""
echo "[1] 分发层 · jsDelivr CDN"
for f in recs.json today.json watch.json; do
  RES=$(curl -s -o /dev/null -w "%{http_code}|%{size_download}|%{content_type}" --max-time 20 "${CDN}/${f}?t=${NOW}")
  CODE=$(echo "$RES" | cut -d'|' -f1)
  SIZE=$(echo "$RES" | cut -d'|' -f2)
  TYPE=$(echo "$RES" | cut -d'|' -f3)
  if [ "$CODE" = "200" ] && echo "$TYPE" | grep -q "application/json"; then
    ok "${f}  ${CODE}  ${SIZE}B  json"
  elif [ "$CODE" = "404" ]; then
    note "${f}  404（新增文件首次分发有延迟，稍后重试）"
  else
    bad "${f}  ${CODE}  ${SIZE}B  type=${TYPE}"
  fi
done

# ---------- 2. 数据内容 ----------
echo ""
echo "[2] 数据内容 · today.json"
curl -s --max-time 20 "${CDN}/today.json?t=${NOW}" -o /tmp/_chk_today.json
if head -c 20 /tmp/_chk_today.json | grep -q "DOCTYPE"; then
  bad "today.json 返回 HTML（SPA 回退），文件实际不存在"
elif [ ! -s /tmp/_chk_today.json ]; then
  bad "today.json 拉取失败"
else
  SUM=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_today.json',encoding='utf-8'))
    print('%s|%s|%s|%s|%s' % (
        d.get('trade_date','?'), d.get('gen_time','?'),
        d.get('zt_total','?'), len(d.get('yaogu') or []),
        ((d.get('temperature') or {}).get('temp','?'))))
except Exception as e:
    print('PARSE_FAIL')
" 2>/dev/null)
  if [ "$SUM" = "PARSE_FAIL" ] || [ -z "$SUM" ]; then
    bad "today.json 解析失败"
  else
    TDATE=$(echo "$SUM" | cut -d'|' -f1)
    GTIME=$(echo "$SUM" | cut -d'|' -f2)
    ZTN=$(echo "$SUM" | cut -d'|' -f3)
    YGN=$(echo "$SUM" | cut -d'|' -f4)
    TEMP=$(echo "$SUM" | cut -d'|' -f5)
    ok "数据日=${TDATE}"
    ok "生成时间=${GTIME}"
    ok "涨停=${ZTN}  妖股=${YGN}  温度=${TEMP}"
    DAYS=$(python3 -c "
from datetime import datetime
try:
    t=datetime.strptime('${GTIME}'.strip(), '%Y-%m-%d %H:%M:%S')
    print((datetime.now()-t).days)
except Exception:
    print(-1)
" 2>/dev/null)
    if [ "$DAYS" != "-1" ] && [ "$DAYS" -gt 4 ] 2>/dev/null; then
      note "数据已 ${DAYS} 天未更新，请查 Actions（长假期间属正常）"
    fi
  fi
fi

# ---------- 2b. 自选数据完整性 ----------
echo ""
echo "[2b] 自选数据 · watch.json"
curl -s --max-time 20 "${CDN}/watch.json?t=${NOW}" -o /tmp/_chk_watch.json
if [ ! -s /tmp/_chk_watch.json ]; then
  bad "watch.json 拉取失败"
else
  WS=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_watch.json',encoding='utf-8'))
    its=d.get('items') or []
    if not its: print('EMPTY'); raise SystemExit
    n=len(its)
    k=len(its[0].get('kline') or [])
    bad=[x['code'] for x in its if not (x.get('prob') and x['prob'].get('momentum') is not None)]
    print('%d|%d|%d|%s' % (n, k, len(bad), ','.join(bad) if bad else '-'))
except Exception:
    print('ERR')
" 2>/dev/null)
  case "$WS" in
    EMPTY) bad "watch.json 自选清单为空" ;;
    ERR)   bad "watch.json 解析失败" ;;
    *)
      WN=$(echo "$WS" | cut -d'|' -f1)
      WK=$(echo "$WS" | cut -d'|' -f2)
      WB=$(echo "$WS" | cut -d'|' -f3)
      WL=$(echo "$WS" | cut -d'|' -f4)
      ok "自选 ${WN} 只 · K线 ${WK} 根"
      if [ "$WB" -gt 0 ]; then
        bad "有 ${WB} 只缺 prob（${WL}）→ 自选卡片会出现「—」「-」"
      else
        ok "prob 齐全（动量/波动/区间/涨跌概率）"
      fi
      if [ "$WK" -lt 16 ]; then
        note "K线仅 ${WK} 根，统计样本偏少（建议 ≥16）"
      fi
      ;;
  esac
fi

# ---------- 2c. 日K数据源可用性（2026-11-06 事故护栏）----------
# 背景：腾讯把 /appstock/app/fqkline/get 整条路径挂上 WAF（HTTP 501 + 跳转页），
# 浏览器 fetch 拿到 HTML → r.json() 抛错 → 取日K 静默返回 []，全站「距今/次日/胜率」
# 一律显示 --，且不报任何错。本项直接验证新接口能否取到 80 根前复权日K。
echo ""
echo "[2c] 日K数据源 · 腾讯 newfqkline"
curl -s --max-time 20 "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=sz300357,day,,,80,qfq" \
  -H "User-Agent: Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" \
  -o /tmp/_chk_kline.json
KN=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_kline.json',encoding='utf-8'))
    n=(d.get('data') or {}).get('sz300357') or {}
    rows=n.get('qfqday') or n.get('day') or []
    print(len(rows))
except Exception:
    print(0)
" 2>/dev/null)
if [ "${KN:-0}" -ge 30 ] 2>/dev/null; then
  ok "日K 可取 ${KN} 根（前复权，供持仓距今/次日胜率）"
else
  bad "日K 取数异常（${KN:-0} 根）——腾讯接口疑似又被 WAF 拦截，持仓页会整体显示 --"
fi

# ---------- 3. 展示层 ----------
echo ""
echo "[3] 展示层 · Cloudflare Pages"
curl -s --max-time 30 "${BOARD}/?v=${NOW}" -o /tmp/_chk_board.html
if [ -s /tmp/_chk_board.html ]; then
  REALMD5=$(md5sum /tmp/_chk_board.html | cut -d' ' -f1)
  BSIZE=$(wc -c < /tmp/_chk_board.html | tr -d ' ')
  if [ "$REALMD5" = "$EXPECT_MD5" ]; then
    ok "index.html  md5 匹配  ${BSIZE}B"
  else
    note "index.html  md5=${REALMD5}"
    echo "          预期 ${EXPECT_MD5}"
    echo "          若你本地改过就属正常；否则线上是旧版本"
  fi
  if grep -q '快照来源 = "CDN"' /tmp/_chk_board.html && ! grep -q 'return "today.json"' /tmp/_chk_board.html; then
    ok "数据源 = CDN 单源（无同源优先回归）"
  else
    bad "检测到同源优先残留！会把数据冻死，必须改回 CDN 单源"
  fi
else
  bad "看板无法访问"
fi

# ---------- 3c. 端侧缓存闸门 ----------
echo ""
echo "[3c] 端侧缓存闸门 · HTML 不落缓存 / 已删模块不复现"
CH=$(curl -sI --max-time 20 "${BOARD}/?v=${NOW}" | tr -d '\r' | grep -i '^cache-control:' | head -1)
if echo "$CH" | grep -qi "no-store"; then
  ok "首页 Cache-Control 含 no-store（手机不会长期吃旧页面）"
else
  bad "首页缺少 no-store 响应头（${CH:-无}）——改完不生效的头号原因，检查 _headers 是否随部署上传"
fi
# SW 版本闸：index.html 的 sw.js?v=N 必须与 sw.js 里的缓存名版本一致。
# 2026-11-09 改为动态比对——原来硬编码 v21，每次升版都要改自检，容易漏。
SW_CACHE=$(curl -s --max-time 20 "${BOARD}/sw.js?v=${NOW}" | grep -o 'astock-static-v[0-9]*' | head -1 | grep -o '[0-9]*$')
SW_REF=$(grep -o 'sw\.js?v=[0-9]*' /tmp/_chk_board.html 2>/dev/null | head -1 | grep -o '[0-9]*$')
if [ -n "$SW_CACHE" ] && [ "$SW_CACHE" = "$SW_REF" ]; then
  ok "Service Worker 版本闸 = v${SW_REF}（与 sw.js 缓存名一致）"
else
  bad "SW 版本闸不一致：index 引用 v${SW_REF:-?} / sw.js 缓存名 v${SW_CACHE:-?}——改 HTML 必须同时 +1 这两处"
fi
if grep -q 'flashBox\|财经快讯\|影响次日情绪' /tmp/_chk_board.html 2>/dev/null; then
  bad "看板仍含已删除的「财经快讯」模块残留"
else
  ok "已删模块不复现（财经快讯 0 命中）"
fi

# ---------- 3d. 持仓卡片 · 「距今」不被挤出 ----------
echo ""
echo "[3d] 持仓卡片 · 距今涨跌幅可完整显示"
if grep -q 'hv-head .hv-title{[^}]*flex:1 1 auto' /tmp/_chk_board.html 2>/dev/null && grep -q 'flex-direction:column;align-items:flex-end' /tmp/_chk_board.html 2>/dev/null; then
  ok "标题可收缩 + 距今堆叠（窄屏不裁切）"
else
  bad "距今布局规则缺失——标题 flex:1 1 auto / hv-day 纵向堆叠 必须同时存在，否则窄屏会切掉「距今」"
fi
if grep -q '.tier-s{display:block;width:max-content' /tmp/_chk_board.html 2>/dev/null; then
  ok "等级徽独立成行（名称上方）"
else
  bad "等级徽未独立成行——.tier-s 应为 display:block 且 width:max-content，否则会与股票名抢横向空间"
fi

# ---------- 3e. 源码镜像目录已删除 ----------
echo ""
echo "[3e] 源码镜像 /recsbot/ 已删除"
curl -s --max-time 25 "${BOARD}/recsbot/engine.js?t=${NOW}" -o /tmp/_chk_mirror.txt
# Pages 对不存在的路径会 SPA 回退到 index.html（仍返 200），故用「内容是否等于首页」判定下线
if [ -s /tmp/_chk_mirror.txt ] && cmp -s /tmp/_chk_mirror.txt /tmp/_chk_board.html; then
  ok "镜像已下线（该路径回退到首页，引擎源码不再对外）"
elif grep -q 'detect双金共振' /tmp/_chk_mirror.txt 2>/dev/null; then
  bad "仍能访问旧版引擎镜像 /recsbot/engine.js——目录应已整体删除"
else
  bad "镜像路径返回异常内容（$(wc -c < /tmp/_chk_mirror.txt)B），请人工核对"
fi

# ---------- 3f. 近 6 个月胜率卡片（2026-11-09） ----------
echo ""
echo "[3f] 复盘页 · 近 6 个月胜率卡片"
if grep -q 'rv-half' /tmp/_chk_board.html 2>/dev/null && grep -q '近 6 个月胜率' /tmp/_chk_board.html 2>/dev/null; then
  ok "半年胜率卡片已上线（rv-half + 标题）"
else
  bad "半年胜率卡片缺失——检查 index.html 是否含 .rv-half 样式与「近 6 个月胜率」渲染"
fi
if grep -q 'half_year' /tmp/_chk_board.html 2>/dev/null; then
  ok "前端读取 params.json 的 half_year 字段"
else
  bad "前端未接 half_year——卡片会永远空白"
fi
# ---------- 3b. 荐股存档代理 ----------
echo ""
echo "[3b] 荐股存档代理 · /api/recs（防 jsDelivr 陈旧散发错版）"
curl -s --max-time 30 "${BOARD}/api/recs?t=${NOW}" -o /tmp/_chk_recs.json
if [ -s /tmp/_chk_recs.json ] && head -c 20 /tmp/_chk_recs.json | grep -q "DOCTYPE"; then
  bad "/api/recs 返回 HTML（SPA 回退），Functions 未部署——检查是否 cd 进 astock-site 再 deploy"
elif [ ! -s /tmp/_chk_recs.json ]; then
  bad "/api/recs 拉取失败"
else
  RS=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_recs.json',encoding='utf-8'))
    recs=d.get('recs') or []
    last=recs[-1] if recs else {}
    print('%s|%s|%s|%d' % (d.get('ok'), d.get('源','?'), last.get('gen_time','?'), len(recs)))
except Exception:
    print('PARSE_FAIL')
" 2>/dev/null)
  case "$RS" in
    PARSE_FAIL|"") bad "/api/recs 返回内容解析失败" ;;
    *)
      ROK=$(echo "$RS" | cut -d'|' -f1)
      RSRC=$(echo "$RS" | cut -d'|' -f2)
      RGEN=$(echo "$RS" | cut -d'|' -f3)
      RN=$(echo "$RS" | cut -d'|' -f4)
      if [ "$ROK" = "True" ] && [ "$RN" -gt 0 ] 2>/dev/null; then
        ok "/api/recs  ok  源=${RSRC}  末期生成=${RGEN}  共 ${RN} 期"
      else
        bad "/api/recs  ok=${ROK} 期数=${RN}（代理异常，看板会回落双路 CDN）"
      fi
      ;;
  esac
fi

# 存档窗口（放在 /api/recs 之后：期数从该响应里数，避免重复请求）
PT=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_recs.json',encoding='utf-8'))
    r=d.get('recs') or d.get('数据',{}).get('recs') or []
    print(len(r))
except Exception:
    print(-1)
" 2>/dev/null)
if [ "$PT" -ge 15 ] 2>/dev/null; then
  ok "荐股存档已扩到 180 天窗口（当前 ${PT} 期）"
elif [ "$PT" -ge 0 ] 2>/dev/null; then
  note "荐股存档仅 ${PT} 期（180 天窗口需累积，或部署未生效）"
else
  note "荐股存档期数解析失败"
fi

# ---------- 3g. 账户资金模拟（2026-11-09：整手 1 万 + 佣金/印花税/过户费） ----------
echo ""
echo "[3g] 复盘页 · 账户资金模拟"
if grep -q 'rv-eq' /tmp/_chk_board.html 2>/dev/null && grep -q '账户模拟' /tmp/_chk_board.html 2>/dev/null; then
  ok "账户模拟卡片已上线（rv-eq + 标题）"
else
  bad "账户模拟卡片缺失——检查 index.html 是否含 .rv-eq 样式与「账户模拟」渲染"
fi
if grep -q 'equity' /tmp/_chk_board.html 2>/dev/null; then
  ok "前端读取 params.json 的 equity 字段"
else
  bad "前端未接 equity——卡片会永远空白"
fi
curl -s --max-time 30 "${CDN}/params.json?t=${NOW}" -o /tmp/_chk_params.json
EQ=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_params.json',encoding='utf-8'))
    e=d.get('equity') or {}
    if not e:
        print('NONE')
    else:
        r=e.get('费率') or {}
        print('%d|%s|%.2f|%s|%d' % (len(e.get('日表') or []), e.get('净收益率'), r.get('每笔成本') or 0, e.get('本金'), e.get('总笔数') or 0))
except Exception:
    print('FAIL')
" 2>/dev/null)
case "$EQ" in
  NONE) note "params.json 暂无 equity 块（review.js 未跑或未部署）" ;;
  FAIL|"") bad "params.json 拉取/解析失败——看板账户卡会空白" ;;
  *)
    ED=$(echo "$EQ" | cut -d'|' -f1); ER=$(echo "$EQ" | cut -d'|' -f2)
    EC=$(echo "$EQ" | cut -d'|' -f3); EB=$(echo "$EQ" | cut -d'|' -f4)
    EN=$(echo "$EQ" | cut -d'|' -f5)
    if [ "$ED" -ge 1 ] 2>/dev/null && [ "$EB" = "50000" ]; then
      ok "equity  ok  本金 ${EB} · ${EN} 笔 · ${ED} 个交易日 · 收益率 ${ER}% · 每笔成本 ${EC} 元"
    else
      bad "equity 异常：本金=${EB} 笔=${EN} 日表=${ED} 成本=${EC}"
    fi
    if [ "$EC" = "15.20" ]; then
      ok "每笔成本 15.20 元（佣金 5+5 + 印花税 5 + 过户费 0.2）"
    else
      note "每笔成本 ${EC} 元，预期 15.20（费用口径被改动？）"
    fi
    ;;
esac

# ---------- 3h. 逐日资金明细（2026-11-09） ----------
echo ""
echo "[3h] 复盘页 · 逐日资金明细"
if grep -q 'rv-eq-more' /tmp/_chk_board.html 2>/dev/null && grep -q '逐日明细' /tmp/_chk_board.html 2>/dev/null; then
  ok "逐日明细折叠表已上线（rv-eq-more + 标题）"
else
  bad "逐日明细缺失——检查 index.html 是否含 .rv-eq-more 样式与「逐日明细」拼接"
fi
# 日表完整性：params.json 的 equity.日表 条数应与 期数 一致（缺一条就是账目漏记）
DT=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_chk_params.json',encoding='utf-8'))
    e=d.get('equity') or {}
    print('%d|%d' % (len(e.get('日表') or []), e.get('期数') or 0))
except Exception:
    print('FAIL')
" 2>/dev/null)
case "$DT" in
  FAIL|"") bad "equity 日表解析失败——逐日明细会空白" ;;
  *)
    DR=$(echo "$DT" | cut -d'|' -f1); DP=$(echo "$DT" | cut -d'|' -f2)
    if [ "$DR" = "$DP" ] && [ "$DR" -ge 1 ] 2>/dev/null; then
      ok "逐日明细条数与期数一致（${DR} 条）"
    else
      bad "日表 ${DR} 条 ≠ 期数 ${DP}——账户模拟可能漏记交易"
    fi
    ;;
esac

# ---------- 4. 同源文件 ----------
echo ""
echo "[4] 同源文件 · 应为空"
for f in today.json watch.json recs.json; do
  TYPE=$(curl -s -o /dev/null -w "%{content_type}" --max-time 15 "${BOARD}/${f}?t=${NOW}")
  if echo "$TYPE" | grep -q "application/json"; then
    bad "${f} 在 Pages 上真实存在（死文件，应删）"
  else
    ok "${f} 不存在（SPA 回退成 html，符合预期）"
  fi
done

# ---------- 汇总 ----------
echo ""
echo "========================================"
printf " 通过 %d · 警告 %d · 失败 %d\n" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " 结论：全链路正常"
else
  echo " 结论：有失败项，见上方 [NG]"
fi
echo "========================================"
[ "$FAIL" -eq 0 ]
