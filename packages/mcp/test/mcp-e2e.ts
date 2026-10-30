/**
 * MCP 协议级 E2E：用 SDK 官方 Client + InMemoryTransport 真跑 tools 与 resource。
 *
 * 覆盖：listTools（10 个工具）→ readResource(规则) → 建桌（拿 0 号位令牌）
 *       → 双方入座（拿各自令牌，校验令牌随 humanUrl / join 返回可见）
 *       → 读观测（带令牌，非旁观）→ 主动旁观视图文案
 *       → 未入座时 get_state 给出可读错误（不是静默旁观）
 *       → 双方提交（cell / actionJson 两种写法）→ 409 非法动作结构化返回
 *       → wait_for_turn → say → get_result → export_log。
 *
 * 运行：pnpm -C packages/mcp exec tsx test/mcp-e2e.ts
 * 需要后端已在 PLAYGROUND_URL（默认 http://127.0.0.1:8787）运行。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, RULES_RESOURCE_URI } from '../src/index.ts';

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

/** 令牌格式：32 位十六进制。 */
function isToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

const server = createMcpServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(clientTransport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log('tools:', names.join(', '));
assert(names.length === 10, `应有 10 个工具，实际 ${names.length}`);
assert(names.includes('playground_submit_action'), '缺少 submit_action');
assert(names.includes('playground_bind_session'), '缺少 bind_session（第 14 轮唤醒桥）');
assert(
  names.every((n) => n.startsWith('playground_')),
  '所有工具应以 playground_ 开头',
);

const resources = await client.listResources();
console.log('resources:', resources.resources.map((r) => r.uri));
assert(
  resources.resources.some((r) => r.uri === RULES_RESOURCE_URI),
  '缺少规则 resource',
);
const rules = await client.readResource({ uri: RULES_RESOURCE_URI });
const rulesText = rules.contents.map((c: any) => c.text ?? '').join('\n');
assert(rulesText.includes('抢宝大作战'), 'resource 应返回规则文本');
console.log('rules 前 30 字:', rulesText.slice(0, 30));

const listed = await client.callTool({ name: 'playground_list_games', arguments: {} });
assert((structOf(listed).games as any[]).length > 0, 'list_games 应返回游戏');

const created = await client.callTool({ name: 'playground_create_room', arguments: { gameId: 'grab' } });
const room = structOf(created);
console.log('created:', { roomId: room.roomId, humanUrl: room.humanUrl, seatTokens: room.seatTokens });
assert(room.roomId && room.humanUrl && room.rules, 'create_room 字段不齐');
assert(isToken(room.seatTokens?.['0']), 'create_room 应返回 seatTokens["0"]（人类令牌）');
assert(
  String(room.humanUrl).includes(`token=${room.seatTokens['0']}`),
  'humanUrl 应带上人类席位令牌（人类零配置入座）',
);
assert(textOf(created).includes('席位令牌'), '建桌文案应说明人类令牌 / 令牌用途');

const roomId = room.roomId as string;
const joined1 = await client.callTool({ name: 'playground_join_room', arguments: { roomId, seat: 1 } });
const joined1S = structOf(joined1);
assert(joined1S.occupied[1] === true, 'Agent 应入座');
assert(isToken(joined1S.token), 'join_room(seat=1) 应把 1 号位令牌返回给调用方');
assert(String(textOf(joined1)).includes('席位令牌'), '入座文案应让人看见令牌已被客户端收下');
const joined0 = await client.callTool({ name: 'playground_join_room', arguments: { roomId, seat: 0 } });
assert(structOf(joined0).status === 'playing', '双方入座后应 playing');
assert(
  structOf(joined0).token === room.seatTokens['0'],
  'join(0) 必须沿用建桌预发的令牌（否则 humanUrl 里的令牌失效）',
);

// 第 14 轮唤醒桥：playground_bind_session 是幂等绑定（只决定「轮到 Agent 时叫醒谁」）
const bound = await client.callTool({
  name: 'playground_bind_session',
  arguments: { roomId, sessionId: 'session-mcp-e2e' },
});
const boundS = structOf(bound);
assert(boundS.bound === true, 'bind_session 应返回 bound=true');
assert(boundS.roomId === roomId, 'bind_session 应回显 roomId');
assert(boundS.sessionId === 'session-mcp-e2e', 'bind_session 应回显 sessionId');
assert(textOf(bound).includes('已绑定'), 'bind_session 文案应明确「已绑定」');
const boundAgain = await client.callTool({
  name: 'playground_bind_session',
  arguments: { roomId, sessionId: 'session-mcp-e2e' },
});
assert(structOf(boundAgain).bound === true, '重复绑定应幂等成功（同一 sessionId 只刷新时间）');

const state = await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } });
const obs = structOf(state).observation;
assert(obs.legalActions.length > 0, '应有 legalActions');
assert(obs.seat === 1, '带令牌观测的 seat 应为 1');
assert(obs.spectator !== true, '带令牌读到的不是旁观视图');
assert(structOf(state).spectator === false, 'get_state 结构化返回应标记 spectator=false');
console.log('state textView 第一行:', String(obs.textView).split('\n')[0]);

