# AGENTS.md · AI 游乐场（ai-playground）

> 给 Agent 的接入指南。人类在浏览器里开桌，你（Agent）坐 **1 号位**。

## 最快接入：MCP over HTTP（推荐）

服务启动后（默认 `http://127.0.0.1:8787`），MCP 端点是：

```
POST http://127.0.0.1:8787/mcp        # Streamable HTTP，无需本地 stdio 进程
```

Claude Code 添加方式：

```bash
claude mcp add --transport http ai-playground http://127.0.0.1:8787/mcp
```

其他客户端：把 `http://127.0.0.1:8787/mcp` 作为 Streamable HTTP MCP server 填入即可。

## 备选：stdio 形态

```bash
pnpm -C packages/mcp exec tsx src/cli.ts    # PLAYGROUND_URL 可覆盖后端地址
```

## ⚠️ 两个先决条件

**1. 工具列表里必须有 `playground_*`。** 如果没有，说明 MCP 还没接上——先把
`http://127.0.0.1:8787/mcp` 加进你的客户端（见上一节），再开始对局。
**不要用 `curl` / PowerShell 手搓 JSON-RPC**：能跑通，但你会失去客户端侧的令牌管理，
只能猜令牌放哪、反复试探返回形状，把整局时间都耗在接口上——人类正在牌桌上等你出招。

**2. 按回合出招，别托管整局。** 读到 `legalActions` 就出一手，然后 `wait_for_turn`。
不要写自动对局脚本把棋下完：人类要的是**和你同桌玩**，不是看你替他打完。

## 一局怎么打

1. `playground_create_room` → 拿到 `roomId` 与 `humanUrl`，把 `humanUrl` 发给人类打开浏览器
2. `playground_join_room(roomId, seat=1)` → **服务端会发一张 1 号位令牌**，MCP 客户端自动保存，之后的调用自动带上
   —— 想让服务端在你该出招时自动叫醒你，就在这一步带上 `sessionId`（你的 `DSH_SESSION_ID`），或随后调 `playground_bind_session`
3. `playground_wait_for_turn(roomId)` → 读 `textView` / `legalActions`
4. `playground_submit_action(roomId, ...)`：grab / battleship / reversi 用 `cell=[行,列]`（battleship 0–4，reversi 0–7），connect4 用 `cell=[0,列]`，yacht / rps-duel 用 `actionJson`（见下节）
5. 重复 3–4 直到 `status=ended`
6. `playground_get_result`；复盘用 `playground_export_log`

### 席位令牌（第 12 轮加的，破坏性变更）

> `?seat=` 现在只表示「我想看哪个座位的视角」，**不再代表身份**。
> 没有令牌的请求一律降级为**旁观者**：能看公开棋盘，`legalActions` 恒为空，也不能出招。

- 0 号位令牌：`POST /api/rooms` 的响应里（`seatTokens["0"]`，也写在 `humanUrlPath` 的 `token` 参数里），由人类浏览器自动收下。
- 1 号位令牌：`POST /api/rooms/{id}/join` 的响应里，MCP 客户端会自己存。
- 重连（换进程 / 重连 MCP）带上原令牌即可幂等入座；**不带令牌会 409 `seat_taken`**，因为座位已经属于上一个人。
- 如果你发现 `legalActions` 一直是 `[]`、而且观测里 `spectator: true`，说明令牌丢了——重新 `join` 一次。

### 几个容易踩的点

- `wait_for_turn` 超时（`timedOut: true`）是**正常现象**（人类还没下手）：直接再调一次，不要重开房间。默认 `timeoutSeconds=60`，上限 300。
- **同时暗选（grab / rps-duel）**：你先提交时返回 `{resolved:false, events:[]}`；**结算事件只回给后提交的一方**。想立刻看到本回合结果，就再调一次 `wait_for_turn` / `get_state`，从 `observation.history` 读。
- **轮流制（connect4 / yacht / battleship / reversi）**：每次提交都会立即返回 `resolved:true` 和该动作的事件，不存在「等对手也提交后才结算」。
- `grab` 场上金币抢完即结束（剩余空格/炸弹不再进行）。

### 🔔 唤醒桥：先 `bind_session`，人类落子会自动叫你（第 14 轮）

DSH 的会话是消息驱动的：回合结束就休眠，浏览器里的点击不会自动注入会话。
把房间绑定到你的会话后，**轮到 Agent 时服务端会主动唤醒你**，不用自己定闹钟轮询。

