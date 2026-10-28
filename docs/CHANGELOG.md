# 变更记录（CHANGELOG）

> 只记「对外可见 / 架构级」的变化；细枝末节看 git 历史（仓库已于 2026-10-27 初始化 git，基线提交 `b3db61c`）。

## 2026-10-28 · 第 13 轮：工程交付（房间落盘 / npx 包 / 素材瘦身）

前三轮把「能不能玩」「好不好用」「安不安全」解决了，这轮解决「别人能不能直接跑起来」。

### 房间落盘：重启不再清空
- 新增 `packages/server/src/persist.ts`：房间快照写 `<dataDir>/rooms.json`，**先写 `.tmp` 再 `renameSync`** 原子覆盖；任何时刻磁盘上要么是旧的完整文件、要么是新的完整文件，进程被杀在半路只留 `.tmp`。
- 触发时机：create / join / submit / say / sweep 后打点，**400ms 防抖**合并；`SIGINT` / `SIGTERM` / `beforeExit` 同步 flush 一次。
- 恢复时按 `gameId` 用 `getGame()` 重新挂上 `GameSpec`（`RoomSnapshot = Omit<Room,'game'>`，以后往 `Room` 加字段漏写会直接编译报错）。
- **`lastActivity` 在加载时刷新成 now**：否则服务停超 2 小时后一启动，TTL 会把所有房间立刻清掉——重启不该等于清空。
- 容错：文件不存在**静默**空启动；JSON 坏 / 版本不匹配 / 顶层形状不对 → warning + 空启动，不崩；未知 `gameId` 只丢那一条。
- 环境变量：`PLAYGROUND_DATA_DIR`（默认 `./data`）、`PLAYGROUND_PERSIST=0`（关闭）。

### npx 一键包
- `packages/server`：静态目录支持 `PLAYGROUND_WEB_DIST` 覆盖（打包后 `import.meta.dirname` 落在 `dist/` 里，算不出包内 `web/`）。
- `packages/cli`：esbuild 打成**单文件 ESM**，把 server / core / mcp / `@modelcontextprotocol/sdk` 全内联，`bin` 指向 `dist/index.js`；`@ai-playground/*` 从 dependencies 挪到 devDependencies（否则安装方解析 `workspace:*` 必失败）。
- `scripts/pack-cli.mjs` 一条命令：构建 web → 复制到 `packages/cli/web` → esbuild → `npm pack`。
- **踩到的坑**：`ws` 内部 `require('events')`，esbuild 在 `format:esm` 下会转成自己的 `__require` 垫片 → `serve` 一启动就 `Dynamic require of "events" is not supported`（而 `--version` 正常，很容易误判已成功）。修法：banner 注入 `createRequire(import.meta.url)`。
- 实测：tarball **12.76 MB**，空目录 `npm i` 后 `npx ai-playground` 起服务，`/api/games`、`/`、`/audio/bgm/*.mp3`、`/llms.txt`、深链回落全部 200；MCP 的 HTTP 与 stdio 两种形态都能 initialize。

### BGM 瘦身
- 6 首 BGM 用 ffmpeg 从 **160 kbps 重编码到 96 kbps**（44.1 kHz 立体声，时长逐首核对不变），文件名不变，manifest 的 `sizeBytes` 同步更新。
- 音频 **21.6 MB → 13.0 MB**，web 产物 **22.0 MB → 13.4 MB**，tarball 随之进入 13 MB 量级。

### 验证（本轮基线）
- core **95/95**、server **45/45**（33 + 落盘 12）
- `pnpm e2e` **11 局 / 223 手 / 15 422 条断言**全过
- MCP **5 套**冒烟全过（HTTP + stdio）
- 四包 `tsc --noEmit` 0 错误
- **真进程重启实测**：装 tarball → 建桌 → 入座 → `SIGKILL` → 重启 → 日志「1 间已恢复」、房间与座位令牌全部有效（`spectator:false`）
- `PLAYGROUND_PERSIST=0` 时目录零文件


## 2026-10-28 · 第 12 轮：席位鉴权（座位令牌 + 旁观视图）

> ⚠️ **破坏性变更**：`?seat=` 不再代表身份。没带令牌的请求一律降级为**旁观者**。

修的是第 10 轮遗留的那个洞：全站没有任何身份凭据，`GET /state?seat=<对手>` 由调用方自报座位，于是猜拳的出手、抢宝的落点、深海猎手的舰队布阵都能被「另一个座位」读走。上一轮只是把挂起动作从观测里删掉（治标），这轮补上身份。


### 令牌模型
- 每个座位一张**32 位十六进制令牌**（`randomBytes(16)`），按「房间 + 座位」存，与房间同生命周期（房间在内存，重启即失效）。
- `POST /api/rooms` 建桌时**预发 0 号位令牌**并写进 `humanUrlPath`（`&token=…`）——否则任何人一个 `POST /join {seat:0}` 就能抢走房主的人类位。
- 1 号位令牌在 `POST /join` 时发放；带原令牌重复 join 幂等且不换令牌，不带令牌 join 已占座位 → **409 `seat_taken`**。
- 校验用 `timingSafeEqual`（定长比较，避免计时侧信道）。

