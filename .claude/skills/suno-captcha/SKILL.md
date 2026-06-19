---
name: suno-captcha
description: suno-api 项目的验证码(hCaptcha)排查与修复。当 generate/custom_generate 失败(token_validation_failed 422、getCaptcha 超时、Suno 网页改版导致验证码解题失效、"No hCaptcha request"、选择器超时)时使用。
---

# suno-api 验证码排查与修复

## 架构(2026-06-19 实测确认)

- **验证码类型:hCaptcha**(3×3 选图,提示是"比参考图中水果更重的物品"这类逻辑题)。⚠️ `challenges.cloudflare.com` 的流量是**背景 invisible Turnstile**(会自己销毁),**不是**选图挑战——别被它误导。
- **Suno 把 hCaptcha 代理到自己域名**(不是 `*.hcaptcha.com`):
  - `hcaptcha-endpoint-prod.suno.com` — api.js / checksiteconfig / getcaptcha
  - `hcaptcha-assets-prod.suno.com` — 静态资产 + `hcaptcha.html#frame=challenge`(挑战 iframe,title="hCaptcha挑战")
  - `hcaptcha-imgs-prod.suno.com` — 挑战图片(`/tip/...`)
- **sitekey**:`d65453de-3f1a-4aac-9366-a0f06e52b2ce`(在 challenge iframe 的 src `#sitekey=` 里)
- **信任期 / 冷却期**:账号刚过 captcha 后有信任期(`captchaRequired()=false`,generate 直接成功,token 可为 null);冷却后 `captchaRequired()=true`,必须带有效 hCaptcha token。多账号都会冷却,**换号解决不了问题,必须解 captcha**。

## getCaptcha 现状(已修复方案)

`src/lib/SunoApi.ts` 的 `getCaptcha()`:**直接用 2captcha 的 hcaptcha 接口(token-based)**,不浏览器、不解图片题:

```ts
const res = await this.solver.hcaptcha({
  pageurl: 'https://suno.com/create',
  sitekey: process.env.HCAPTCHA_SITEKEY || 'd65453de-3f1a-4aac-9366-a0f06e52b2ce',
});
return res.data || res.token;   // ~18-35s 拿到 token,塞进 generateSongs 的 payload.token
```

**禁止**恢复"浏览器 + coordinates 解题"方案:coordinates 解"比X更重"逻辑题**慢(实测 235s,3 次全错)+ 不准**,远超挑战 60s 有效期。

## 排查流程(Suno 网页改版 / 再次失败时)

1. **先看 `diagnostics/`**:getCaptcha / generateSongs 失败会自动 dump 到 `diagnostics/<date>/<HHMMSS>_<step>_<errType>/`(screenshot.png + dom.html + console.log + http.json + meta.json)。看最新一个。
2. **看 `requests/`**:每次请求记录在 `requests/<date>/<HHMMSS>_<route>_<status>.json`,含可复制 curl,直接 curl 复现。
3. **确认验证码类型**:`node scripts/capture-suno.mjs`(开浏览器手动操作,抓真实请求)或手动开 suno.com/create 操作,看弹的是 hCaptcha(3×3 选图)还是别的。**别读代码硬猜**。
4. **验证 2captcha 还能不能解**:`node scripts/test-hcaptcha.mjs`(确认 sitekey + 2captcha hcaptcha 接口能 <60s 拿 token)。
5. **sitekey 失效**:去 create 页,challenge iframe 的 src `#sitekey=xxx` 取新值,更新 getCaptcha 的默认 sitekey(或 `.env` 的 `HCAPTCHA_SITEKEY`)。

## 常见症状 → 根因 → 解决

| 症状 | 根因 | 解决 |
|------|------|------|
| `No hCaptcha request occurred within 1 min` | (旧浏览器方案)waitForRequests 正则等 `img*.hcaptcha.com`,但代理到 `hcaptcha-assets-prod.suno.com` | 已改 token-based,不再用 waitForRequests。若恢复浏览器方案,正则要改 `/hcaptcha/i` |
| `token_validation_failed` 422 | generate/v2-web 没带有效 hCaptcha token | 确认 getCaptcha 返回了 token(solver.hcaptcha),generateSongs payload.token 有值 |
| 选择器超时(`.custom-textarea` 等) | Suno 改版 create 页 DOM | token-based 方案不浏览器,不受影响。若恢复浏览器,用 dump 的 dom.html 找新选择器(注意 dpr=2,coordinates 要 /dpr) |
| `solver.turnstile is not a function` | 用错接口/库版本旧 | hCaptcha 用 `solver.hcaptcha({pageurl, sitekey})`,参数是 **pageurl** 不是 url |

## 工具脚本

- `scripts/test-hcaptcha.mjs` — 验证 2captcha hcaptcha 接口(pageurl+sitekey→token,应 <60s)
- `scripts/capture-suno.mjs` — 手动抓包(开浏览器手动生成,抓 generate/v2-web 真实包对比)
- `diagnostics/` `requests/` — 失败现场 + 请求记录(自动落盘,已 gitignore)

## 关键约束

- **从看到挑战到解决 ≤ 60s**(挑战有效期),任何超时的解题方案无意义
- **多账号都会冷却**,换号不解决问题,必须真正解 captcha
- 验证一个修复前先**单测各环节**(waitForRequests 正则 / iframe 选择器 / 2captcha 接口),别直接跑整个 generate 流程(依赖多,一坏全坏难定位)
- cookie 默认脱敏(`LOG_REQUEST_AUTH=false`),diagnostics/requests 已 gitignore