// 主动旁观：不发送令牌，服务端降级为旁观观测；文案必须明说「旁观视图，请先 join」
const spectate = await client.callTool({
  name: 'playground_get_state',
  arguments: { roomId, seat: 1, spectate: true },
});
const spectateS = structOf(spectate);
assert(spectateS.spectator === true, 'spectate=true 应返回旁观视图');
assert(spectateS.observation.spectator === true, '旁观观测应带 spectator: true');
assert(spectateS.observation.seat === null, '旁观观测的 seat 应为 null');
assert(
  Array.isArray(spectateS.observation.legalActions) && spectateS.observation.legalActions.length === 0,
  '旁观视图 legalActions 应为空',
);
assert(textOf(spectate).includes('旁观视图'), '旁观文案应明确写「旁观视图」');
assert(textOf(spectate).includes('join'), '旁观文案应告诉 Agent 先 join');
assert(spectate.isError !== true, '旁观视图不是错误（围观是正当场景）');
console.log('spectate:', { seat: spectateS.observation.seat, legal: spectateS.observation.legalActions.length });

const pick1 = obs.legalActions[0].cell;
const pick0 = obs.legalActions.find((a: any) => a.cell[0] !== pick1[0] || a.cell[1] !== pick1[1]).cell;

const sub1 = await client.callTool({
  name: 'playground_submit_action',
  arguments: { roomId, seat: 1, cell: pick1 },
});
assert(structOf(sub1).resolved === false, '只有 Agent 提交时不应结算');

const sub0 = await client.callTool({
  name: 'playground_submit_action',
  arguments: { roomId, seat: 0, actionJson: JSON.stringify({ action: 'grab', cell: pick0 }) },
});
const sub0s = structOf(sub0);
assert(sub0s.resolved === true, '双方提交后应结算');
const reveal = sub0s.events.find((e: any) => e.type === 'reveal');
assert(reveal, '应返回 reveal');
console.log('reveal:', { round: reveal.round, picks: reveal.picks, scores: reveal.scores });

// 409 路径：选已消失的格子，应把 legalActions 结构化返回
const takenCell = reveal.picks['1'];
const illegal = await client.callTool({
  name: 'playground_submit_action',
  arguments: { roomId, seat: 1, actionJson: JSON.stringify({ action: 'grab', cell: takenCell }) },
});
const illegalS = structOf(illegal);
console.log('illegal:', { isError: illegal.isError, error: illegalS.error, legalCount: (illegalS.legalActions ?? []).length });
assert(illegal.isError === true, '非法动作应返回 isError');
assert(illegalS.error === 'illegal_action', '错误码应为 illegal_action');
assert(Array.isArray(illegalS.legalActions) && illegalS.legalActions.length > 0, '应返回 legalActions');

const waited = await client.callTool({
  name: 'playground_wait_for_turn',
  arguments: { roomId, seat: 1, timeoutSeconds: 3 },
});
const waitedS = structOf(waited);
console.log('wait:', { ready: waitedS.ready, timedOut: waitedS.timedOut, round: waitedS.observation?.round });
assert(waitedS.ready === true, '第 2 回合应轮到我');

const said = await client.callTool({
  name: 'playground_say',
  arguments: { roomId, seat: 1, text: '这枚金币归我了' },
});
assert(structOf(said).message.text === '这枚金币归我了', 'say 应成功');

const result = await client.callTool({ name: 'playground_get_result', arguments: { roomId } });
assert(structOf(result).ended === false, '对局未结束');

const log = await client.callTool({ name: 'playground_export_log', arguments: { roomId, seat: 1 } });
assert((structOf(log).events as any[]).some((e) => e.event.type === 'reveal'), '日志应含 reveal');
console.log('log events:', (structOf(log).events as any[]).map((e) => e.event.type));

// 超时分支：新房间只有 Agent 入座，等 1 秒应 timedOut 且观测仍为 waiting（不是错误）
const room2 = structOf(
  await client.callTool({ name: 'playground_create_room', arguments: { gameId: 'grab' } }),
);
const room2Id = room2.roomId as string;

// 先验证「未入座 → 可读错误」：不能静默给旁观视图，否则 Agent 会以为是规则问题空转
const noToken = await client.callTool({
  name: 'playground_get_state',
  arguments: { roomId: room2Id, seat: 1 },
});
assert(noToken.isError === true, '未入座读观测应返回 isError（而不是静默旁观）');
assert(String(textOf(noToken)).includes('席位令牌'), '未入座错误应说明缺少席位令牌');
assert(String(textOf(noToken)).includes('join'), '未入座错误应指引先调用 join');
console.log('no-token get_state:', String(textOf(noToken)).split('\n')[0]);

const room2Join = await client.callTool({
  name: 'playground_join_room',
  arguments: { roomId: room2Id, seat: 1 },
});
assert(isToken(structOf(room2Join).token), '第二间房入座也应拿到 1 号位令牌');
const waiting = await client.callTool({
  name: 'playground_wait_for_turn',
  arguments: { roomId: room2Id, seat: 1, timeoutSeconds: 1 },
});
const waitingS = structOf(waiting);
console.log('wait(timeout):', {
  ready: waitingS.ready,
  timedOut: waitingS.timedOut,
  status: waitingS.observation?.status,
});
assert(waitingS.ready === false && waitingS.timedOut === true, '人类未入座时应超时');
assert(waitingS.observation?.status === 'waiting', '超时观测应仍是 waiting');
assert(waiting.isError !== true, '超时不应标记 isError');

await client.close();
await server.close();
console.log('\n✅ MCP 协议 E2E 通过（10 tools + resource + 席位令牌透传 + 旁观视图 + 409 结构化返回）');
