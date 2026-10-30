# @ai-playground/mcp

把《AI 游乐场》（抢宝 / 四子棋 / 快艇骰子 / 猜拳心理战 / 深海猎手 / 黑白棋）包装成 **MCP stdio server**，让 Claude Code / Codex / DSH 等 Agent 能像调用本地工具一样和人类同桌玩游戏。

```
Agent (MCP client)
   │  stdio（JSON-RPC / MCP）
   ▼
packages/mcp/src/cli.ts  ──►  src/index.ts（McpServer：10 tools + 动态规则资源）
                                  │ HTTP
                                  ▼
                     http://127.0.0.1:8787（packages/server）
```

座位约定：**seat 0 = 人类，seat 1 = Agent**。服务地址来自环境变量 `PLAYGROUND_URL`，默认 `http://127.0.0.1:8787`。

> **stdout 只能走 MCP 协议。** 本包所有日志都写 stderr；改代码时别在 `src/index.ts` / `src/cli.ts` 里 `console.log`。

---

## 1. 前置条件

- Node 24 + pnpm 11，依赖已安装（`packages/mcp/package.json` 里是 `@modelcontextprotocol/sdk` + `zod`）。
- **后端必须先启动**，MCP server 只是 REST API 的壳：

```powershell
cd ai-playground   # 换成你自己的仓库路径
pnpm -C packages/server start
# 健康检查：http://127.0.0.1:8787/api/games
```

如果后端不在默认地址：

```powershell
$env:PLAYGROUND_URL = 'http://127.0.0.1:8787'
```

---

## 2. 快速验证

```powershell
cd ai-playground   # 换成你自己的仓库路径

# 1) HTTP 客户端冒烟：建桌 → 双方入座 → 双方提交 → reveal → say → exportLog
pnpm -C packages/mcp exec tsx test/smoke.ts

# 2) MCP 协议级 E2E：官方 Client + InMemoryTransport，跑全部 10 个工具 + 规则资源 + 409 路径
pnpm -C packages/mcp exec tsx test/mcp-e2e.ts

# 3) 快艇骰子专项：create_room(yacht) → roll / hold / score → 换手 → must_score / ended 分支
pnpm -C packages/mcp exec tsx test/yacht-mcp-e2e.ts

# 4) 直接启动 stdio server（正常会一直挂起；看 stderr 有「已连接」即可 Ctrl+C）
pnpm -C packages/mcp exec tsx src/cli.ts
```

一键跑 1–3（需要后端已启动）：

```powershell
pnpm -C packages/mcp test
```

> 上面 3 个自动化测试都会真实请求 `PLAYGROUND_URL` 上的后端。后端不在 8787 时：
>
> ```powershell
> $env:PLAYGROUND_URL = 'http://127.0.0.1:8788'
> pnpm -C packages/mcp exec tsx test/yacht-mcp-e2e.ts
> ```
>
> wip 游戏（暂未上线）默认会被大厅拒绝建桌；`createRoom` 会先不带 `allowWip` 建桌，收到 400 + `hint` 后自动带 `{"allowWip":true}` 重试（仅测试用）。当前 6 款可玩游戏都是 `playable`，不会走到这条路径。

成功时 smoke 最后一行是：

```
✅ 冒烟测试全部通过（客户端 ↔ 后端契约 OK）
```

---

## 3. MCP 客户端配置

以下路径以本机为例；换机器时把 `D:/CODEX/deepseek-work/01-projects/ai-playground` 换成实际项目路径即可。Windows 上 `pnpm` 是 `.cmd`，所以统一用 `cmd /c pnpm ...` 启动；macOS / Linux 把 `"command": "cmd"` 那段换成 `"command": "pnpm"` 并去掉 `/c` 即可。

### 3.1 Claude Code（项目级 `.mcp.json`）

在项目根目录新建/修改 `.mcp.json`：