### 请求与行为
| 接口 | 无令牌 / 错令牌 |
|---|---|
| `GET /state?seat=&token=` | **不报错**，降级为旁观观测：`spectator:true`、`seat:null`、`legalActions:[]`、`isYourTurn:false` |
| `POST /action`、`POST /say` | `403 seat_token_required` |
| `POST /join` 已占座位 | `409 seat_taken` |
| `GET /api/rooms/:id`（摘要）、`GET /log`、`/result`、`/chat`、`WebSocket` | 公开（摘要里**去掉了 `humanUrlPath`**，否则一 GET 就把令牌送人） |

降级而不是 401 是故意的：把房间链接发给朋友围观是正当场景。但旁观者拿不到任何私有信息。

### 内核：旁观视图（`observe(state, seat: null)`）
六款游戏的内核都支持 `seat = null`，此时 `legalActions` 恒为空、座位相对字段按「座位 0」呈现、`textView` 用「座位 0 / 座位 1」中性称呼：

- **深海猎手**：`yourFleet = []`、`enemyGrid` 全 `unknown`、`shotsFired = 0`；`textView` 不画「我方海域」，只给一张合并的公开战况图（每炮命中/沉没本来就广播）。
- **快艇骰子**：`previewScores` 全 `null`。
- 其余四款没有真正的私有数据，只清空可执行动作。

### 前端
- 新增 `seatToken.ts`：令牌存 `sessionStorage`（按房间 + 座位），`api.ts` 自动附加；`humanUrl` 里的 `token` 读完立刻用 `history.replaceState` 从地址栏抹掉。
- 无令牌打开房间 → **旁观模式**：顶部琥珀色横幅、计分条写「旁观中」、玩家标签改成「座位 0 / 座位 1」、棋盘只读、聊天输入框禁用。
- 建桌 → 进桌 → 出招全流程**不需要手抄令牌**；令牌只在创建房间的那个浏览器里生效。

### MCP / 脚本
- `client.ts` 按房间存令牌，`getState` / `submitAction` / `say` 自动附加；缺令牌时报 `403 seat_token_missing` 并提示先 `playground_join_room`，不会静默变旁观。
- `playground_get_state` 拿到旁观视图时明确输出「当前是旁观视图，请先 join」；新增可选 `spectate` 用于主动围观。
- `scripts/e2e.ts` 每间房跑鉴权探针：无令牌 `?seat=` 必须旁观、0 号位令牌读 1 号位仍是旁观、无令牌 join(0) 409、无令牌 action/say 403、summary 里没有 `humanUrlPath`、battleship 旁观不漏舰队。

### 验证（本轮基线）
- core **95/95**（原 85 + 旁观 10）、server **33/33**（原 21 + 鉴权 7 + HTTP 集成 5）
- `pnpm e2e` **11 局 / 222 手 / 16 840 条断言**全过（含每房鉴权探针）
- MCP **5 套**冒烟全过（含 MCP over HTTP）
- 四包 `tsc --noEmit` 0 错误；`vite build` 通过（主包 gzip 77.99 kB）
- 真机实测：建桌 → 进桌 → 出招正常；同一房间换标签页（不带令牌）打开 → 旁观横幅 + 只读；地址栏里的 `token` 已被抹掉
- 越权实测：`?seat=1` 无令牌 → `spectator:true`、`yourFleet=[]`、`enemyGrid` 全 unknown；0 号位令牌读 1 号位 → 仍旁观

### 已知缺口（本轮未做）
- 令牌是**内存态**，服务重启后房间和令牌一起失效（房间落盘是下一轮「工程交付」的事）。
- MCP over HTTP 的令牌表在服务进程内**按 roomId+座位共享**，不按 MCP 会话隔离；本机单用户无碍，公网多租户前要再设计。
- `join` 的响应里没有带令牌的 `humanUrl`：外部把 roomId 丢给 Agent 时，Agent 只能拿 1 号位令牌，人类这边仍要从创建者浏览器进。


## 2026-10-28 · 第 11 轮：体验打磨（可达性 + 一致性）

六款游戏功能不动，把「同一产品里不该有的不一致」和「键盘/读屏用户踩得到的坑」收干净。

### 可达性
- **新增 `components/Dialog.tsx`**：`role="dialog"` + `aria-modal` + `aria-labelledby`、首焦点（`data-autofocus`）、Tab 焦点陷阱、Esc 关闭、关闭后焦点回到触发按钮、背景滚动锁定。邀请弹窗（牌桌 + 大厅）与结算浮层统一走它；结算浮层现在 **Esc 回大厅**。
- **弹窗打开时棋盘快捷键失效**：新增 `utils.isDialogOpen()`，猜拳 `1/2/3` 与快艇 `Enter` 在处理函数开头守卫（之前弹窗开着按 1 会替玩家出手）。
- **对比度达 WCAG AA**：`--ink-4` `#79808d → #666d7a`（白底 3.97 → 5.21:1）、新增 `--amber-ink #8a5f14`（amber 小字 3.04 → 5.63:1）、`--ink-3` `#6f7686 → #5f6675`（paper 底 4.10 → 5.19:1，同时把 token 深浅层级调回 `ink-2 > ink-3 > ink-4`）。三处小字题色改 `--amber-ink`。
- **触控目标 ≥44px**：`@media (pointer: coarse)` 下按钮/输入/图标键统一抬到 44px；**棋盘格例外**（8×8 在 412px 每格只能 35–40px，硬拉会横向溢出）。