- 绑定（三选一，幂等，可改绑）：
  - `playground_bind_session({ roomId, sessionId })`
  - `playground_create_room({ gameId, sessionId })`
  - `playground_join_room({ roomId, seat: 1, sessionId })`
  - `sessionId` 一般就是环境变量 `DSH_SESSION_ID`（形如 `session-xxxx`）；只允许 `A-Za-z0-9._:-`，最长 128。
  - 纯 REST：`POST /api/rooms/{id}/bind  {"sessionId":"<DSH_SESSION_ID>"}`
- 什么时候叫：**只在你该出招时**——轮流制结算后当前行动方是你；同时暗选里人类已提交、你还没提交。
  对局结束、还没轮到你、没绑定会话，都不会叫。
- 叫几次：同一「房间+回合」3 秒内不重复、最多 2 次；**只叫醒，不替你出招**，更不会托管整局。
- 绑定只决定「叫醒谁」：不改变对局规则，也不影响席位令牌。
- 排查：`GET /api/rooms/{id}` 的 `wake: { boundSessionId, lastWakeAt, lastWakeError }` 是只读诊断字段；
  唤醒失败只记服务端日志，**不影响对局**。
- 平台侧需要配 `WAKE_URL`（插件 `/wake` 地址）与 `WAKE_SECRET`；**不配 = 功能关闭**，行为与以前完全一致。

## 纯 REST 也能玩（不用 MCP）

```
GET  /api/games
POST /api/rooms                        {"gameId":"grab"}          → seatTokens:{"0":"<t0>"}
POST /api/rooms/{id}/join              {"seat":1}                 → token:"<t1>"
GET  /api/rooms/{id}/state?seat=1&token=<t1>
POST /api/rooms/{id}/action            {"seat":1,"token":"<t1>","action":{"action":"grab","cell":[1,2]}}
POST /api/rooms/{id}/say               {"seat":1,"token":"<t1>","text":"..."}
GET  /api/rooms/{id}/result
GET  /api/rooms/{id}/log?seat=1
```

不带 `token` 的 `/state` 不报错，但会返回 `spectator: true` 的旁观观测；不带 `token` 的 `/action`、`/say` 返回 403 `seat_token_required`。


## 发现入口（不用先读源码）

- `GET /llms.txt` —— 纯文本接入说明
- `GET /.well-known/ai-playground.json` —— 机器可读描述（端点/工具/快速开始）
- `GET /api/agent` —— 同上（兼容只探 API 的 Agent）

## 当前游戏（6 款）

| id | 名字 | 模式 | 一句话 |
|---|---|---|---|
| `grab` | 抢宝大作战 | `simultaneous`（同时暗选） | 3×3 抢金币，撞车谁都拿不到，金币抢完即结束 |
| `connect4` | 四子棋 | `turn`（轮流） | 7 列重力落子，横竖斜先连成四子者胜 |
| `yacht` | 快艇骰子 | `turn`（轮流） | 5 颗骰子 3 次机会，13 栏记分比总分 |
| `rps-duel` | 猜拳心理战 | `simultaneous`（同时暗选） | 三局猜拳，决胜局 2 分，读招赌心理 |
| `battleship` | 深海猎手 | `turn`（轮流） | 5×5 盲射找船，命中继续开炮 |
| `reversi` | 黑白棋 | `turn`（轮流） | 8×8 夹住翻面，终局数子多者胜 |

6 款都可直接开桌。

规则全文：`GET /api/games` 的 `rules` 字段，或 MCP 资源 `playground://games/<id>/rules`（6 款均已注册）。

### 轮流制（connect4）必看

- 只有轮到你时 `legalActions` 才非空；否则返回 `[]`。
- 用 `isYourTurn` / `currentSeat` 判断该谁动；没轮到你提交会收到 `not_your_turn`。
- `playground_submit_action` 支持 `cell: [行, 列]`（自动映射成 `{"action":"drop","column":n}`），也可以直接 `actionJson`。
- 落子立即换手并广播事件，没有「同时揭示」这一步。

### 快艇骰子（yacht）必看

> 已可开桌。三种动作必须用 `actionJson`；`cell` 快捷方式只适用于 grab / connect4 / battleship / reversi。下面是交互契约摘要，完整规则见 [docs/rules-yacht.md](docs/rules-yacht.md)。

