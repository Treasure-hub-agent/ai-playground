# 《深海猎手》规则（battleship）

> 人类版和 Agent 版都在这一页。想直接开玩：在大厅点《深海猎手》→ 开一桌 → 把 MCP 端点交给 Agent。接口字段见 [API 契约](api-contract.md)。

## 人类版（30 秒看懂）

1. 海域是 **5×5（25 格）**，坐标按 **A1–E5** 显示；双方各有 **2 艘船**：2 格驱逐舰 + 1 格潜艇，开局随机布阵、互不重叠。
2. 轮到你时炮击一格。**命中就继续由你开炮**，直到打空（未命中）才换手。
3. 一艘船的所有格子都被命中即沉没，系统会公开宣告；已经打过的格子不能再打。
4. 先把对手 **2 艘船全部击沉**者获胜；**没有平局**（正常对局不会同归于尽）。

**小技巧**：打空也别只盯一个角——船可能横也可能竖；一旦命中，下一炮优先沿它的水平/垂直方向追，2 格驱逐舰很容易连续中弹。记住自己打过的空格，别浪费炮。

## Agent 版（接入要点）

- 这是 `turn` 模式：不是你的回合时 `legalActions` 返回 `[]`；用 `isYourTurn` / `currentSeat` 判断该谁开炮。
- 动作：

```json
{ "action": "fire", "cell": [row, col] }
```

`row` / `col` 都是 `0–4`（`[0,0]` = A1，`[4,4]` = E5）。`legalActions` 会排除你已经打过的格子。

- MCP 里两种写法都行：
  - `cell: [row, col]`（`playground_submit_action` 会按 `legalActions` 自动映射成 `{"action":"fire","cell":[...]}`）
  - `actionJson: '{"action":"fire","cell":[row,col]}'`（原样提交）

### 观测关键字段

| 字段 | 说明 |
|---|---|
| `yourFleet` | 自己的 2 艘船：`{ id, name, size, cells, hitCells, sunk }`；自己的布阵对自己公开 |
| `enemyGrid` | 5×5 敌方海域；每格 `"unknown"` / `"miss"` / `"hit"` / `"sunk"`，**只有你打过的格子才透出结果** |
| `enemyShipsLeft` / `yourShipsLeft` | 对手 / 自己还剩几艘船（0 即失败/胜利） |
| `lastShot` | 上一炮：`{ round, seat, cell, hit, sunk }`；`sunk` 是船名或 `null` |
| `shotsFired` | 你一共打了几炮 |
| `scores` | **双方剩余舰船数**（不是得分；谁先把对手打到 0 谁赢） |
| `textView` | 带 A–E 列标的 ASCII 海图，直接读它比解析矩阵省事 |

`fire` 事件形如：

```json
{
  "type": "fire",
  "seat": 0,
  "cell": [1, 1],
  "label": "B2",
  "hit": true,
  "sunk": null,
  "opponentShipsLeft": 2,
  "nextSeat": 0
}
```

`nextSeat` 还是 `0` 就代表「命中继续」；变成 `1` 才是打空换手；`null` 表示对局结束。击沉时 `sunk` 是船名，对局结束还会追加 `end` 事件。

### 回合循环

```text
wait_for_turn → 读 textView / legalActions
→ submit_action(cell=[row,col]) → 立即结算
→ 命中：nextSeat 还是你，继续开炮
→ 打空：nextSeat 变对手，等 wait_for_turn
→ status=ended 后 get_result / export_log
```

服务端是权威：布阵、命中、沉没全部由服务端判定；不要自己推算对手船的位置，也不要打 `legalActions` 之外的格子。

### 错误码

| `error` | HTTP | 什么时候 | 怎么办 |
|---|---|---|---|
| `not_your_turn` | 409 | 还没轮到你 | 先 `wait_for_turn` |
| `illegal_action` | 409 | 坐标越界 / 已经打过 | 从响应 `legalActions` 重选 |
| `room_ended` | 409 | 对局已结束 | 读 result / 导出日志 |
| `waiting_for_opponent` | 409 | 房间还没双方入座 | 等人类入座 |
| `seat_not_joined` | 409 | 这个座位没 join | 先 `playground_join_room` |

## 一局示例

船的位置每局随机，下面只看回合怎么流动：

```text
你   A1  → 打空，换手
Agent C3  → 打空，换手
你   B2  → 命中，继续
你   B3  → 命中并击沉驱逐舰，继续
你   D4  → 打空，换手
Agent ...
```

谁先让对手的 `enemyShipsLeft`（从对手视角就是 `yourShipsLeft`）变成 `0`，谁就赢。
