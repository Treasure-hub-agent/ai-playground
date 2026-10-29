# API 契约 v0.1（人类 UI / Agent / MCP 共用）

服务地址：`http://127.0.0.1:8787`（`PORT` 环境变量可改）。所有 JSON 使用 UTF-8。
座位约定：**seat 0 = 人类，seat 1 = Agent**。

## 0. Agent 发现层（新会话自举用）

| 路径 | 用途 |
|---|---|
| `GET /llms.txt` | 纯文本接入说明（LLM 生态约定） |
| `GET /.well-known/ai-playground.json` | 机器可读描述：MCP 端点、REST 端点、工具清单、快速开始 |
| `GET /api/agent` | 同上（给只探 API 的 Agent） |
| `POST /mcp` | **MCP over HTTP**（Streamable HTTP）：`claude mcp add --transport http ai-playground http://127.0.0.1:8787/mcp` |
| `GET /AGENTS.md` | 仓库根 `AGENTS.md` 接入指南（`text/markdown`；大厅「给 Agent 的接入说明」按钮指向这里） |
| `GET /CREDITS.md` | `docs/CREDITS.md` 音频署名（`text/markdown`；CC-BY 4.0 要求可点到的署名页） |
| `GET /docs/<name>.md` | `docs/` 目录下**单层** Markdown 文档，如 `/docs/rules-yacht.md`；白名单 + 防路径穿越，找不到返回 404 |
| `GET /` | 首页 HTML 内嵌 `<noscript>` 与 meta，指向以上入口 |

### 0.1 静态资源与音频

- `pnpm build` 会先执行 `prebuild`（`scripts/sync-audio.mjs`），把 `assets/audio/` 同步到 `packages/web/public/audio/`，随前端 dist 发布；运行时 URL 形如 `/audio/bgm/calm-1.mp3`。
- 静态服务对 `.mp3` 返回 `audio/mpeg`、`.ogg` 返回 `audio/ogg`、`.wav` 返回 `audio/wav`、`.m4a` 返回 `audio/mp4`（避免 `<audio>` 拒播 `application/octet-stream`）。

## 1. 房间生命周期

`waiting`（等双方入座）→ `playing`（对局中）→ `ended`（结束，`result` 非空）。

## 2. REST 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/games` | 游戏列表 |
| POST | `/api/rooms` | 建房间，body `{"gameId":"grab"}`；响应里带 0 号位令牌 |
| GET | `/api/rooms/:id` | 房间摘要（公开，**不含** `humanUrlPath`，避免泄露令牌） |
| POST | `/api/rooms/:id/join` | 入座，body `{"seat":0}` 或 `{"seat":1}`，重连时带上 `{"token":"…"}`；响应里返回 `token` |
| GET | `/api/rooms/:id/state?seat=0&token=…` | 该座位的观测（**唯一读数出口**）；令牌不对时降级为旁观观测 |
| POST | `/api/rooms/:id/action` | 提交动作，body `{"seat":1,"token":"…","action":{"action":"grab","cell":[1,2]}}` |
| POST | `/api/rooms/:id/say` | 气泡聊天，body `{"seat":1,"token":"…","text":"这枚金币归我了"}`（限流 800ms/座位，≤200 字） |
| GET | `/api/rooms/:id/chat?since=0` | 聊天记录（`since` 为最后一条消息 id，公开） |
| GET | `/api/rooms/:id/result` | 结算结果（未结束为 `null`，公开） |
| GET | `/api/rooms/:id/log?seat=0` | 对局日志（含 seed/events，可回放，公开） |