### 一致性
- **新增 `components/BoardShell.tsx`**：六款棋盘统一「一行 kicker + 右对齐 meta」，**删掉棋盘大标题**（计分条已给全局数/轮次）。三份棋盘 CSS 的 `xx-head/xx-kicker/xx-title` 合并进 `board-shell.css`。
- **计数口径**：深海猎手 `unitLabel` 由「炮」改「回合」（原来「第 23 炮」与盘内「已开炮 13 次」互相打架），盘内改「本局已开炮 N 次」，剩余舰船补「艘」；黑白棋盘内计数补「子」。
- **结算文案不再重复计数**：四子棋/深海猎手的 core 文案里已有「共 N 手」，前端不再拼第二遍。
- **抢宝回合号统一**：揭示期间计分条显示「刚揭晓的这一回合」，不再出现「第 4 回合 vs 揭示条第 3 回合」。
- **底部 hint 去重**：默认态不再重复 kicker 的话，只在等对手/揭示中/断线/终局时播报状态。
- **大厅**：「开发中」筛选按是否真有 wip 动态生成（路线图清零后不再有空入口）；骨架屏 3 → 6；hero 单局时长从 `/api/games` 汇总为「30 秒 – 8 分钟」；「三步开玩」第 3 步改为同时暗选/轮流行动双模式表述。
- **文案修正**：抢宝 hint「点击亮起的格子」与「可点格不再常亮」的实况一致；牌桌内的次要按钮从「先留在大厅」改为「关掉弹窗」。

### 抢宝回看
- 揭示条从 `.board-wrap` 里（绝对定位，会压住最后一排）移到棋盘下方走文档流。
- 侧栏新增可折叠「本局记录」：直接渲染观测里的 `history`，错过的 2.6 秒揭示也能回看（最新在上）。

### 双设计层与布局
- `.pending-chip` 的 `top`/`bottom` inset 冲突（徽章被拉成整格竖条）清干净；`.room-code` 去掉 2px 黑描边；`.cell-bomb::before` 红虚线内框删除。
- 快艇：≤900 托盘底栏改「信息在上、按钮在下」且按钮不再全宽（768 的整行灰带）；`.dice-row` 改五等分 grid（412 下 5 颗骰子不再 4+1 折行）。
- 1024：删掉 legacy 的 760 限宽与 20px 内缩，牌桌与顶栏同宽 968。
- `.audio-controls.is-compact` 的两条死选择器换成真实 `.audio-range`；牌桌顶栏的紧凑音量控件现在真的会收起。

### 死代码
删 `SkyDecor`（含 `App.tsx` 挂载）、`Confetti`/`Sparkles`、`api.fetchSummary`、`types.LegalActions`、`RpsObservation.lastRound`、`registry.hasGameUi`、`utils.{CELL_KEYS,isLegal,YACHT_CATEGORY_IDS}`、`resultHeadline` 的 emoji 字段。

### 验证（本轮基线）
- core **85/85**、server **21/21** 未退化
- `pnpm e2e` **11 局 / 208 手 / 12 038 条断言**全过（六款全覆盖）
- MCP **5 套**冒烟全过
- 四个包 `tsc --noEmit` 0 错误；`vite build` 通过（主包 gzip 75.78 → 77.13 kB）
- 键盘实测：结算浮层 Tab 在两按钮间循环不外溢、Esc 回大厅、首焦点落在「再来一桌」
- 响应式实测：1440 / 1024 / 768 / 412 四档走查，1024 牌桌与顶栏同宽、768 快艇按钮不再整行、412 五颗骰子一行、8×8 黑白棋无横向溢出
- 六款棋盘实测均有 kicker、均无大标题


## 2026-10-27 · 深夜（第 10 轮：最后两款上线 + 初期阶段收尾审查）

**6 款全部可开桌，路线图清空，项目初期阶段性开发到此收尾。**

### 新游戏
- **《深海猎手》（`battleship`）**：5×5 海域、每方 2 艘船（驱逐舰 2 格 + 潜艇 1 格，seed 随机布阵）、**命中继续开炮**、全沉即胜、无平局。5–8 分钟。
- **《黑白棋》（`reversi`）**：8×8 标准奥赛罗、八方向夹子翻面、无子可下自动跳过、终局数子。4–8 分钟。
- 两款都**零改动接入服务端**：深海猎手验证了「同一座位连续行动」（`submitTurn` 每步重读 `currentSeat`，不假设轮转）。

### 新增文档
[rules-battleship.md](rules-battleship.md) · [rules-reversi.md](rules-reversi.md)。

