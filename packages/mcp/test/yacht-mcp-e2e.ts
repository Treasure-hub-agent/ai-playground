/**
 * 快艇骰子（yacht）MCP 冒烟：走真实后端 + 真实 MCP 工具。
 *
 * 覆盖任务 task-9 的验收点：
 * 1. create_room(yacht)：先不带 allowWip，失败后按服务端 hint 自动带 allowWip 重试；
 * 2. 资源 playground://games/yacht/rules 返回完整规则；
 * 3. submit_action 的 actionJson 通道跑通 roll / hold（单颗 toggle、多颗被拒）/ score；
 * 4. legalActions 为空时区分：不是你的回合、对局已结束（用四子棋快速终局验证）；
 * 5. phase=must_score 时只能记分，roll/hold 被拒且提示正确；
 * 6. wait_for_turn 在 turn 模式下用 isYourTurn 判定，能等到自己的回合；
 * 7. cell 参数继续服务 grab/connect4，但用于 yacht 时给出 actionJson 指引。
 * 8. 席位鉴权（第 12 轮）：建桌拿 0 号位令牌、入座拿 1 号位令牌，之后读写全部自动透传。
 *
 * 运行：
 *   $env:PLAYGROUND_URL='http://127.0.0.1:8788'; pnpm -C packages/mcp exec tsx test/yacht-mcp-e2e.ts
 * 后端默认 http://127.0.0.1:8787；wip 游戏的建桌重试由 client 自动完成。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  RULES_RESOURCE_URI,
  rulesResourceUri,
} from '../src/index.ts';
import {
  getBaseUrl,
  joinRoom,
  submitAction,
  type GameEvent,
} from '../src/client.ts';

function assert(cond: unknown, msg: string, detail?: unknown): asserts cond {
  if (!cond) {
    const extra = detail === undefined ? '' : `\n  详情: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    throw new Error(`断言失败：${msg}${extra}`);
  }
}

function textOf(result: any): string {
  const first = result?.content?.[0];
  return first && first.type === 'text' ? String(first.text) : '';
}

function structOf(result: any): any {
  return result?.structuredContent ?? {};
}

function obsOf(result: any): any {
  return structOf(result).observation ?? {};
}

function has(obj: any, uri: string): boolean {
  return Array.isArray(obj) && obj.some((r: any) => r.uri === uri);
}

/** 席位令牌格式：32 位十六进制。 */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