- **yacht 不能用 `cell` 快捷方式**，必须把完整动作放进 `actionJson`（对象或 JSON 字符串）。三种动作：

```json
{ "action": "roll" }
```

```json
{ "action": "hold", "indices": [2] }
```

```json
{ "action": "score", "category": "full_house" }
```

- `hold` 是**单颗 toggle**：一次只切换一颗，`indices` 只放一个 0–4 下标；想锁多颗就连续发多次。`{"action":"hold","indices":[]}` 是全部解锁。
- **必须先掷过至少一次骰才能 score**；每手最多 3 次掷骰，3 次用完 `phase = "must_score"`，只能 score。选了 score 立刻换手。
- 不是你的回合或终局：`legalActions` 为 `[]`；`must_score` 时只有 score；`phase = "choice"` 时还有 roll / 单颗 hold / 空数组 hold。
- 13 个栏目每格只能用一次；打不出分也必须选一格记 0。三条/四条计「五颗骰子总和」，葫芦恰好 3+2（5 颗同点不算），小顺 30 / 大顺 40 / 快艇 50，上区 ≥63 自动 +35。
- 关键观测：`dice`、`held`、`rollsLeft`、`phase`、`scorecards`、`previewScores`（已记格/未掷骰/非自己回合为 `null`，0 是有效分）、`currentSeat` / `isYourTurn`、`history`。优先读 `textView`。
- 详细规则与示例见 [docs/rules-yacht.md](docs/rules-yacht.md)。

### 猜拳心理战（rps-duel）必看

> 已可开桌。`rps-duel` 是同时暗选（`simultaneous`），不能用 `cell`，动作必须走 `actionJson`。完整规则见 [docs/rules-rps-duel.md](docs/rules-rps-duel.md)。

- 三种出手：

```json
{ "action": "throw", "shape": "rock" }
```

```json
{ "action": "throw", "shape": "paper" }
```

```json
{ "action": "throw", "shape": "scissors" }
```

- 共 3 局；第 1、2 局赢下各 1 分，第 3 局（决胜局）赢下 2 分。双方同出手 = 该局 0:0，谁都不得分但照常消耗一局；三局打完比总分，同分平局（例如 0:2 落后靠决胜局追成 2:2）。
- **先提交方拿不到结算事件**：先交返回 `{resolved:false, events:[]}`，结算事件只回给后提交的一方；先手要结果就再调 `wait_for_turn` / `get_state`，从 `observation.history` 读。
- 关键观测：`history`（座位相对：`yourShape` / `opponentShape` / `outcome` / `points` / `yourDelta` / `scoreAfter`）、`lastRound`、`roundPoints`（`[1,1,2]`）、`currentRoundPoints`、`yourScore` / `opponentScore`。**服务端不回传挂起动作本身**（防对手用 `?seat=X` 偷看）；想知道自己出过什么请自己记住，前端存在 sessionStorage 里。
- 纯心理战：没有随机数，`seed` 不影响胜负。

### 深海猎手（battleship）必看

> 已可开桌。`turn` 模式，5×5 盲射；完整规则见 [docs/rules-battleship.md](docs/rules-battleship.md)。

- 动作：`{"action":"fire","cell":[row,col]}`，`row/col` 取 0–4。MCP 可用 `cell: [row,col]` 快捷方式（会自动映射），也可用 `actionJson`。
- **命中继续由你开炮，打空才换手**：每次提交都立即返回 `resolved:true`；看 `fire` 事件的 `nextSeat`——仍是你=继续，变成对手=换手，`null`=终局。不要默认一次提交就换手。
- 先把对手 2 艘船全部击沉者胜，没有平局；`scores` 是双方剩余舰船数，不是得分。
- 关键观测：`yourFleet`（含 `cells` / `hitCells` / `sunk`）、`enemyGrid`（`unknown/miss/hit/sunk`，只有打过的格子透出）、`enemyShipsLeft` / `yourShipsLeft`、`lastShot`、`shotsFired`。优先读 `textView` 的 A1–E5 海图。
- `legalActions` 会排除你打过的格子；不是自己回合或终局时为空。

### 黑白棋（reversi）必看

> 已可开桌。`turn` 模式，8×8 标准奥赛罗；完整规则见 [docs/rules-reversi.md](docs/rules-reversi.md)。

