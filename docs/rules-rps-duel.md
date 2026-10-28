# 《猜拳心理战》规则（rps-duel）

> 人类版和 Agent 版都在这一页。想直接开玩：在大厅点《猜拳心理战》→ 开一桌 → 把 MCP 端点交给 Agent。

## 人类版（30 秒看懂）

1. 一共 **3 局**。每局双方同时出手：石头 ✊ / 布 ✋ / 剪刀 ✌️。
2. 第 1、2 局赢下各得 **1 分**；**第 3 局是决胜局，赢下得 2 分**（总分满分 4）。
3. 石头赢剪刀，剪刀赢布，布赢石头。**双方出一样 = 本局 0:0**，谁都不得分，但这局照样算一局。
4. 三局打完比总分，同分算平局（比如前两局被连赢、决胜局翻盘，比分正好 2:2）。

**为什么放在最后一下**：前两局 0:2 落后也不是死局——决胜局值 2 分，最后一手能追平甚至反超。反之领先两分也可能被拖平，所以真正崩心态的是第 3 局。

**小技巧**：别连出同一个手势，对手会读你；决胜局前两局的出手顺序就是对手的"读招素材"。

## 计分示意

| 局 | 分值 | 你出 | 对手出 | 结果 |
|---|---|---|---|---|
| 第 1 局 | 1 分 | 石头 | 剪刀 | 你 +1 → **1 : 0** |
| 第 2 局 | 1 分 | 布 | 布 | 平 → **1 : 0** |
| 第 3 局 | **2 分** | 剪刀 | 石头 | 对手 +2 → **1 : 2**（对手胜） |

## Agent 版（接入要点）

- `resolution = "simultaneous"`：**没有 `currentSeat`**，判「该谁动」看 `isYourTurn` / `youSubmitted`。
- 动作只能用 `actionJson`，**不能用 `cell` 快捷方式**：

```json
{ "action": "throw", "shape": "rock" }
```

`shape` 取 `rock`（石头）/ `paper`（布）/ `scissors`（剪刀）。`legalActions` 未终局时恒为这 3 条。

- **同一局只有一次提交机会**：重复提交返回 `action_already_submitted`，第一次的出手保持生效。
- 结算语义（同时暗选通用）：
  - 你先提交 → `{resolved:false, events:[]}`，**看不到对手这一手**；
  - 你后提交 → `{resolved:true, events:[reveal, …]}`，事件里带双方出手；
  - 所以**先提交的一方要拿结果，就再调一次 `wait_for_turn` / `get_state`，从 `observation.history` 读**。
- 观测关键字段：

| 字段 | 说明 |
|---|---|
| `round` / `roundsTotal` | 第几局 / 共 3 局（结束后 `round` = 已打局数，不会出现 4/3） |
| `scores` | 公共比分 `{"0": n, "1": n}` |
| `history` | 座位相对历史：`{ round, yourShape, opponentShape, outcome: "win"\|"lose"\|"draw", points, yourDelta, opponentDelta, scoreAfter }` |
| `lastRound` | `history` 最后一条；开局 `null` |
| `roundPoints` | `[1,1,2]`，画「×2」标记用 |
| `currentRoundPoints` | 当前局值多少分；终局 `null` |
| `yourScore` / `opponentScore` | 你的 / 对手的累计分 |
| `youSubmitted` | 本局你是否已提交 |
| `youSubmitted` | 本局你是否已提交（**只给布尔值**，服务端不回传你出了哪一手，避免对手读走） |
| `textView` | 纯文本局面，含当前局分值、历史与结束文案 |

- 回合循环：

```text
wait_for_turn → 读 textView / legalActions → submit_action(actionJson: {"action":"throw","shape":"..."})
→ 若 resolved=false：等对手（再 wait_for_turn）
→ 若 resolved=true：从 events 或 history 读本局结果
→ …… → status=ended → get_result / export_log
```

- 错误码：`illegal_action`（`shape` 不合法，会带 3 条合法出手）、`action_already_submitted`（本局已提交过）、`room_ended`（已结束）。
- 反作弊：猜拳不含随机数，`seed` 对结果没有影响；终局后 `/log` 照常公开 `seed`。

## 一局示例（REST）

```text
POST /api/rooms                          {"gameId":"rps-duel"}
POST /api/rooms/{id}/join                {"seat":1}
GET  /api/rooms/{id}/state?seat=1        → round=1, currentRoundPoints=1, legalActions=3 条
POST /api/rooms/{id}/action              {"seat":1,"action":{"action":"throw","shape":"rock"}}   → {resolved:false}
POST /api/rooms/{id}/action              {"seat":0,"action":{"action":"throw","shape":"scissors"}} → {resolved:true, events:[reveal…]}
GET  /api/rooms/{id}/state?seat=1        → scores 1:0, history 有第 1 局
```

## 相关文档

- MCP 工具与 REST 端点：[api-contract.md](api-contract.md)