async function main(): Promise<void> {
  console.log(`🎲 快艇骰子 MCP 冒烟 · 服务端 ${getBaseUrl()}`);

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'yacht-smoke', version: '0.0.1' });
  await client.connect(clientTransport);

  // ── 0. 工具 / 资源枚举 ────────────────────────────────────────────
  const tools = await client.listTools();
  assert(tools.tools.length === 10, `应有 10 个工具，实际 ${tools.tools.length}`);
  const resources = await client.listResources();
  const yachtRulesUri = rulesResourceUri('yacht');
  console.log(
    `✅ 资源：${resources.resources.map((r) => r.uri).join(', ')}`,
  );
  assert(has(resources.resources, yachtRulesUri), `资源列表缺少 ${yachtRulesUri}`);
  assert(has(resources.resources, RULES_RESOURCE_URI), '资源列表缺少 grab 规则');
  assert(has(resources.resources, rulesResourceUri('connect4')), '资源列表缺少 connect4 规则');

  const yachtRules = await client.readResource({ uri: yachtRulesUri });
  const rulesText = yachtRules.contents.map((c: any) => c.text ?? '').join('\n');
  assert(rulesText.includes('快艇骰子'), 'yacht 规则资源应包含「快艇骰子」');
  assert(rulesText.includes('"action":"hold"'), 'yacht 规则应说明 hold 动作');
  assert(rulesText.includes('"action":"score"'), 'yacht 规则应说明 score 动作');
  console.log(`✅ yacht 规则资源：${rulesText.length} 字符，含 roll / hold / score 说明`);

  // ── 1. list_games 里能看到 yacht（wip 时列在 planned）────────────────
  const games = structOf(await client.callTool({ name: 'playground_list_games', arguments: {} }));
  const yachtListed = [...(games.games ?? []), ...(games.planned ?? [])].some(
    (g: any) => g.id === 'yacht',
  );
  assert(yachtListed, 'list_games 应能看到 yacht（可玩或开发中）');
  console.log(
    `✅ list_games：可玩 ${(games.games ?? []).length} 款，开发中 ${(games.planned ?? []).length} 款（含 yacht）`,
  );

  // ── 2. create_room(yacht)：自动 allowWip 重试 ─────────────────────
  const createdResult = await client.callTool({
    name: 'playground_create_room',
    arguments: { gameId: 'yacht' },
  });
  const created = structOf(createdResult);
  const roomId = created.roomId as string;
  assert(roomId, 'create_room 应返回 roomId');
  assert(String(created.rules).includes('快艇骰子'), 'create_room 应返回 yacht 规则');
  assert(isToken(created.seatTokens?.['0']), '建桌应预发 0 号位（人类）令牌');
  console.log(
    `✅ create_room(yacht)：room=${roomId}，wipBypass=${created.wipBypass === true}` +
      (textOf(createdResult).includes('allowWip') ? '（返回文案已提示 allowWip）' : ''),
  );

  // 人类座位用 REST 占座，避免 UI 等待；双方各自拿自己座位的令牌
  const joinedSeat1 = structOf(
    await client.callTool({ name: 'playground_join_room', arguments: { roomId, seat: 1 } }),
  );
  assert(isToken(joinedSeat1.token), 'Agent 入座应拿到 1 号位令牌');
  const humanJoin = await joinRoom(roomId, 0);
  assert(isToken(humanJoin.token), '人类入座应拿到 0 号位令牌');
  assert(
    humanJoin.token === created.seatTokens['0'],
    '人类入座应沿用建桌预发令牌（否则 humanUrl 里的令牌不可用）',
  );
  console.log('✅ 双方入座：seat1=MCP，seat0=REST，各自持有席位令牌');

  // ── 3. 不是你的回合：legalActions 为空 + 提交被拒文案 ─────────────
  const notTurnState = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(notTurnState.seat === 1 && notTurnState.spectator !== true, '带令牌观测应为座位 1 视图，不是旁观');
  assert(notTurnState.isYourTurn === false, '开局应轮到 seat0（isYourTurn=false）');
  assert(notTurnState.currentSeat === 0, '开局 currentSeat 应为 0');
  assert(notTurnState.legalActions.length === 0, '不是自己回合时 legalActions 应为空');
  const notTurnText = textOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(notTurnText.includes('不是你的回合'), 'get_state 文案应说明不是你的回合');
  console.log(`✅ 非自己回合：isYourTurn=false，legalActions=0，文案含「不是你的回合」`);

  const wrongTurn = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"roll"}' },
  });
  assert(wrongTurn.isError === true, '非自己回合提交应返回 isError');
  assert(structOf(wrongTurn).error === 'not_your_turn', '错误码应为 not_your_turn');
  assert(textOf(wrongTurn).includes('不是你的回合'), '409 文案应说明不是你的回合');
  console.log(`✅ 非自己回合提交被拒：not_your_turn + 可读文案`);

  // ── 4. seat0 用 REST 掷骰 + 记分，把回合交给 seat1 ─────────────────
  const s0roll = await submitAction(roomId, 0, { action: 'roll' });
  assert(
    s0roll.events.some((e: GameEvent) => e.type === 'roll'),
    'seat0 roll 应返回 roll 事件',
  );
  const s0score = await submitAction(roomId, 0, { action: 'score', category: 'chance' });
  assert(
    s0score.events.some((e: GameEvent) => e.type === 'score'),
    'seat0 score 应返回 score 事件',
  );
  console.log('✅ seat0(REST) 完成 roll + score，已换手');

  // ── 5. wait_for_turn：turn 模式应等到自己的回合 ──────────────────
  const waited = structOf(
    await client.callTool({
      name: 'playground_wait_for_turn',
      arguments: { roomId, seat: 1, timeoutSeconds: 5 },
    }),
  );
  assert(waited.ready === true, 'seat1 应等到自己的回合');
  assert(waited.observation?.isYourTurn === true, 'wait 返回观测 isYourTurn 应为 true');
  assert(waited.observation?.phase === 'roll', '新一手 phase 应为 roll');
  assert(
    (waited.observation?.legalActions ?? []).some((a: any) => a.action === 'roll'),
    '轮到 seat1 时 legalActions 应包含 roll',
  );
  console.log(
    `✅ wait_for_turn：ready=${waited.ready}，phase=${waited.observation?.phase}，legal=${waited.observation?.legalActions?.length}`,
  );

  // ── 6. cell 用于 yacht → 明确指引 actionJson ─────────────────────
  const cellMisuse = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, cell: [0, 0] },
  });
  assert(cellMisuse.isError === true, 'yacht 用 cell 应被拒');
  assert(textOf(cellMisuse).includes('快艇骰子不能用 cell'), '应提示 yacht 不支持 cell');
  assert(textOf(cellMisuse).includes('"action":"roll"'), '应给出 actionJson 示例');
  console.log('✅ cell 误用：明确提示改用 actionJson（roll/hold/score）');

  // ── 7. roll（对象形式 actionJson）→ hold（单颗 toggle / 空数组全解锁 / 多颗拒绝）
  const roll1 = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: { action: 'roll' } },
  });
  assert(roll1.isError !== true, `roll 应成功：${textOf(roll1)}`);
  const afterRoll = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(afterRoll.phase === 'choice', 'roll 后 phase 应为 choice');
  assert(afterRoll.dice.length === 5 && afterRoll.dice.every((d: number) => d >= 1 && d <= 6), '骰子应为 5 颗 1-6');
  assert(Object.keys(afterRoll.previewScores ?? {}).length === 13, 'previewScores 应有 13 栏');
  assert(
    (afterRoll.legalActions ?? []).some((a: any) => a.action === 'hold'),
    'choice 阶段 legalActions 应包含 hold',
  );
  assert(String(afterRoll.textView).includes('快艇骰子'), 'textView 应包含游戏名');
  console.log(`✅ roll：dice=[${afterRoll.dice.join(' ')}]，phase=choice，legal=${afterRoll.legalActions.length}，preview=13 栏`);

  const holdOn = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[0]}' },
  });
  assert(holdOn.isError !== true, `hold 应成功：${textOf(holdOn)}`);
  let heldState = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(heldState.held[0] === true, 'hold [0] 后第 0 颗应锁定');

  const holdAllOff = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[]}' },
  });
  assert(holdAllOff.isError !== true, 'hold [] 应成功');
  heldState = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(heldState.held.every((v: boolean) => v === false), 'hold [] 应全部解锁');

  await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[0]}' },
  });
  const holdOff = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[0]}' },
  });
  assert(holdOff.isError !== true, '再次 hold [0] 应成功');
  heldState = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(heldState.held[0] === false, '再次 hold [0] 应解锁');
  console.log('✅ hold：单颗 toggle（锁定 → 解锁）与 indices:[] 全部解锁均生效');

  await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[0]}' },
  });
  const multiHold = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[1,2]}' },
  });
  assert(multiHold.isError === true, '一次 hold 多颗应被服务端拒绝');
  assert(structOf(multiHold).error === 'illegal_action', '多颗 hold 应返回 illegal_action');
  assert(textOf(multiHold).includes('一次只能切一颗'), '多颗 hold 文案应说明一次一颗');
  console.log('✅ hold 多颗被拒：illegal_action + 「一次只能切一颗」提示');

  // ── 8. score：记分并换手到 seat0 ─────────────────────────────────
  const score1 = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"score","category":"chance"}' },
  });
  assert(score1.isError !== true, `score 应成功：${textOf(score1)}`);
  const scoreEvent = structOf(score1).events.find((e: any) => e.type === 'score');
  assert(scoreEvent, 'score 应返回 score 事件');
  assert(scoreEvent.nextSeat === 0, 'seat1 记分后应换手到 seat0');
  console.log(`✅ score：chance 得 ${scoreEvent.gained} 分，nextSeat=${scoreEvent.nextSeat}`);

  const afterScore = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(afterScore.isYourTurn === false, '记分后 seat1 应不再轮到');
  assert(afterScore.legalActions.length === 0, '记分后 legalActions 应为空');
  assert(afterScore.phase === 'roll', '换手后 phase 应重置为 roll');
  console.log('✅ 换手后观测：isYourTurn=false，legalActions=0，phase=roll');

  // 对手回合时 wait_for_turn 应超时而不是误判「轮到你」
  const waitOpponentResult = await client.callTool({
    name: 'playground_wait_for_turn',
    arguments: { roomId, seat: 1, timeoutSeconds: 1 },
  });
  const waitOpponent = structOf(waitOpponentResult);
  assert(waitOpponent.ready === false && waitOpponent.timedOut === true, '对手回合应超时');
  assert(waitOpponent.observation?.isYourTurn === false, '超时观测应仍是 isYourTurn=false');
  const waitOpponentText = textOf(waitOpponentResult);
  assert(waitOpponentText.includes('还没轮到你'), '超时文案应说明还没轮到你');
  console.log('✅ wait_for_turn 对手回合：timedOut=true，文案含「还没轮到你」');

  // seat0 再打一手，把回合交回 seat1（换一个还没用过的栏目）
  await submitAction(roomId, 0, { action: 'roll' });
  await submitAction(roomId, 0, { action: 'score', category: 'twos' });
  const backToMe = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(backToMe.isYourTurn === true, 'seat0 记分后应轮回 seat1');
  assert(backToMe.legalActions.length > 0, '轮回 seat1 时 legalActions 应非空');
  console.log('✅ 轮回 seat1：isYourTurn=true，legalActions 恢复');

  // ── 9. phase=must_score：只能记分 ────────────────────────────────
  for (let i = 0; i < 3; i++) {
    const r = await client.callTool({
      name: 'playground_submit_action',
      arguments: { roomId, seat: 1, actionJson: '{"action":"roll"}' },
    });
    assert(r.isError !== true, `第 ${i + 1} 次 roll 应成功：${textOf(r)}`);
  }
  const mustScore = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  assert(mustScore.phase === 'must_score', '掷满 3 次后 phase 应为 must_score');
  assert(mustScore.rollsLeft === 0, 'must_score 时 rollsLeft 应为 0');
  assert(
    mustScore.legalActions.length > 0 &&
      mustScore.legalActions.every((a: any) => a.action === 'score'),
    'must_score 时 legalActions 应只有 score',
  );

  const holdInMustScore = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"hold","indices":[0]}' },
  });
  assert(holdInMustScore.isError === true, 'must_score 时 hold 应被拒');
  assert(textOf(holdInMustScore).includes('must_score'), '文案应提到 phase=must_score');
  assert(textOf(holdInMustScore).includes('只能记分'), '文案应提示只能记分');

  const cellInMustScore = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, cell: [0, 0] },
  });
  assert(cellInMustScore.isError === true, 'must_score 时 cell 应被拒');
  assert(textOf(cellInMustScore).includes('只能记分'), 'must_score + cell 文案应提示只能记分');
  console.log('✅ must_score：legalActions 只剩 score，hold/cell 被拒且提示「只能记分」');

  const score2 = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"score","category":"ones"}' },
  });
  assert(score2.isError !== true, `must_score 下 score 应成功：${textOf(score2)}`);
  const score2Event = structOf(score2).events.find((e: any) => e.type === 'score');
  assert(score2Event?.nextSeat === 0, 'must_score 记分后应换手到 seat0');
  console.log(`✅ must_score 记分：ones 得 ${score2Event.gained} 分，换手到 seat0`);

  // 换手后再抢提交：应命中 not_your_turn / 不是你的回合
  const wrongTurn2 = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, seat: 1, actionJson: '{"action":"roll"}' },
  });
  assert(wrongTurn2.isError === true, '换手后 seat1 提交应被拒');
  assert(textOf(wrongTurn2).includes('不是你的回合'), '换手后文案应说明不是你的回合');
  console.log('✅ 换手后抢行动：被拒 + 「不是你的回合」');

  // ── 10. ended 分支：用四子棋快速打一场终局 ──────────────────────
  const c4 = structOf(
    await client.callTool({ name: 'playground_create_room', arguments: { gameId: 'connect4' } }),
  );
  const c4Room = c4.roomId as string;
  await client.callTool({ name: 'playground_join_room', arguments: { roomId: c4Room, seat: 1 } });
  await joinRoom(c4Room, 0);
  for (let i = 0; i < 4; i++) {
    await submitAction(c4Room, 0, { action: 'drop', column: 0 });
    if (i < 3) {
      await client.callTool({
        name: 'playground_submit_action',
        arguments: { roomId: c4Room, seat: 1, cell: [0, 1] },
      });
    }
  }
  const endedState = obsOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId: c4Room, seat: 1 } }),
  );
  assert(endedState.status === 'ended', '四子棋四连后 status 应为 ended');
  assert(endedState.legalActions.length === 0, '终局后 legalActions 应为空');

  const endedSubmit = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId: c4Room, seat: 1, cell: [0, 0] },
  });
  assert(endedSubmit.isError === true, '终局后提交应被拒');
  assert(textOf(endedSubmit).includes('对局已经结束'), '终局文案应说明对局已结束');
  console.log('✅ ended 分支：legalActions=0，提交提示「对局已经结束」');

  await client.close();
  await server.close();
  console.log('\n🎉 快艇骰子 MCP 冒烟全部通过');
}

main().catch((err: unknown) => {
  console.error('\n❌ 快艇骰子 MCP 冒烟失败：');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
