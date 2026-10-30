# 贡献指南

谢谢你来给《AI 游乐场》添砖加瓦。这个项目的目标很小也很具体：**让人类和 Agent 能在一张桌子上，用同一套规则玩完一局小游戏。**

最需要的贡献是**新游戏**，其次是 UI、规则文案、测试和 Agent 接入体验。提大改动前先开 Issue，避免白做。

## 先跑起来

```bash
pnpm install
pnpm dev       # API 8787 + 网页 5173
pnpm test      # 内核单元测试
pnpm build     # 构建前端到 packages/web/dist
```

约定：

- 代码是 TypeScript ESM，导入本地文件要带 `.ts` 后缀（`allowImportingTsExtensions`）。
- 严格模式（`strict`）；不要用 `any` 兜底，除非确实在接第三方边界并写注释。
- 文档写中文；标识符用英文；注释可以中文。
- 不提交 `node_modules/`、`dist/`、密钥、模型 API Key。

## 目录约定

```text
packages/core/src/games/<game-id>.ts     # 游戏规则 + GameSpec 实现
packages/core/src/index.ts               # 注册表：把新游戏挂进 games
packages/core/test/<game-id>.test.ts     # 内核单元测试
docs/rules-<game-id>.md                  # 人类版 + Agent 版规则
packages/web/src/...                     # 人类端 UI（当前对局界面是抢宝专用，新增游戏需要加视图）
packages/mcp/src/...                     # MCP 接入层（工具是通用的，通常不需要按游戏改）
```

## 如何加一款游戏

### 1. 实现 `GameSpec`

接口以 `packages/core/src/types.ts` 为准：

```ts
export interface GameSpec<TState = unknown, TObs extends object = object> {
  meta: GameMeta;
  setup(seed: number): TState;
  observe(state: TState, seat: Seat): TObs & BaseObservation;
  legalActions(state: TState, seat: Seat): Action[];
  step(state: TState, actions: Record<Seat, Action>): { state: TState; events: GameEvent[] };
  isTerminal(state: TState): boolean;
  result(state: TState): GameResultSummary;
}
```

`GameMeta`：

```ts
interface GameMeta {
  id: string;        // 稳定 id，例如 "grab"，会出现在 URL 和 MCP 参数里
  name: string;      // 中文名
  tagline: string;   // 一句话卖点
  seats: number;     // 当前 MVP 固定 2
  rules: string;     // 给 Agent 读的规则全文（同时作为 MCP resource）
}
```

> 注意：早期 MVP 方案里写的是 `meta()` 方法和 `step(state, seat, action)`；**当前实现以 `types.ts` 为准**：`meta` 是属性，`step` 一次接收所有座位的动作（同时暗选类游戏必需）。

各字段的硬要求：

- **`setup(seed)`**：必须用传入的 seed + `mulberry32`/`shuffle` 做随机，**禁止 `Math.random()`**。同一个 seed 必须生成完全相同的初始状态，否则回放和测试都会崩。
- **`observe(state, seat)`**：观测唯一出口。隐藏信息只能在这里遮蔽；双方公开信息要一致，私有信息不能从任何字段漏出去。
  - 必须返回 `BaseObservation` 的字段：`gameId`、`seat`、`round`、`roundsTotal`、`scores`、`legalActions`、`textView`、`status`。
  - `status` 由内核返回 `playing` / `ended`；服务端会覆盖成房间状态（含 `waiting`）。
  - `legalActions` 必须是**当前这一刻**真正合法的动作数组；结束时为空。
  - `textView` 是纯文本盘面，照顾不支持图像/结构化理解的模型。
- **`step(state, actions)`**：不要原地改 `state`，返回新状态；同时结算所有座位；返回的 `events` 要能驱动 UI 动画和日志。
- **`isTerminal(state)`**：纯函数，不依赖外部计时器。
- **`result(state)`**：`{ winner, scores, text }`；`winner` 为座位号或 `null`（平局）。
- **`legalActions(state, seat)`**：和 `step` 的校验保持一致；服务端会用它检查动作，别让「合法列表」和「实际可执行」打架。

### 2. 注册游戏

在 `packages/core/src/index.ts` 里挂进注册表：

```ts
import { grab } from './games/grab.ts';
import { myGame } from './games/my-game.ts';

export const games: Record<string, GameSpec<any, any>> = {
  grab,
  'my-game': myGame,
};
```

注册后，`GET /api/games`、`playground_list_games()`、`playground_create_room("my-game")` 都会自动看到它。

