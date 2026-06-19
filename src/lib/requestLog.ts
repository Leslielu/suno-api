import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import yn from 'yn';
import pino from 'pino';
import { REQUESTS_ROOT, todayStr, hhmmss, safeStringify } from '@/lib/diagnostics';

// 每次请求的原始记录:method/url/headers/body + 可直接复制的 curl。
// 设计原则:wrapper 用 finally 保证落盘,用 catch 重抛 —— 绝不接管响应生成,
// route 既有 catch / corsHeaders / AllAccountsExhausted 等分支全部原样保留。

const logger = pino();

type Handler = (req: NextRequest) => Promise<Response | NextResponse>;

const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
const AUTH_HEADERS = new Set(['cookie', 'authorization', 'x-api-key']);

/** 高阶包装:记录原始请求 + 生成 curl,handler 抛错也照常记录后重抛。 */
export function withRequestLog(routeName: string, handler: Handler): Handler {
  return async (req: NextRequest) => {
    const start = Date.now();

    // clone 后从 clone 读 body —— 原 req 的 body 流未被消费,handler 内 req.json() 正常
    let recordedBody: any = undefined;
    try {
      recordedBody = await req.clone().json();
    } catch {
      try { recordedBody = await req.clone().text(); } catch {}
    }

    let status = 0;
    try {
      const resp = await handler(req);
      status = resp.status;
      return resp;
    } catch (err: any) {
      status = err?.response?.status || 500;
      throw err; // 不接管,交回 route 自己的 catch
    } finally {
      const durationMs = Date.now() - start;
      recordRequest({ routeName, req, body: recordedBody, status, durationMs }).catch((e) =>
        logger.warn({ err: (e as Error).message, route: routeName }, 'requestLog: write failed'),
      );
    }
  };
}

async function recordRequest(args: {
  routeName: string;
  req: NextRequest;
  body: any;
  status: number;
  durationMs: number;
}) {
  const { routeName, req, body, status, durationMs } = args;

  // 白名单(留空 = 记录所有被包的 route)
  const allow = process.env.LOG_REQUEST_ROUTES;
  if (allow && allow.trim()) {
    const set = new Set(allow.split(',').map((s) => s.trim()).filter(Boolean));
    if (!set.has(routeName)) return;
  }

  const url = new URL(req.url);
  const headersObj: Record<string, string> = {};
  req.headers.forEach((v, k) => { headersObj[k] = v; });

  const logAuth = yn(process.env.LOG_REQUEST_AUTH, { default: false });
  const masked = maskHeaders(headersObj, logAuth);
  const curl = buildCurl(req.method, url, masked, body, logAuth);

  const record = {
    ts: new Date().toISOString(),
    route: routeName,
    method: req.method,
    url: req.url,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: masked,
    body,
    status,
    durationMs,
    curl,
    note: logAuth ? undefined : 'auth headers redacted; set LOG_REQUEST_AUTH=true to include',
  };

  const dir = path.join(REQUESTS_ROOT, todayStr());
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${hhmmss()}_${routeName}_${status}.json`);
  await fs.writeFile(file, safeStringify(record));
}

function maskHeaders(h: Record<string, string>, logAuth: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (SKIP_HEADERS.has(lk)) continue;
    if (!logAuth && AUTH_HEADERS.has(lk)) {
      out[k] = v ? `<redacted len=${v.length}>` : '';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 生成可直接复制运行的 curl。脱敏 header 跳过(避免日志里留可复用凭证)。 */
function buildCurl(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: any,
  logAuth: boolean,
): string {
  const parts = [`curl -X ${method}`];
  for (const [k, v] of Object.entries(headers)) {
    if (!logAuth && AUTH_HEADERS.has(k.toLowerCase())) continue; // 脱敏的不进 curl
    parts.push(`-H ${shq(`${k}: ${v}`)}`);
  }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`--data ${shq(data)}`);
  }
  parts.push(shq(url.toString()));
  return parts.join(' \\\n  ');
}

/** POSIX 单引号转义:val 中的 ' -> '"'"' */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}
