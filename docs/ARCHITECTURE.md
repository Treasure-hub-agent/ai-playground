# 架构说明（开发参考）

> 版本：2026-10-26 ｜ 适用仓库：`ai-playground`
> 这份文档是**开发时的权威参考**：新增游戏、改协议、动 UI 之前先读它。

---

## 1. 仓库结构

```text
ai-playground/
├─ packages/
│  ├─ core/     游戏内核：GameSpec 接口、各游戏实现、目录（catalog）、种子随机
│  ├─ server/   HTTP + WebSocket + MCP over HTTP；房间与结算裁判；静态托管 web/dist
│  ├─ mcp/      MCP stdio server（9 个 playground_* 工具 + 规则 resource）
│  ├─ cli/      命令行入口 ai-playground [serve|mcp]
│  └─ web/      React + Vite 人类端（大厅 / 牌桌 / 结算）
├─ scripts/     e2e、replay 等验证脚本
├─ docs/        架构、API 契约、规则、Agent 接入、交接报告、调研
└─ assets/      截图与打赏占位图
```

依赖方向：`web` / `mcp` / `server` → `core`；`server` → `mcp`（HTTP MCP 复用同一套工具）。`core` 不依赖任何包。

---

## 2. 内核：GameSpec

```ts
interface GameSpec<TState> {
  meta: GameMeta;
  setup(seed: number): TState;                       // 必须确定性（同 seed 同局面）
  observe(state, seat): Observation;                 // 观测唯一出口（隐藏信息在这里遮蔽）
  legalActions(state, seat): Action[];               // 合法动作枚举（对局结束后返回 []）
  step(state, actions): { state: TState; events: GameEvent[] };
  isTerminal(state): boolean;
  result(state): { winner: Seat | null; scores; text };
  currentSeat?(state): Seat | null;                  // 仅 resolution='turn' 需要
}
```

`GameMeta` 字段：

| 字段 | 用途 |
|---|---|
| `id / name / tagline / seats / rules` | 标识与给 Agent 的规则全文 |
| `category / tags / duration` | 大厅筛选与卡片展示 |
| `status: 'playable' \| 'wip'` | 可开桌 / 未上线 |
| `accent` | 卡片主题色 |
| `resolution: 'simultaneous' \| 'turn'` | 结算模式，见 §4 |

---

## 3. 观测与事件

观测（`GET /api/rooms/:id/state?seat=N` 与 MCP `get_state`）共同字段：

```json
{
  "gameId": "grab", "seat": 1, "round": 2, "roundsTotal": 9,
  "status": "playing", "scores": { "0": 3, "1": 2 },
  "legalActions": [{ "action": "grab", "cell": [1, 2] }],
  "textView": "给纯文本 Agent 的 ASCII 局面",
  "currentSeat": 1, "isYourTurn": true
}
```

- `currentSeat` / `isYourTurn` 在所有游戏里都返回（`simultaneous` 类恒为「轮到双方」，`isYourTurn` 表示你本回合还没提交）。
- 各游戏可追加自己的字段（如 `grab` 的 `grid / history`，`connect4` 的 `board`）。
- 事件（WS `events` 与 REST 响应里的 `events`）必须自带前端渲染所需的最小信息；`end` 事件带 `result`。

---

## 4. 两种结算模式（`meta.resolution`）

| 模式 | 语义 | 服务端行为 | 例 |
|---|---|---|---|
| `simultaneous` | 双方同时暗选，都到齐才结算 | 收到 seat0 的动作先挂起；seat1 到齐后一起 `step`，广播 `reveal` | 抢宝大作战 / 猜拳心理战 |
| `turn` | 轮流行动，当前行动方提交即结算 | 校验 `currentSeat === seat`，只把该座位动作传给 `step`，立刻广播事件并换手 | 四子棋 / 快艇骰子 / 深海猎手 / 黑白棋 |

`turn` 模式下的错误码：
- `not_your_turn`：不是你的回合（前端据此提示「等对方」）。

`simultaneous` 模式下的错误码沿用：`waiting_for_opponent / action_already_submitted / illegal_action / room_ended`。

---

## 5. 服务端（packages/server）

```text
POST /api/rooms                建房间（wip 游戏返回 400）
POST /api/rooms/:id/join       入座（seat 0/1）
GET  /api/rooms/:id/state      观测（唯一读数出口）
POST /api/rooms/:id/action     提交动作（按 resolution 分流）
POST /api/rooms/:id/say        气泡聊天（800ms 限流）
GET  /api/rooms/:id/chat       聊天增量
GET  /api/rooms/:id/result     结算
GET  /api/rooms/:id/log        对局日志（可回放）
WS   /ws?room=<id>             hello + events 推送
POST /mcp                      MCP over HTTP（无状态）
GET  /llms.txt | /.well-known/ai-playground.json | /api/agent
```