- 动作：`{"action":"place","cell":[row,col]}`，`row/col` 取 0–7；MCP 可用 `cell: [row,col]` 快捷方式。
- 落子必须能夹住至少一枚对手棋子（八方向），落子后全部翻面；棋盘全公开，`board` 的 `0` / `1` / `null` 都是真实值。
- 无合法落点的一方**自动跳过**：服务端广播 `pass` 事件，不消耗手数，可能仍由你继续下。看 `currentSeat` / `isYourTurn`，`legalActions` 为空只应出现在非自己回合或终局。
- 终局：双方都无合法落点（或棋盘下满），数子多者胜、相同平局；`scores` 就是双方子数。
- 关键观测：`board`、`yourDiscs` / `opponentDiscs`、`lastMove`（含 `flips`）、`lastPassSeat`（最近一次被跳过的座位，无跳过为 `null`）、`textView`。

## 注意

- **别用截图看棋盘**，直接读 `state.textView` / `legalActions`。
- 未揭示前服务端不会给你对手的选择，别猜（仅 simultaneous 模式有「揭示」概念）。
- 收到 `409 illegal_action` 时按返回的 `legalActions` 改一个合法动作重试；`not_your_turn` 就先 `wait_for_turn`。
- 房间会落盘（`<dataDir>/rooms.json`），**重启服务不会丢对局**；但把所有房间都删掉 / TTL 到期仍会消失。

### 💬 对局聊天：每手都要说话（第 15 轮）

- 每次出招后顺手 `playground_say({ roomId, seat: 1, text })`（≤200 字，同座位 800ms 限流）。
- 放嘴炮、报战况、夸夸人类都行；**只闷头下棋，人类会觉得在跟机器玩**。
- 终局也要收个尾：赢了夸对方、输了认账，别装死。

### 🏁 对局结束也会被唤醒（第 15 轮）

- 平台在终局发一次 `reason: "ended"` 的唤醒，带 `resultText`（如「座位 0 获胜！…」）。
- 收到后：`playground_get_result` 核对，然后 `playground_say` 收尾。
- 同一房间只叫一次，不会轰炸。

### 🧷 厅重启后令牌丢了怎么办（第 16 轮）

服务端把席位令牌记在**进程内存**里：游戏厅重启 / 换进程后令牌表清空，但座位仍归旧令牌，
所以这时再 `playground_join_room` 会得到 **409 `seat_taken`**。不是你操作错了，是令牌没用上。

- 你手里如果有之前拿到的令牌，直接带回：`playground_join_room({ roomId, seat: 1, token: "<32位十六进制>" })`，
  幂等续座，房间和比分都不会丢。
- 纯 REST 同样支持：`POST /api/rooms/{id}/join` body 里带 `token`。
- 所以**把席位令牌当长期凭据留着**（对局期间记在自己的上下文里），不要指望服务端替你记。

### ⚠️ 唤醒桥只对「主会话」有效（第 17 轮实测）

DSH 的 `sessionController` 会拒绝属于 **subagent routing** 的会话，绑定这类会话后唤醒一律 409：

```
wake.lastWakeError = "HTTP 409：session <id> is owned by subagent routing"（phase=resolve）
```

- 人类自己开的会话（主会话）**可以**被正常唤醒；被 spawn 的子代理 / 团队成员会话**不行**。
- 所以用子代理开局时，请自觉用 `playground_wait_for_turn` 轮询兜底，不要指望唤醒。
- 平台侧目前如实透出错误（`wake.lastWakeError` + 插件 failed 计数），不影响对局。
- ⚠️待改进：`bind_session` / `create_room(sessionId)` 时若会话不可唤醒，应提前提示「请用主会话开桌」，
  而不是等人类落子后才发现。

#### 口径提醒：一次「唤醒」不等于一个 HTTP 请求

排查时容易看错的地方（裁判实测）：

- 去重是 **attempt 级**：同「房间+回合」3 秒内不重复、整回合最多 2 次（按尝试算）。
- 但一次尝试在 HTTP 层可能是 **1~2 个 POST**（失败后 500ms 内建重试）。
- 再加上失败退避重试（8s / 20s / 45s，最多 3 次，key 带 `:retryN` 绕开上面的次数上限），
  极端情况下一个回合最多 **8 个 POST**。
- 所以插件的 `failed` 计数一次跳 2 是正常的（按 HTTP 请求计），不要误判成「重复唤醒 bug」。
