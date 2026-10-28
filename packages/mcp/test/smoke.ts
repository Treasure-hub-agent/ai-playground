/**
 * 冒烟测试：不经过 MCP 协议，直接调用 src/client.ts 的 HTTP 函数跑完一局的核心路径。
 *
 * 第 12 轮（席位鉴权）之后，`seat` 不再代表身份，流程变成：
 *   listGames → createRoom（拿 0 号位令牌，humanUrl 里也带着）
 *   → joinRoom(1)（拿 Agent 令牌）→ joinRoom(0)（预发令牌一致 + 幂等）
 *   → 鉴权探针（无令牌旁观降级 / 令牌隔离 / 无令牌行动 403 / 令牌缺失可读错误）
 *   → getState(1) → submitAction(1) → submitAction(0) → 断言 resolved + reveal
 *   → say → exportLog。
 *
 * 运行：pnpm -C packages/mcp exec tsx test/smoke.ts
 * 需要后端已在 PLAYGROUND_URL（默认 http://127.0.0.1:8787）运行。
 */

import {
  PlaygroundApiError,
  createRoom,
  exportLog,
  getResult,
  getSeatToken,
  getState,
  joinRoom,
  listGames,
  say,
  submitAction,
  getBaseUrl,
  type CreatedRoom,
  type Observation,
  type RevealEvent,
} from '../src/client.ts';

function line(label: string): void {
  console.log(`\n──────── ${label} ────────`);
}

function print(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function sameCell(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

/** 令牌格式：32 位十六进制（docs/design-auth-round12.md §3.1）。 */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

/** 断言某次调用抛 PlaygroundApiError，并核对状态码 / 错误码。 */
async function expectApiError(
  fn: () => Promise<unknown>,
  expected: { status?: number; code?: string },
  what: string,
): Promise<PlaygroundApiError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof PlaygroundApiError, `${what} 应抛 PlaygroundApiError，实际：${String(caught)}`);
  if (expected.status !== undefined) {
    assert(
      caught.status === expected.status,
      `${what} 的 HTTP 状态应为 ${expected.status}，实际 ${caught.status}`,
    );
  }
  if (expected.code !== undefined) {
    assert(
      caught.code === expected.code,
      `${what} 的错误码应为 ${expected.code}，实际 ${caught.code}`,
    );
  }
  return caught;
}

/** 建桌响应的令牌自检：0 号位令牌必须是 32 位 hex，并且写进了 humanUrl 链接。 */
function assertCreateTokens(room: CreatedRoom): string {
  const seat0 = room.seatTokens?.['0'];
  assert(isToken(seat0), 'createRoom 应返回 seatTokens["0"]（32 位十六进制人类令牌）');
  assert(
    room.humanUrlPath.includes(`token=${seat0}`) || room.humanUrl.includes(`token=${seat0}`),
    'humanUrl 应带上人类席位令牌（浏览器零配置入座）',
  );
  assert(
    (room.seatTokens as Record<string, unknown> | undefined)?.['1'] === undefined,
    '建桌时不应该预发 1 号位令牌（Agent 必须自己 join 拿）',
  );
  return seat0;
}

