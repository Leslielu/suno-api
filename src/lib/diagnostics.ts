import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'rebrowser-playwright-core';
import pino from 'pino';

// 失败诊断 / 请求记录的可观测性工具。
// 设计原则:所有 dump 函数内部全 try/catch —— 诊断本身的任何失败
// 都不得掩盖或干扰被诊断的原始错误。pm2 cwd = 项目根,相对路径可靠。

const logger = pino();

const ROOT = process.cwd();
export const DIAGNOSTICS_ROOT = path.join(ROOT, 'diagnostics');
export const REQUESTS_ROOT = path.join(ROOT, 'requests');

// ---------- 共享 helpers ----------

export function todayStr(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, 与 meta.ts 一致)
}

export function hhmmss(d = new Date()): string {
  return d.toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
}

function errName(err: unknown): string {
  const e = err as any;
  if (e?.name && e.name !== 'Error') return e.name;
  if (e?.code) return String(e.code);
  if (e?.response?.status) return `HTTP_${e.response.status}`;
  return 'Error';
}

function sanitize(s: string, max = 60): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, max);
}

function stampName(step: string, errType: string, d = new Date()): string {
  return `${hhmmss(d)}_${sanitize(step)}_${sanitize(errType)}`;
}

function getCircularReplacer() {
  const seen = new WeakSet();
  return (_k: string, v: any) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  };
}

/** JSON 序列化,容忍循环引用 + 超大 body 截断。永不抛错。 */
export function safeStringify(obj: unknown, limit = 65536): string {
  try {
    const s = JSON.stringify(obj, getCircularReplacer(), 2);
    if (s.length > limit) {
      return s.slice(0, limit) + `\n...__truncated(${s.length - limit} more bytes)`;
    }
    return s;
  } catch (e) {
    return `<unserializable: ${(e as Error).message}>`;
  }
}

/**
 * 账号指纹:从完整 cookie 字符串或 `__client=u_xxx` 取值,sha1 前 8 位。
 * 不落明文 cookie / __client。
 */
export function accountTag(cookieOrClient?: string): string {
  let client = (cookieOrClient || '').trim();
  const m = client.match(/__client=([^;]+)/);
  if (m) client = m[1];
  if (!client) return 'unknown';
  return createHash('sha1').update(client).digest('hex').slice(0, 8);
}

// ---------- 浏览器控制台收集 ----------

export interface ConsoleCollector {
  stop: () => string[];
}

/** 早挂在 page 上,收集 console / pageerror。stop() 解绑并返回已收集行。 */
export function attachConsoleCollector(page: Page): ConsoleCollector {
  const lines: string[] = [];
  const onConsole = (msg: any) => {
    try { lines.push(`[${msg.type()}] ${msg.text()}`); } catch {}
  };
  const onPageError = (err: Error) => {
    try { lines.push(`[pageerror] ${err.message}`); } catch {}
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  return {
    stop: () => {
      try { page.off('console', onConsole); } catch {}
      try { page.off('pageerror', onPageError); } catch {}
      return lines;
    },
  };
}

// ---------- 浏览器失败落盘 ----------

export interface BrowserDiagCtx {
  page?: Page | null;
  account?: string;
  step: string; // 'goto' | 'waitForProject' | 'textarea' | 'solveLoop' | 'waitForToken'
  consoleLines?: string[];
}

/** 截屏 + DOM + console + meta 落到 diagnostics/<date>/<HHMMSS>_<step>_<errType>/。 */
export async function dumpBrowserFailure(err: unknown, ctx: BrowserDiagCtx): Promise<string> {
  const dir = path.join(DIAGNOSTICS_ROOT, todayStr(), stampName(ctx.step, errName(err)));
  await fs.mkdir(dir, { recursive: true });

  let url: string | null = null;
  if (ctx.page) {
    try { url = ctx.page.url(); } catch {}
  }

  const meta: any = {
    ts: new Date().toISOString(),
    kind: 'browser',
    step: ctx.step,
    account: ctx.account ?? 'unknown',
    url,
    errorType: errName(err),
    errorMessage: (err as any)?.message ?? String(err),
    errorStack: (err as any)?.stack,
  };

  // 尽力截屏 + DOM —— page 可能已被 close,失败只记到 meta,绝不抛
  if (ctx.page) {
    try {
      await ctx.page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true });
      meta.screenshot = 'screenshot.png';
    } catch (e) {
      meta.screenshotError = (e as Error).message;
    }
    try {
      await fs.writeFile(path.join(dir, 'dom.html'), await ctx.page.content());
      meta.dom = 'dom.html';
    } catch (e) {
      meta.domError = (e as Error).message;
    }
  }
  if (ctx.consoleLines && ctx.consoleLines.length) {
    try { await fs.writeFile(path.join(dir, 'console.log'), ctx.consoleLines.join('\n')); } catch {}
  }
  try { await fs.writeFile(path.join(dir, 'meta.json'), safeStringify(meta)); } catch {}

  logger.error({ dir, step: ctx.step, err: meta.errorMessage }, 'diagnostics: browser failure dumped');
  return dir;
}

// ---------- HTTP 失败落盘 ----------

export interface HttpDiagCtx {
  account?: string;
  step: string; // 'generate_v2_web' | 'captcha_check' ...
  request?: { method?: string; url?: string; headers?: any; data?: any } | null;
}

/** 把 axios 错误的 request/response 原文落到 http.json(含 Suno 返回的 detail)。 */
export async function dumpHttpFailure(err: unknown, ctx: HttpDiagCtx): Promise<string> {
  const dir = path.join(DIAGNOSTICS_ROOT, todayStr(), stampName(ctx.step, errName(err)));
  await fs.mkdir(dir, { recursive: true });

  const ax = err as any;
  const payload: any = {
    ts: new Date().toISOString(),
    kind: 'http',
    step: ctx.step,
    account: ctx.account ?? 'unknown',
    errorType: errName(err),
    message: ax?.message ?? String(err),
    request: ctx.request ?? {
      method: ax?.config?.method,
      url: ax?.config?.url,
      headers: ax?.config?.headers,
      data: safeStringify(ax?.config?.data),
    },
    response: ax?.response
      ? {
          status: ax.response.status,
          statusText: ax.response.statusText,
          headers: ax.response.headers,
          data: safeStringify(ax.response.data), // token_validation_failed 的 detail 落这
        }
      : null,
    hasResponse: !!ax?.response,
    hasRequest: !!ax?.request,
  };

  try { await fs.writeFile(path.join(dir, 'http.json'), safeStringify(payload)); } catch {}
  logger.error({ dir, step: ctx.step, status: payload.response?.status }, 'diagnostics: http failure dumped');
  return dir;
}

// ---------- 过期清理 ----------

/** 按 mtime 删除 diagnostics/ 与 requests/ 下超过 retentionDays 的条目。retentionDays<=0 不清。 */
export async function cleanupDiagnostics(retentionDays: number): Promise<void> {
  if (!(retentionDays > 0)) return;
  const cutoff = Date.now() - retentionDays * 86400_000;
  for (const root of [DIAGNOSTICS_ROOT, REQUESTS_ROOT]) {
    let entries: string[] = [];
    try { entries = await fs.readdir(root); } catch { continue; }
    for (const name of entries) {
      const full = path.join(root, name);
      let st;
      try { st = await fs.stat(full); } catch { continue; }
      if (st.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