房间状态：`state / pending / status / occupied / seatTokens / chat / log / result`，并落盘到
`<dataDir>/rooms.json`（`.tmp` + `renameSync` 原子写、400ms 防抖、退出时同步 flush），**服务重启不丢对局**。
`PLAYGROUND_DATA_DIR` 改目录，`PLAYGROUND_PERSIST=0` 关闭；`Room.game` 是函数对象不落盘，恢复时按 `gameId` 重新挂载。

---

## 6. 前端（packages/web）

```text
main.tsx → App.tsx ──(URL ?room=)──> GameRoom.tsx
                    └─(无 room)────> Lobby.tsx
styles.css   旧版基础样式（保留，被 theme.css 覆盖）
theme.css    设计系统：颜色/圆角/阴影/字距/动效/组件样式
components/Icons.tsx  线条 SVG 图标（金币/炸弹/头像/各游戏图形）
components/Board.tsx  抢宝棋盘（gameId=grab）
```

多游戏适配约定：
- **棋盘渲染按 `gameId` 分流**：`components/boards/<game>Board.tsx`；大厅卡片图形用 `Icons.GameGlyph`。
- **动作构造按 `gameId` 分流**：`web/src/games/registry.ts` 的 `actionForPick(gameId, [row, col])`。
- **规则速查按 `gameId` 分流**：`rulesFor(gameId)`。
- 新增游戏时同步在 web 注册这三处，缺一不可。

交互与动效约束：
- 所有动效必须尊重 `prefers-reduced-motion`。
- 棋盘可点提示只在 hover 出现，避免整盘闪烁。
- 提交后立即有「已提交」反馈；错误用 toast，不阻塞棋盘。

---

## 7. 新增一款游戏（清单）

1. `packages/core/src/games/<id>.ts`：实现 `GameSpec`，写 `meta`（含 `resolution`）。
2. `packages/core/src/index.ts`：在 `games` 注册表登记（大厅自动出现，状态为可玩）。
3. `packages/core/test/<id>.test.ts`：覆盖 setup / 合法动作 / 胜负 / 终局 / 观测遮蔽。
4. `packages/server/test/rooms.test.ts`：补一条房间级用例（尤其 `turn` 模式的 `not_your_turn`）。
5. `packages/web/src/components/boards/<Id>Board.tsx` + `games/registry.ts` 三处登记。
6. `docs/rules-<id>.md`：人类版 + Agent 版规则。
7. 跑 `pnpm -C packages/core test && pnpm -C packages/server test && pnpm e2e && pnpm build`。
8. 截图存 `assets/`，更新 README 游戏库表格。

---

## 8. 测试与验证

| 命令 | 覆盖 |
|---|---|
| `pnpm -C packages/core test` | 内核规则单测 |
| `pnpm -C packages/server test` | 房间/结算/错误码（含 turn 模式） |
| `pnpm e2e` | 真实 HTTP + WS 打完整局、断言协议 |
| `pnpm -C packages/mcp exec tsx test/smoke.ts` | MCP stdio 客户端冒烟 |
| `pnpm -C packages/mcp exec tsx test/http-mcp.ts` | MCP over HTTP 冒烟（模拟新会话 Agent） |
| `pnpm replay --room <id>` | 由 seed + picks 回放并逐项对账 |
| `pnpm build` | 前端构建（server 静态托管产物） |

---

## 9. 关键设计决策（简版 ADR）

| 决策 | 理由 |
|---|---|
| TypeScript monorepo | 内核/服务/UI 同语言，Agent 部署只需一条命令 |
| 无内置 AI，只面向外部 Agent | 产品定位：Agent 就是对手；引擎只当裁判 |
| MCP over HTTP + stdio 双形态 | 新会话 Agent 拿一个 URL 即可接入，无需翻源码 |
| 观测遮蔽唯一出口 | 防偷看；UI 与 Agent 都只能通过 `observe` 拿信息 |
| 内核确定性 + seed 回放 | 可复现、可对账、可做回放 UI |
| 注册表驱动的大厅 | 加游戏不改大厅代码；未上线游戏用 `wip` |
| CSS 覆盖层（theme.css） | 老样式保留可回滚，新设计集中管理 |

