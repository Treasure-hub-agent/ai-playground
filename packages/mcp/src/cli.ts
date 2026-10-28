/**
 * CLI 入口：通过 stdio 启动 AI 游乐场 MCP server。
 *
 * 用法：
 *   pnpm -C packages/mcp exec tsx src/cli.ts
 *
 * 也可以被 Claude Code / Codex / DSH 作为 MCP server 子进程拉起。
 * 重要：stdout 是 MCP 协议通道，本文件与依赖库都不得往 stdout 写日志，日志统一走 stderr。
 */

import { getBaseUrl } from './client.ts';
import { startMcpServer } from './index.ts';

console.error('[ai-playground-mcp] 正在通过 stdio 启动…');
console.error(`[ai-playground-mcp] AI 游乐场服务地址：${getBaseUrl()}（用 PLAYGROUND_URL 覆盖）`);
console.error('[ai-playground-mcp] 等待 MCP 客户端请求（stdout 仅用于 MCP 协议）…');

startMcpServer().catch((err: unknown) => {
  console.error('[ai-playground-mcp] ❌ 启动失败：');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
