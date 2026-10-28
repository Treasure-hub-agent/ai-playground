/**
 * 《AI 游乐场》命令行入口
 *
 *   ai-playground              起服务（默认 serve）
 *   ai-playground serve        起服务（REST + WS + 静态托管）
 *   ai-playground mcp          以 stdio 方式启动 MCP server（给 Claude Code / Codex / DSH 接入）
 *   ai-playground --version
 *   ai-playground --help
 *
 * 同一份代码有两种运行形态：
 * - 仓库内开发：`pnpm cli` → tsx 直接跑 `src/index.ts`；
 * - npm 包：`dist/index.js`（esbuild 打成的单文件 ESM，server/core/mcp 全内联）。
 *
 * `src/` 与 `dist/` 都在包根下一层，所以下面一律用 `import.meta.url` 定位包内资源，
 * 不依赖 cwd——用户在哪个目录执行 `npx ai-playground` 都能找到 web/ 与 package.json。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const cmd = (argv[0] ?? 'serve').toLowerCase();

/** 包根目录：src/index.ts 与 dist/index.js 都在包根下一层，取 `..` 即可。 */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 版本号只认 package.json，不写死：以前这里硬编码 "0.1.0 (M0)"，
 * 发版时改了 package.json 忘了改代码，用户看到的版本就是错的。
 */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(PKG_DIR, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // 极端情况下（包被拆散/打包工具裁剪）也别让 --version 崩，给个可辨认的占位即可
    return '0.0.0';
  }
}

const VERSION = readVersion();
/** 包内静态资源目录：由 pack-cli.mjs 把 packages/web/dist 原样复制到这里。 */
const BUNDLED_WEB_DIST = resolve(PKG_DIR, 'web');

const HELP = `AI 游乐场（ai-playground）v${VERSION}

用法：
  ai-playground [serve]        启动服务（默认 127.0.0.1:8787，PORT 可改）
  ai-playground mcp            以 stdio 启动 MCP server（给 Agent 接入）
  ai-playground --version      查看版本
  ai-playground --help         显示本帮助

环境变量：
  PORT                   服务端口（默认 8787）
  HOST                   监听地址（默认 127.0.0.1）
  PLAYGROUND_URL         MCP 侧连接的服务地址（默认 http://127.0.0.1:8787）
  PLAYGROUND_WEB_DIST    覆盖静态目录（默认用包内 web/）
  PLAYGROUND_DATA_DIR    房间落盘目录（默认 ./data）
  PLAYGROUND_PERSIST     设为 0 关闭房间落盘（重启即清空）

示例：
  ai-playground                 # 浏览器打开 http://127.0.0.1:8787 开一桌
  PORT=8899 ai-playground       # 换个端口
  ai-playground mcp             # 把 MCP 配置粘给 Claude Code / Codex / DSH
`;

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(HELP);
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(`ai-playground ${VERSION}`);
  process.exit(0);
}

if (cmd === 'serve' || cmd === 'start' || cmd === 'dev') {
  // server 模块也支持 PLAYGROUND_WEB_DIST，但它是被 bundle 进来的，import.meta.dirname
  // 会落在 dist/ 里，自己算不出包内 web/ 的位置——所以由 CLI 注入绝对路径。
  // 用 ??= 而不是 =：用户显式指定（比如指到自己 build 的 dist）优先。
  process.env.PLAYGROUND_WEB_DIST ??= BUNDLED_WEB_DIST;
  if (!existsSync(process.env.PLAYGROUND_WEB_DIST)) {
    console.warn(`[ai-playground] 警告：静态目录不存在（${process.env.PLAYGROUND_WEB_DIST}），首页会 404，API 仍可用。`);
  }

  // 落盘策略必须在 server.ts 构造 RoomManager **之前**配好——它是模块顶层 `new RoomManager()`，
  // 静态 import 会先把整个模块求值完，配置就永远太晚（详见 packages/server/src/index.ts 的注释）。
  const { persistConfigFromEnv } = await import('@ai-playground/server/persist');
  const { activePersistenceInfo, configurePersistence, flushActiveRooms } = await import('@ai-playground/server/rooms');
  configurePersistence(persistConfigFromEnv());

  const { startServer } = await import('@ai-playground/server/start');
  startServer();

  const persistence = activePersistenceInfo();
  console.log(
    persistence !== null
      ? `  房间持久化：${persistence.file}（${persistence.restored} 间已恢复）`
      : '  房间持久化：已关闭（PLAYGROUND_PERSIST=0）',
  );

  // npx 形态没有 server/src/index.ts 那层入口，信号收尾要在这里补，
  // 否则 Ctrl+C / kill 会丢掉最后 400ms 防抖窗口里的对局进度。
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (flushActiveRooms()) console.log(`[persist] ${reason}：房间已落盘`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('beforeExit', () => {
    if (flushActiveRooms()) console.log('[persist] beforeExit：房间已落盘');
  });
} else if (cmd === 'mcp') {
  const { startMcpServer } = await import('@ai-playground/mcp');
  await startMcpServer();
} else {
  console.error(`未知命令：${cmd}\n`);
  console.error(HELP);
  process.exit(2);
}
