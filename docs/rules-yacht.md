# 《快艇骰子》规则（yacht）

> 人类版和 Agent 版都在这一页。规则以 `packages/core/src/games/yacht.ts` 的 `RULES` / `CATEGORY_LABELS` / `scoreCategory` 为准；接口字段见 [API 契约](api-contract.md)。
>
> **当前状态**：已上线（内核 + 前端界面 + MCP 资源均已完成），大厅可直接开桌。规则实现以 `packages/core/src/games/yacht.ts` 的 `RULES` / `CATEGORY_LABELS` / `scoreCategory` 为准；接口字段见 [API 契约](api-contract.md)。

## 人类版（一屏看懂）

**一句话：每手最多掷 3 次 5 颗骰子，锁定想留的骰子重掷其余，然后在 13 个栏目里选一格记分；双方各填满 13 格后比总分。**

### 一手怎么玩

1. 点「掷骰」掷 5 颗六面骰（d6）——这是第 1 次，最多共 3 次。
2. 掷完后可以锁定任意多颗骰子；再点「掷骰」时只有**未锁定**的骰子会重掷，锁定的保持不动。
3. 锁定是**切换**语义：点一下锁定，再点一下解锁；没有「设置成锁定」的单独按钮。
4. 第 1、2、3 次掷完都可以记分（不是必须掷满 3 次）；记分后立刻换手。
5. 每个栏目一局只能用一次；13 格填满后该玩家结束。双方各 13 手，共 **26 手**。

骰子点数由服务端种子化随机产生；玩家只能决定「掷」和「锁」，不能指定点数。

### 13 个栏目与计分

| 分区 | 栏目 | id | 判定 | 分数 |
|---|---|---|---|---|
| 上区 | 一点 | `ones` | 统计 1 的颗数 | 每颗 1 分 |
| 上区 | 二点 | `twos` | 统计 2 的颗数 | 每颗 2 分 |
| 上区 | 三点 | `threes` | 统计 3 的颗数 | 每颗 3 分 |
| 上区 | 四点 | `fours` | 统计 4 的颗数 | 每颗 4 分 |
| 上区 | 五点 | `fives` | 统计 5 的颗数 | 每颗 5 分 |
| 上区 | 六点 | `sixes` | 统计 6 的颗数 | 每颗 6 分 |
| 下区 | 三条 | `three_kind` | 至少 3 颗同点 | **五颗骰子总和**，否则 0 |
| 下区 | 四条 | `four_kind` | 至少 4 颗同点 | **五颗骰子总和**，否则 0 |
| 下区 | 葫芦 | `full_house` | 恰好 3+2（两种点数） | **固定 25**；5 颗同点不算葫芦 |
| 下区 | 小顺 | `small_straight` | 含任意 4 个连续点数 | **固定 30** |
| 下区 | 大顺 | `large_straight` | 含 1-2-3-4-5 或 2-3-4-5-6 | **固定 40** |
| 下区 | 快艇 | `yacht` | 5 颗同点 | **固定 50** |
| 下区 | 全骰 | `chance` | 任意 5 颗 | **五颗骰子总和** |

> 容易记错：三条/四条不是固定 30 分，是「满足条件后把五颗骰子全加起来」；葫芦是恰好 3+2，快艇（5 颗同点）不能当葫芦。

### 上区奖励与总分

- 上区小计：`ones` 到 `sixes` 六格已记分数之和。
- 上区奖励：小计 **≥ 63** 时额外 **+35**，自动计算，不需要也不能单独选这个栏目。
- 总分：`上区小计 + 上区奖励 + 下区合计`。
- 上区小计一旦达到 63，`upperBonus` 就是 35（不要求先填满上区；上区分数只会增加，不会掉下来）。

### 示例

**示例 1：`[3,3,3,5,2]`**

- 三点：9
- 三条：16（3+3+3+5+2）
- 四条：0
- 葫芦：0（是 3+1+1，不是 3+2）
- 全骰：16

**示例 2：`[1,2,3,4,5]`**

- 小顺：30；大顺：40——**两者都可选，但一手只能记一格**。
- 全骰：15；一点：1；二点：2……