async function main(): Promise<void> {
  console.log(`AI 游乐场 MCP 冒烟测试 · 服务地址 ${getBaseUrl()}`);

  // 1. 游戏列表
  line('1/10 listGames');
  const games = await listGames();
  assert(Array.isArray(games) && games.length > 0, '游戏列表不能为空');
  const grab = games.find((g) => g.id === 'grab');
  assert(grab, '游戏列表里应该有 grab');
  print(games.map((g) => ({ id: g.id, name: g.name, seats: g.seats })));
  assert(grab.rules.includes('抢宝大作战'), 'grab 规则文本应包含标题');

  // 2. 建桌（响应里带 0 号位令牌）
  line('2/10 createRoom(grab) + 席位令牌');
  const room = await createRoom('grab');
  assert(room.roomId && typeof room.roomId === 'string', 'createRoom 应返回 roomId');
  assert(room.humanUrl.includes(`room=${room.roomId}`), 'humanUrl 应包含 roomId');
  assert(room.humanUrl.includes('seat=0'), 'humanUrl 应指向人类座位 seat=0');
  assert(room.agentSeat === 1, 'agentSeat 应为 1');
  assert(typeof room.rules === 'string' && room.rules.length > 0, 'createRoom 应返回规则');
  const humanTokenFromCreate = assertCreateTokens(room);
  print({
    roomId: room.roomId,
    gameId: room.gameId,
    humanUrl: room.humanUrl,
    agentSeat: room.agentSeat,
    seatTokens: room.seatTokens,
  });

  // 3. Agent 入座（seat 1）：响应里必须带 1 号位令牌，客户端自动入库
  line('3/10 joinRoom(seat=1) → 拿 Agent 令牌');
  const joinedAgent = await joinRoom(room.roomId, 1);
  assert(joinedAgent.ok, 'Agent 入座应成功');
  assert(joinedAgent.occupied[1] === true, 'Agent 座位应为已占');
  assert(isToken(joinedAgent.token), 'joinRoom(1) 应返回 1 号位令牌（32 位十六进制）');
  assert(
    getSeatToken(room.roomId, 1) === joinedAgent.token,
    '客户端应把 Agent 令牌存进 roomId → seat 表（后续请求自动附加）',
  );
  print({ status: joinedAgent.status, occupied: joinedAgent.occupied, token: joinedAgent.token });
  assert(joinedAgent.status === 'waiting', '只有 Agent 入座时应为 waiting');

  // 4. 模拟人类入座（seat 0）：令牌应与建桌预发的同一个；重复入座幂等
  line('4/10 joinRoom(seat=0) 模拟人类占座');
  const joinedHuman = await joinRoom(room.roomId, 0);
  assert(joinedHuman.ok, '人类入座应成功');
  assert(joinedHuman.status === 'playing', '双方入座后状态应为 playing');
  assert(joinedHuman.occupied[0] === true && joinedHuman.occupied[1] === true, '两个座位都应为已占');
  assert(isToken(joinedHuman.token), 'joinRoom(0) 应返回人类令牌');
  assert(
    joinedHuman.token === humanTokenFromCreate,
    'join(0) 必须沿用建桌预发的令牌，否则 humanUrl 里那把「入场券」会失效',
  );
  const rejoin = await joinRoom(room.roomId, 0);
  assert(rejoin.status === 'playing', '带令牌重复入座应保持 playing（幂等）');
  assert(rejoin.token === joinedHuman.token, '幂等入座不应更换令牌');
  print({ status: joinedHuman.status, occupied: joinedHuman.occupied, token: joinedHuman.token });

  // 5. 令牌缺失：未入座的座位读观测应抛可读错误（而不是静默给旁观视图）
  line('5/10 令牌缺失 → 可读错误');
  const unused = await createRoom('grab');
  assert(isToken(assertCreateTokens(unused)), '第二间房也应带 0 号位令牌');
  const missing = await expectApiError(
    () => getState(unused.roomId, 1),
    { status: 403, code: 'seat_token_missing' },
    '未入座座位 getState',
  );
  assert(
    missing.message.includes('playground_join_room'),
    '令牌缺失的错误信息应告诉 Agent 去调用 playground_join_room',
  );
  assert(
    missing.message.includes('旁观'),
    '令牌缺失的错误信息应说明「不带令牌只会拿到旁观视图」，避免 Agent 误判成规则问题',
  );
  // 入座之后同一个座位就能正常读（恢复路径）
  await joinRoom(unused.roomId, 1);
  const recovered = await getState(unused.roomId, 1);
  assert(recovered.seat === 1, '入座后观测的 seat 应为 1');
  assert(recovered.spectator !== true, '入座后不应再是旁观视图');
  print({ error: missing.message.split('\n')[0], recoveredSeat: recovered.seat });

  // 6. 鉴权探针：无令牌旁观降级 / 令牌隔离 / 无令牌行动 403
  line('6/10 鉴权探针：旁观降级 / 令牌隔离 / 403');
  const anon = await getState(room.roomId, 1, { spectator: true });
  assert(anon.spectator === true, '无令牌 GET /state 应降级为旁观视图（spectator=true）');
  assert(anon.seat === null, '旁观视图的 seat 应为 null');
  assert(
    Array.isArray(anon.legalActions) && anon.legalActions.length === 0,
    '旁观视图 legalActions 必须为空',
  );

  const crossToken = await getState(room.roomId, 1, { token: humanTokenFromCreate });
  assert(
    crossToken.spectator === true && crossToken.seat === null,
    '令牌按座位隔离：0 号位令牌读 1 号位也只能拿到旁观视图',
  );

  const anonAction = await expectApiError(
    () => submitAction(room.roomId, 1, { action: 'grab', cell: [0, 0] }, { spectator: true }),
    { status: 403, code: 'seat_token_required' },
    '无令牌提交动作',
  );
  assert(
    anonAction.message.includes('playground_join_room'),
    '403 seat_token_required 的错误信息应指引重新入座',
  );
  await expectApiError(
    () => say(room.roomId, 1, '旁观者不能说话', { spectator: true }),
    { status: 403, code: 'seat_token_required' },
    '无令牌 say',
  );
  // 探针不能把本地令牌弄丢：之后的正常读写仍然要成功
  assert(getSeatToken(room.roomId, 1) === joinedAgent.token, '403 不应清掉仍然有效的令牌');
  print({ spectator: anon.spectator, spectatorSeat: anon.seat, crossSeat: crossToken.seat });

  // 7. 读取 Agent 观测（带令牌）
  line('7/10 getState(seat=1)');
  const state: Observation = await getState(room.roomId, 1);
  assert(state.status === 'playing', '观测状态应为 playing');
  assert(state.round === 1, '首回合 round 应为 1');
  assert(state.seat === 1, '带令牌观测的 seat 应为 1');
  assert(state.spectator !== true, '带令牌不应是旁观视图');
  assert(state.youSubmitted === false, '还没提交动作，youSubmitted 应为 false');
  assert(Array.isArray(state.legalActions) && state.legalActions.length > 0, 'legalActions 不能为空');
  print(state.textView);
  print({ legalActions: state.legalActions, yourScore: state.yourScore, opponentScore: state.opponentScore });

  const agentPick = state.legalActions[0];
  assert(agentPick && Array.isArray(agentPick.cell), '第一个合法动作应有 cell');
  const agentCell = agentPick.cell as [number, number];
  const humanPick = state.legalActions.find((a) => !sameCell(a.cell as [number, number], agentCell));
  assert(humanPick && Array.isArray(humanPick.cell), '应能找到一个与 Agent 不同的格子给人类选');
  const humanCell = humanPick.cell as [number, number];

  // 8. Agent 先提交（对手未到，应 resolved=false）
  line('8/10 submitAction(seat=1)');
  const agentSubmit = await submitAction(room.roomId, 1, { action: 'grab', cell: agentCell });
  assert(agentSubmit.ok, 'Agent 提交应成功');
  assert(agentSubmit.resolved === false, '只有一方提交时 resolved 应为 false');
  assert(agentSubmit.events.length === 0, '只有一方提交时不应有事件');
  print({ resolved: agentSubmit.resolved, events: agentSubmit.events });

  // 9. 模拟人类提交不同格 → 服务器立即结算，返回 reveal
  line('9/10 submitAction(seat=0) → 期望立即结算');
  const humanSubmit = await submitAction(room.roomId, 0, { action: 'grab', cell: humanCell });
  assert(humanSubmit.ok, '人类提交应成功');
  assert(humanSubmit.resolved === true, '双方都提交后 resolved 应为 true');
  const reveal = humanSubmit.events.find((e): e is RevealEvent => e.type === 'reveal');
  assert(reveal, '结算后应返回 reveal 事件');
  assert(reveal.round === 1, 'reveal.round 应为 1');
  assert(sameCell(reveal.picks['1'], agentCell), 'reveal 里 Agent 的选择应与提交一致');
  assert(sameCell(reveal.picks['0'], humanCell), 'reveal 里人类的选择应与提交一致');
  print({
    resolved: humanSubmit.resolved,
    reveal: {
      round: reveal.round,
      picks: reveal.picks,
      delta: reveal.delta,
      collision: reveal.collision,
      scores: reveal.scores,
    },
    eventTypes: humanSubmit.events.map((e) => e.type),
  });

  // 10a. 观测里应出现本回合历史与比分
  line('10/10 收尾：getState / say / getResult / exportLog');
  const stateAfter = await getState(room.roomId, 1);
  assert(Array.isArray(stateAfter.history) && stateAfter.history.length === 1, '历史应有 1 回合');
  assert(stateAfter.round === 2, '结算后 round 应前进到 2');
  assert(stateAfter.youSubmitted === false, '新回合 youSubmitted 应重置为 false');
  print({ round: stateAfter.round, scores: stateAfter.scores, historyLength: stateAfter.history.length, legalActions: stateAfter.legalActions.length });

  // 10b. 气泡聊天（带令牌）
  const said = await say(room.roomId, 1, '这枚金币归我了');
  assert(said.ok && said.message.text === '这枚金币归我了', 'say 应返回发出的消息');
  assert(said.message.seat === 1, 'say 消息座位应为 1');
  print({ message: said.message });

  // 10c. 结果（刚打 1 回合，应为 null）
  const result = await getResult(room.roomId);
  assert(result === null, '对局尚未结束时 getResult 应为 null');
  print({ result });

  // 10d. 导出日志（/log 仍公开，但客户端会附加已保存的令牌）
  const log = await exportLog(room.roomId, 1);
  assert(log.roomId === room.roomId, '日志 roomId 应一致');
  assert(log.seat === 1, '日志 seat 应为请求的座位');
  // 反作弊：对局进行中不公开 seed（yacht 的骰面由 seed 唯一决定，提前给等于能预测骰子），终局后才给
  assert(log.seed === null, '对局进行中日志不应公开 seed');
  assert(Array.isArray(log.events) && log.events.length >= 1, '日志应至少包含 reveal 事件');
  assert(log.events.some((e) => e.event.type === 'reveal'), '日志应包含 reveal 事件');
  // 注意：/log 的 events 只记对局事件（reveal/end），聊天走 /chat，不进回放日志。
  print({
    roomId: log.roomId,
    gameId: log.gameId,
    seed: log.seed,
    seat: log.seat,
    eventTypes: log.events.map((e) => e.event.type),
    result: log.result,
  });

  console.log('\n✅ 冒烟测试全部通过（客户端 ↔ 后端契约 OK，席位令牌已全程透传）');
}

main().catch((err: unknown) => {
  console.error('\n❌ 冒烟测试失败：');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
