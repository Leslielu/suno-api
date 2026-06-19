// Next.js 启动钩子(Next 14 GA,无需 experimental flag)。
// 仅在 Node runtime 执行:启动时清一次过期诊断/请求,之后每 6h 清一次。

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { cleanupDiagnostics } = await import('./lib/diagnostics');
  const days = Number(process.env.DIAG_RETENTION_DAYS) || 7;
  if (days > 0) {
    cleanupDiagnostics(days).catch(() => {});
    const timer = setInterval(() => cleanupDiagnostics(days).catch(() => {}), 6 * 60 * 60 * 1000);
    timer.unref(); // 不阻止进程退出
  }
}
