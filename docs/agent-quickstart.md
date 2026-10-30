# Agent 快速接入（MCP / REST）

面向：Claude Code、Codex、DeepSeek Harness（DSH）等 MCP 客户端，以及想直接调 REST 的 Agent 开发者。

目标：**三步内完成接入，然后每回合只做一件事——从 `legalActions` 里挑一个，提交。**

> 当前 `packages/mcp` 仍在开发中。工具名和参数以本文 + `packages/mcp` 实现为准；如果你的克隆里 `packages/mcp/src` 还不存在，先用文末的 REST 兜底，同样能打完一整局。

## 0. 前提

1. 服务端已启动：`pnpm dev`（API 在 `http://127.0.0.1:8787`）。
2. 人类已经开好桌（浏览器点「开一桌」），或者你准备用 `playground_create_room` 开桌。
3. 不需要任何模型 API Key；Agent 自己就是玩家。

## 1. 挂上 MCP

把配置粘到客户端的 MCP servers 配置里：

```json
{
  "mcpServers": {
    "ai-playground": {
      "command": "npx",
      "args": ["ai-playground", "mcp"]
    }
  }
}
```

> **MCP 包开发中**：发布后的最终形态是 `npx ai-playground mcp`；当前仓库请用下面的 tsx 入口（等价于根目录 `pnpm mcp`）起 stdio server，配置改成：
>
> ```json
> {
>   "mcpServers": {
>     "ai-playground": {
>       "command": "pnpm",
>       "args": ["-C", "packages/mcp", "exec", "tsx", "src/cli.ts"],
>       "env": { "PLAYGROUND_URL": "http://127.0.0.1:8787" }
>     }
>   }
> }
> ```
>
> 在仓库根目录启动（大厅「复制 MCP 配置」生成的就是这一版）。客户端工作目录不固定时，把 `args` 换成 `["--dir", "D:\\path\\to\\ai-playground", "mcp"]`。开发模式下如果想让 Agent 开桌返回的 `humanUrl` 也指向 Vite 5173，把 `PLAYGROUND_URL` 改成 `http://127.0.0.1:5173`（Vite 会把 `/api` 代理到 8787）；人类从大厅开桌、Agent 只 `join_room` 时保持 8787 即可。Windows 客户端若报找不到 `pnpm`，把 `command` 写成 `pnpm.cmd`。

注意事项：

- stdio 模式下 **stdout 只走 MCP 协议**，日志在 stderr；不要往 stdout 打调试信息。
- 先起服务端，再起 MCP；MCP 默认连 `http://127.0.0.1:8787`，可用环境变量 `PLAYGROUND_URL` 覆盖。
- 人类入口和 MCP 是两条独立通道，同一间房靠 `roomId` 对齐。

## 2. 十个工具

涉及座位的工具都有 `seat` 参数（默认 `1`，Agent 一般不用传）。

| # | 工具 | 参数 | 返回 |
|---|---|---|---|
| 1 | `playground_list_games()` | 无 | `games[]`：id、名称、简介、规则全文；M0 只有 `grab` |
| 2 | `playground_create_room(gameId="grab", sessionId?)` | `gameId` 可选、`sessionId` 可选 | `roomId`、`humanUrl`、`humanUrlPath`、`agentSeat`、`rules` |
| 3 | `playground_join_room(roomId, seat=1, sessionId?)` | `roomId`、`seat`、`sessionId` 可选 | 房间摘要（状态、占用、待提交座位）+ `humanUrl`；幂等 |
| 3.5 | `playground_bind_session(roomId, sessionId)` | `roomId`、`sessionId` | 唤醒桥绑定结果（`bound: true`、`boundAt`）；之后轮到 Agent 时服务端主动叫醒会话 |
| 4 | `playground_wait_for_turn(roomId, seat=1, timeoutSeconds=60)` | `roomId`、`seat`、超时秒数 | `ready` / `timedOut` / `ended` + `observation` |
| 5 | `playground_get_state(roomId, seat=1)` | `roomId`、`seat` | `{ observation }`（**优先用它，不靠截图**） |
| 6 | `playground_submit_action(roomId, seat=1, cell=[r,c])` 或 `... actionJson=...` | `roomId`、`seat`、二选一动作 | 成功：`ok`、`resolved`、`events`；被拒：`error`、`legalActions` |
| 7 | `playground_say(roomId, seat=1, text)` | `roomId`、`seat`、文本 | 发出的消息；无游戏效果；限流 800ms、≤200 字 |
| 8 | `playground_get_result(roomId)` | `roomId` | `{ ended, result }`；未结束 `result=null` |
| 9 | `playground_export_log(roomId, seat=1)` | `roomId`、`seat` | 可回放日志（seed + events；不含聊天） |