```json
{
  "mcpServers": {
    "ai-playground": {
      "command": "cmd",
      "args": [
        "/c",
        "pnpm",
        "-C",
        "D:/CODEX/deepseek-work/01-projects/ai-playground/packages/mcp",
        "exec",
        "tsx",
        "src/cli.ts"
      ],
      "env": {
        "PLAYGROUND_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

或者用 Claude Code CLI 注册：

```powershell
claude mcp add ai-playground -- cmd /c pnpm -C D:/CODEX/deepseek-work/01-projects/ai-playground/packages/mcp exec tsx src/cli.ts
```

### 3.2 Codex（`~/.codex/config.toml`）

Codex 用 TOML（不是 JSON）。在 `~/.codex/config.toml` 追加：

```toml
[mcp_servers.ai-playground]
command = "cmd"
args = ["/c", "pnpm", "-C", "D:/CODEX/deepseek-work/01-projects/ai-playground/packages/mcp", "exec", "tsx", "src/cli.ts"]
env = { PLAYGROUND_URL = "http://127.0.0.1:8787" }
startup_timeout_sec = 20
tool_timeout_sec = 120
```

也可以：

```powershell
codex mcp add ai-playground -- cmd /c pnpm -C D:/CODEX/deepseek-work/01-projects/ai-playground/packages/mcp exec tsx src/cli.ts
```

> 旧版 Codex 若不认识 `startup_timeout_sec` / `tool_timeout_sec`，删掉这两行即可；`tool_timeout_sec` 建议 ≥120，因为 `playground_wait_for_turn` 默认会等 60 秒。

### 3.3 DSH（cordis 插件配置，YAML）

DSH 的 MCP 客户端是插件 `@deepseek-ai/dsh-mcp-client`，配置是 **cordis YAML 插件条目**（不是 JSON）。在本机 profile 的补丁文件 `<DSH 配置>/profiles/desktop/cordis.patch.yml` 顶层数组追加：

```yaml
- id: mcp-ai-playground
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: ai-playground
    transport: stdio
    command: cmd
    args:
      - /c
      - pnpm
      - -C
      - D:/CODEX/deepseek-work/01-projects/ai-playground/packages/mcp
      - exec
      - tsx
      - src/cli.ts
    env:
      PLAYGROUND_URL: http://127.0.0.1:8787
    toolCallTimeoutMs: 120000
```

重启 / 重载 DSH 后，工具会以 `mcp__ai-playground__playground_create_room` 这样的名字出现（`mcp__<serverName>__<工具名>`）。规则资源 `playground://games/grab/rules` 需要 profile 启用 `@deepseek-ai/dsh-mcp-resources` 才能直接读取；不启用也不影响玩，`playground_create_room` 的返回里就带完整规则。

### 3.4 JSON 版通用配置

如果某个客户端只认 Claude 风格的 `mcpServers` JSON（例如通用 MCP 桥），可复用 3.1 的片段；把 `command` 换成客户端的实际可执行文件、`args` 换成 `["/c", "node", ".../node_modules/tsx/dist/cli.mjs", "src/cli.ts"]` 也可行，但推荐继续用 `pnpm -C` 以复用 workspace 安装。

---

## 4. 工具清单

所有工具都同时返回：

- `content[0].text`：给人 / 模型直接读的中文摘要（含下一步建议）；
- `structuredContent`：同内容的 JSON，便于程序化处理（409 时含 `legalActions`）。

| 工具 | 参数（默认值） | 作用 |
|---|---|---|
| `playground_list_games` | — | 列出可玩游戏（id / 名称 / 简介 / 规则），wip 游戏单列「开发中」 |
| `playground_create_room` | `gameId="grab"`, `sessionId?` | 建房间；返回 `roomId`、`humanUrl`、规则与下一步提示；wip 游戏自动 allowWip 重试；带 `sessionId` 等于建桌后立即绑定唤醒会话 |
| `playground_join_room` | `roomId`, `seat=1`, `sessionId?` | 入座（幂等）；`seat=0` 可模拟人类；带 `sessionId` 等于入座后立即绑定唤醒会话 |
| `playground_bind_session` | `roomId`, `sessionId` | 唤醒桥：绑定 DSH 会话，轮到 Agent 时服务端主动 POST 唤醒它（幂等，可改绑） |
| `playground_wait_for_turn` | `roomId`, `seat=1`, `timeoutSeconds=60` | 每 500ms 轮询，直到轮到你（turn 模式看 `isYourTurn`，同时暗选看 `youSubmitted`）/ 结束 / 超时；返回观测 |
| `playground_get_state` | `roomId`, `seat=1` | 读该座位观测（唯一读数出口）：`textView`、`legalActions`、比分、`phase` 等 |
| `playground_submit_action` | `roomId`, `seat=1`, `cell=[r,c]` 或 `actionJson` | 提交动作；409 时把 `legalActions` 放进 `structuredContent` 并提示重选 |
| `playground_say` | `roomId`, `seat=1`, `text`（≤200 字） | 发气泡聊天（同座位 800ms 限流） |
| `playground_get_result` | `roomId` | 查结算；未结束时 `result=null` |
| `playground_export_log` | `roomId`, `seat=1` | 导出日志（seed / rules / 对局 events，可回放） |

