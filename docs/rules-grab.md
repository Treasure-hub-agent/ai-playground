# 《抢宝大作战》规则（Grab & Grab）

> 适用版本：M0。规则实现以 `packages/core/src/games/grab.ts` 的 `RULES` 常量为准；本文是给人类和 Agent 的说明书。接口字段细节见 [API 契约](api-contract.md)。
> 座位约定：**seat 0 = 人类，seat 1 = Agent**。

## 人类版（一屏看懂）

**一句话：每回合你和对手同时暗抢一格。金币归你，炸弹扣你，抢同一格谁都拿不到。**

### 盘面

- **3×3 九宫格**，开局随机摆放 **9 个物件**：
  - 金币 ×6，面值分别是 **1、1、2、2、3、3**
  - 炸弹 ×1，踩中 **扣 2 分**
  - 空格 ×2，什么都不发生
- 金币和炸弹的位置是**公开的**，双方都能看到；看不到的只有对手这一回合选哪格。

### 一回合怎么走

1. 双方**同时暗选**一格，互相看不到对方的选择。
2. 双方选**不同格**：各自生效——金币加分、炸弹扣 2 分、空格无事。
3. 双方选**同一格**：撞车，该格宝物被撞飞，**双方都拿不到**；如果那是炸弹，**双方都不扣分**。
4. 被选过的格子变成「已抢走」（`taken`），之后不能再选。
5. 格子抢完即结束，**最多 9 回合**，通常 60–90 秒一局。

### 怎么赢

- 结束时总分高者获胜；**同分算平局**（当前版本不加赛）。
- 分数可能为负（踩炸弹扣分），负分也可能赢——只要比对手高。

> 实现差异：早期方案曾写「同分加赛 1 回合」，当前代码没有实现加赛，`result.winner = null` 即平局。以服务端 `result` 为准。

### 示例一：各抢各的

开局盘面（行、列都从 0 开始）：

| | 列 0 | 列 1 | 列 2 |
|---|---|---|---|
| **行 0** | 💰1 | 💣 | 空 |
| **行 1** | 💰2 | 💰3 | 💰1 |
| **行 2** | 空 | 💰2 | 💰3 |

人类选 `[0,0]`（金币 1），Agent 选 `[1,1]`（金币 3）：

- 没有撞车，各自拿走：人类 +1，Agent +3，当前比分 **1 : 3**。
- 两格都变成 `taken`，下一回合可选 7 格。

```text
第 0 行:  ✖ | 💣 | 空
第 1 行: 💰2 | ✖ | 💰1
第 2 行: 空 | 💰2 | 💰3
```

### 示例二：撞车

回到开局盘面，双方都选 `[2,1]`（金币 2）：

- 撞车，金币被撞飞，**双方都是 +0**，该格消失。
- 下一回合从剩下的 8 格里选。

### 示例三：一起踩炸弹

回到开局盘面，双方都选 `[0,1]`（炸弹）：

- 撞车，炸弹被撞飞，**双方都不扣分**（不是各扣 2 分）。
- 如果只有一方踩中炸弹，那一方 **-2 分**。

## Agent 版（接入规格）

### 观测（`GET /api/rooms/:id/state?seat=1`）

这是 Agent 的**唯一读数出口**。不要用截图、不要自己重建棋盘。

> 字段名以本文 / [API 契约](api-contract.md) 为准。早期 MVP 草案里的 snake_case（`legal_actions`、`my_score`）和 `deadline_ms` 没有实现；当前服务端不设倒计时，也不会超时代打。

| 字段 | 类型 | 说明 |
|---|---|---|
| `gameId` | string | 固定 `"grab"` |
| `seat` | number | 你的座位，Agent 固定 `1` |
| `round` | number | **下一回合序号**（从 1 开始）。结束时是「已打回合数 + 1」，可能是 6–10；判断结束请用 `status` / `legalActions`，不要用 `round` |
| `roundsTotal` | number | 固定 `9`（回合上限） |
| `scores` | `{"0": number, "1": number}` | 双方总分，可能为负 |
| `legalActions` | `Action[]` | 本回合所有合法动作；结束后为空数组 |
| `textView` | string | 纯文本盘面，适合纯文本模型直接读 |
| `status` | `"waiting" \| "playing" \| "ended"` | 房间状态；`waiting` = 等人入座 |
| `grid` | `(1\|2\|3\|"bomb"\|"empty"\|"taken")[][]` | 3×3 公开盘面 |
| `history` | `RoundRecord[]` | 已揭示的历史回合，见下 |
| `yourScore` / `opponentScore` | number | 你的 / 对手的分数（等价于 `scores[seat]`） |
| `roomId` | string | 房间 id |
| `youSubmitted` | boolean | 你本回合是否已提交动作 |
| `waitingFor` | number[] | 还在等哪些座位提交（`playing` 时有效） |
| `result` | object \| null | 结束前为 `null`；结束后见「结算」 |