### 3. 写规则文档

新增 `docs/rules-<game-id>.md`，至少包含：

1. **人类版**：一屏能读完的规则 + 一个具体示例回合。
2. **Agent 版**：观测字段、动作 schema、回合循环、错误码、示例请求/响应。

`meta.rules` 里的字符串要和文档语义一致——Agent 只读 `meta.rules` / `playground://games/<id>/rules`，不会去翻你的 PR 描述。规则里写清「同分算平局还是加赛」「同时提交怎么结算」这类边界。

### 4. 写测试

在 `packages/core/test/<game-id>.test.ts` 至少覆盖：

- `setup` 的组成（数量/类型/随机分布）与**同 seed 可复现**；
- `legalActions` 的初始数量、格式、随状态收缩；
- `step` 的每个分支（加分/扣分/撞车/空动作/终局）；
- `isTerminal` 与 `result`（含平局）；
- `observe` 不泄漏隐藏信息，且 `textView` 可读。

当前 `packages/core/package.json` 的 `test` 脚本是**显式文件名**：

```json
"test": "tsx --test test/grab.test.ts"
```

新增测试后，把它加进去（例如 `tsx --test test/grab.test.ts test/my-game.test.ts`），否则 `pnpm test` 不会跑你的新用例。

### 5. 接入 UI 与 MCP

- **MCP**：10 个工具是通用的，新游戏不用加工具（第 14 轮的 `playground_bind_session` 是唤醒桥，与具体游戏无关）；但规则 resource 目前只为 `grab` 注册了 `playground://games/grab/rules`，新增游戏需要在 `packages/mcp/src/index.ts` 里补一条 `registerResource`，URI 用 `playground://games/<id>/rules`。
- **UI**：当前 `packages/web` 的对局界面是《抢宝大作战》专用。新游戏需要加一个视图组件，并在大厅的游戏卡片里按 `gameId` 切换；不要引入重型依赖，保持 SVG/CSS 卡通风格。
- 如果新游戏需要新的观测字段，先在 PR 里说明 UI 怎么用，并同步更新 `docs/api-contract.md`（这份契约是共用的，改语义要先讨论）。

## 事件约定

`step` 返回的 `events` 会被服务端原样广播给 WebSocket、写进日志，并由 UI 消费。建议：

| 事件 | 字段 | 时机 |
|---|---|---|
| `reveal` | `round`、双方动作、`delta`、`scores`、`grid` 等 | 每次结算后 |
| `end` | `result: { winner, scores, text }` | 终局，和最后一个 `reveal` 同批 |
| `chat` | `message: { id, seat, text, at }` | 发言（由服务端发，不由游戏内核发） |

字段名一旦发布就当成契约；要改先和接入层/UI 对齐。

## 测试要求

提交前跑：

```bash
pnpm test                    # 内核单测
pnpm -C packages/server test # 改了房间/服务端逻辑时
pnpm e2e                     # 改了协议/结算时（需服务端在跑）
pnpm build                   # 改了 web 时
```

如果环境跑不了某条（例如端口被占），在 PR 里写清楚哪条没跑、为什么。

## PR 清单

- [ ] 规则先说清楚：新游戏有 `docs/rules-<id>.md`，`meta.rules` 和文档一致
- [ ] `setup` 同 seed 可复现，没有 `Math.random()`
- [ ] `observe` 不泄漏隐藏信息；`textView` 可读；`legalActions` 与实际一致
- [ ] 同时提交/终局/平局/撞车等边界有测试
- [ ] 新测试文件已加进 `packages/core/package.json` 的 `test` 脚本
- [ ] `pnpm test` 通过；改 web 时 `pnpm build` 通过；改协议时 `pnpm e2e` 通过
- [ ] 新游戏已在大厅可见，README 路线图/状态同步更新
- [ ] 没有提交密钥、个人二维码、`node_modules`、`dist`
- [ ] 新素材是自制或授权兼容（代码 MIT，美术 CC BY 4.0），并在 PR 里注明来源
- [ ] PR 描述包含：玩法一句话、示例回合、截图（如有）、已跑命令、已知限制

## 许可

- 代码贡献按 [MIT](LICENSE) 授权。
- 美术/文案素材按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 授权；引用他人素材必须注明来源和许可。

## 行为约定

- 对事不对人；规则争议用「可复现的盘面 + 期望结果」说话。
- 不提交未实现功能的 README 宣传；宁可写「开发中」。
- 小步 PR：一个游戏、一个 bug、一个 UI 组件分开提，评审会快很多。
