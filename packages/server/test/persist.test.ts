/**
 * 房间落盘测试（第 13 轮 P1，契约见 docs/design-engineering-round13.md §2）
 *
 * 运行：pnpm -C packages/server test
 *
 * 全部走真实文件系统（os.tmpdir 下的独立临时目录），不 mock fs：
 * 落盘这件事的坑几乎都在「写一半被杀 / 目录不存在 / rename 覆盖」这类真实行为上，
 * 把 fs 换成假的就什么都没验证到。唯一用假时钟的是防抖窗口，避免用例真的 sleep 400ms。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RoomManager, activePersistenceInfo, configurePersistence, flushActiveRooms } from '../src/rooms.ts';
import {
  PERSIST_VERSION,
  PersistScheduler,
  loadRooms,
  persistConfigFromEnv,
  saveRooms,
  toSnapshot,
  type RoomSnapshot,
} from '../src/persist.ts';
import { games } from '@ai-playground/core';

interface TempRoomFile {
  dir: string;
  file: string;
  cleanup: () => void;
}

/** 每个用例一个独立临时目录，避免互相踩文件。 */
function tempRoomFile(): TempRoomFile {
  const dir = mkdtempSync(join(tmpdir(), 'ai-playground-persist-'));
  return {
    dir,
    file: join(dir, 'rooms.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 收集 console.warn。落盘容错的设计要求是「只 warn 不抛」，
 * 光断言不抛只验证了一半，还得确认确实留了线索。
 */
function captureWarn(): { lines: string[]; restore: () => void } {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  return { lines, restore: () => (console.warn = original) };
}

/** 建一桌 grab 并把两个座位都坐满，返回令牌。 */
function openGrabTable(manager: RoomManager) {
  const room = manager.create('grab');
  const token0 = room.seatTokens[0] as string;
  manager.join(room.id, 0, token0);
  const token1 = manager.join(room.id, 1).token;
  return { room, token0, token1 };
}

test('落盘恢复：房间 / 状态 / 比分 / seatTokens / pending 全部一致', () => {
  const { file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file } });
    const { room, token0, token1 } = openGrabTable(manager);

    // 打满两轮（同时暗选：双方各交一次才算一轮），留下真实比分与 history
    manager.submit(room.id, 0, { action: 'grab', cell: [0, 0] }, token0);
    manager.submit(room.id, 1, { action: 'grab', cell: [0, 1] }, token1);
    manager.submit(room.id, 0, { action: 'grab', cell: [0, 2] }, token0);
    manager.submit(room.id, 1, { action: 'grab', cell: [1, 0] }, token1);

    const before = manager.get(room.id)!;
    assert.ok(manager.flushSync(), 'flushSync 应真的写了盘');

    // 用同一个文件新建一个 RoomManager，模拟「进程重启」
    const restarted = new RoomManager({ persist: { file } });
    assert.equal(restarted.size, 1);
    assert.equal(restarted.restoredCount, 1);

    const after = restarted.get(room.id)!;
    assert.equal(after.gameId, 'grab');
    assert.equal(after.seed, before.seed);
    assert.equal(after.status, before.status);
    assert.equal(after.createdAt, before.createdAt);
    // JSON 往返比较：落盘本身就是一次 JSON 序列化，这样能顺带抓出
    // undefined / 函数 / Map 之类会被 JSON 静默丢掉的字段
    assert.deepEqual(after.state, JSON.parse(JSON.stringify(before.state)));
    assert.deepEqual(after.log, JSON.parse(JSON.stringify(before.log)));
    assert.deepEqual(after.occupied, [true, true]);
    assert.deepEqual(after.seatTokens, [token0, token1]);
    assert.deepEqual(after.pending, [null, null]);
    assert.equal(after.result, before.result ?? null);
    assert.equal(after.chatSeq, before.chatSeq);
    // 比分从 state 里恢复出来，不是重新开局
    assert.equal(restarted.summary(room.id).scores[0], (before.state as { scores: { 0: number } }).scores[0]);

    // game 必须是重新挂上的真 GameSpec，不能是 JSON 里的空壳
    assert.equal(after.game, games.grab);
    assert.equal(typeof after.game.observe, 'function');

    // 设计稿 §2：加载时 lastActivity 刷新成 now（否则停机超 TTL 后一重启就被全清）
    assert.ok(after.lastActivity >= before.lastActivity);

    // 令牌原样恢复：拿旧令牌读还是本人视角，而不是旁观
    const observed = restarted.observation(room.id, 0, token0);
    assert.equal(observed.spectator, false);
    assert.equal(observed.seat, 0);
  } finally {
    warns.restore();
    cleanup();
  }
});