`grid` 取值：

- `1` / `2` / `3`：金币面值
- `"bomb"`：炸弹
- `"empty"`：空格
- `"taken"`：已被抢走 / 撞飞，不能再选

`history` 的每一回合：

```json
{
  "round": 1,
  "picks": { "0": [0, 0], "1": [1, 1] },
  "delta": { "0": 1, "1": 3 },
  "collision": false
}
```

> 关键：**对手本回合的选择在揭示前不会出现在任何观测字段里**。`youSubmitted=true` 只说明你交了，不代表能猜出对方选了哪格。

### 动作 schema

```json
{
  "action": "grab",
  "cell": [row, col]
}
```

- `action`：固定 `"grab"`。
- `cell`：`[行, 列]`，两个整数，取值 `0–2`。
- 必须是当前 `legalActions` 中的某一项。`legalActions` 的实际形状是：

```json
[
  { "action": "grab", "cell": [0, 0] },
  { "action": "grab", "cell": [0, 2] }
]
```

> `RULES` 常量末句写的是「形如 `[[0,0],[0,2],...]`」，那是简写；实际 `legalActions` 的每个元素都是上面这种 `{action, cell}` 对象，以接口返回为准。

- 每回合**只能提交一次**；重复提交会得到 `action_already_submitted`。
- 提交入口：`POST /api/rooms/:id/action`，body 里带上你的 `seat`：

```json
{
  "seat": 1,
  "action": { "action": "grab", "cell": [1, 2] }
}
```

### 回合循环

```text
loop:
  state = GET /state?seat=1
  if state.status == "waiting":   等对手入座，继续
  if state.status == "ended":     读 result，结束
  if state.youSubmitted:          等揭示，不要重复提交
  action = 从 state.legalActions 里选一项
  resp = POST /action
  if resp.ok == false:
      按 error 处理（见下表）；illegal_action 时从 resp.legalActions 重选
  else if resp.resolved == false:
      对手还没交，回到 loop 等待
  else:
      resp.events 里有 reveal（以及可能的 end），本地更新分数后进入下一回合
```

服务端在**双方动作都到齐的那一刻立即结算**并广播 `reveal`，没有倒计时、没有自动代打。对方不交，回合就暂停。

### 揭示与结算

`POST /action` 在双方到齐时返回：

```json
{
  "ok": true,
  "resolved": true,
  "events": [
    {
      "type": "reveal",
      "round": 1,
      "picks": { "0": [0, 0], "1": [1, 1] },
      "delta": { "0": 1, "1": 3 },
      "applied": { "0": "coin", "1": "coin" },
      "collision": false,
      "scores": { "0": 1, "1": 3 },
      "grid": [["taken", "bomb", "empty"], [2, "taken", 1], ["empty", 2, 3]]
    }
  ]
}
```

- `delta` 是这一回合的分数变化（撞车双方都是 0；炸弹是 -2）。
- `applied` 取值：`"coin"` / `"bomb"` / `"empty"` / `"collision"`（正常对局中不会出现 `"taken"`）。
- 对局结束时，同一批 `events` 里还会多一条 `{"type":"end","result":{...}}`。
- 结算 `result` 形状：

```json
{
  "winner": 0,
  "scores": { "0": 12, "1": 9 },
  "text": "座位 0 获胜！比分 12 : 9。"
}
```

`winner` 为 `0` / `1` / `null`（平局）。

### 错误码

| `error` | HTTP | 什么时候 | 怎么办 |
|---|---|---|---|
| `waiting_for_opponent` | 409 | 房间还在等人入座 | 等对手 join，别重试提交 |
| `room_ended` | 409 | 对局已结束 | 读 `/result`，停止 |
| `seat_not_joined` | 409 | 你这个座位还没 join | 先 `POST /join` |
| `action_already_submitted` | 409 | 本回合你已经交过 | 等揭示，别重复交 |
| `illegal_action` | 409 | 动作不在 `legalActions` 里 | 从响应里的 `legalActions` 重选 |
| `房间不存在: <id>` | 404 | roomId 写错 / 服务重启后房间没了 | 重新开桌 |
| `未知游戏: <id>` | 400 | `gameId` 不存在 | 目前只支持 `grab` |
| `空文本` | 400 | `say` 发了空串 | 说点别的 |
| `说话太快了，歇一下` | 400 | `say` 间隔 < 800ms | 等 0.8s 再发 |

补充：`say` 每条最多 200 字（REST 超出会截断；MCP 工具超限会被 schema 直接拒绝），只在人类界面显示气泡，不影响对局。

### 一句话策略提示

金币位置公开，所以这不是纯运气：你要猜的是**对手会抢哪一格**。高分金币容易被盯上，炸弹旁边的高分格是心理战场；连续撞车也别慌，对方同样在赌。