### 三方复审修掉的问题
| 级别 | 问题 | 修法 |
|---|---|---|
| **严重** | **暗选可被对手读走**：我上轮加的 `yourPending` 回传「自己挂起的动作」，但服务端无鉴权，`GET /state?seat=<对手>` 谁都能请求 → 猜拳的出手、抢宝的落点全泄露（审查员实测 4 个房间 `leak:true`） | 删掉该字段，服务端只回 `youSubmitted`；前端改写 `sessionStorage` 记住自己出了什么 |
| **严重** | **MCP 结算方直接报错**：`formatReveal` 硬编码读 grab 的 `picks`，猜拳后提交方抛 `Cannot read properties of undefined`，动作却已结算（盲重试会把同一手交到下一局） | 揭示渲染改成按形状分派 + 兜底，并补 `fire` / `place` / `pass` 事件渲染 |
| 严重 | battleship / reversi 结算副标题回退到 grab（赢局显示「金币都进了你的口袋」） | `WIN_SUBTITLES` 补两款三套文案 |
| 严重 | 邀请弹窗把猜拳当抢宝（「一起抢宝」「炸弹 −2」） | `RoomInvite` 增加 `gameId` 维度，按游戏取引导词 |
| 中 | `replay` 只支持 3 款（自称可对账却对不了新增三款） | 补 rps / battleship / reversi 回放，六款全覆盖 |
| 中 | 黑白棋规则文本把开局四子座位写反 | 改成与 `setup()` 一致（D5/E4 = 座位 0） |
| 中 | 深海猎手 `result.text` 里「共 N 炮」与结算浮层重复；「全场第 N 炮 / 你已开炮 M 次」口径不清 | 文案去重 + 明确标注口径 |
| 中 | `AudioControls` 的 `compact` 传了没拼 `is-compact`（牌桌顶栏白留一块滑块） | 补 class |
| 中 | 邀请弹窗打开时按 `1/2/3` 仍会出手 | 键盘处理检测 `.modal-backdrop` 后跳过 |
| 中 | `POST /mcp` 坏 JSON 返回 500 | 沿用 HTTP 语义：400 / 413 |
| 中 | 黑白棋 `lastPassSeat` 恒为 `null`（假字段） | 存进 `ReversiState` 并由 `step` 维护 |

### 验证（本轮基线）
- core **85/85**（59 + 深海猎手 13 + 黑白棋 13）
- server **21/21**（17 + 深海猎手 2 + 黑白棋 2）
- `pnpm e2e` **11 局 / 195 手**（六款全覆盖）
- MCP **5 套**冒烟全过（新增 `all-games-mcp.ts`：六款逐款建桌→入座→观测→首个动作）
- `pnpm replay` **六款全部可对账**（新增三款各实测一局通过）
- 四个包 `tsc` 干净、`vite build` 通过
- 真机：1440px 六款棋盘截图、412px 三款新棋盘无横向溢出

### 已知未修
游戏内弹层仍缺完整 dialog 语义与焦点管理；对比度从 2.6:1 提到 3.97:1 仍未达 AA；抢宝无本局回看、揭示条压棋盘；深海猎手「剩余艘数」在计分条与盘内重复显示；大厅「开发中」筛选已是空入口；三款新棋盘有独立标题区、三款旧板没有（骨架不统一）；`/docs/%ZZ` 的 400 仍带 `text/markdown`；多段 Range 未支持。

## 2026-10-27 · 晚间（第 9 轮：第 4 款《猜拳心理战》上线）

大厅从 3 款变 4 款。这一轮的重点不只是「多一个游戏」，而是**验证「加游戏不改服务端」这条架构承诺**——上一轮审查报告点名过同时暗选分支可能只认 grab 的动作形状，猜拳就是那块试金石。

### 新游戏
- **《猜拳心理战》（`rps-duel`）**：3 局制，同时暗出手。局 1、局 2 各 1 分，**局 3（决胜局）2 分**，总分 4；双方同出手 = 该局 0:0 但照常消耗；三局打完比总分，**同分平局**（0:2 落后靠决胜局翻成 2:2 是实战跑通的路径）。30–60 秒。
- 动作：`{"action":"throw","shape":"rock"|"paper"|"scissors"}`，只能用 `actionJson`（无 `cell` 快捷方式）。
- 规则：[docs/rules-rps-duel.md](rules-rps-duel.md)。

### 架构验证：服务端零改动
- `rooms.ts` 的 `matchesLegalAction` 是**模式子集匹配**（`legalActions` 每条当模式，字段等价出现即通过），与 `cell / column` 无关。猜拳因此**不需要服务端认识 `throw`**，一行逻辑都没改。
- 唯一动到的服务端代码是观测新增 `yourPending`（**只回给提交者本人**）：同时暗选游戏里「我这一手出的是什么」属于自己该知道的信息，页面刷新后不丢，Agent 忘了也能查回。对手的挂起出手绝不外泄。

### 前端
- 新 `RpsDuelBoard`：三局比分轨道（第 3 格标 `×2`）、单手势键 ≥96px、键盘 `1/2/3` 出招（`keydown` 排除输入控件）、提交后按 `yourPending` 进「已锁定」态、揭示动画由 `history.length` 增长驱动（**不依赖 grab 的 `reveal` 事件结构**，刷新后历史仍完整）、终局三局战报。
- 412px 竖排三个手势，无横向溢出。

### 真机验收发现并修掉的三处（都是「照抄抢宝」留下的坑）
| 问题 | 影响 | 修法 |
|---|---|---|
| `GameRoom` 的封盘条硬编码「已开牌 · 等 Agent 出招」 | 对所有同时暗选游戏生效，且绝对定位后**压在猜拳自己的状态行上** | `GameUi.inlineSeal`：棋盘已在盘内提示锁定态时不叠浮层；文案改取 `ui.hints.sealed` |
| 结算副标题 fallback 到 grab | 猜拳赢了显示「金币都进了你的口袋～」 | `WIN_SUBTITLES` 补 `rps-duel` 三条（赢/输/平） |
| `result.text` 直接吐英文 | 人类看到 `1:scissorsvrock 2:papervpaper` | 内核改成「第1局 石头 vs 剪刀 · ……」 |

