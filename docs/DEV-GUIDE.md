# 开发指南（本地留档）

> 给「明天的自己」和协作者用。跑起来、改起来、排查起来，都在这里。
> 架构与契约见 [ARCHITECTURE.md](ARCHITECTURE.md)；接口字段见 [api-contract.md](api-contract.md)。

---

## 1. 环境

| 项 | 要求 |
|---|---|
| Node | ≥ 22（推荐 24） |
| pnpm | ≥ 9（仓库用 11 验证过） |
| 系统 | Windows / macOS / Linux 均可；Windows 下命令示例用 PowerShell |

```bash
pnpm install          # 首次
pnpm dev              # API 8787 + Vite 5173（改代码热更新）
pnpm build && pnpm start   # 生产态：构建前端 + 单端口 8787 托管
```

端口占用时：`PORT=8799 pnpm -C packages/server start`（Windows PowerShell 用 `$env:PORT=8799`）。

---

## 2. 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 同时起 API 与前端（开发主用） |
| `pnpm dev:server` / `pnpm dev:web` | 只起其一 |
| `pnpm start` | 构建 + 生产态单端口 |
| `pnpm test` | 内核单测（glob：`test/*.test.ts`） |
| `pnpm -C packages/server test` | 房间/结算单测 |
| `pnpm e2e` | 真实 HTTP+WS 打完整局（默认跑 grab / connect4 / yacht / rps-duel / battleship / reversi） |
| `pnpm replay --room <id>` | 由 seed+picks 回放对账 |
| `pnpm -C packages/mcp exec tsx test/smoke.ts` | MCP stdio 客户端冒烟 |
| `pnpm -C packages/mcp exec tsx test/http-mcp.ts` | MCP over HTTP 冒烟（含四子棋） |
| `pnpm -C packages/web exec tsc --noEmit` | 前端类型检查 |
| `pnpm cli -- --help` | 命令行入口（serve / mcp） |

---

## 3. 目录速查

```text
packages/core/src/
  types.ts            GameSpec / GameMeta / Observation 契约
  index.ts            游戏注册表（加游戏只改这里一行）
  catalog.ts          下一批候选游戏（当前为空）
  games/grab.ts       抢宝大作战（simultaneous）
  games/connect4.ts   四子棋（turn）
  games/yacht.ts      快艇骰子（turn）
  games/rps-duel.ts   猜拳心理战（simultaneous）
  games/battleship.ts 深海猎手（turn）
  games/reversi.ts    黑白棋（turn）
packages/server/src/
  rooms.ts            房间状态机：submit 按 resolution 分流
  server.ts           HTTP 路由 + WS + MCP over HTTP + 静态托管
  discovery.ts        llms.txt / well-known 描述
packages/web/src/
  App.tsx / Lobby.tsx / GameRoom.tsx
  games/registry.tsx  前端游戏注册表（棋盘/动作/规则/hint）
  components/boards/  各游戏棋盘
  components/Icons.tsx
  styles.css          旧基础样式
  theme.css           设计系统（覆盖层，新样式都写这里）
```

---

## 4. 改一处代码前先问自己

1. **是规则还是表现？** 规则进 `core`，表现进 `web`；服务端只做裁判与协议。
2. **观测够不够？** 前端只能读 `observe()` 给的东西；需要新字段先改内核再改前端。
3. **两种结算模式会不会冲突？** 动 `submit` 时同时照顾 `simultaneous` 与 `turn`，并跑两套单测。
4. **要不要动旧样式？** 新样式都写 `theme.css`，`styles.css` 只在必须时改（覆盖层便于回滚）。

---

## 5. 调试技巧

- **看 agent 到底收到什么**：`curl "http://127.0.0.1:8787/api/rooms/<id>/state?seat=1"`，或 MCP 的 `playground_get_state`。
- **看协议流水**：WS 事件 + `/log?seat=1` 有完整事件序列；`pnpm replay --room <id>` 可逐回合对账。
- **两个座位互演**：REST 直接给 seat0/seat1 各提交，最快复现一局（见 scripts/e2e.ts 写法）。
- **前端样式没生效**：确认改的是 `theme.css`（在 `main.tsx` 里 import 在 styles.css 之后），选择器权重够不够。
- **Windows 上 pnpm 找不到**：MCP 配置里 `command` 写 `pnpm.cmd`。
- **服务重启房间就没了**：房间只在内存（MVP 取舍），重新开一桌即可。

---

## 6. 常见坑（踩过的）