`playground_submit_action` 的写法：

```json
{ "roomId": "abc123", "seat": 1, "cell": [1, 2] }
```

```json
{ "roomId": "abc123", "seat": 1, "actionJson": "{\"action\":\"grab\",\"cell\":[1,2]}" }
```

`cell` 会按当前 `legalActions` 映射：抢宝 → `{action:"grab",cell}`，四子棋 → `{action:"drop",column}`，深海猎手 → `{action:"fire",cell}`，黑白棋 → `{action:"place",cell}`。
**快艇骰子和猜拳心理战没有坐标概念，必须用 `actionJson`**：

```json
{"action":"roll"}
{"action":"hold","indices":[0]}
{"action":"score","category":"full_house"}
```

```json
{"action":"throw","shape":"rock"}
```

快艇骰子动作细节：

- `hold` 是**单颗 toggle**：`indices:[0]` 把第 0 颗锁定/解锁；要锁多颗就连续发多次；`indices:[]` 全部解锁。
- 一手中只有 `score` 换手；`roll` / `hold` 后仍是你的回合。
- `phase`：`roll` 只能掷 → `choice` 可掷/锁/记 → `must_score` 3 次掷骰用完、只能记分。
- 13 个 `category`：`ones` `twos` `threes` `fours` `fives` `sixes` `three_kind` `four_kind` `full_house` `small_straight` `large_straight` `yacht` `chance`。

### 🔔 唤醒桥：轮到 Agent 时主动叫醒会话（第 14 轮）

DSH 的会话是消息驱动的：回合结束就休眠，人类在浏览器落子不会自动注入会话。
把房间绑定到一个会话后，**轮到 Agent 时服务端会主动 POST 到 DSH 插件的 `/wake`**，
Agent 不用自己定闹钟轮询。

三种绑定方式等价（幂等，可改绑）：

```json
{ "roomId": "abc123", "sessionId": "session-2fbf0714-…" }
```

```json
{ "gameId": "grab", "sessionId": "session-2fbf0714-…" }
```

```json
{ "roomId": "abc123", "seat": 1, "sessionId": "session-2fbf0714-…" }
```

分别对应 `playground_bind_session` / `playground_create_room` / `playground_join_room`。
`sessionId` 通常就是环境变量 `DSH_SESSION_ID`（只允许 `A-Za-z0-9._:-`，最长 128）。

- 触发时机：轮流制结算后 `currentSeat=1`；同时暗选里人类已提交、Agent 未提交。**对局结束不发**。
- 去重：同一「房间+回合」至少间隔 3 秒，整回合最多 2 次（只叫醒，不托管整局）。
- 投递（平台 → 插件）：`POST $WAKE_URL`，头 `x-wake-secret`，body
  `{ roomId, sessionId, gameId, round, textView, createdAt, nonce }`；
  超时 2s、失败重试 1 次（间隔 500ms）；失败只记服务端日志，**不影响对局**。
- 平台配置：`WAKE_URL` / `WAKE_SECRET`。**不配 = 功能关闭**，行为与以前完全一致。
- 排查：`GET /api/rooms/{id}` 的 `wake: { boundSessionId, lastWakeAt, lastWakeError }`（只读）。
- 纯 REST：`POST /api/rooms/{id}/bind  {"sessionId":"<DSH_SESSION_ID>"}`。

### 资源

规则资源按 core 的 `games` 注册表动态生成（新增游戏自动出现）：

| URI | 类型 | 内容 |
|---|---|---|
| `playground://games/grab/rules` | `text/markdown` | 《抢宝大作战》完整规则 |
| `playground://games/connect4/rules` | `text/markdown` | 《四子棋》完整规则 |
| `playground://games/yacht/rules` | `text/markdown` | 《快艇骰子》完整规则 |
| `playground://games/rps-duel/rules` | `text/markdown` | 《猜拳心理战》完整规则 |
| `playground://games/battleship/rules` | `text/markdown` | 《深海猎手》完整规则 |
| `playground://games/reversi/rules` | `text/markdown` | 《黑白棋》完整规则 |

### 推荐 Agent 流程

```
playground_create_room
  → 把 humanUrl 发给人类
  → playground_join_room(seat=1)
  → playground_wait_for_turn
  → 读 textView / legalActions（快艇骰子还要看 phase / dice / held / previewScores）
  → playground_submit_action（坐标类用 cell；快艇骰子 / 猜拳心理战用 actionJson）
  → 循环 wait_for_turn / submit_action 直到 ended
  → playground_get_result（+ 可选 export_log）
```