> 席位令牌的完整规则见 [§5.1](#51-席位鉴权座令牌seat-token)。
> 一句话：**没有令牌就是旁观者**——能看公开信息，不能出招，也看不到对手的私有信息。

### 2.1 建房间响应

```json
{
  "roomId": "wleyow",
  "gameId": "grab",
  "humanUrlPath": "/?room=wleyow&seat=0&token=1f3c…",
  "agentSeat": 1,
  "rules": "……（同 GET /api/games 的 rules 全文）",
  "seatTokens": { "0": "1f3c…" }
}
```

`humanUrlPath` 里的 `token` 是 0 号位的座位令牌；前端读到后会存进 `sessionStorage` 并把地址栏里的令牌抹掉。
**这个响应只发给建房间的人**——`GET /api/rooms/:id` 的摘要里不含该字段。

### 2.2 观测（`/state`）响应

```json
{
  "gameId": "grab",
  "seat": 1,
  "round": 1,
  "roundsTotal": 9,
  "scores": { "0": 0, "1": 0 },
  "legalActions": [{ "action": "grab", "cell": [0, 0] }],
  "textView": "第 1/9 回合 · 你 0 分 · 对手 0 分\n第 0 行:  💰1| 💰2| 空 \n……",
  "status": "playing",
  "grid": [[1, 2, "empty"], [3, 3, 1], [2, "empty", "bomb"]],
  "history": [{ "round": 1, "picks": { "0": [0,0], "1": [2,2] }, "delta": { "0": 1, "1": 2 }, "collision": false }],
  "yourScore": 0,
  "opponentScore": 0,
  "roomId": "wleyow",
  "youSubmitted": false,
  "waitingFor": [0, 1],
  "result": null
}
```

`grid` 取值：`1|2|3` = 金币面值，`"bomb"` = 炸弹，`"empty"` = 空格，`"taken"` = 已被抢走。
**注意**：`grid` 是公开信息（双方都看得见宝物位置）；双方的「本回合选择」在揭示前**不在任何观测里出现**。

### 2.3 提交动作

成功（未满两人）：
```json
{ "ok": true, "resolved": false, "events": [] }
```
成功（双方到齐，服务器立即结算）：
```json
{
  "ok": true,
  "resolved": true,
  "events": [
    {
      "type": "reveal",
      "round": 1,
      "picks": { "0": [0,0], "1": [2,1] },
      "delta": { "0": 1, "1": 3 },
      "applied": { "0": "coin", "1": "coin" },
      "collision": false,
      "scores": { "0": 1, "1": 3 },
      "grid": [[ "taken", 2, "empty" ], "..."]
    }
  ]
}
```
非法动作（HTTP 409）：
```json
{ "ok": false, "error": "illegal_action", "legalActions": [{ "action": "grab", "cell": [0,1] }] }
```
错误码：`waiting_for_opponent` / `room_ended` / `seat_not_joined` / `action_already_submitted` / `illegal_action` / `not_your_turn`（turn 模式）。

### 2.4 快艇骰子（yacht）观测

> `yacht.meta.status` 已为 `"playable"`，`POST /api/rooms` 可直接建桌，MCP 规则资源 `playground://games/yacht/rules` 也已注册。`resolution = "turn"`，座位仍是 0 = 人类、1 = Agent。
>
> **测试开关**：`allowWip` 仅供自动化测试/联调使用——`POST /api/rooms` body 传 `{"allowWip":true}`，或启动服务时设 `PLAYGROUND_ALLOW_WIP=1`；wip 游戏默认仍返回 400，响应里带 `hint` 字段。

| 字段 | 类型 / 取值 | 说明 |
|---|---|---|
| `dice` | `number[5]` | 5 颗骰子；本手还没掷时全为 `0` |
| `held` | `boolean[5]` | 锁定状态；`true` = 下次 `roll` 不重掷这颗 |
| `rollsLeft` | `0–3` | 本手剩余掷骰次数 |
| `phase` | `"roll" \| "choice" \| "must_score"` | 未掷 / 可继续掷或记分 / 只能记分 |
| `scorecards` | `Record<"0" \| "1", Scorecard>` | 双方计分板；含 13 格与 `upperSubtotal` / `upperBonus` / `total` |
| `previewScores` | `Record<Category, number \| null>` | 当前骰面对 13 格的预览分；已记格、未掷骰、非自己回合、终局为 `null` |
| `upperTarget` | `63` | 上区奖励门槛 |
| `upperBonusValue` | `35` | 达标后奖励分 |
| `history` | `TurnRecord[]` | 已完成的记分：`{seat, category, gained, dice}` |
| `currentSeat` | `0 \| 1 \| null` | 当前行动方；终局为 `null` |
| `isYourTurn` | `boolean` | 是否轮到你 |
| `round` / `roundsTotal` | `number` | 全局手数（双方合计）/ `26` |
| `scores` | `{"0": number, "1": number}` | 双方当前总分（含上区奖励） |
| `legalActions` | `Action[]` | 当前合法动作；非自己回合或终局为 `[]` |
| `textView` | `string` | 纯文本盘面，优先读它 |

`Scorecard` 固定包含 13 个栏目字段（`ones`…`chance`，未记为 `null`）以及 `upperSubtotal`、`upperBonus`、`total`。turn 模式下服务端还会补 `roomId`、`status`、`currentSeat`、`isYourTurn`、`youSubmitted`（恒 `false`）、`waitingFor`（当前行动方）、`result`。

```json
{
  "gameId": "yacht",
  "seat": 1,
  "round": 2,
  "roundsTotal": 26,
  "scores": { "0": 27, "1": 0 },
  "currentSeat": 1,
  "isYourTurn": true,
  "status": "playing",
  "dice": [3, 3, 5, 1, 3],
  "held": [false, false, true, false, true],
  "rollsLeft": 2,
  "phase": "choice",
  "upperTarget": 63,
  "upperBonusValue": 35,
  "scorecards": {
    "0": { "ones": null, "twos": null, "threes": null, "fours": null, "fives": null, "sixes": null, "three_kind": 27, "four_kind": null, "full_house": null, "small_straight": null, "large_straight": null, "yacht": null, "chance": null, "upperSubtotal": 0, "upperBonus": 0, "total": 27 },
    "1": { "ones": null, "twos": null, "threes": null, "fours": null, "fives": null, "sixes": null, "three_kind": null, "four_kind": null, "full_house": null, "small_straight": null, "large_straight": null, "yacht": null, "chance": null, "upperSubtotal": 0, "upperBonus": 0, "total": 0 }
  },
  "previewScores": { "ones": 1, "twos": 0, "threes": 9, "fours": 0, "fives": 5, "sixes": 0, "three_kind": 15, "four_kind": 0, "full_house": 0, "small_straight": 0, "large_straight": 0, "yacht": 0, "chance": 15 },
  "legalActions": [
    { "action": "roll" },
    { "action": "hold", "indices": [0] },
    { "action": "hold", "indices": [] },
    { "action": "score", "category": "ones" }
  ],
  "history": [
    { "seat": 0, "category": "three_kind", "gained": 27, "dice": [5, 5, 5, 6, 6] }
  ],
  "textView": "快艇骰子 · 第 2/26 手 · 剩 2 次掷骰 · 轮到你了\n……"
}
```

`previewScores` 的 `null` 语义很重要：**已记过的格子、还没掷骰、不是你的回合、对局结束**都是 `null`；只要轮到你且已掷骰，未记格即使算出来是 0 也会返回 `0`。

> 上面的 `legalActions` 只示例了部分 score；实际 `phase="choice"` 会列出所有未记栏目，`must_score` 只列 score。

### 2.5 快艇骰子动作契约

```json
{ "action": "roll" }
```

```json
{ "action": "hold", "indices": [2] }
```

```json
{ "action": "score", "category": "full_house" }
```

- `roll`：重掷所有未锁定的骰子；每手最多 3 次，3 次后 `phase = "must_score"`。
- `hold`：**一次只切换一颗**，`indices` 只含一个 0–4 下标；`{"action":"hold","indices":[]}` 表示全部解锁。引擎可接受多下标，但服务端按 `legalActions` 模式校验，对外的合法动作只有「单颗 / 空数组」。
- `score`：`category` 是 13 个栏目之一且本玩家未记过；记分后立刻换手。必须先掷过骰才能记分。

`legalActions` 按局面变化：

**非自己回合**（`currentSeat !== seat`）：

```json
[]
```

**自己回合、3 次掷骰用完（`phase = "must_score"`）**：只有 score，且只列未记过的栏目。

```json
[
  { "action": "score", "category": "ones" },
  { "action": "score", "category": "twos" },
  { "action": "score", "category": "threes" }
]
```

**终局**（`status = "ended"`，`currentSeat = null`）：

```json
[]
```

作为参考：`phase = "roll"` 时只有 `[{ "action": "roll" }]`；`phase = "choice"` 时是 `roll` + 5 个单颗 `hold` + `hold: []` + 所有未记栏目的 `score`。提交的动作必须命中 `legalActions` 的某一项（键序无关、允许多余字段），否则返回 409 `illegal_action`；没轮到你返回 409 `not_your_turn`。

三种事件：

```json
{ "type": "roll", "seat": 0, "dice": [3, 3, 5, 1, 3], "held": [false, false, true, false, true], "rollsLeft": 2 }
```

```json
{ "type": "hold", "seat": 0, "held": [true, false, true, false, true] }
```

```json
{
  "type": "score",
  "seat": 0,
  "category": "three_kind",
  "gained": 27,
  "scorecard": { "three_kind": 27, "upperSubtotal": 0, "upperBonus": 0, "total": 27 },
  "nextSeat": 1
}
```

`score` 的 `scorecard` 是记分方的完整计分板快照（上面只列变化字段，实际含 13 格 + `upperSubtotal` / `upperBonus` / `total`）；`nextSeat` 为 `null` 表示对局结束，同批还会有一条 `end` 事件。`roll` 事件的 `held` 是掷骰前就锁定的骰子（掷骰不改变锁定）。

### 2.6 猜拳心理战（rps-duel）

> `resolution = "simultaneous"`，2 座，`meta.status = "playable"`。规则全文见 [rules-rps-duel.md](rules-rps-duel.md)。

**动作**（只能用 `actionJson`，没有 `cell` 快捷方式）：

```json
{ "action": "throw", "shape": "rock" }
```

`shape` 取 `rock`（石头）/ `paper`（布）/ `scissors`（剪刀）。未终局时 `legalActions` 恒为这 3 条；同一局重复提交返回 409 `action_already_submitted`（第一次的出手保持生效）。

**观测附加字段**：

| 字段 | 类型 / 取值 | 说明 |
|---|---|---|
| `round` / `roundsTotal` | `1–3` / `3` | 第几局；结束后 `round` = 已打局数（不会出现 4/3） |
| `history` | `RpsHistoryEntry[]` | **座位相对**：`{ round, yourShape, opponentShape, outcome: "win"\|"lose"\|"draw", points, yourDelta, opponentDelta, scoreAfter: { you, opponent } }` |
| `lastRound` | 同 `history` 一项 \| `null` | 最近一局；开局为 `null` |
| `roundPoints` | `number[]` | `[1,1,2]`，第 3 局翻倍 |
| `currentRoundPoints` | `1 \| 2 \| null` | 当前局分值；终局 `null` |
| `yourScore` / `opponentScore` | `number` | 座位相对累计分 |

**事件**：

```json
{
  "type": "reveal",
  "round": 1,
  "shapes": { "0": "rock", "1": "scissors" },
  "winner": 0,
  "points": 1,
  "delta": { "0": 1, "1": 0 },
  "scores": { "0": 1, "1": 0 },
  "labels": { "0": "石头", "1": "剪刀" }
}
```

**挂起动作不回传**：服务端没有鉴权，`?seat=X` 任何客户端都能请求，所以观测里**不会**出现「本局已提交的动作内容」——只给 `youSubmitted` 布尔值。前端要显示「你出了✊」请自己存（本项目用 sessionStorage）。

**同时暗选语义**：先提交方返回 `{resolved:false, events:[]}`，**结算事件只回给后提交的一方**；先手方要取结果，重新 `GET /state` 或 `wait_for_turn`，从 `observation.history` 读。终局时同批追加 `end` 事件。

### 2.7 深海猎手（battleship）

> `resolution = "turn"`，5×5 海域，每方 2 艘船（驱逐舰 2 格 + 潜艇 1 格）。规则全文见 [rules-battleship.md](rules-battleship.md)。

**动作**：`{"action":"fire","cell":[row,col]}`，`row/col` 取 0–4。

```json
{ "action": "fire", "cell": [2, 3] }
```

**命中连射**：命中时 `currentSeat` 保持为同一位座位（可以连续提交），打空才换手。这是唯一「同一个座位连续多次提交」的轮流制游戏，客户端不要假设一提交就轮转。

**观测附加字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `yourFleet` | `ShipView[]` | 自己的舰队：`{ id, name, size, cells, hitCells, sunk }` |
| `enemyGrid` | `5×5` 的 `"unknown" \| "miss" \| "hit" \| "sunk"` | 敌方海域；**只有自己打过的格子才透出结果**，沉没的船整船标 `sunk` |
| `enemyShipsLeft` / `yourShipsLeft` | `number` | 剩余舰船数 |
| `lastShot` | `{ round, seat, cell, hit, sunk } \| null` | 上一炮 |
| `shotsFired` | `number` | 自己已开炮次数 |
| `scores` | `{"0": n, "1": n}` | **剩余舰船数**（不是得分） |

**事件**：

```json
{
  "type": "fire",
  "seat": 0,
  "cell": [2, 3],
  "label": "D3",
  "hit": true,
  "sunk": null,
  "opponentShipsLeft": 1,
  "nextSeat": 0
}
```

`nextSeat` 为 `null` 表示对局结束（同批会有 `end`）。`sunk` 是船名（如 `"驱逐舰"`）。

**错误**：重复打同一格 / 越界 → 409 `illegal_action`（带 `legalActions`，已排除打过的格子）；非自己回合 → 409 `not_your_turn`。

### 2.8 黑白棋（reversi）

> `resolution = "turn"`，8×8 标准奥赛罗，座位 0 先手。规则全文见 [rules-reversi.md](rules-reversi.md)。

**动作**：`{"action":"place","cell":[row,col]}`，`row/col` 取 0–7。

**观测附加字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `board` | `8×8` 的 `0 \| 1 \| null` | 全公开棋盘；`0` = 座位 0 的子，`1` = 座位 1 的子 |
| `yourDiscs` / `opponentDiscs` | `number` | 双方子数 |
| `scores` | `{"0": n, "1": n}` | 等价于双方子数 |
| `lastMove` | `{ move, seat, cell, flips } \| null` | 上一手；`flips` 是被翻子的坐标数组 |
| `lastPassSeat` | `0 \| 1 \| null` | 最近一次被跳过的座位（无跳过为 `null`） |

**自动跳过**：轮到的一方若没有合法落点，内核会直接跳过并广播 `pass` 事件（不消耗手数，可能仍由同一位座位继续下）。因此 `legalActions` 为空时应理解为「不是你的回合」或「已终局」，而不是「你被卡住了」。

**事件**：

```json
{ "type": "place", "seat": 0, "cell": [2, 3], "flips": [[3, 3]], "counts": { "0": 4, "1": 1 }, "board": [[...]] }
```

```json
{ "type": "pass", "seat": 1, "nextSeat": 0 }
```

**终局**：双方都无合法落点（或棋盘下满）时结束，`result.scores` 是子数，相同算平局。

## 3. WebSocket

`ws://127.0.0.1:8787/ws?room=<roomId>`（Vite 开发时走代理 `ws://localhost:5173/ws?room=...`）。

- 连接后立即收到：`{"type":"hello","roomId":"...","summary":{...}}`
- 之后收到：
  - `{"type":"events","roomId":"...","events":[ ...同 REST 的 events... ]}`（揭示/结束/聊天事件都会推送）
  - 聊天事件形如 `{"type":"chat","message":{"id":3,"seat":1,"text":"...","at":169...}}`，包在 `events` 数组里推送
- 重连策略：指数退避；重连后拉一次 `/state` 与 `/chat?since=<lastId>` 补齐。

## 4. 事件类型（events 数组元素）

| type | 字段 | 何时 |
|---|---|---|
| `reveal` | round, picks, delta, applied, collision, scores, grid | grab：每回合双方动作到齐、结算后 |
| `drop` | seat, column, row, board, nextSeat, lastMove | connect4：每次落子后（详见 [rules-connect4.md](rules-connect4.md)） |
| `roll` | seat, dice, held, rollsLeft | yacht：每次掷骰后 |
| `hold` | seat, held | yacht：每次切换锁定后 |
| `score` | seat, category, gained, scorecard, nextSeat | yacht：每次记分后；`nextSeat=null` 表示终局 |
| `end` | result: {winner, scores, text} | 对局结束（grab 与最后一个 reveal、connect4 与最后一个 drop、yacht 与最后一个 score 同批） |
| `chat` | message: {id, seat, text, at} | 有人发言 |

## 5. 回放

`GET /api/rooms/:id/log?seat=0` 返回 `{roomId, gameId, seed, seat, result, rules, events, createdAt}`。
注意：`events` 数组元素是**包装结构** `{"t": <时间戳>, "event": { ...事件... }}`，`event` 字段才是 §4 里的事件本体。
`seed` 由内核重建初始盘面，`events` 依次回放即完整对局；日志按座位导出，不含未揭示的私有信息（本游戏互为公开信息，只需保证未揭示选择不落地）。

## 5.1 席位鉴权（座位令牌 seat token）

**这一节是 2026-10-28 第 12 轮加的，属于破坏性变更**：`?seat=` 不再代表身份，只表示「我想以哪个座位的视角看」。

### 令牌从哪来

| 时机 | 谁拿到 | 怎么拿 |
|---|---|---|
| `POST /api/rooms` | 0 号位（人类） | 响应里的 `seatTokens["0"]`，同时写进 `humanUrlPath` 的 `token` 查询串 |
| `POST /api/rooms/:id/join {"seat":1}` | 1 号位（Agent） | 入座响应里的 `token` |

令牌是 32 位十六进制；服务端按「房间 + 座位」存，重启即失效（房间本来也在内存里）。

### 请求怎么带

- `GET /state`：查询串 `?seat=0&token=<t>`
- `POST /action` / `POST /say`：请求体里加 `"token": "<t>"`
- `POST /join`：请求体里加 `"token": "<t>"`（重连时用；不带就等于「我是新来的」）
- 三种带法任选，优先级 **请求体 > 查询串 > 请求头**：
  - 请求体 `{"token": "<t>"}`
  - 查询串 `?token=<t>`
  - 请求头 `X-Seat-Token: <t>`（不想把凭据写进 URL 与访问日志时用它）
- **形状提醒**：REST 的 `/state` 直接返回观测对象本身（字段在顶层）；MCP 的
  `playground_get_state` 包在 `structuredContent` 里。按哪个接口取，就按哪个形状解析。
- **「自动附加令牌」只对 MCP 客户端成立**（MCP server 进程内按房间记住令牌）；
  裸 HTTP 调用方必须每次自己带。

### 三种结果

| 情况 | `GET /state` | `POST /action` / `/say` |
|---|---|---|
| 令牌正确 | 正常观测，`spectator: false` | 正常执行 |
| 令牌缺失 / 错误 | **降级为旁观观测**（不报错），`spectator: true`、`seat: null`、`legalActions: []` | `403 {"error":"seat_token_required"}` |
| 座位已被占 + `join` 不带令牌 | —— | `409 {"error":"seat_taken"}` |

旁观是**故意不报错**的：把房间链接发给朋友围观是正当场景。
但旁观者拿不到任何私有信息——深海猎手的 `yourFleet` 是空数组、`enemyGrid` 全是 `unknown`，猜拳/抢宝的挂起出手本来就不在任何观测里。

### 为什么 WebSocket 不用令牌

所有游戏事件都只在**结算之后**才广播（同时暗选要双方到齐才 `step`），事件流本身是公开信息。给 WS 加鉴权只会让围观变复杂，换不来安全性。

### 兼容性

老的调用方（不带令牌）不会报错，但会**静默降级成旁观者**：`legalActions` 永远为空、`isYourTurn` 永远是 `false`。
如果你的 Agent 突然「看不到能做什么」，先检查是不是忘了 `join` 拿令牌。

## 5.2 座位取值范围

所有带 `seat` 的读写接口都只接受 `0` 或 `1`，其它值返回 400 `{"error":"seat 必须是 0（人类）或 1（Agent）"}`。
座位取值范围与「有没有权限」是两件事：合法座位号 + 错误令牌 = 旁观，不是 400。

## 6. 给实现者的约束

- **不得绕过 `/state` 读私有信息**；UI 只渲染观测里给的字段。
- 提交动作前先校验 `legalActions`；409 时用返回的 `legalActions` 纠正后重试。
- 服务端为唯一裁判：骰子/随机/布阵全部在 `@ai-playground/core` 内核完成。
- 服务端只监听回环地址（默认 `127.0.0.1`）；不保存任何模型密钥。
