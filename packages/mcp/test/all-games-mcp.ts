/**
 * 六款游戏 MCP 打通冒烟：确认「大厅里能开桌的每一款」，MCP 侧都能开桌、入座、读观测、拿到规则资源。
 *
 * 覆盖：
 * 1. 资源列表含 6 个 playground://games/<id>/rules；
 * 2. create_room 对每一款都成功（不再有 wip）；
 * 3. 双方入座后 get_state 的 gameId / legalActions / textView 都正常；
 * 4. 动作形状能被 MCP 的 cell 快捷方式或 actionJson 正确提交一次（不追求打完）。
 * 5. 席位鉴权（第 12 轮）：每款都要「建桌拿 0 号位令牌 → 入座拿各自令牌 → 带令牌读观测/行动」。
 *
 * 运行：pnpm -C packages/mcp exec tsx test/all-games-mcp.ts
 * 需要后端在 PLAYGROUND_URL（默认 http://127.0.0.1:8787）运行。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, rulesResourceUri } from '../src/index.ts';
import { getBaseUrl, joinRoom, listGames, submitAction } from '../src/client.ts';

function assert(cond: unknown, msg: string, detail?: unknown): asserts cond {
  if (!cond) {
    const extra = detail === undefined ? '' : `\n  详情: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    throw new Error(`断言失败：${msg}${extra}`);
  }
}

function structOf(result: any): any {
  return result?.structuredContent ?? {};
}

function textOf(result: any): string {
  const first = result?.content?.[0];
  return first && first.type === 'text' ? String(first.text) : '';
}

/** 席位令牌格式：32 位十六进制。 */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

/** 每款游戏「打开局面的第一个合法动作」（含形状）。 */
const FIRST_ACTION: Record<string, (legal: any[]) => Record<string, unknown>> = {
  grab: (legal) => ({ action: 'grab', cell: legal[0].cell }),
  connect4: (legal) => ({ action: 'drop', column: legal[0].column }),
  yacht: () => ({ action: 'roll' }),
  'rps-duel': () => ({ action: 'throw', shape: 'rock' }),
  battleship: (legal) => ({ action: 'fire', cell: legal[0].cell }),
  reversi: (legal) => ({ action: 'place', cell: legal[0].cell }),
};

async function main(): Promise<void> {
  console.log(`🎪 六款游戏 MCP 打通冒烟 · 服务端 ${getBaseUrl()}`);

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'all-games-smoke', version: '0.0.1' });
  await client.connect(clientTransport);

  // 1. 服务端与 MCP 的资源列表都要覆盖 6 款
  const games = await listGames();
  const playable = games.filter((g) => g.status === 'playable');
  assert(playable.length === 6, `应有 6 款可玩，实际 ${playable.length}`);
  const resources = await client.listResources();
  for (const game of playable) {
    const uri = rulesResourceUri(game.id);
    assert(
      resources.resources.some((r: any) => r.uri === uri),
      `资源列表缺少 ${uri}`,
    );
  }
  console.log(`✅ 资源：6 款规则资源齐全（${playable.map((g) => g.id).join(' / ')}）`);

  // 2. 逐款开桌 → 入座 → 观测 → 提交第一个合法动作
  for (const game of playable) {
    const created = await client.callTool({
      name: 'playground_create_room',
      arguments: { gameId: game.id },
    });
    const room = structOf(created);
    assert(typeof room.roomId === 'string', `${game.id} 应能建桌`);
    assert(room.gameId === game.id, `${game.id} 房间 gameId 应一致`);
    assert(String(textOf(created)).includes(game.name), `${game.id} 建桌文案应带游戏名`);

    const joined = await client.callTool({
      name: 'playground_join_room',
      arguments: { roomId: room.roomId, seat: 1 },
    });
    assert(
      structOf(joined).ok === true || String(textOf(joined)).length > 0,
      `${game.id} Agent 入座应成功`,
    );
    assert(isToken(structOf(joined).token), `${game.id} Agent 入座应拿到 1 号位令牌`);
    assert(isToken(room.seatTokens?.['0']), `${game.id} 建桌应预发 0 号位令牌`);
    const human = await joinRoom(room.roomId, 0);
    assert(human.status === 'playing', `${game.id} 双方入座后应为 playing`);
    assert(isToken(human.token), `${game.id} 人类入座应拿到 0 号位令牌`);
    assert(
      human.token === room.seatTokens['0'],
      `${game.id} 人类令牌应与建桌预发的一致`,
    );

    const stateRes = await client.callTool({
      name: 'playground_get_state',
      arguments: { roomId: room.roomId, seat: 0 },
    });
    const obs = structOf(stateRes).observation ?? {};
    assert(obs.gameId === game.id, `${game.id} 观测 gameId 应一致`, obs.gameId);
    assert(obs.seat === 0, `${game.id} 带令牌观测的 seat 应为 0`, obs.seat);
    assert(obs.spectator !== true, `${game.id} 带令牌观测不应是旁观视图`);
    assert(
      Array.isArray(obs.legalActions) && obs.legalActions.length > 0,
      `${game.id} 开局应有合法动作`,
    );
    assert(typeof obs.textView === 'string' && obs.textView.length > 0, `${game.id} 应有 textView`);

    // 座位 0 是当前行动方 / 同时暗选可提交
    const action = FIRST_ACTION[game.id](obs.legalActions);
    assert(action, `${game.id} 应有首个动作构造器`);
    const submitted = await submitAction(room.roomId, 0, action as any);
    assert(submitted.ok, `${game.id} 首个动作应被接受：${JSON.stringify(action)}`);
    console.log(
      `✅ ${game.id}（${game.name}）：建桌 → 入座 → 观测 → 首个动作 ${JSON.stringify(action)}`,
    );
  }

  await client.close();
  console.log('\n🎉 六款游戏 MCP 打通冒烟全部通过');
}

main().catch((err: unknown) => {
  console.error('\n❌ 六款游戏 MCP 冒烟失败：');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