**示例 3：`[6,6,6,6,6]`**

- 六点：30；三条：30；四条：30；快艇：50；全骰：30。
- 葫芦：0（5 颗同点不算 3+2）。

### 新手常见误区

1. **必须先掷骰才能记分。** `phase = "roll"` 时只有 `{"action":"roll"}`，没有记分入口。
2. **`hold` 是单颗 toggle，不是「批量设置锁定」。** 一次只切换一颗；想锁三颗就连续发三次 `hold`。`indices: []` 是「全部解锁」。
3. **打不出分也必须记一格。** 不能跳过；选一个栏目记 0 分，这是策略的一部分。
4. **每个栏目一局只能用一次。** 已经记过的格子不会再出现在 `legalActions` 里。
5. **三条/四条 = 五颗骰子总和**，不是固定分；四条也不要求五颗全同。
6. **快艇不是葫芦。** 葫芦必须恰好两种点数（3+2）。
7. **大顺同时也含小顺。** 掷出 1-2-3-4-5 时两个栏目都可选，但只能选一个记分。
8. **掷满 3 次不是强制的。** 第 1、2 次掷完觉得满意就可以直接记分。
9. **上区奖励自动加**，不用选「奖励」格；上区小计 63 分是门槛，不是奖励分。
10. **当前简化版没有 Yahtzee 奖励 / Joker 规则**，快艇只固定 50 分。
11. **锁定只在当前这一手有效**；记分换手后 `held` 全部清空，`rollsLeft` 回 3。
12. **骰子不能自己指定**；`roll` / `hold` / `score` 之外的动作一律不合法。

## Agent 版（接入要点）

> 已可开桌：`playground_list_games` 会把它列为可玩，`playground_create_room({gameId:"yacht"})` 可直接建房；MCP 规则资源 `playground://games/yacht/rules` 也已注册。下面是内核已实现的真实契约。

### 观测字段

| 字段 | 类型 / 取值 | 说明 |
|---|---|---|
| `dice` | `number[5]` | 5 颗骰子；本手还没掷时全为 `0` |
| `held` | `boolean[5]` | 对应骰子是否锁定；`true` = 本次重掷保持不变 |
| `rollsLeft` | `0–3` | 本手还剩几次掷骰 |
| `phase` | `"roll" \| "choice" \| "must_score"` | `roll` 还没掷；`choice` 已掷且有次数；`must_score` 3 次用完只能记分 |
| `scorecards` | `Record<"0" \| "1", Scorecard>` | 双方计分板（公开），含 13 格与上区小计/奖励/总分 |
| `previewScores` | `Record<Category, number \| null>` | 当前骰面对 13 格各能得多少分；`null` 规则见下 |
| `upperTarget` | `63` | 上区奖励门槛 |
| `upperBonusValue` | `35` | 达到门槛后的奖励分 |
| `history` | `TurnRecord[]` | 已完成的记分记录，按发生顺序 |
| `currentSeat` | `0 \| 1 \| null` | 当前行动方；终局为 `null` |
| `isYourTurn` | `boolean` | 现在是不是轮到你（等价于 `currentSeat === seat` 且对局进行中） |
| `round` / `roundsTotal` | `number` | 全局手数（双方合计）/ 总手数 26 |
| `scores` | `{"0": number, "1": number}` | 双方当前总分（含上区奖励） |
| `legalActions` | `Action[]` | 当前合法动作；非自己回合或终局为空数组 |
| `textView` | `string` | 纯文本盘面，预算有限时直接读它 |

`Scorecard` 的字段：

```json
{
  "ones": 3, "twos": 8, "threes": null, "fours": null, "fives": null, "sixes": null,
  "three_kind": null, "four_kind": null, "full_house": null,
  "small_straight": null, "large_straight": null, "yacht": null, "chance": null,
  "upperSubtotal": 11, "upperBonus": 0, "total": 11
}
```

`TurnRecord`（`history` 的元素）：

```json
{ "seat": 0, "category": "three_kind", "gained": 27, "dice": [5,5,5,6,6] }
```