test('同时暗选：挂起动作（pending）跨重启恢复后仍能正常结算', () => {
  const { file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file } });
    const { room, token0, token1 } = openGrabTable(manager);
    const half = manager.submit(room.id, 0, { action: 'grab', cell: [2, 2] }, token0);
    assert.equal(half.resolved, false, '只有一方交招，不该结算');
    assert.ok(manager.flushSync());

    const restarted = new RoomManager({ persist: { file } });
    const restored = restarted.get(room.id)!;
    // 这条是「半局重启不丢局面」的核心：挂起的那手必须还在
    assert.deepEqual(restored.pending[0], { action: 'grab', cell: [2, 2] });
    assert.equal(restored.pending[1], null);

    // 用恢复出来的 pending 结算：后交的一方应该拿到 resolved + 事件
    const settled = restarted.submit(room.id, 1, { action: 'grab', cell: [0, 0] }, token1);
    assert.equal(settled.resolved, true);
    assert.ok(settled.events.length > 0);
    assert.deepEqual(restored.pending, [null, null]);

    restarted.flushSync();
  } finally {
    warns.restore();
    cleanup();
  }
});

test('TTL 清扫：被 sweep 清掉的房间重新加载后不再出现', () => {
  const { file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file } });
    const keep = manager.create('connect4');
    const stale = manager.create('connect4');

    // 把 lastActivity 拨回 3 小时前（TTL 是 2 小时）。直接改字段比 sleep 可控，
    // 也避免为了测 TTL 让用例真的等两小时。
    manager.get(stale.id)!.lastActivity = Date.now() - 3 * 60 * 60 * 1000;

    assert.equal(manager.sweep(), 1);
    assert.equal(manager.size, 1);
    assert.ok(manager.flushSync());

    const restarted = new RoomManager({ persist: { file } });
    assert.equal(restarted.size, 1);
    assert.equal(restarted.get(stale.id), undefined, '被清掉的房间不能从磁盘里复活');
    assert.ok(restarted.get(keep.id), '没被清的房间要照常恢复');
  } finally {
    warns.restore();
    cleanup();
  }
});

test('读盘容错：文件不存在静默 / JSON 坏掉 / 顶层不是对象 → 空启动，只 warn 不抛', () => {
  const { dir, file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    // ① 文件不存在 = 首次启动的常态：**必须完全静默**
    //    （以前这里会 warn，导致正常空启动在控制台里长得像出错，已改掉）
    const missing = new RoomManager({ persist: { file: join(dir, 'nested', 'nowhere.json') } });
    assert.equal(missing.size, 0);
    assert.equal(missing.restoredCount, 0);
    assert.equal(
      warns.lines.filter((line) => line.includes('房间文件不存在')).length,
      0,
      `首次启动不该报警告，实际：${JSON.stringify(warns.lines)}`,
    );

    // ② JSON 坏了（写到一半被杀、手改错）——绝不能把进程带崩
    writeFileSync(file, '{"version":1,"rooms":[', 'utf8');
    const broken = new RoomManager({ persist: { file } });
    assert.equal(broken.size, 0);
    assert.equal(broken.restoredCount, 0);
    assert.ok(
      warns.lines.some((line) => line.includes('读取房间文件失败')),
      '坏 JSON 必须留下 warning（这才是真需要人看一眼的情况）',
    );

    // ③ 顶层是数组（合法 JSON，但形状不对）
    writeFileSync(file, '[]', 'utf8');
    const weird = new RoomManager({ persist: { file } });
    assert.equal(weird.size, 0);
  } finally {
    warns.restore();
    cleanup();
  }
});

test('版本不匹配：旧格式整批丢弃，空启动', () => {
  const { file, cleanup } = tempRoomFile();
  // 先造一个真实快照，再把 version 改成未来版本——验证的是「主动忽略」而不是「读不出来」
  const memory = new RoomManager();
  const snapshot = toSnapshot(memory.create('connect4'));
  writeFileSync(
    file,
    JSON.stringify({ version: PERSIST_VERSION + 1, savedAt: Date.now(), rooms: [snapshot] }),
    'utf8',
  );

  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file } });
    assert.equal(manager.size, 0);
    assert.ok(
      warns.lines.some((line) => line.includes('版本不匹配')),
      `应留下版本不匹配的 warning，实际：${JSON.stringify(warns.lines)}`,
    );
  } finally {
    warns.restore();
    cleanup();
  }
});