| 现象 | 原因 | 处理 |
|---|---|---|
| core 测试只跑了 grab | 测试脚本曾写死文件 | 已改 glob：`tsx --test "test/*.test.ts"` |
| `export *` 报 TS2308 重名 | grab 与 connect4 都有 `buildTextView` | connect4 侧改名 `buildConnect4TextView` |
| turn 模式棋盘一直可点 | 前端用 `youSubmitted` 判断 | 改用 `isYourTurn`（README/架构文档已写明） |
| MCP `wait_for_turn` 立刻「就绪」 | 只看 `youSubmitted` | 已改为 `isYourTurn ?? !youSubmitted` |
| MCP `submit_action(cell)` 只认 grab | 写死 `{action:'grab',cell}` | 已改为按 `legalActions` 自动映射（支持 column） |
| 四子棋事件里 board 看着像字符串 | PowerShell `ConvertTo-Json -Depth` 截断显示 | 数据本身是 `number[][]`，加 `-Depth 6` 即可 |
| 棋盘格子看不见 | 忘加 `.c4-*` 样式 | 样式在 `theme.css` 末尾 |
| 房间 409 `not_your_turn` | 轮流制抢对方的回合 | 先 `wait_for_turn` |
| 大厅点进新游戏却是抢宝界面 | 前端 `uiFor()` 未注册该 gameId 会回退到 grab | 先把 `games/registry.tsx` 与 `<Id>Board` 注册好，再把 `meta.status` 从 `wip` 改 `playable` |
| 骰子 hold 提交被拒 | 契约是**单颗 toggle**：`{"action":"hold","indices":[i]}`，传多个下标不合法 | 一次只切换一颗，重复调用 |
| 弹窗出现时背后先露白板 | 背板有淡入动画 + 外壳白底双层 | 背板 `animation:none`、外壳透明、只动卡片（theme.css 弹窗段） |
| 想给新游戏加音频/3D 依赖 | npm registry 偶发 `ECONNREFUSED` | 换时间重试或换源；3D 依赖在 `packages/web` |
| 大厅「给 Agent 的接入说明」点开 404 | 服务端只托管 `web/dist`，不认仓库里的 md | 已加 `/AGENTS.md`、`/CREDITS.md`、`/docs/*.md` 路由（白名单 + 防穿越） |
| 音频 `<audio>` 不播 / 控制台报格式不支持 | 静态服务把它当 `application/octet-stream` 发出去 | `MIME` 表补 `.mp3/.ogg/.wav/.m4a` |
| 大厅「开一桌」弹窗文案串味（骰子游戏说「抢宝」） | `RoomInvite` 默认 `mode='simultaneous'`，大厅没把 `resolution` 传下去 | 从 `/api/games` 的 `resolution` 取，传给 `RoomInvite mode` |
| 记分确认条 `position: sticky` 不出现 | 粘在长表格末尾时浏览器不给吸底位 | 改成**行内展开**：确认条插在被点的那一行下面（`YachtBoard` 的 `y-confirm-row`） |
| 3D 骰子读数难 | 相机太低（≈25°）顶面被压扁 | 相机抬到 ≈52° 俯角：`camera.position(0, d*0.82, d*0.6)` |
| 骰面点数对不上服务端 | 材质顺序或朝向映射错 | `BoxGeometry` 材质序 `[+X,-X,+Y,-Y,+Z,-Z]` → `[3,4,1,6,2,5]`；"点数 n 朝上"用固定四元数，别用物理模拟 |
| `wip` 游戏建桌被 400，e2e 跑不动 | `POST /api/rooms` 对 `status==='wip'` 直接拒绝 | 传 `{"allowWip":true}` 或起服务设 `PLAYGROUND_ALLOW_WIP=1`（仅供测试） |
| 服务起在非 8787，MCP 工具打到别的实例 | `packages/mcp` 默认连 8787 | `server.ts` 启动时 `process.env.PLAYGROUND_URL ??= http://HOST:PORT` |
| 窄屏（≤720px）整页横向溢出 | 3D 托盘的 canvas 拿旧布局尺寸，撑开了列宽 | 小屏改走平面骰子（`USE_3D_MIN_WIDTH=720`）；3D 是**桌面优先**实现，安卓移植时再按真机调相机；另 `renderer.setSize(w,h)` 要带 `updateStyle`，并监听 `window.resize` |
| 计分板把列撑得比视口宽 | 表格默认布局按 min-content 计算，长标签推宽整列 | `.y-table { table-layout: fixed }` + 你/对手两列固定 68px |
| **重掷出相同点数时骰子一直转** | 吸附只盯着"骰面字符串是否变化"，值没变就不触发 | 用 `settleKey`（round + rollsLeft + 骰面）驱动吸附，并留 2.4s 兜底超时 |
| **骰子溢出托盘 / 锁定框对不上** | 相机取景半宽少算一半；热区用像素坐标 | 取景按 `SLOT_GAP*2 + DIE_SIZE/2 + 余量`；热区改**归一化百分比** + `aspect-ratio: 1` |
| 骰子读数被"翻面"干扰 | 随机轴翻滚会露出侧面点数 | 改**正交相机正对 + 只绕视线轴自转**，点数面永远朝向观众 |
| 快艇骰子牌桌特别窄、聊天区特别宽 | `.board-wrap` 有 486/520px 固定宽度；grid 子项 `min-width:auto` 按 min-content 膨胀 | 给快艇骰子的外壳加 `.is-plain` 放开宽度；列上补 `min-width: 0` |
| 锁定想用"抬起"表示，结果框跟着歪 | 位移会改变投影位置，热区不跟着动 | 用**材质自发光**表示锁定，位置不动 |