资源：`playground://games/grab/rules` —— 抢宝大作战规则全文，Agent 自学的唯一依据。

### 返回结构（structuredContent）

MCP 工具同时返回给人读的 `text` 和给程序读的 `structuredContent`。程序化接入时读后者，关键形状：

```text
playground_create_room  → { roomId, gameId, humanUrl, humanUrlPath, agentSeat, rules }
playground_join_room     → { ok, roomId, status, occupied, pendingSeats, result, humanUrlPath, humanUrl }
playground_get_state     → { observation }                 # observation 就是 /state 的完整对象
playground_wait_for_turn → { ready, timedOut, ended, polls, elapsedSeconds, observation }
playground_submit_action → 成功 { ok: true, resolved, events, submitted }
                           被拒 { ok: false, status, error, legalActions, submitted }（isError=true）
playground_get_result    → { ended, result }
playground_export_log    → { roomId, gameId, seed, seat, result, rules, events: [{ t, event }], createdAt }
```

> `observation` 的字段见 [抢宝规则 · Agent 版](rules-grab.md#agent-版接入规格)。`wait_for_turn` 的观测在 `observation` 里，不在顶层。

### `playground_submit_action` 的两种写法

**写法 A（推荐）**：只传格子，工具自动包装成 `{"action":"grab","cell":[...]}`。

```json
{ "roomId": "<roomId>", "seat": 1, "cell": [1, 2] }
```

**写法 B**：传完整动作对象，或它的 JSON 字符串。

```json
{
  "roomId": "<roomId>",
  "seat": 1,
  "actionJson": { "action": "grab", "cell": [1, 2] }
}
```

- `cell` 是 `[行, 列]`，0–2，必须是当前 `legalActions` 中某一项的 `cell`。
- 推荐直接用 `get_state` 返回的 `legalActions[i].cell`，不要自己造坐标。
- 每回合只能交一次；交完等对手，重复交会报 `action_already_submitted`。
- `cell` 和 `actionJson` 二选一；两个都不传会返回 `isError=true` 的提示。

## 3. 典型回合循环

```text
# 开桌（人类也可以先开，然后把 roomId 给你）
room = playground_create_room(gameId="grab")
playground_join_room(room.roomId, seat=1)
把 room.humanUrl 发给人类

loop:
    turn = playground_wait_for_turn(room.roomId, seat=1, timeoutSeconds=60)
    if turn.ended:
        break
    obs = turn.observation                    # 完整观测在 observation 里
    if obs.status == "waiting":
        # 人类还没入座；把 room.humanUrl 再发一次
        continue
    if obs.youSubmitted:
        # 已经交了，等揭示，不要重复提交
        continue

    action = choose(obs.legalActions)          # 你的策略在这里
    res = playground_submit_action(room.roomId, seat=1, cell=action.cell)

    if res.isError and res.error == "illegal_action":
        action = res.legalActions[0]           # 用服务端给的合法动作纠正
        res = playground_submit_action(room.roomId, seat=1, cell=action.cell)
    if res.isError and res.error in ("waiting_for_opponent", "action_already_submitted"):
        continue                               # 等，不要重试同一个动作

    # res.resolved == true 时，res.events 里有 reveal（及可能的 end）
    # 分数以事件里的 scores / 下一次 obs 为准，不要自己猜

result = playground_get_result(room.roomId)
log = playground_export_log(room.roomId, seat=1)
```

关键点：

- **同时暗选**：你交完不代表对手交了；`youSubmitted=true` 时没有任何对手信息可读。
- **服务端是唯一裁判**：不要在本地重算分数、不要自己洗牌。
- **没有倒计时代打**：对手不交，回合就暂停；`wait_for_turn` 超时是正常的，`timedOut=true` 时 sleep 1–2 秒再等，别忙轮询。
- 每回合从最新 `obs.legalActions` 选，别缓存上一回合的合法格。
- **先手方拿不到 reveal**：你先提交时返回 `{resolved:false, events:[]}`，结算事件只回给后提交的一方。想知道本回合结果，就再调一次 `playground_wait_for_turn` / `get_state`，读 `observation.history` 的最后一条（含 picks / delta / collision）。
- **结束条件**：场上金币被抢完即结束（剩下的空格/炸弹不再进行）。`status=ended` 时 `legalActions=[]`、`textView` 末尾带「🏁 对局已结束：X 获胜」，`round` 显示的是已进行回合数。
- **开发模式的人类链接**：`create_room` 的 `humanUrl` 是用 `PLAYGROUND_URL` 拼出来的。`pnpm dev` 下前端在 5173，如果 MCP 连的是 8787，链接会指向 8787（开发时可能没有页面）。两个办法：让人类从 5173 大厅开桌、把 `roomId` 给你；或者把 `PLAYGROUND_URL` 设成 `http://127.0.0.1:5173`。`pnpm start` 单端口模式则 8787 直接能用。

## 4. 非法动作怎么纠正

提交了不在 `legalActions` 里的动作，REST 返回 **409**：

```json
{
  "ok": false,
  "error": "illegal_action",
  "legalActions": [
    { "action": "grab", "cell": [0, 1] },
    { "action": "grab", "cell": [0, 2] }
  ]
}
```

MCP 的 `playground_submit_action` 会把它转成 `isError=true`，`structuredContent` 里保留 `{ ok: false, status: 409, error: "illegal_action", legalActions: [...] }`；模型侧同时能看到一段中文明文提示。

正确做法：

1. 不要再发同一个动作。
2. 从 `legalActions` 里重新选（通常直接取第一个或按你的策略排序）。
3. 最多重试 3 次；仍失败就停下来报告，不要死循环。

注意区分：

- `illegal_action`：动作本身不合法，**可以**用返回列表纠正后立刻重试。
- `action_already_submitted`：你这一回合已经交过了，**不要**再交，等揭示。
- `waiting_for_opponent`：房间还没开局，不是你的错，等人类入座。

## 5. 常见错误码表

| 错误 | HTTP | 含义 | Agent 应该做什么 |
|---|---|---|---|
| `waiting_for_opponent` | 409 | 还有座位没入座 | 等；别重复交动作 |
| `room_ended` | 409 | 对局已结束 | 读 `get_result` / `export_log`，停止 |
| `seat_not_joined` | 409 | 这个座位没 join | 先 `playground_join_room` |
| `action_already_submitted` | 409 | 本回合已交过 | 等揭示，不要重交 |
| `illegal_action` | 409 | 动作不合法 | 用响应里的 `legalActions` 重选 |
| `房间不存在: <id>` | 404 | roomId 错 / 服务重启房间没了 | 重新开桌 |
| `未知游戏: <id>` | 400 | gameId 不存在 | M0 只支持 `grab` |
| `说话太快了，歇一下` | 400 | `say` 间隔 < 800ms | 隔 0.8s 再发 |
| `空文本` | 400 | 发了空串 | 说点别的 |
| `not_found` | 404 | API 路径写错 | 对照 [API 契约](api-contract.md) |

> `say` 的 200 字上限：REST 由服务端截断；MCP 工具的 schema 上限也是 200，超长会先被工具拒绝。它只影响气泡，不影响对局。

## 6. 不要用截图看棋盘

这是给多模态 Agent 的硬性建议：

- **直接读 `state`**（MCP：`playground_get_state` / `playground_wait_for_turn`；REST：`GET /state?seat=1`）。
- 纯文本模型优先读 `textView`，它已经把行号、分数、金币/炸弹/空格排好了。
- 截图会引入 OCR 误差、动画中间态和分辨率问题；观测字段才是服务端认证过的事实。
- 对手本回合的选择在揭示前**不在任何观测里**；看截图也看不到，别浪费时间。

## 7. 没有 MCP 时的 REST 兜底

MCP 只是包了一层 REST。任何能发 HTTP 的 Agent 都能直接玩：

> 第 12 轮加了**席位令牌**：入座时服务端发一张令牌，之后每次「按座位读写」都要带上。
> 不带令牌不会报错，但你会变成一个**旁观者**（`legalActions` 恒为空、不能出招）。

```bash
# 1) 看游戏列表
curl -s http://127.0.0.1:8787/api/games

# 2) 开一桌（人类也可以开，然后跳过这步）
#    响应里的 seatTokens["0"] 是人类座的令牌，humanUrlPath 里也带着它
curl -s -X POST http://127.0.0.1:8787/api/rooms \
  -H "content-type: application/json" \
  -d '{"gameId":"grab"}'

# 3) Agent 入座 —— 响应里的 token 就是你这一局的凭据，存好
curl -s -X POST http://127.0.0.1:8787/api/rooms/<roomId>/join \
  -H "content-type: application/json" \
  -d '{"seat":1}'
#   → {"ok":true,"seat":1,"token":"<t1>","status":"playing",...}

# 4) 读观测（Agent 唯一读数出口）
curl -s "http://127.0.0.1:8787/api/rooms/<roomId>/state?seat=1&token=<t1>"

# 5) 提交动作
curl -s -X POST http://127.0.0.1:8787/api/rooms/<roomId>/action \
  -H "content-type: application/json" \
  -d '{"seat":1,"token":"<t1>","action":{"action":"grab","cell":[0,0]}}'

# 6) 结算 / 日志（公开，不需要令牌）
curl -s http://127.0.0.1:8787/api/rooms/<roomId>/result
curl -s "http://127.0.0.1:8787/api/rooms/<roomId>/log?seat=1"
```

重连（进程重启、换机器）时带上原令牌 `{"seat":1,"token":"<t1>"}` 重新 join 即可幂等恢复；
**不带令牌 join 已占用的座位会收到 409 `seat_taken`**——那不是报错，是告诉你这个座位已经属于上一个人了。

> Windows PowerShell 下，`curl` 是 `Invoke-WebRequest` 的别名，建议写 `curl.exe`；单引号 JSON 在部分版本会被吞引号，可改用 `Invoke-RestMethod` 或 `--data-raw "{\"gameId\":\"grab\"}"`。

WebSocket 可选：`ws://127.0.0.1:8787/ws?room=<roomId>`，会推送 `hello` 和 `events`。REST 轮询足够跑通一局。

## 8. 接入自检（3 步）

1. `playground_list_games()` 能返回 `grab`。
2. `playground_create_room("grab")` 或 `playground_join_room(<roomId>, 1)` 成功，`playground_get_state` 返回 `status="playing"`、`legalActions` 非空。
3. 提交一个 `legalActions` 里的动作，响应 `ok=true`；人类也提交后收到 `resolved=true` 和 `reveal`。

三步都过，就可以开始读心了。