test('未知 gameId：只丢那一条，其它房间照常恢复', () => {
  const { file, cleanup } = tempRoomFile();
  const memory = new RoomManager();
  const good = toSnapshot(memory.create('connect4'));
  // 手工把一条快照的 gameId 改成不存在的游戏（模拟回滚版本后磁盘上留着新游戏的房间）
  const ghost: RoomSnapshot = { ...good, id: 'ghost-room', gameId: 'no-such-game' };
  saveRooms(file, [good, ghost]);

  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file } });
    assert.equal(manager.size, 1);
    assert.equal(manager.restoredCount, 1);
    assert.ok(manager.get(good.id), '好房间必须还在');
    assert.equal(manager.get('ghost-room'), undefined, '未知游戏必须被丢弃');
    assert.ok(
      warns.lines.some((line) => line.includes('未知游戏')),
      `应留下未知游戏的 warning，实际：${JSON.stringify(warns.lines)}`,
    );
  } finally {
    warns.restore();
    cleanup();
  }
});

test('防抖：注入假时钟，多次打点只排一次定时器、只写一次盘', () => {
  const { file, cleanup } = tempRoomFile();
  const scheduled: { fn: () => void; ms: number }[] = [];
  const snapshot: RoomSnapshot[] = [toSnapshot(new RoomManager().create('connect4'))];

  const scheduler = new PersistScheduler({
    file,
    snapshot: () => snapshot,
    // 假时钟：只记录「谁在什么延时后被安排」，由用例手动推进
    timers: {
      set(fn, ms) {
        scheduled.push({ fn, ms });
        return scheduled.length;
      },
      clear() {
        /* 假时钟不需要真的取消 */
      },
    },
  });

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(scheduled.length, 1, '防抖窗口内的三次打点只能排一次定时器');
  assert.equal(scheduled[0].ms, 400, '默认窗口是 400ms');
  assert.equal(existsSync(file), false, '窗口没到之前不该写盘');

  scheduled[0].fn(); // 时间到
  assert.equal(scheduler.writes, 1);
  assert.equal(scheduler.pending, false);
  assert.equal(existsSync(file), true);

  // 落盘之后再打点要重新排队
  scheduler.schedule();
  assert.equal(scheduled.length, 2);
  scheduler.stop();
  cleanup();
});

test('防抖（真定时器）与文件格式：到期自动落盘，内容是 {version,savedAt,rooms}', async () => {
  const { file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    const manager = new RoomManager({ persist: { file, debounceMs: 20 } });
    manager.create('connect4');
    assert.equal(existsSync(file), false, '防抖窗口内不该有文件');

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(existsSync(file), true, '窗口到期后应自动落盘');

    const payload = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(payload.version, PERSIST_VERSION);
    assert.equal(typeof payload.savedAt, 'number');
    assert.equal(Array.isArray(payload.rooms), true);
    assert.equal(payload.rooms.length, 1);
    // 落盘里绝不能出现 game（GameSpec 带函数，JSON 化之后只剩空壳）
    assert.equal('game' in payload.rooms[0], false);
    // 第 12 轮加的 seatTokens 必须在字段清单里
    assert.equal(Array.isArray(payload.rooms[0].seatTokens), true);
  } finally {
    warns.restore();
    cleanup();
  }
});