### 测试
- core **59/59**（新增 15 条猜拳单测：9 种出手组合、翻倍计分、平局局照常消耗、0:2→2:2、4:0、终局、座位相对历史、回合号不越界、非法 shape）
- server **17/17**（新增 2 条房间用例：非 `cell` 形状走同时暗选通道不被 409、`yourPending` 只回自己、三局终局 + `room_ended`）
- `pnpm e2e` 覆盖 4 款游戏（猜拳 2 局 / 6 手 / 293 断言：两种「谁先提交」路径、非法出手、平局局、决胜局翻倍、2:2 平局、终局后 seed 才公开）
- MCP 新增 `test/rps-mcp-e2e.ts`（四套冒烟：cell 误用指引、`actionJson` 通道、挂起可读回、重复提交、三局终局、资源注册）
- 发现层 `/llms.txt`、`/.well-known/ai-playground.json`、`/api/agent` 同步成 4 款 + 4 个规则资源

### 自己踩的坑（已记进设计稿）
- 桶导出命名撞车：`ROUNDS_TOTAL` / `RoundRecord` / `buildTextView` 与 grab 重名，`export *` 直接 tsc 报错。按 yacht 的约定改为 `RPS_ROUNDS_TOTAL` / `RpsRoundRecord` / `buildRpsTextView`。
- 遮蔽断言的靶点写错：一开始用整个观测的 JSON 查 `rock`，但 `legalActions` 与 `textView` 本来就该列出三种出手。真正的遮蔽点是 `history` / `lastRound`。


## 2026-10-26 · 深夜（第 8 轮：三方审查 + 修复）

派了三个审查员分头查代码 / UI / 真机运行，按报告逐条复核后修复如下。

### 严重（审查发现 → 已修）
- **一行 URL 打死服务进程**：`GET /docs/%ZZ.md` 触发未捕获 `URIError`，整个 Node 退出（房间全内存 → 所有对局瞬间丢失）。已给 `decodeURIComponent` 加保护，并给整个请求处理器加最外层 try/catch（未捕获异常一律 5xx，不再逃逸成 unhandledRejection）。
- **快艇骰子可被预测**：对局进行中 `/api/rooms/:id/log` 就返回 `seed`，而骰面由 `seed + draws` 唯一决定 —— 审查员实测算出了对手下一手（`seed=779298555 → 13251`，与实际完全一致）。已改为**终局后才公开 seed**，MCP 客户端类型同步改成 `number | null`。
- **打字时按 Enter 会误记分**：快艇骰子的确认条展开后，聊天框里的 Enter 被 window 级 keydown 抢走 → 直接确认记分、吃掉一手、聊天还发不出去。已排除 `input / textarea / select / contenteditable`。
- **1024px 牌桌压穿**：计分条 Agent 一侧被聊天面板盖住（三款游戏全中，980 断点前有空档）。两栏 → 单栏的断点提前到 1100px（含计分板）。

### 中等（已修）
- 房间**无 TTL / 无上限**：加 `lastActivity` 与每 10 分钟一次的 `sweep()`（闲置 2 小时回收，`unref` 不阻止退进程）；WS 集合顺带回收 + 30s 心跳清半死连接；房间不存在直接关闭 WS 而不是永久静默。
- **`readBody` 无上限、坏 JSON 静默变成 `{}`**：现在 64KB 上限（413）、非法 JSON 明确 400 —— 以前「发坏 JSON」等于开了一桌默认游戏。
- **`Number(body.seat ?? 0)` 类型陷阱**：`true→1`、`[0]→0`，且"忘了传"会替人类下手。改为严格 `parseSeat()`，POST 路由必须显式传 0/1。
- **simultaneous 分流硬编码 `grab`**：新的同时暗选游戏会整体不可用。改为按 `legalActions` 通用匹配。
- **静态资源 404 全兜底成 HTML**：`/audio/nope.mp3`、`/assets/nope.js` 都返回 200 + HTML，`<audio>` 静默失败。现在带扩展名的缺失资源回 404，无扩展名才走 SPA。同时补 **Range/206**（4.4MB BGM 才能 seek）与 `Content-Length`。
- **发现层过时**（外部 Agent 唯一会读的东西）：`/llms.txt` 还写"两款游戏"，`/.well-known` 与 `/api/agent` 还写"只有 grab 一款"、资源只列 grab。已同步成三款 + 三种动作语义 + 3 个规则资源。
- `seat_not_joined` 分支不可达（先判 waiting）：调整检查顺序，未入座现在能正确报错。
- 对局结束后仍 2.2s 轮询（一小时 3000+ 请求）：ended 后停止轮询。
- 断线文案"操作依旧有效"与实际相反：改成"这期间的出招可能失败，稍等一两秒再点"。
- 非自己回合点棋盘零反馈：补 toast 提示。
- 房间内没有音频控件（BGM 默认开、点一下就下 4.4MB）：牌桌顶栏加紧凑版音量开关（悬停展开滑块）。
- 四子棋结算显示"1 分 : 0 分"且文案多空格：无分游戏不再渲染比分块。
- 灰字对比度不足（`--ink-4` 在暖纸底上只有 2.6:1）：调深到 `#79808d`。
- 揭示徽章被拉成整格高竖条 / 旧贴纸皮盖住分数：`bottom` 与 `top` 同时生效的老样式问题，补 `top: auto`、清掉 2px 描边与投影。

