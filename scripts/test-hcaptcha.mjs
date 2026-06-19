// 试 2captcha 的 hcaptcha 接口(token-based)能否在 60s 内拿 token。
import { Solver } from '@2captcha/captcha-solver';
import fs from 'fs';

const envText = fs.readFileSync('.env', 'utf8');
for (const raw of envText.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const k = line.slice(0, eq).trim();
  let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const solver = new Solver(process.env.TWOCAPTCHA_KEY + '');
const SITEKEY = 'd65453de-3f1a-4aac-9366-a0f06e52b2ce';
const URL = 'https://suno.com/create';

console.log('试 solver.hcaptcha(url=' + URL + ', sitekey=' + SITEKEY + ') ...');
const t0 = Date.now();
try {
  const res = await solver.hcaptcha({ pageurl: URL, sitekey: SITEKEY });
  const tok = res?.data || res?.token || '';
  console.log('✓ 成功!耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's, token 长度', tok.length, '| keys:', Object.keys(res || {}));
} catch (e) {
  console.log('✗ 失败(耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's):', e.message);
}