test('PLAYGROUND_PERSIST=0：一个字节都不写；PLAYGROUND_DATA_DIR 覆盖默认目录', () => {
  // ① 环境变量解析
  assert.equal(persistConfigFromEnv({ PLAYGROUND_PERSIST: '0' }), null);
  assert.equal(persistConfigFromEnv({ PLAYGROUND_PERSIST: '0', PLAYGROUND_DATA_DIR: '06-tmp/x' }), null);
  assert.equal(persistConfigFromEnv({})!.file, join(resolve('./data'), 'rooms.json'));
  assert.equal(
    persistConfigFromEnv({ PLAYGROUND_DATA_DIR: '06-tmp/persist-test' })!.file,
    join(resolve('06-tmp/persist-test'), 'rooms.json'),
  );

  // ② 即便给了数据目录，PLAYGROUND_PERSIST=0 也必须一个字节都不写
  const dir = mkdtempSync(join(tmpdir(), 'ai-playground-persist-off-'));
  const warns = captureWarn();
  try {
    const manager = new RoomManager({
      persist: persistConfigFromEnv({ PLAYGROUND_PERSIST: '0', PLAYGROUND_DATA_DIR: dir }),
    });
    const { room, token0, token1 } = openGrabTable(manager);
    manager.submit(room.id, 0, { action: 'grab', cell: [0, 0] }, token0);
    manager.submit(room.id, 1, { action: 'grab', cell: [0, 1] }, token1);
    assert.equal(manager.flushSync(), false, '没启用持久化时 flushSync 不该写盘');
    assert.equal(manager.persistenceFile, null);
    assert.equal(manager.restoredCount, 0);
    assert.deepEqual(readdirSync(dir), [], '关闭持久化后目录里不能有任何文件');
  } finally {
    warns.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('六款游戏全量往返：恢复后的 state 逐字段相等，引擎挂上去还能继续跑', () => {
  const { dir, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    for (const gameId of ['grab', 'connect4', 'yacht', 'rps-duel', 'battleship', 'reversi']) {
      const file = join(dir, `${gameId}.json`);
      const manager = new RoomManager({ persist: { file } });
      const room = manager.create(gameId);
      const token0 = room.seatTokens[0] as string;
      manager.join(room.id, 0, token0);
      const token1 = manager.join(room.id, 1).token;

      // 每款游戏各打两步：轮流制只认当前行动方，同时暗选要双方都交
      for (let round = 0; round < 2; round++) {
        const live = manager.get(room.id)!;
        const turnBased = live.game.meta.resolution === 'turn';
        const seats = turnBased ? [live.game.currentSeat?.(live.state) ?? 0] : [0, 1];
        for (const seat of seats) {
          const legal = live.game.legalActions(live.state, seat);
          if (legal.length === 0) continue;
          manager.submit(room.id, seat, legal[0], seat === 0 ? token0 : token1);
        }
      }

      const before = manager.get(room.id)!;
      assert.ok(manager.flushSync(), `${gameId}: 应该写了盘`);

      const restarted = new RoomManager({ persist: { file } });
      const after = restarted.get(room.id);
      assert.ok(after, `${gameId}: 房间应该被恢复`);
      // 严格逐字段比较（不是比 JSON 字符串）：一旦 state 里有 undefined / 函数 /
      // Map 之类被 JSON 静默丢掉的字段，这里会直接失败
      assert.deepEqual(after.state, before.state, `${gameId}: state 往返失真`);
      assert.equal(after.game.meta.id, gameId, `${gameId}: game 必须重新挂上`);
      assert.equal(after.seed, before.seed);

      // 引擎真的能挂在恢复出来的 state 上继续跑
      const observed = restarted.observation(room.id, 0, token0);
      assert.equal(observed.spectator, false, `${gameId}: 令牌应仍有效`);
      assert.equal(typeof observed.textView, 'string');
      assert.doesNotThrow(() => restarted.summary(room.id), `${gameId}: summary 不能炸`);
      const restoredRoom = restarted.get(room.id)!;
      assert.doesNotThrow(
        () => restoredRoom.game.legalActions(restoredRoom.state, 0),
        `${gameId}: legalActions 不能炸`,
      );
    }
  } finally {
    warns.restore();
    cleanup();
  }
});

test('进程级接口：configurePersistence 后无参构造也落盘，flushActiveRooms 供退出时调用', () => {
  const { file, cleanup } = tempRoomFile();
  const warns = captureWarn();
  try {
    // index.ts 的用法就是这个顺序：先配进程级默认，再让 server.ts 顶层的
    // `new RoomManager()`（无参）吃到它，否则所有房间都会以不落盘的方式建起来。
    configurePersistence({ file });
    const manager = new RoomManager();
    assert.equal(manager.persistenceFile, file);
    assert.equal(manager.restoredCount, 0);
    manager.create('connect4');

    // 启动日志要用的信息
    assert.deepEqual(activePersistenceInfo(), { file, restored: 0 });

    // 退出时 index.ts 调用的就是这个：同步 flush
    assert.equal(flushActiveRooms(), true);
    assert.equal(existsSync(file), true);
    assert.equal(loadRooms(file).length, 1);
  } finally {
    // 别把进程级默认值泄漏给后面的用例
    configurePersistence(null);
    warns.restore();
    cleanup();
  }
});

test('原子写：目录不存在时自动创建，写完不留 .tmp，可被覆盖重写', () => {
  const { dir, cleanup } = tempRoomFile();
  try {
    const nested = join(dir, 'deep', 'data', 'rooms.json');
    saveRooms(nested, [toSnapshot(new RoomManager().create('connect4'))]);
    assert.equal(existsSync(nested), true);
    assert.equal(existsSync(`${nested}.tmp`), false, 'rename 之后不能残留临时文件');

    // 再写一次（覆盖已有文件）：rename 覆盖在 Windows 上也必须成立
    saveRooms(nested, []);
    assert.equal(loadRooms(nested).length, 0);
    assert.equal(existsSync(`${nested}.tmp`), false);
    assert.equal(JSON.parse(readFileSync(nested, 'utf8')).rooms.length, 0);
  } finally {
    cleanup();
  }
});