### 我这次自己引入又修掉的回归
- 重写静态服务时用 `normalize(pathname) === '/'` 判断 SPA 入口 —— **Windows 上 `normalize('/')` 会变成 `\`**，根路径指向 dist 目录本身并抛 `EISDIR`，首页直接 500。改为用原始 `pathname` 判断。

### 已知未修（记进快照，留给下一轮）
- 抢宝没有本局记录回看（错过 2.6s 揭示就看不到）
- 揭示条会压住棋盘最后一排；回合号在揭示条 / 计分条 / 结算里偶有不一致
- 邀请弹窗与结算浮层缺完整 dialog 语义（Esc 已补，焦点管理未做）
- 聊天框 placeholder 在三档宽度会被截断
- 412px 大厅顶栏仍偏挤；快艇骰子 412 下 2D 骰子会 4+1 折行
- 触控目标是否统一到 44px、要不要冲 WCAG AA：需要产品拍板

### 验证
- core 44/44、server 15/15、`pnpm e2e` 7 局 / 113 手 / 10828 断言、`pnpm -C packages/mcp test` 全过
- replay 对终局房间对账 609 项通过（seed 改为终局后公开，回放不受影响）
- 独立 8793 实例实测：崩溃 URL 不再杀进程（404/400）、坏 JSON 400、缺 seat 400、缺失资源 404、Range 返回 206 且 `Content-Range` 正确、房间不存在统一 404
- 浏览器 1024px 实测：单栏布局、计分条不再被盖、房间内音量控件可用、骰面点数与服务端一致（`4,6,1,1,1` ↔ 预览 一=3/四=4/六=6）


## 2026-10-26 · 深夜（第 7 轮：真机反馈驱动的骰子与计分板重做）

主人真机打完整局（26 手，205 : 248）后提了四条，全部按反馈改：

### 修复（真 bug）
- **第三次掷骰后两颗骰子停不下来**：托盘只在「骰面字符串变化」时吸附，若重掷掷出**相同点数**，字符串不变 → 不吸附 → 永久自转。改为用 `settleKey`（`round + rollsLeft + 骰面`，每掷一次必变）驱动吸附，并加 2.4s 兜底超时。
- **骰子溢出显示框**：算相机距离时半宽写成 `(间距 + 骰子)/2`，少算一半，骰子被放大 ~40%。已按「最外侧骰心 + 半个骰子 + 余量」重算。
- **锁定框与骰子错位**：热区用像素投影 + 容器尺寸两套坐标，容易对不上。改成**归一化百分比**（NDC → 0–100%），并给热区加 `aspect-ratio: 1`，与 canvas 实际像素解耦。
- **计分板把牌桌列挤扁**：`.board-wrap` 有 `width: min(100%, 486px)` 的旧固定宽度（抢宝时代的装饰框），且 grid 子项 `min-width: auto` 让聊天列按 min-content 膨胀。加 `.board-wrap.is-plain`（快艇骰子用）放开宽度，并给列补 `min-width: 0`。

### 变更（按主人审美）
- **骰子改成正交相机正对 Z 轴**：只看得见点数那一面，没有顶面/侧面透视；掷骰变成**绕视线轴自转**（不再是随机轴翻滚露侧面）。
- 骰子**不再有面内随机倾角**（那会让方块是斜的、而框是正的 → 看起来"框歪了"）。
- 锁定状态改用**材质自发光**（暖琥珀）表示，不做位移，所以点击框永不偏移；正面视角没有投影，另加一层 CSS 落影把骰子压住。
- **计分板重做**（`YachtScorecard.tsx` + `styles/scorecard.css`）：桌面两栏（上区 6 行 / 下区 7 行），整行都是 ≥50px 的可点按钮，我的分数 21px 粗体、对手 14px 弱化，琥珀预览 / 灰底已记 / 最划算色条，确认条内联展开在被点行下方；≤900px 自动单栏。
- 牌桌列宽从 `1.55fr : 0.95fr` 调到 `1.95fr : 0.82fr`，把宽度还给棋盘。

### 验证
- core 44/44、server 15/15、`tsc --noEmit` 0 错误、`pnpm build` 通过。
- 浏览器实测：正面视图中五颗骰子为正方形、点数与服务端完全一致；锁定框严丝合缝；`must_score` 时骰子全部停住；两栏计分板内联确认条不挤压；抢宝棋盘在变宽后的列里居中正常。
- `assets/screenshot-yacht.png` 已更新为新版界面。

## 2026-10-26 · 夜（第 6 轮：快艇骰子界面 + 3D + 音频接线）

### 新增
- **`YachtBoard`**（`packages/web/src/components/boards/YachtBoard.tsx`）：骰子托盘 + 13 栏计分板。计分板含预览分（虚线琥珀格）、当前最划算格子提示（绿点）、上区 63 进度条、已记格灰底、对手列只读、终局总分行。
- **`DiceTray3D`**（three.js）：圆角象牙骰 + 点数贴图 + `RoomEnvironment` 环境光；**确定性吸附**——先随机翻滚，落定时用四元数把服务端点数转到顶面，不接物理引擎（物理随机结果会和权威骰面冲突）。只用 `three` 一个依赖，未引入 fiber/drei。
- **`DiceRow` / `DiceFace`**：纯 CSS 骰面兜底（WebGL 不可用、懒加载期间、`prefers-reduced-motion`）。
- **`onAction` 通道**：`BoardRenderProps` 增加非格子类动作入口，`GameUi.actionForPick` 改为可选，新游戏不必再伪装成「点格子」。
- **按游戏取词**：`ScoreBar` 的 `turnLabel/waitLabel`、`ChatPanel.quickPhrases`、`RoomInvite.mode`、`resultHeadline(result, gameId)`，避免骰子游戏说「这枚金币归我」。
- **SFX 接线**：掷骰 / 落定 / 锁定 / 解锁 / 记分 / 揭示 / 胜负全部接到真实音效，自带合成兜底。
- **`assets/screenshot-yacht.png`**：锁定一颗骰子的中局截图。

### 变更
- **`yacht.meta.status` → `playable`**，`yacht.test.ts` 断言恢复严格相等（`assert.equal(meta.status,'playable')`）。
- **服务端静态层**：`MIME` 补 `.mp3/.ogg/.wav/.m4a`（否则 `<audio>` 收到 `octet-stream` 可能拒播）。
- **服务端补文档路由**：`/AGENTS.md`、`/CREDITS.md`、`/docs/*.md`（白名单 + 防路径穿越）。此前大厅「给 Agent 的接入说明」按钮指向 `/AGENTS.md` 实际是 404。
- **大厅「开一桌」弹窗**：从 `/api/games` 的 `resolution` 推导 `RoomInvite mode`，轮流制游戏不再显示「同时暗选」引导。
- **页脚**新增「音乐与音效署名」链接（CC-BY 4.0 需要可点到的署名）。
- **`package.json`**：`prebuild` 自动跑 `scripts/sync-audio.mjs`，`audio:sync` 可手动同步。
- **`uiFor()` 兜底**：未注册的 gameId 显示「界面还没做好」占位，不再错渲染成抢宝棋盘。

### 修复
- 记分确认条原用 `position: sticky` 吸底，实际不出现 → 改为**行内展开**，确认条直接插在被点的那一行下面。
- 3D 相机过低导致顶面被压扁、点数难读 → 抬到约 52° 俯角；骰子间距 1.24 → 1.38，透视下不再互相压住。
- 服务起在非 8787 端口时 `/mcp` 内工具仍打 8787 → 启动时 `process.env.PLAYGROUND_URL ??= http://HOST:PORT`。
- **窄屏横向溢出**：3D 托盘的 canvas 拿旧布局尺寸把列撑宽 → `renderer.setSize` 改为带 `updateStyle`、补 `window.resize` 与父容器 ResizeObserver；同时**小屏（≤720px）改走平面骰子**（3D 仍桌面优先，安卓移植时再按真机调参）。
- **计分板撑宽整列**：表格按 min-content 计算 → `.y-table { table-layout: fixed }` + 你/对手两列固定 68px。

## 2026-10-26 · 夜（音频素材入库）

### 新增
- **音频素材库**：`assets/audio/bgm/` 6 首（合计约 18 分钟）、`assets/audio/sfx/` 9 个音效，全部为可商用授权（CC0 1.0 × 9、CC-BY 4.0 × 6），无 NC / ND / GPL 音频。
- **`assets/audio/manifest.json`**：机器可读清单，含 `id` / `file` / `title` / `author` / `license` / `licenseUrl` / `sourceUrl` / `durationSec` / `sizeBytes`；`file` 为相对 `assets/audio/` 的路径（如 `bgm/calm-1.mp3`）。
- **[CREDITS.md](CREDITS.md)**：中文署名表（作者 / 许可证 / 来源链接 / 是否修改），附 CC-BY 4.0 署名文案与「版权方要求即移除」声明。

### 变更
- BGM 统一转码为 160 kbps MP3（44.1 kHz 立体声），单曲 2.5–4.7 MB，满足 2–6 MB 预算；SFX 统一为单声道 128 kbps MP3 并做 −1.5 dBFS 峰值归一化，单个 2.5–61 KB（均 < 200 KB）。
- SFX 键名固定为 `dice-roll` / `dice-land` / `hold-on` / `hold-off` / `score` / `reveal` / `win` / `lose` / `click`，供 `AudioManager.playSfx(name)` 直接映射。

### 未接入
- 本次只交付素材与清单，`packages/web/src` 未改动；AudioManager 接线由后续提交完成。

## 2026-10-26 · 夜（快艇骰子文档）

### 新增
- **[docs/rules-yacht.md](rules-yacht.md)**：快艇骰子人类版 + Agent 版规则；13 栏判定表、上区 63→35、26 手终局、roll/hold/score 三种动作、`legalActions` 的三种形态、`previewScores` 语义、新手常见误区。
- **[docs/api-contract.md](api-contract.md)**：新增 yacht 观测字段表与动作契约，补充 roll / hold / score 事件；事件表补上 connect4 的 `drop`；补充 `/AGENTS.md`、`/CREDITS.md`、`/docs/<name>.md` 文档路由与音频 MIME / `prebuild` 同步说明。
- **AGENTS.md**：当前游戏 2 款 → 3 款，新增「快艇骰子（yacht）必看」小节（三种动作 JSON、hold 单颗 toggle、不能用 cell 快捷方式）。

### 变更
- **README.md**：游戏库/路线图把快艇骰子标为「✅ 可开桌」；当前版本改为 3 款可开桌，多游戏状态与项目结构同步更新。
- 文档口径统一：yacht 的 phase 为 `roll` / `choice` / `must_score`；`yacht.meta.status` 已从 `wip` 切为 `playable`，大厅可直接开桌。
- **core RULES**：`hold` 示例统一为 `{"action":"hold","indices":[0]}`，与服务端「一次只切一颗」的校验一致。
- **前端 yacht 界面完成**：3D 骰子托盘（three.js，落定点数吸附）、13 栏计分板（预览分 + 最佳格提示 + 上区 63 进度条）、两步记分确认、终局弹窗按游戏换词。
- **MCP**：规则资源改为按 `games` 注册表动态生成，`playground://games/yacht/rules` 已可用；yacht 三种动作走 `actionJson`。
- **`allowWip` 保持为测试开关**：`POST /api/rooms` body 传 `{"allowWip":true}` 或服务端设 `PLAYGROUND_ALLOW_WIP=1`；wip 游戏默认仍拒绝建桌，400 响应带 `hint`。

### 验证
- `pnpm -C packages/core test`：44/44 通过。
- `pnpm -C packages/server test`：15/15 通过。
- `pnpm e2e`：7 局 / 113 手 / 10795 条断言，EXIT 0。
- `pnpm -C packages/mcp test`：全部通过。

### 说明
- `assets/screenshot-yacht.png` 已补，README 游戏库已引用。
- 已记录设计稿与内核实现的差异（计分、phase 命名、错误码等），待下一轮修订。

---

## 2026-10-26 · 晚（第 3 轮）

### 新增
- **《四子棋》上线**（`turn` 轮流制第一款）：6×7 重力落子、横/竖/斜四连、满盘平局；内核 12 条单测。
- **服务端支持两种结算模式**：`meta.resolution = 'simultaneous' | 'turn'`；turn 模式引入 `not_your_turn`、`currentSeat`、`isYourTurn`，房间单测 15 条（含真实四子棋房间级用例）。
- **前端多游戏适配层**：`web/src/games/registry.tsx`（棋盘/动作/规则/hint 按 gameId 注册）、`components/boards/`（GrabBoard / Connect4Board）。
- **MCP 适配 turn 模式**：`wait_for_turn` 用 `isYourTurn` 判定；`submit_action(cell)` 按 `legalActions` 自动映射动作形状（grab.cell / connect4.column）；新增 `not_your_turn` 文案与 `playground://games/connect4/rules` 资源。
- **文档留档**：`docs/ARCHITECTURE.md`、`docs/DEV-GUIDE.md`、`docs/rules-connect4.md`、本 CHANGELOG。

### 变更
- `core` 测试脚本改为 glob（`tsx --test "test/*.test.ts"`），新增游戏测试自动纳入。
- `GameMeta` 增加 `resolution`；`BaseObservation` 增加 `currentSeat` / `isYourTurn`。
- README 游戏库：四子棋从「开发中」改为「可开桌」，新增四子棋截图与规则链接。

### 修复
- 服务端 `submit` 动作匹配不再特判 grab 形状（键序无关、允许忽略多余字段）。
- 四子棋棋盘缺少样式导致不可见 → 补齐 `.c4-*` 样式与落子动画。

---

## 2026-10-26 · 白天（第 2 轮）

### 新增
- **Agent 发现层**：`/llms.txt`、`/.well-known/ai-playground.json`、`/api/agent`、`POST /mcp`（MCP over HTTP）、仓库根 `AGENTS.md`、首页 `<noscript>` 提示。
- 前端设计系统 `theme.css` + 线条 SVG 图标层；大厅/牌桌/弹窗/结算全面重构，动效与 reduced-motion 支持。

### 修复（真机对局发现）
- 结束态回合数与文案错位；残局无决策（改为金币抢完即结束）；快捷短语只填不发；邀请弹窗 MCP 配置仍为 stdio（改 HTTP）。

---

## 2026-10-26 · 凌晨（第 1 轮 / M0 首秀）

### 新增
- TypeScript monorepo：`core`（GameSpec + 抢宝大作战）、`server`（房间/WS/静态托管）、`web`（大厅/牌桌）、`mcp`（9 工具）、`cli`。
- 一键启动、MCP 配置、规则文档、打赏占位图、e2e 与 replay 脚本、交接报告。
- 真人对局打通：浏览器人类 vs 队友 Agent（MCP HTTP），完整跑通入座→对局→结算→导出日志。

## 2026-10-26 · 晚（第 4 轮，微调）

### 变更
- 路线图骰子游戏由《掷骰胆量》改为《快艇骰子》（id `yacht`，5 颗骰子三次机会按牌型记分、比总分，3–5 分钟）。
- 开桌弹窗动效修正：背板改为**立即铺满**（原来 0.18s 淡入，开头会露出白色底），外壳改为透明、只让卡片做 320ms 进入动画；打开时锁定页面滚动，底部操作区 sticky 吸底。

### 修复
- 弹窗出现瞬间能看到「白色背板 + 卡片后到」的双层观感。

## 2026-10-26 · 夜（第 5 轮：快艇骰子内核）

### 新增
- **《快艇骰子》内核**（`packages/core/src/games/yacht.ts`）：5 骰、每回合 3 次掷骰、单颗锁定 toggle、13 栏判定（含四条/葫芦/大小顺/快艇/全骰）、上区 63→35、26 手终局、`previewScores`、可读 `textView`；注册进 `games` 表并移除目录占位。
- 单测 24 条（core 总计 **44/44**）。

### 变更
- 设计文档定稿（规则/协议/计分板/3D 方案/音频设计/里程碑）。

### 说明
- `yacht.meta.status` 暂挂 `wip`：**前端 UI（计分板 + 3D 骰子）完成后再改回 `playable`**，避免大厅入口渲染错误界面；对应单测断言已放宽并留注释。（同日已切到 `playable`，见顶部条目。）
- 3D 依赖（three / @react-three/fiber / drei）因 npm registry `ECONNREFUSED` 尚未安装，待网络恢复后补。
