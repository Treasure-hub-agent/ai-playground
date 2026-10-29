/**
 * Agent 发现层：让任何一个新会话的 Agent 都能「自报家门」式地找到接入方式。
 *
 * - GET /llms.txt                        纯文本接入说明（LLM 生态事实标准）
 * - GET /.well-known/ai-playground.json  机器可读描述（端点/工具/快速开始）
 * - GET /api/agent                       同上（给只探 API 的 Agent 留的入口）
 * - MCP over HTTP: POST /mcp             无需本地 stdio 进程即可接入
 */

export interface DiscoveryOptions {
  baseUrl: string; // 例如 http://127.0.0.1:8787
  repoPath: string; // 仓库绝对路径（stdio 形态用）
}

export function buildDescriptor(opts: DiscoveryOptions) {
  const base = opts.baseUrl.replace(/\/$/, '');
  return {
    schemaVersion: 1,
    name: 'AI 游乐场',
    id: 'ai-playground',
    version: '0.1.0',
    summary:
      '人类和 AI Agent 同桌玩的小游戏大厅：浏览器当牌桌，Agent 当对手，服务器只当裁判。当前六款可玩：抢宝大作战（grab）、四子棋（connect4）、快艇骰子（yacht）、猜拳心理战（rps-duel）、深海猎手（battleship）、黑白棋（reversi）。',
    seats: { human: 0, agent: 1 },
    seatAuth: {
      tokenFormat: '32 位小写十六进制（16 字节随机数）',
      howToGet: [
        '0 号位（人类）：POST /api/rooms 的响应里有 seatTokens["0"]，人类入口 humanUrl 也带着同一个 token。',
        '1 号位（Agent）：POST /api/rooms/:id/join {"seat":1} 的响应里有 token；**请保存好，丢了就等于丢座位**。',
      ],
      howToUse:
        '之后每次请求都带令牌：GET /api/rooms/:id/state?seat=1&token=<t>；POST /action、POST /say 在 JSON 体里加 "token":"<t>"。',
      spectator:
        '不带令牌（或令牌不对）读观测不会报错，而是降级为旁观：spectator=true、seat=null、legalActions=[]，只有公开信息。',
      errors: {
        '403 seat_token_required': '没有有效令牌却想 POST /action 或 /say（旁观可以看，但不能出手）。',
        '409 seat_taken': '座位已被占（0 号位从建桌起就预留），又拿不出原令牌；同一人重连带原令牌再 join 是幂等的。',
      },
      publicEndpoints: 'GET /api/rooms/:id（summary）、GET /api/rooms/:id/log、WS /ws 都是公开的；summary 不返回令牌。',
    },
    howToPlay: [
      '用 MCP 连接（推荐）：POST ' + base + '/mcp （Streamable HTTP，无需本地进程）',
      '调用 playground_create_room 开一桌，把返回的 humanUrl 交给人类在浏览器打开',
      '调用 playground_join_room(roomId, seat=1) 入座，**保存返回的 token**',
      '循环：playground_wait_for_turn → 读 textView/legalActions → playground_submit_action（客户端自动带 token）',
      '结束后 playground_get_result，想要复盘用 playground_export_log',
    ],
    mcp: {
      http: base + '/mcp',
      stdio: {
        command: 'pnpm',
        args: ['-C', opts.repoPath + '/packages/mcp', 'exec', 'tsx', 'src/cli.ts'],
        env: { PLAYGROUND_URL: base },
      },
      transport: 'streamable-http',
      tools: [
        'playground_list_games',
        'playground_create_room',
        'playground_join_room',
        'playground_wait_for_turn',
        'playground_get_state',
        'playground_submit_action',
        'playground_say',
        'playground_get_result',
        'playground_export_log',
      ],
      resources: [
        'playground://games/grab/rules',
        'playground://games/connect4/rules',
        'playground://games/yacht/rules',
        'playground://games/rps-duel/rules',
        'playground://games/battleship/rules',
        'playground://games/reversi/rules',
      ],
    },
    rest: {
      base: base + '/api',
      endpoints: {
        'GET /api/games': '游戏列表与规则全文',
        'POST /api/rooms': '建桌（body: {"gameId":"grab"|"connect4"|"yacht"|"rps-duel"|"battleship"|"reversi"}）→ 返回 roomId、humanUrlPath、seatTokens["0"]（人类座的令牌）',
        'POST /api/rooms/:id/join': '入座（body: {"seat":1} → 发 1 号位令牌；已有座位要带 {"seat":0,"token":"<t>"}）',
        'GET /api/rooms/:id/state?seat=1&token=<t>': '该座位观测（唯一读数出口）；不带令牌 = 旁观视图 spectator=true',
        'POST /api/rooms/:id/action':
          '提交动作，body 里带 "token"。grab: {"action":"grab","cell":[r,c]}；connect4: {"action":"drop","column":n}；yacht: {"action":"roll"} / {"action":"hold","indices":[i]} / {"action":"score","category":"..."}；rps-duel: {"action":"throw","shape":"rock"|"paper"|"scissors"}；battleship: {"action":"fire","cell":[r,c]}；reversi: {"action":"place","cell":[r,c]}',
        'POST /api/rooms/:id/say': '气泡聊天（body: {"seat":1,"text":"...","token":"<t>"}）',
        'GET /api/rooms/:id/result': '结算',
        'GET /api/rooms/:id/log?seat=1': '对局日志（公开；seed 在终局后才公开，避免提前预测骰子）',
      },
    },
    rules: {
      all: base + '/api/games',
      mcpResources: [
        'playground://games/grab/rules',
        'playground://games/connect4/rules',
        'playground://games/yacht/rules',
        'playground://games/rps-duel/rules',
        'playground://games/battleship/rules',
        'playground://games/reversi/rules',
      ],
    },
    docs: {
      llms: base + '/llms.txt',
      quickstart: opts.repoPath + '/docs/agent-quickstart.md',
      apiContract: opts.repoPath + '/docs/api-contract.md',
    },
    notes: [
      '别用截图看棋盘：直接读 state.textView / legalActions。',
      '第 12 轮起 seat 参数不再代表身份：没有令牌一律降级为旁观（spectator=true），入座时拿到的 token 才是凭据。',
      '没有有效令牌 POST /action 或 /say 会 403 {"error":"seat_token_required"}；已占用座位无令牌 join 会 409 {"error":"seat_taken"}。',
      '409 illegal_action 会返回 legalActions，照着改再提交。',
      '房间只在内存里，服务重启即失效；重新开桌即可（令牌也一起失效）。',
    ],
  };
}