### 三种动作

```json
{ "action": "roll" }
```

```json
{ "action": "hold", "indices": [2] }
```

```json
{ "action": "score", "category": "full_house" }
```

- `roll`：重掷所有 `held[i] === false` 的骰子；每手最多 3 次。
- `hold`：**一次只切换一颗**。`indices` 只含一个 0–4 的下标；`{"action":"hold","indices":[]}` 表示全部解锁。想锁多颗就连续调用多次。掷骰前（`phase="roll"`）和 3 次用完后（`must_score`）都不能 hold。
  - 引擎内部其实能一次处理多个下标，但**服务端按 `legalActions` 模式匹配**，只会放行单颗和空数组；对 Agent 的契约就是「一次一颗」。
- `score`：`category` 必须是 13 个栏目 id 之一，且本玩家还没记过；记分后立刻换手。

### `legalActions` 的形态

**1）不是你的回合**

```json
[]
```

看 `currentSeat` / `isYourTurn`；硬提交会得到 `not_your_turn`（HTTP 409）。`previewScores` 这时全是 `null`（虽然 `dice` 仍然可见）。

**2）你的回合，还没掷骰（`phase = "roll"`）**

```json
[{ "action": "roll" }]
```

**3）你的回合，已掷过且有次数（`phase = "choice"`）**

```json
[
  { "action": "roll" },
  { "action": "hold", "indices": [0] },
  { "action": "hold", "indices": [1] },
  { "action": "hold", "indices": [2] },
  { "action": "hold", "indices": [3] },
  { "action": "hold", "indices": [4] },
  { "action": "hold", "indices": [] },
  { "action": "score", "category": "ones" },
  { "action": "score", "category": "twos" }
]
```

上面只示意了前两个 score；实际会列出**所有尚未记过的栏目**（最多 13 个）。

**4）你的回合，3 次掷骰用完（`phase = "must_score"`）**

只有 `score`，没有 `roll` / `hold`：

```json
[
  { "action": "score", "category": "ones" },
  { "action": "score", "category": "twos" },
  { "action": "score", "category": "threes" }
]
```

**5）终局**

```json
[]
```

`status = "ended"`，`currentSeat = null`，`isYourTurn = false`；读 `/result` 或 `playground_get_result`。

### `previewScores` 语义

- 永远有 13 个 key（对应 13 个栏目）。
- 值为 `null` 的情况：该栏目**已经记过**、**还没掷过骰**、**不是你的回合**、**对局已结束**。
- 值为数字的情况：轮到你且已掷骰、该栏目未记过；**0 也是有效分数**（例如当前打不出三条，`three_kind: 0`），不要当成 `null`。
- 它是「按当前 `dice` 算出来的预览」，不是承诺；你下一次 `roll` 后会变。
- 不要自己重算分数——以 `previewScores` / `scorecards` 为准。

示例（`dice = [1,1,6,5,4]`，你的回合，都还没记）：

```json
{
  "ones": 2, "twos": 0, "threes": 0, "fours": 4, "fives": 5, "sixes": 6,
  "three_kind": 0, "four_kind": 0, "full_house": 0,
  "small_straight": 0, "large_straight": 0, "yacht": 0, "chance": 17
}
```

### 事件

每次动作成功后，`POST /action`（或 MCP `submit_action`）返回 `resolved: true` 和事件数组；没有「同时揭示」这一步。

```json
{ "type": "roll", "seat": 0, "dice": [3,3,5,1,3], "held": [false,false,true,false,true], "rollsLeft": 2 }
```

```json
{ "type": "hold", "seat": 0, "held": [true,false,true,false,true] }
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

- `score` 的 `scorecard` 是记分方记完这一格后的计分板快照（上面只列变化字段，实际还含完整的 13 格与 `upperSubtotal` / `upperBonus` / `total`）；`nextSeat` 为 `null` 表示对局结束。
- 对局结束时，同一批事件里还会多一条 `{"type":"end","result":{...}}`。
- `roll` 事件的 `held` 是本次掷骰前就锁定的骰子（掷骰不会改变锁定状态）。

### 回合循环

```text
room = create_room("yacht")            # 已可开桌
join_room(roomId, seat=1)
humanUrl 发给人类

