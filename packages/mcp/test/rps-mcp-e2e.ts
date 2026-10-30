/**
 * 猜拳心理战（rps-duel）MCP 冒烟：走真实后端 + 真实 MCP 工具。
 *
 * 覆盖：
 * 1. create_room(rps-duel) 直接建桌（不再需要 allowWip）；
 * 2. 资源 playground://games/rps-duel/rules 返回完整规则；
 * 3. cell 误用 → 明确提示改用 actionJson（throw），而不是笼统「不合法」；
 * 4. actionJson 提交 throw → 先提交方 resolved=false，youSubmitted 正确且**不回传挂起动作**；
 * 5. 对手到齐 → reveal 带 shapes / winner / points；重复提交被拒；
 * 6. 三局打完 → ended、get_result、终局后 seed 才公开。
 * 7. 席位鉴权（第 12 轮）：建桌拿 0 号位令牌、入座拿 1 号位令牌，之后读写全部自动透传。
 *
 * 运行：pnpm -C packages/mcp exec tsx test/rps-mcp-e2e.ts
 * 需要后端在 PLAYGROUND_URL（默认 http://127.0.0.1:8787）运行。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, rulesResourceUri } from '../src/index.ts';
import { exportLog, getBaseUrl, joinRoom, submitAction } from '../src/client.ts';

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
  console.log(`✊ 猜拳心理战 MCP 冒烟 · 服务端 ${getBaseUrl()}`);

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'rps-smoke', version: '0.0.1' });
  await client.connect(clientTransport);

  // ── 0. 工具 / 资源 ────────────────────────────────────────────────
  const tools = await client.listTools();
  assert(tools.tools.length === 10, `应有 10 个工具，实际 ${tools.tools.length}`);
  const resources = await client.listResources();
  const rulesUri = rulesResourceUri('rps-duel');
  assert(has(resources.resources, rulesUri), `资源列表缺少 ${rulesUri}`);
  console.log(`✅ 资源：${resources.resources.map((r: any) => r.uri).join(', ')}`);

  const rulesRes = await client.readResource({ uri: rulesUri });
  const rulesText = rulesRes.contents.map((c: any) => c.text ?? '').join('\n');
  assert(rulesText.includes('猜拳心理战'), 'rps-duel 规则资源应包含标题');
  assert(rulesText.includes('决胜局'), 'rps-duel 规则应说明决胜局翻倍');
  assert(rulesText.includes('throw'), 'rps-duel 规则应给出 throw 动作');
  console.log('✅ 规则资源：标题 / 决胜局 / throw 动作齐全');

  // ── 1. 建桌 ───────────────────────────────────────────────────────
  const created = await client.callTool({
    name: 'playground_create_room',
    arguments: { gameId: 'rps-duel' },
  });
  const room = structOf(created);
  assert(typeof room.roomId === 'string' && room.roomId.length > 0, 'create_room 应返回 roomId');
  assert(room.gameId === 'rps-duel', '房间 gameId 应为 rps-duel', room.gameId);
  assert(String(textOf(created)).includes('猜拳心理战'), '建桌文案应带游戏名');
  assert(isToken(room.seatTokens?.['0']), '建桌应预发 0 号位（人类）令牌');
  console.log(`✅ create_room(rps-duel)：room=${room.roomId}`);

  // 双方入座（Agent 走 MCP，人类模拟走 REST）：各自拿自己座位的令牌
  const joined = await client.callTool({
    name: 'playground_join_room',
    arguments: { roomId: room.roomId, seat: 1 },
  });
  assert(String(textOf(joined)).includes('入座') || structOf(joined).ok === true, 'Agent 入座应成功');
  assert(isToken(structOf(joined).token), 'Agent 入座应拿到 1 号位令牌');
  const humanJoin = await joinRoom(room.roomId, 0);
  assert(humanJoin.ok && humanJoin.status === 'playing', '双方入座后应为 playing');
  assert(isToken(humanJoin.token), '人类入座应拿到 0 号位令牌');
  assert(
    humanJoin.token === room.seatTokens['0'],
    '人类入座应沿用建桌预发令牌（humanUrl 里那把才能用）',
  );
  console.log('✅ 双方入座：seat1=MCP，seat0=REST，各自持有席位令牌');

  // ── 2. 开局观测 ───────────────────────────────────────────────────
  const stateRes = await client.callTool({
    name: 'playground_get_state',
    arguments: { roomId: room.roomId, seat: 1 },
  });
  const state = obsOf(stateRes);
  assert(state.gameId === 'rps-duel', '观测 gameId 应为 rps-duel');
  assert(state.seat === 1, '带令牌观测的 seat 应为 1（不是旁观者）', state.seat);
  assert(state.spectator !== true, '带令牌观测不应是旁观视图');
  assert(state.round === 1 && state.roundsTotal === 3, '开局应为第 1/3 局', state.round);
  assert(state.currentRoundPoints === 1, '第 1 局应值 1 分');
  assert(state.currentSeat === null, 'simultaneous 不应有 currentSeat');
  assert(Array.isArray(state.legalActions) && state.legalActions.length === 3, '应有 3 种出手');
  assert(state.youSubmitted === false, '开局不该已提交');
  assert(!('yourPending' in (state as any)), '观测不该携带挂起动作');
  assert(state.history.length === 0, '开局不该有历史');
  const stateText = textOf(stateRes);
  assert(stateText.includes('石头') || stateText.includes('rock'), '观测文案应列出出手');
  assert(stateText.includes('actionJson') || stateText.includes('throw'), '应提示用 actionJson 提交');
  console.log('✅ get_state：3 出手 / 第 1 局值 1 分 / 提示 actionJson');

  // ── 3. cell 误用 → 明确指引 ───────────────────────────────────────
  const cellMisuse = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId: room.roomId, seat: 1, cell: [0, 0] },
  });
  const cellText = textOf(cellMisuse);
  assert(cellText.includes('不能用 cell'), 'cell 误用应明确说不能用 cell');
  assert(cellText.includes('actionJson'), 'cell 误用应指向 actionJson');
  assert(cellText.includes('throw'), 'cell 误用应给出 throw 示例');
  console.log('✅ cell 误用：明确提示改用 actionJson(throw)');

  // ── 4. Agent 先提交 ───────────────────────────────────────────────
  const agentThrow = await client.callTool({
    name: 'playground_submit_action',
    arguments: {
      roomId: room.roomId,
      seat: 1,
      actionJson: { action: 'throw', shape: 'rock' },
    },
  });
  const agentStruct = structOf(agentThrow);
  assert(agentStruct.resolved === false, '单方提交不应结算', agentStruct.resolved);
  assert(Array.isArray(agentStruct.events) && agentStruct.events.length === 0, '单方提交不应有事件');
  console.log('✅ submit_action(throw rock)：resolved=false，等待对手');

  const pendingRes = await client.callTool({
    name: 'playground_get_state',
    arguments: { roomId: room.roomId, seat: 1 },
  });
  const pending = obsOf(pendingRes);
  assert(pending.youSubmitted === true, '提交后 youSubmitted 应为 true');
  assert(!('yourPending' in (pending as any)), '服务端不回传挂起动作（防对手 ?seat=X 偷看）');
  const pendingText = textOf(pendingRes);
  assert(pendingText.includes('等待') || pendingText.includes('已提交') || pendingText.includes('密封'), '应提示在自己等待对手');
  console.log('✅ 挂起状态：youSubmitted=true，观测不含动作内容（防 ?seat=X 偷看）');

  // 重复提交 → 409 语义
  const dup = await client.callTool({
    name: 'playground_submit_action',
    arguments: {
      roomId: room.roomId,
      seat: 1,
      actionJson: { action: 'throw', shape: 'paper' },
    },
  });
  assert(String(textOf(dup)).includes('已提交') || String(textOf(dup)).includes('already'), '重复提交应被拒绝并说明原因');
  console.log('✅ 同局重复提交被拒（action_already_submitted）');

  // ── 5. 人类提交 → 结算（石头赢剪刀）──────────────────────────────
  const humanThrow = await submitAction(room.roomId, 0, { action: 'throw', shape: 'scissors' });
  assert(humanThrow.ok && humanThrow.resolved === true, '双方到齐应立即结算');
  const reveal = humanThrow.events.find((e) => e.type === 'reveal') as any;
  assert(reveal, '结算事件应包含 reveal');
  assert(reveal.shapes['0'] === 'scissors' && reveal.shapes['1'] === 'rock', 'reveal.shapes 应正确');
  assert(reveal.winner === 1, '石头应赢剪刀（seat1 胜）', reveal.winner);
  assert(reveal.points === 1, '第 1 局应值 1 分');
  console.log(`✅ reveal：${reveal.shapes['0']} vs ${reveal.shapes['1']} → 座位 ${reveal.winner} +${reveal.points}`);

  const afterRound1 = await client.callTool({
    name: 'playground_get_state',
    arguments: { roomId: room.roomId, seat: 1 },
  });
  const s1 = obsOf(afterRound1);
  assert(s1.scores['1'] === 1 && s1.scores['0'] === 0, '比分应为 0:1', s1.scores);
  assert(s1.round === 2 && s1.currentRoundPoints === 1, '应进入第 2 局（值 1 分）');
  assert(s1.history.length === 1, '历史应有 1 局');
  assert(!('yourPending' in (s1 as any)), '结算后观测依然不含动作内容');
  console.log('✅ 第 2 局开始，比分 0:1，挂起已清空');

  // ── 6. 打完后两局，验证决胜局翻倍与终局 ───────────────────────────
  // 第 2 局：Agent(seat1) 出布，人类(seat0) 出布 → 平局，比分仍 0:1
  let r = await submitAction(room.roomId, 1, { action: 'throw', shape: 'paper' });
  assert(r.resolved === false, '第 2 局单方提交不应结算');
  r = await submitAction(room.roomId, 0, { action: 'throw', shape: 'paper' });
  assert(r.resolved === true, '第 2 局双方到齐应结算');
  const reveal2 = r.events.find((e) => e.type === 'reveal') as any;
  assert(reveal2.winner === null, '双方同出手应判平局局');
  assert(reveal2.scores['0'] === 0 && reveal2.scores['1'] === 1, '平局局不加分');
  console.log('✅ 第 2 局平局：0:1 不变');

  // 第 3 局（值 2 分）：Agent(seat1) 出剪刀，人类(seat0) 出石头 → 人类 +2 → 2:1
  r = await submitAction(room.roomId, 0, { action: 'throw', shape: 'rock' });
  assert(r.resolved === false, '第 3 局单方提交不应结算');
  r = await submitAction(room.roomId, 1, { action: 'throw', shape: 'scissors' });
  assert(r.resolved === true, '第 3 局双方到齐应结算');
  const reveal3 = r.events.find((e) => e.type === 'reveal') as any;
  assert(reveal3.points === 2, '决胜局应值 2 分', reveal3.points);
  assert(reveal3.winner === 0, '决胜局应由人类获胜');
  const endEvent = r.events.find((e) => e.type === 'end') as any;
  assert(endEvent, '最后一局应带 end 事件');
  console.log(`✅ 决胜局 +${reveal3.points} → 比分 ${reveal3.scores['0']}:${reveal3.scores['1']}`);

  // ── 7. 终局结果与 seed 公开 ───────────────────────────────────────
  const resultRes = await client.callTool({
    name: 'playground_get_result',
    arguments: { roomId: room.roomId },
  });
  const result = structOf(resultRes).result ?? structOf(resultRes);
  assert(result.winner === 0, '终局结果应由座位 0 获胜', result.winner);
  assert(result.scores['0'] === 2 && result.scores['1'] === 1, '终局比分应为 2:1', result.scores);
  console.log(`✅ get_result：${result.scores['0']}:${result.scores['1']}，座位 ${result.winner} 胜`);

  const log = await exportLog(room.roomId, 1);
  assert(typeof log.seed === 'number', '终局后应公开数字 seed');
  assert(Array.isArray(log.events) && log.events.length >= 3, '日志应至少 3 局事件');
  console.log(`✅ export_log：seed=${log.seed}，事件 ${log.events.length} 条`);

  // 终局后再提交
  const late = await client.callTool({
    name: 'playground_submit_action',
    arguments: {
      roomId: room.roomId,
      seat: 1,
      actionJson: { action: 'throw', shape: 'rock' },
    },
  });
  assert(String(textOf(late)).includes('结束'), '终局后提交应提示对局已结束');
  console.log('✅ 终局后提交：提示已结束');

  await client.close();
  console.log('\n🎉 猜拳心理战 MCP 冒烟全部通过');
}

main().catch((err: unknown) => {
  console.error('\n❌ 猜拳心理战 MCP 冒烟失败：');
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