export function buildLlmsTxt(opts: DiscoveryOptions): string {
  const base = opts.baseUrl.replace(/\/$/, '');
  return `# AI 游乐场（ai-playground）

> 人类和 AI Agent 同桌玩的小游戏大厅。你是 Agent 的话，坐 1 号位；人类坐 0 号位，在浏览器里玩。
> 当前六款游戏：
> - 《抢宝大作战》grab：3×3 同时暗选抢金币，60–90 秒（resolution=simultaneous）
> - 《四子棋》connect4：7 列轮流落子，先连成四子者胜（resolution=turn，注意 isYourTurn / not_your_turn）
> - 《快艇骰子》yacht：5 颗骰子 3 次掷骰，13 栏记分比总分（resolution=turn，动作是 roll / hold / score）
> - 《猜拳心理战》rps-duel：3 局同时暗出手，第 3 局翻倍，30–60 秒（resolution=simultaneous，动作是 throw）
> - 《深海猎手》battleship：5×5 盲射找船，命中继续开炮（resolution=turn，动作是 fire）
> - 《黑白棋》reversi：8×8 夹子翻面，数子定胜负（resolution=turn，动作是 place）

## 最快接入（推荐）：MCP over HTTP

- 端点：${base}/mcp
- 传输：Streamable HTTP（MCP 官方规范），无需在本地起 stdio 进程
- 工具：playground_create_room / playground_join_room / playground_wait_for_turn /
  playground_get_state / playground_submit_action / playground_say /
  playground_get_result / playground_export_log / playground_list_games
- 规则资源：playground://games/grab/rules · playground://games/connect4/rules · playground://games/yacht/rules · playground://games/rps-duel/rules · playground://games/battleship/rules · playground://games/reversi/rules

客户端配置示例（Claude Code 风格）：
  claude mcp add --transport http ai-playground ${base}/mcp

## ⚠️ 先确认 MCP 真的接上了

如果你当前的工具列表里**没有 playground_ 开头的那组工具**，说明 MCP 还没接上：
先用上面那条命令把端点加进客户端，再开始对局。

**不要用 curl / PowerShell 手搓 JSON-RPC**。能跑通，但你会失去客户端侧的令牌管理，
只能猜令牌该放哪、并反复试探接口形状——整局的时间都会耗在这上面，而人类在牌桌上等着。

## ⚠️ 对局礼仪

按回合出招：读到 legalActions 就出一手，然后 wait_for_turn。
**不要写自动对局脚本把整局托管掉**——人类要的是「和你同桌玩」，不是看你把棋下完。

## 席位与令牌（第 12 轮新增，必读）

- 每个座位一枚令牌：32 位小写十六进制（16 字节随机数），存在房间的 seatTokens[seat] 里。
- 0 号位（人类）：POST /api/rooms 时生成并**预留**，响应里有 seatTokens["0"]；humanUrl 也带同一个 token。
- 1 号位（Agent）：POST /api/rooms/{roomId}/join {"seat":1} → 响应 {ok, seat, token, ...}。**把 token 存好**，丢了就等于丢座位。
- 之后每次请求都带令牌（三种放法任选，优先级：请求体 > 查询串 > 请求头）：
  - 读观测：GET /api/rooms/{roomId}/state?seat=1&token=<t>
  - 出招：POST /api/rooms/{roomId}/action {"seat":1,"action":{...},"token":"<t>"}
  - 说话：POST /api/rooms/{roomId}/say {"seat":1,"text":"...","token":"<t>"}
  - 或者统一放进请求头 X-Seat-Token: <t>（不想把凭据写进 URL 与访问日志时用它）
- 不带令牌也能读，但会**降级为旁观**：spectator=true、seat=null、legalActions=[]，只给公开信息。这是给围观朋友的正当场景，不是错误。
- 不带令牌 / 令牌不对去出招：403 {"error":"seat_token_required"}。旁观可以看，但不能出手。
- 座位已被占（0 号位从建桌起就预留），又拿不出原令牌：409 {"error":"seat_taken"}。
- 同一个人重连时带原令牌再 join 即可（幂等，令牌不变）；0 号位令牌不能用于 1 号位，反之亦然。
- GET /api/rooms/{id}（summary）、GET .../log、WebSocket 事件都是公开的；summary **不会**返回令牌，别去那里找。

## 备选：直接用 REST

> 形状提醒：REST 的 /state **直接返回观测对象本身**（没有外层包装，字段就在顶层）；
> MCP 的 playground_get_state 则是结构化的 { structuredContent: {...观测} }。
> 别拿同一个 .observation 去套两边——按哪个接口取，就按哪个形状解析。

- 游戏与规则：GET ${base}/api/games
- 开桌：POST ${base}/api/rooms  {"gameId":"grab"}  → 返回 roomId、humanUrlPath、seatTokens["0"]
- 入座：POST ${base}/api/rooms/{roomId}/join  {"seat":1}  → 返回该座位的 token
- 观测：GET ${base}/api/rooms/{roomId}/state?seat=1&token=<t>
- 出招：POST ${base}/api/rooms/{roomId}/action  {"seat":1,"action":{"action":"grab","cell":[1,2]},"token":"<t>"}
- 说话：POST ${base}/api/rooms/{roomId}/say  {"seat":1,"text":"...","token":"<t>"}
- 结算：GET ${base}/api/rooms/{roomId}/result
- 日志：GET ${base}/api/rooms/{roomId}/log?seat=1   （公开）

## 一局的标准循环

1. create_room → 把 humanUrl 发给人类，等他在浏览器打开
2. join_room(seat=1) → **保存 token**（MCP 客户端会自动带，手写 curl 的要自己带）
3. wait_for_turn → 读 textView / legalActions
4. submit_action（grab / connect4 用 cell=[行,列]；yacht / rps-duel 用 actionJson）
5. 重复 3-4 直到 status=ended
6. get_result；需要复盘就 export_log

## wait_for_turn 的返回语义

- 参数：roomId、seat（默认 1）、timeoutSeconds（默认 60，范围 1–300）
- 返回 ready=true：轮到你提交（youSubmitted=false 且 status=playing）
- 返回 ready=false + timedOut=true：超时（人类还没动；**直接再调一次即可**，不需要重开房间）
- 返回 ended=true：对局结束，改调 get_result / export_log
- polls / elapsedSeconds：本次等了几次、等了多久

## submit_action 的行为（重要）

- 你是先提交的一方：返回 {resolved:false, events:[]}，等对手提交后才结算
- 你是后提交（结算）的一方：返回 {resolved:true, events:[reveal, …]}
- 所以**先手方要拿结算结果，请再调 wait_for_turn 或 get_state，从 observation.history 读本回合结果**
- 409 illegal_action 会带 legalActions，照着改一格重试

## 结束条件

- 抢宝：场上金币被抢完即结束（剩下的空格/炸弹不再进行）。
- 猜拳：3 局打完即结束（第 3 局翻倍，同分算平局）。
- 深海猎手：一方 2 艘船全沉即结束（没有平局）。
- 黑白棋：双方都无合法落点即结束，数子定胜负（同数算平局）。
- status=ended 时 legalActions 为空、textView 带「🏁 对局已结束」与胜负文案。

## 猜拳心理战（rps-duel）补充

- 动作只用 actionJson：{"action":"throw","shape":"rock"}（石头）/ "paper"（布）/ "scissors"（剪刀）。
- 每局双方各提交一次；先提交的一方看不到对手这一手，**结算事件只回给后提交的一方**，先手方请再调 wait_for_turn 或 get_state 从 observation.history 读结果。
- 分数：第 1、2 局各 1 分，第 3 局 2 分（总分 4）；同出手该局 0:0 但照常消耗。

## 注意

- 观测是唯一信息源，别去猜对手本回合选了什么（未揭示前服务端不给）。
- **seat 参数不是身份**：没有令牌读取只会得到旁观视图（spectator=true、legalActions=[]）。
- 收到 409 时按返回的 legalActions 改一个合法格再提交；403 seat_token_required 表示没带对令牌。
- 房间只存在内存里，服务重启即失效（令牌同理）。
- 机器可读版本：${base}/.well-known/ai-playground.json
`;
}

