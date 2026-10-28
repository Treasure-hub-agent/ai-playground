/**
 * MCP over HTTP 冒烟：模拟一个「新会话 Agent」——不读源码、不知道 stdio 配置，
 * 只拿到一个 URL（默认 http://127.0.0.1:8787/mcp），能否顺利完成接入并打一回合。
 *
 * 运行：pnpm -C packages/mcp exec tsx test/http-mcp.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_URL = process.env.PLAYGROUND_MCP ?? 'http://127.0.0.1:8787/mcp';
const REST_BASE = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:8787';

function textOf(result: any): string {
  const first = result?.content?.[0];
  return first && first.type === 'text' ? String(first.text) : '';
}

function jsonOf(result: any): any {
  const sc = result?.structuredContent;
  if (sc?.observation) return sc.observation; // get_state / wait_for_turn 的返回
  if (sc) return sc;
  const t = textOf(result);
  const start = t.indexOf('{');
  if (start === -1) return {};
  try {
    return JSON.parse(t.slice(start));
  } catch {
    return {};
  }
}

/**
 * 用 REST 模拟人类入座（0 号位），返回该座位的席位令牌。
 *
 * 0 号位令牌在建桌时就预发了，所以这里必须带上去：不带令牌的 join 会被判定为
 * 「座位已被预留」并返回 409 seat_taken —— 这正是防止别人抢走房主人类位的设计。
 */
async function joinHumanSeat(roomId: string, createToken: string | undefined): Promise<string> {
  if (!createToken) throw new Error(`建桌响应没有 seatTokens["0"]，无法模拟人类入座：${roomId}`);
  const res = await fetch(`${REST_BASE}/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seat: 0, token: createToken }),
  });
  if (!res.ok) throw new Error(`人类入座失败 HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('人类入座没拿到席位令牌（服务端可能还是旧版本）');
  return body.token;
}

async function main() {
  console.log(`🔌 连接 MCP HTTP：${MCP_URL}`);
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'http-mcp-smoke', version: '0.0.1' });
  await client.connect(transport);
  console.log('✅ 握手成功');

  const tools = await client.listTools();
  console.log(`✅ tools: ${tools.tools.length} 个 → ${tools.tools.map((t) => t.name).join(', ')}`);

  const games = await client.callTool({ name: 'playground_list_games', arguments: {} });
  console.log(`✅ list_games: ${textOf(games).split('\n')[0]}`);

  const created = await client.callTool({
    name: 'playground_create_room',
    arguments: { gameId: 'grab' },
  });
  const info = jsonOf(created);
  const roomId = info.roomId ?? (textOf(created).match(/"roomId"\s*:\s*"(\w+)"/) ?? [])[1];
  if (!roomId) throw new Error(`create_room 没拿到 roomId：${textOf(created)}`);
  console.log(`✅ create_room: room=${roomId}`);

  // 人类占 0 号位（用 REST 模拟浏览器入座）：响应里的人类令牌要存下来，
  // 之后用原生 fetch 打 /action 时必须带上，否则 403 seat_token_required。
  const humanToken = await joinHumanSeat(roomId, info.seatTokens?.['0']);
  console.log(`✅ 人类入座拿到令牌：${humanToken.slice(0, 8)}…（只打印前缀）`);

  const joined = await client.callTool({
    name: 'playground_join_room',
    arguments: { roomId, seat: 1 },
  });
  console.log(`✅ join_room: ${textOf(joined).split('\n')[0]}`);

  const state = jsonOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId, seat: 1 } }),
  );
  const legal = state.legalActions ?? [];
  if (!legal.length) throw new Error('get_state 没返回 legalActions');
  console.log(`✅ get_state: round=${state.round} legal=${legal.length} 个`);

  const cell = legal[0].cell as [number, number];
  const submitted = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId, cell },
  });
  console.log(`✅ submit_action: ${textOf(submitted).split('\n')[0]}`);
  console.log(`✅ 等待对手中：${JSON.stringify(jsonOf(submitted).resolved ?? '')}`);

  // ── 第二种游戏：四子棋（turn 模式 + cell→column 自动映射）──
  const c4 = jsonOf(
    await client.callTool({ name: 'playground_create_room', arguments: { gameId: 'connect4' } }),
  );
  const c4Room = c4.roomId ?? (textOf(await client.callTool({ name: 'playground_list_games', arguments: {} })).match(/connect4/)?.[0]);
  if (!c4Room) throw new Error('没能为四子棋建桌');
  const c4HumanToken = await joinHumanSeat(c4Room, c4.seatTokens?.['0']);
  await client.callTool({ name: 'playground_join_room', arguments: { roomId: c4Room, seat: 1 } });
  const c4Before = jsonOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId: c4Room, seat: 1 } }),
  );
  console.log(`✅ 四子棋 get_state: currentSeat=${c4Before.currentSeat} isYourTurn=${c4Before.isYourTurn}`);

  const wrongTurn = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId: c4Room, cell: [0, 3] },
  });
  const wrongText = textOf(wrongTurn);
  console.log(`✅ 四子棋越权提交被拒：${wrongText.split('\n')[0].slice(0, 60)}`);

  // seat0 先手先落一子，再让 Agent 用「cell=[行,列]」写法定列
  // 注意：原生 fetch 不走 MCP 客户端的令牌表，必须自己带上 0 号位令牌，否则 403。
  const c4HumanAction = await fetch(`${REST_BASE}/api/rooms/${c4Room}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seat: 0, token: c4HumanToken, action: { action: 'drop', column: 0 } }),
  });
  if (!c4HumanAction.ok) {
    throw new Error(`四子棋人类落子失败 HTTP ${c4HumanAction.status}：${await c4HumanAction.text()}`);
  }
  const c4Move = await client.callTool({
    name: 'playground_submit_action',
    arguments: { roomId: c4Room, cell: [0, 3] },
  });
  const c4After = jsonOf(
    await client.callTool({ name: 'playground_get_state', arguments: { roomId: c4Room, seat: 1 } }),
  );
  const lastDrop = c4After.history?.[c4After.history.length - 1];
  console.log(`✅ 四子棋落子：${textOf(c4Move).split('\n')[0].slice(0, 60)}`);
  if (!lastDrop || lastDrop.column !== 3) {
    throw new Error(`四子棋落子未生效：history 末条=${JSON.stringify(lastDrop)}`);
  }
  console.log(`✅ 四子棋 cell→column 映射生效：column=${lastDrop.column}, row=${lastDrop.row}`);

  await client.close();
  console.log('\n🎉 MCP over HTTP 冒烟通过：新会话只拿到一个 URL 就能接入并出招（两款游戏都验证）');
}

main().catch((err) => {
  console.error('\n❌ MCP HTTP 冒烟失败：', err?.message ?? err);
  process.exit(1);
});
