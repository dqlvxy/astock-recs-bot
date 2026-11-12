#!/usr/bin/env node
// 七牛云 Kodo 上传脚本：把当日快照上传到七牛桶，作为 GitHub 之外的第二个归档副本
// 环境变量：
//   QINIU_AK       AccessKey
//   QINIU_SK       SecretKey
//   QINIU_BUCKET   桶名（默认 astock-backtest）
//   QINIU_ZONE     区域（默认 huadong 华东）
import qiniu from 'qiniu';
import fs from 'node:fs';

const AK = process.env.QINIU_AK;
const SK = process.env.QINIU_SK;
const BUCKET = process.env.QINIU_BUCKET || 'astock-backtest';
const ZONE = (process.env.QINIU_ZONE || 'huadong').toLowerCase();

if (!AK || !SK) {
  console.log('[SKIP] QINIU_AK / QINIU_SK 未设置，跳过七牛上传');
  process.exit(0);
}

const zoneMap = {
  huadong: qiniu.zone.ZoneHuadong,
  huabei: qiniu.zone.ZoneHuabei,
  huanan: qiniu.zone.ZoneHuanan,
  beimei: qiniu.zone.ZoneBeimei,
  xinjiapo: qiniu.zone.ZoneXinjiapo,
};
const mac = new qiniu.auth.digest.Mac(AK, SK);
const putPolicy = new qiniu.rs.PutPolicy({ scope: BUCKET });
const uploadToken = putPolicy.uploadToken(mac);

const config = new qiniu.conf.Config();
config.zone = zoneMap[ZONE] || qiniu.zone.ZoneHuadong;
const formUploader = new qiniu.form_up.FormUploader(config);
const putExtra = new qiniu.form_up.PutExtra();

const FILES = ['recs.json', 'today.json', 'watch.json'];
let ok = 0, fail = 0;

for (const f of FILES) {
  if (!fs.existsSync(f)) {
    console.log(`[SKIP] ${f} 不存在`);
    continue;
  }
  const size = fs.statSync(f).size;
  // 用日期做 key，保留历史版本：archive/YYYYMMDD/filename
  const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `archive/${TODAY}/${f}`;
  await new Promise((resolve) => {
    formUploader.putFile(uploadToken, key, f, putExtra, (err, body, info) => {
      if (err) {
        console.error(`[FAIL] ${f}:`, err.message || err);
        fail++;
      } else if (info.statusCode === 200) {
        console.log(`[OK] ${f} (${size}B) -> qiniu://${BUCKET}/${key}`);
        ok++;
      } else {
        console.error(`[FAIL] ${f}: HTTP ${info.statusCode}`, body);
        fail++;
      }
      resolve();
    });
  });
}

console.log(`\n七牛归档完成：成功 ${ok}，失败 ${fail}`);
if (fail > 0) process.exit(1);
