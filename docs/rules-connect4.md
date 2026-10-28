# 《四子棋》规则（connect4）

> 人类版和 Agent 版都在这一页。想直接开玩：在大厅点《四子棋》→ 开一桌 → 把 MCP 端点交给 Agent。

## 人类版（30 秒看懂）

1. 棋盘 7 列 × 6 行，你执青色、Agent 执紫色，你先手。
2. 轮到你时点顶部任意一个「↓」，棋子落到该列最下面的空位。
3. 横、竖、斜任意方向先连成 **4 个**同色棋子就赢；棋盘下满还没人连成四子算平局。
4. 落子立刻生效，不能悔棋，也没有隐藏信息——棋盘对双方完全透明。

**小技巧**：先占中间列（D），它的斜线机会最多；同时盯住对手的「三连 + 两头空」。

## Agent 版（接入要点）

- 不是你的回合时，`legalActions` 返回空数组——这是判「该谁动」的信号，不要硬提交。
- 回合内 `legalActions` 形如：

```json
[{ "action": "drop", "column": 3 }, { "action": "drop", "column": 4 }]
```

- 动作：`{"action":"drop","column":n}`，n 取值 0–6（列 A=0 … G=6）。
- MCP 里 `playground_submit_action` 支持两种写法：
  - `cell: [0, n]`（会自动映射成 `{"action":"drop","column":n}`）
  - `actionJson: '{"action":"drop","column":n}'`（原样提交）
- 观测里的关键字段：
  - `board`：6×7 的数字矩阵，`0` 空 / `1` 座位 0 / `2` 座位 1（`board[5]` 是最底行）
  - `currentSeat`：现在该谁落子；`isYourTurn`：是不是轮到你
  - `history`：`[{ seat, column, row }, …]`，最后一条是上一手
  - `textView`：带 A–G 列标的 ASCII 棋盘，直接读它比解析 `board` 更省事
- 回合循环：

```text
wait_for_turn → 读 textView / legalActions → submit_action(cell=[0, 列])
→ 落子立刻换手 → 再 wait_for_turn → …… → status=ended → get_result
```

- 错误码：`not_your_turn`（没轮到你，先 wait）、`illegal_action`（列满了/越界，会带 legalActions）、`room_ended`（已经结束）。

## 一局示例

```text
你  D4    →   Agent C1
你  D5    →   Agent C2
你  E5    →   Agent C3
你  D6    →   ……（D 列 4 子成线，你赢）
```
