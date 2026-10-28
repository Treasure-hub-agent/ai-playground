# 《黑白棋》规则（reversi）

> 人类版和 Agent 版都在这一页。想直接开玩：在大厅点《黑白棋》→ 开一桌 → 把 MCP 端点交给 Agent。接口字段见 [API 契约](api-contract.md)。

## 人类版（30 秒看懂）

1. 8×8 棋盘，开局中央摆 4 子（两色交错）；**座位 0 先手**。
2. 轮到你时落一子，必须沿横、竖、斜任意方向**夹住**至少一枚对手棋子；落子后所有被夹住的棋子翻成你的颜色。
3. 只能落在合法点上；没有合法落点的一方**自动跳过**（不消耗手数，也不落子）。
4. 双方都无子可下（或棋盘下满）即终局，**棋子多者胜，数量相同算平局**。
5. 棋盘完全公开，没有隐藏信息；落子立即生效，不能悔棋。

**小技巧**：角是永远翻不掉的稳定子，优先抢角；边上和靠近角的位置容易把角送给对手，中盘要算「这一步会给对手哪些好点」。

## Agent 版（接入要点）

- 这是 `turn` 模式：不是你的回合时 `legalActions` 返回 `[]`；用 `isYourTurn` / `currentSeat` 判断该谁落子。
- 动作：

```json
{ "action": "place", "cell": [row, col] }
```

`row` / `col` 都是 `0–7`，`[0,0]` 是左上角。合法落点必须能翻到至少一枚对手棋子。

- MCP 里两种写法都行：
  - `cell: [row, col]`（`playground_submit_action` 会按 `legalActions` 自动映射成 `{"action":"place","cell":[...]}`）
  - `actionJson: '{"action":"place","cell":[row,col]}'`（原样提交）

### 观测关键字段

| 字段 | 说明 |
|---|---|
| `board` | 8×8 矩阵；`0` = 座位 0 的子，`1` = 座位 1 的子，`null` = 空格；全公开 |
| `yourDiscs` / `opponentDiscs` | 双方当前子数 |
| `scores` | 等价于双方子数 |
| `lastMove` | 上一手：`{ move, seat, cell, flips }`；`flips` 是被翻子的坐标数组 |
| `lastPassSeat` | 最近一次被跳过的座位（`0` / `1`），没有跳过时为 `null`；判断是否刚发生跳过也可以看 `pass` 事件或 `currentSeat` |
| `textView` | 带 A–H 列标的 ASCII 棋盘；合法空点会标 `·` |
| `currentSeat` / `isYourTurn` | 当前该谁落子；终局 `currentSeat=null` |

`place` 事件形如：

```json
{
  "type": "place",
  "seat": 0,
  "cell": [2, 3],
  "flips": [[3, 3]],
  "counts": { "0": 4, "1": 1 },
  "board": [["…"]]
}
```

如果落子后对手没有任何合法点、而你还可继续下，服务端会额外广播一条 `pass` 事件：

```json
{ "type": "pass", "seat": 1, "nextSeat": 0 }
```

`pass` 不消耗手数，也不会写进 `history`；接着仍然由你落子。

### 回合循环

```text
wait_for_turn → 读 textView / legalActions
→ submit_action(cell=[row,col]) → 落子立即结算
→ 若 nextSeat 仍是你：对手被 pass，继续下
→ 否则等 wait_for_turn
→ status=ended 后 get_result / export_log
```

- 终局条件是「双方都没有合法落点」；如果一方还能下，另一方不能下只会触发 `pass`，不会结束对局。
- `legalActions` 为空只在「不是你的回合」或「终局」时出现；轮到你时它一定是你当前的全部合法落点。

### 错误码

| `error` | HTTP | 什么时候 | 怎么办 |
|---|---|---|---|
| `not_your_turn` | 409 | 还没轮到你 | 先 `wait_for_turn` |
| `illegal_action` | 409 | 已占用 / 翻不到子 / 越界 | 从响应 `legalActions` 重选 |
| `room_ended` | 409 | 对局已结束 | 读 result / 导出日志 |
| `waiting_for_opponent` | 409 | 房间还没双方入座 | 等人类入座 |
| `seat_not_joined` | 409 | 这个座位没 join | 先 `playground_join_room` |

## 一局示例

开局中央四子，座位 0 先手。下面是一段合法的开局（列 A=0 … H=7）：

```text
你   D3 [2,3]  → 翻 D4
Agent C3 [2,2] → 翻 D4
你   C4 [3,2]  → 翻 D4
Agent ...
```

中盘如果 Agent 没有合法点，你会收到 `pass` 事件并继续落子；最后棋盘下满或双方都无子可下时，比较双方子数：多者胜，相同平局。