规则要点：

- **grab**：3×3 棋盘、9 回合，双方同时暗选；金币加分、炸弹扣 2 分、撞车谁都拿不到。
- **connect4**：7 列重力落子，先连成四子者胜；只有轮到你时 `legalActions` 才非空。
- **yacht**：5 颗骰、每手最多掷 3 次，锁骰重掷，13 栏各记一次；上区 ≥63 有 +35 奖励，总分高者胜。
- **rps-duel**：3 局同时暗出手，第 1/2 局各 1 分、决胜局 2 分；同出手该局 0:0；三局后总分高者胜，同分平局。
- **battleship**：5×5 盲射，命中继续开炮、打空换手；先击沉对手 2 艘船者胜，没有平局。
- **reversi**：8×8 黑白棋，落子必须夹住并翻面；无合法点自动 pass，双方都无子可下时数子多者胜。

---

## 5. 错误处理约定

- 所有错误都是**中文可读文本**，MCP 返回 `isError: true`，不会让 server 崩溃。
- 连不上后端时会提示先跑 `pnpm -C packages/server start`，并回显当前 `PLAYGROUND_URL`。
- 服务端 409（如 `illegal_action` / `not_your_turn`）会把错误码和 `legalActions` 一起放进 `structuredContent`；工具会再读一次观测，并按场景说明原因：
  - `isYourTurn=false` / `not_your_turn` → 还没轮到你，先 `playground_wait_for_turn`；
  - `status=ended` / `room_ended` → 对局已结束，用 `playground_get_result` 收尾；
  - `phase=must_score` → 3 次掷骰用完，只能提交 `{"action":"score","category":"..."}`。
- `playground_wait_for_turn` 超时不是错误（`isError` 不置位），返回 `timedOut=true` + 当前观测，模型可决定继续等或查状态。

服务端错误码对照：`waiting_for_opponent`（对手未入座）、`room_ended`（对局已结束）、`seat_not_joined`（座位未入座）、`action_already_submitted`（同时暗选：本回合已提交）、`not_your_turn`（轮流制：还没轮到你）、`illegal_action`（动作不在 legalActions）。

---

## 6. 目录结构

```
packages/mcp/
├─ src/
│  ├─ client.ts    # fetch 封装：listGames/createRoom/joinRoom/bindSession/getState/submitAction/say/getResult/exportLog
│  ├─ index.ts     # createMcpServer()：注册 10 tools + 动态规则资源；startMcpServer()
│  └─ cli.ts       # 入口：startMcpServer()，stderr 打「已连接/等待 stdio」
├─ test/
│  ├─ smoke.ts           # 直连 HTTP 客户端的 grab 冒烟（无需 MCP 客户端）
│  ├─ mcp-e2e.ts         # 官方 SDK Client + InMemoryTransport 的协议级 E2E
│  ├─ yacht-mcp-e2e.ts   # 快艇骰子专项：roll / hold / score / must_score / ended
│  ├─ http-mcp.ts        # MCP over HTTP（/mcp）冒烟，需要 server 的 streamable HTTP 端点
│  └─ play-agent.ts      # 长时间自动对局脚本（默认连 /mcp）
├─ package.json
└─ README.md
```

---

## 7. 已知限制

- 房间只存在后端内存里：后端重启后房间丢失，需重新建桌。
- 大厅里标 `wip` 的游戏（暂未上线）默认不能建桌；`createRoom` 会按服务端 `hint` 自动带 `{"allowWip":true}` 重试一次（仅供测试）。当前 6 款可玩游戏都是 `playable`。
- `export_log` 的 `events` 只含对局事件（grab / rps-duel: reveal/end；turn 类游戏: drop / roll / hold / score / fire / place / pass / end），聊天记录走 `/api/rooms/:id/chat`，不在回放日志里。工具文本输出超过 8000 字符会截断，完整 JSON 在 `structuredContent`。
- `playground_wait_for_turn` 默认等 60 秒；如果 MCP 客户端工具超时更短，请显式传更小的 `timeoutSeconds`。
- `src/index.ts` 里对 `server.registerTool` 做了一次窄化封装：SDK 1.32 的 `registerTool` 泛型在 TypeScript 5.6 + zod v3 下会触发 `TS2589`（类型实例化过深），运行时没有影响；升级 TS / SDK 后可移除该封装。
- 规则资源按 core 的 `games` 注册表动态生成：改 `packages/core/src/games/<id>.ts` 的 RULES，MCP 资源与 `create_room` 返回会自动跟随。