loop:
    obs = wait_for_turn(roomId)        # turn 模式用 isYourTurn 判断
    if obs.status == "ended": break
    if !obs.isYourTurn: continue

    actions = obs.legalActions
    if 想重掷 and actions 含 roll:      action = {"action":"roll"}
    else if 想锁某颗 and actions 含 hold: action = {"action":"hold","indices":[i]}
    else:                              action = 选一个 score 动作

    submit_action(roomId, actionJson=action)   # 注意：不是 cell
    # 记分后换手；没记分则仍是你，继续循环

result = get_result(roomId)
```

MCP 注意：

- `playground_submit_action` 的 `cell: [行,列]` 快捷方式只适用于 grab（`cell`）和 connect4（`column`）；**yacht 必须用 `actionJson`** 传完整动作对象或 JSON 字符串。
- `playground_wait_for_turn` 对 yacht 可用：它用 `isYourTurn` 判断，掷骰后仍是你，会立即返回最新观测。
- `not_your_turn` 表示还没轮到你；先 `wait_for_turn`，不要硬提交。
- 规则资源：`playground://games/yacht/rules` 已注册，返回 `RULES` 全文；也可以读 `GET /api/games` 的 `rules` 字段。

### 错误码

| `error` | HTTP | 什么时候 | 怎么办 |
|---|---|---|---|
| `not_your_turn` | 409 | 还没轮到你 | 先 `wait_for_turn`，看 `currentSeat` |
| `illegal_action` | 409 | 动作不在 `legalActions` 模式里（含未掷骰就 score、已记过的栏目、非法 hold 下标） | 从响应 `legalActions` 重选 |
| `room_ended` | 409 | 对局已结束 | 读 result / 导出日志 |
| `waiting_for_opponent` | 409 | 房间还没双方入座 | 等人类入座 |
| `seat_not_joined` | 409 | 这个座位没 join | 先 `playground_join_room` |

> 设计稿里提过 `category_used` / `must_score` 两个错误码，当前实现没有这两个码：已记栏目、错误 phase 都会在服务端被 `legalActions` 模式匹配拦下，返回 `illegal_action` + 最新合法动作。

## 当前实现状态

- ✅ 内核：5 骰、每手 3 次掷骰、13 栏判定、上区 63→35、26 手终局、`previewScores`、`textView`、种子化随机（同 seed + 同动作可复现）。
- ✅ 前端：3D 骰子托盘（落定点数吸附）、13 栏计分板（预览分 + 最佳格提示 + 上区 63 进度条）、两步记分确认、终局弹窗。
- ✅ MCP：9 个通用工具 + `playground://games/yacht/rules` 资源；三种动作通过 `actionJson` 提交。
- ✅ `yacht.meta.status = "playable"`；`POST /api/rooms` 可直接建桌，`playground_list_games` 会把它列为可玩。

## 附：与设计稿的差异

设计稿定稿早于内核，以下以代码为准：

- **三条/四条计分**：设计稿 §1 表格写「三条 30、四条 30+」；实现是「满足条件后五颗骰子总和」（四条不要求五颗全同）。
- **phase 命名**：设计稿用 `roll_ready` / `can_roll`；实现是 `roll` / `choice` / `must_score`。
- **记分时机**：设计稿的状态图和合法动作示例暗示 `roll_ready` 也能 score；实现必须先掷至少 1 次，`phase="roll"` 时只有 roll。
- **错误码**：设计稿提过 `category_used` / `must_score`；实现没有这两个码，统一返回 `illegal_action` + `legalActions`（`step` 内的异常只在绕过服务端时出现）。
- **栏目键**：设计稿示例写 `yahtzee`；实现 id 是 `yacht`。
- **previewScores**：设计稿只说「已用格为 null」；实现里未掷骰、不是自己回合、终局也全为 null。
- **Yahtzee 奖励 / Joker**：设计稿保留为待确认变体；当前实现是简化版，快艇固定 50，没有额外奖励/Joker。
