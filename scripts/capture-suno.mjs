// 一次性诊断脚本：用真实浏览器打开 suno.com，监听网页端实际发出的请求包，
// 与 src/lib/SunoApi.ts 里拼的包对比，定位 token_validation_failed (422) 根因。
// 敏感值(Authorization / cookie / *token* / *jwt*)一律打码，只看结构与长度。
// 模式：手动 —— 打开页面后由你在浏览器里手动生成，脚本只负责抓包。
// 用法: node scripts/capture-suno.mjs
import { chromium } from 'rebrowser-playwright-core';
import * as cookieLib from 'cookie';
import fs from 'fs';

// ---------- 读 .env (不依赖 dotenv) ----------
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

const cookieStr = ((process.env.SUNO_COOKIES || '').split('|||')[0] || process.env.SUNO_COOKIE || '').trim();
if (!cookieStr) { console.error('!! .env 里没找到 SUNO_COOKIE(S)'); process.exit(1); }
const parsed = cookieLib.parse(cookieStr);
console.log('[cookie] 字段数:', Object.keys(parsed).length,
  '| 含 __client:', '__client' in parsed, '| 含 __session:', '__session' in parsed);

// ---------- 打码工具 ----------
function mask(v) {
  v = String(v ?? '');
  if (v.length <= 40) return v;
  return `${v.slice(0, 14)}…<len=${v.length}>`;
}
function maskHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    out[k] = /authorization|cookie|token/i.test(k) ? mask(v) : v;
  }
  return out;
}
function maskPayload(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(maskPayload);
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && /token|jwt|secret|authorization/i.test(k)) out[k] = mask(v);
    else if (typeof v === 'object') out[k] = maskPayload(v);
    else out[k] = v;
  }
  return out;
}
const want = (u) => /auth\.suno\.com|studio-api\.prod\.suno\.com/.test(u);

// ---------- 启动浏览器 ----------
const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: null });
const cookieObjs = Object.entries(parsed).map(([name, value]) => ({
  name, value: String(value), domain: '.suno.com', path: '/', sameSite: 'Lax',
}));
await context.addCookies(cookieObjs);

const clerkVersions = new Set();
const sessionIdCalls = [];
context.on('request', (req) => {
  const u = req.url();
  if (!want(u)) return;
  const cv = (u.match(/_clerk_js_version=([^&]+)/) || [])[1];
  if (cv) clerkVersions.add(cv);
  if (/\/api\/user\/create_session_id/.test(u)) sessionIdCalls.push({ url: u, postData: req.postData() });
});

const page = await context.newPage();
console.log('\n[goto] https://suno.com/create ...');
await page.goto('https://suno.com/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForResponse((r) => /\/api\/(project|feed|billing)/.test(r.url()), { timeout: 30000 });
  console.log('[load] 页面数据接口已响应 → 登录态有效 ✓');
} catch {
  console.log('[load] ⚠ 30s 内没等到 project/feed/billing 接口');
}
await page.waitForTimeout(2000);

console.log('\n网页端真实 _clerk_js_version =', [...clerkVersions].join(', ') || '(还没抓到 auth.suno.com 请求)');

// ---------- 监听 generate/v2-web，等你手动操作 ----------
console.log('\n============================================================');
console.log('👉 现在请在弹出的浏览器窗口里手动创建一首歌');
console.log('   （输入描述/歌词 → 点 Create。遇到 captcha 自己过）');
console.log('   我在后台监听 generate/v2-web，最长等 5 分钟…');
console.log('============================================================\n');

const genReqPromise = page
  .waitForRequest((r) => /\/api\/generate\/v2-web/.test(r.url()), { timeout: 300000 })
  .catch(() => null);
const genRespPromise = page
  .waitForResponse((r) => /\/api\/generate\/v2-web/.test(r.url()), { timeout: 300000 })
  .catch(() => null);

const genReq = await genReqPromise;
if (!genReq) {
  console.log('[gen] 5 分钟内没抓到 generate/v2-web，结束。');
} else {
  console.log('\n========= generate/v2-web 请求（网页端真实包，token 已打码） =========');
  console.log('URL:', genReq.url());
  console.log('请求 headers:', JSON.stringify(maskHeaders(genReq.headers()), null, 2));
  let pd = genReq.postData();
  try {
    console.log('请求 payload 结构:\n', JSON.stringify(maskPayload(JSON.parse(pd)), null, 2));
  } catch {
    console.log('请求 postData(原始):', mask(pd));
  }
  const genResp = await genRespPromise;
  if (genResp) {
    console.log('\n========= generate/v2-web 响应 =========');
    console.log('status:', genResp.status());
    console.log('body:', (await genResp.text()).slice(0, 800));
  }
}

console.log('\ncreate_session_id 调用次数:', sessionIdCalls.length);
for (const c of sessionIdCalls) console.log('  postData:', c.postData);

await page.waitForTimeout(2000);
await browser.close();
console.log('\n[done] 浏览器已关闭。');
