/**
 * 服务进程入口（`pnpm serve` / `pnpm -C packages/server start`）。
 *
 * 第 13 轮起负责两件「进程级」的事：
 * 1. 把环境变量翻译成落盘策略（PLAYGROUND_DATA_DIR / PLAYGROUND_PERSIST）；
 * 2. 在进程退出前把脏房间同步刷盘，并且接住 beforeExit 兜底。
 *
 * 为什么 server.ts 必须用**动态** import：它在模块顶层就 `new RoomManager()` 了
 * （房间单例是模块私有，本轮不改 server.ts），而落盘策略必须在单例构造之前配好。
 * 静态 import 会在本文件任何一行语句执行前就把 server.ts 整个求值完，
 * configurePersistence() 就永远太晚——所有房间都会以「不落盘」的方式建起来。
 */

import { persistConfigFromEnv } from './persist.ts';
import { activePersistenceInfo, configurePersistence, flushActiveRooms } from './rooms.ts';

// 先定策略：不落盘时 resolve 出 null（PLAYGROUND_PERSIST=0），一个字节都不会写。
const persistConfig = persistConfigFromEnv();
configurePersistence(persistConfig);

const { startServer } = await import('./server.ts');
startServer();

// 启动日志放在启动横幅前面：此时 RoomManager 已经在 server.ts 顶层构造完、房间也恢复好了，
// 而 listen 回调是异步的，硬等它只会把日志顺序搞得更乱。
const persistence = activePersistenceInfo();
if (persistence !== null) {
  console.log(`  房间持久化：${persistence.file}（${persistence.restored} 间已恢复）`);
} else {
  console.log('  房间持久化：已关闭（PLAYGROUND_PERSIST=0）');
}

let shuttingDown = false;

/**
 * 收到信号时的收尾：同步 flush 一次再退出。
 * 只 flush 不 server.close()——close() 要等所有 WebSocket 断开，Ctrl+C 时会卡住；
 * 而 flushSync 是同步的，写完就能安全退出，正是这里要的顺序保证。
 */
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const wrote = flushActiveRooms();
  if (wrote) console.log(`[persist] ${reason}：房间已落盘`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// beforeExit：事件循环自然空掉（例如外部调用了 server.close()）时的兜底。
// 这里**不能**再调用 process.exit()，否则会打断 Node 自己的收尾流程。
process.on('beforeExit', () => {
  if (flushActiveRooms()) console.log('[persist] beforeExit：房间已落盘');
});