---

## 7. 提交前自检清单

- [ ] `pnpm -C packages/core test`（含新游戏用例）
- [ ] `pnpm -C packages/server test`
- [ ] `pnpm e2e`（grab / connect4 / yacht / rps-duel / battleship / reversi 全跑；`--game=<id>` 可单跑）
- [ ] 新游戏：`pnpm -C packages/mcp test` + 实机打一局
- [ ] `pnpm -C packages/web exec tsc --noEmit` + `pnpm build`（`prebuild` 会自动同步音频素材）
- [ ] 更新 `docs/rules-<id>.md`、README 游戏库表格、本文件「常见坑」（如果又踩了新坑）
- [ ] 截图存 `assets/screenshot-<feature>.png`


| 一行 URL 打死服务进程 | `decodeURIComponent` 抛出的 URIError 无人捕获，逃逸成 unhandledRejection | 解码处 try/catch + 请求处理器最外层 try/catch（未捕获一律 5xx） |
| 骰子被"算命" | 进行中就返回 seed，而 yacht 骰面 = f(seed, draws) | seed 只在终局后公开；测试断言同步改成 `seed === null` |
| 聊天框按 Enter 却记了分 | window 级 keydown 没排除输入框 | 判断 `event.target` 的 tagName / isContentEditable |
| Windows 上首页 500 `EISDIR` | `normalize('/')` 在 win32 返回 `\`，被判成目录 | SPA 判断用**原始 pathname**，别用 normalize 结果 |
| 1024px 被聊天面板压住 | 两栏断点写在 980 | 提前到 1100（含计分板） |
| `/audio/x.mp3` 返回 200 HTML | SPA 兜底把缺失资源也回 index.html | 带扩展名的缺失资源回 404；同时补 Range/206 |
| 未入座提交只报 `waiting_for_opponent` | 检查顺序：先判 waiting 再判 occupied | 先判 occupied，`seat_not_joined` 才可达 |
| `seat: true` 被当成座位 1 | `Number(body.seat ?? 0)` 强转 | 严格 `parseSeat()`，POST 必须显式传 0/1 |
| **暗选被「自己视角」字段泄露** | 观测里加了「本局我提交的动作」（`yourPending`），但服务端无鉴权，`GET /state?seat=<对手>` 谁都能请求 | **不要加任何「只回给某座位」的字段**；自己出过什么由客户端存（本项目用 `sessionStorage`）。观测里只放 `youSubmitted` 布尔值 |
| MCP 猜拳后提交方报 `Cannot read properties of undefined` | `formatReveal` 硬编码读 grab 的 `ev.picks`，而 rps 的 reveal 只有 `shapes`；动作其实已结算，盲重试会交到下一局 | 事件渲染按**形状分派 + 兜底**，并把新游戏的 `fire` / `place` / `pass` 一起补上 |
| 新游戏结算显示「金币都进了你的口袋」 | `WIN_SUBTITLES` 没有该游戏，兜底回 grab | 新游戏必须补三套文案（赢/输/平） |
| 邀请弹窗把猜拳讲成抢宝 | `RoomInvite` 只按 `mode` 二选一，两款 simultaneous 共用一套词 | 传 `gameId`，按游戏取引导词 |
| 桶导出报 `TS2308: already exported` | `Coord` / `ROUNDS_TOTAL` / `buildTextView` 在多个内核里重名 | 按游戏加前缀（`RPS_ROUNDS_TOTAL`），或把 `Coord` 设为模块内私有 |
| 内核文件语法错误「Expected ; but found ...」 | 规则文本模板串里用反引号包了字段名，把模板提前闭合 | 规则文本里不要用反引号，用「」或纯文本 |
| `replay` 对一半游戏 `exit 1` | 新游戏上线没同步回放脚本 | 新增游戏时把 `scripts/replay.ts` 的分派一起补（现在六款全覆盖） |
| 弹窗打开时按 `1/2/3` 仍然出手 | 全局 `keydown` 没有检查弹层 | 处理键盘前先 `document.querySelector('.modal-backdrop')` |
