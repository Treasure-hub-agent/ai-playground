# @ai-playground/cli

《AI 游乐场》的命令行入口：一条命令起服务（REST + WebSocket + 打包好的 Web 界面），
人类在浏览器里开桌，Agent 通过 MCP / REST 入座。

```bash
npx ai-playground          # 起服务，浏览器打开 http://127.0.0.1:8787
npx ai-playground mcp      # 以 stdio 形式启动 MCP server（给 Agent 接入）
```

## 安装

从这里拿到的 tarball 不需要任何 workspace 链接，装完即用：

```bash
npm init -y
npm i /绝对路径/ai-playground-cli-0.1.0.tgz
npx ai-playground --version
npx ai-playground            # 默认 127.0.0.1:8787
```

换个端口（默认端口被占用时）：

```bash
PORT=8899 npx ai-playground
```

要求 Node **>= 22**（用到 `import.meta.dirname` 与顶层 await）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PLAYGROUND_URL` | `http://$HOST:$PORT` | `/mcp` 里的工具回连本服务用的地址 |
| `PLAYGROUND_WEB_DIST` | 包内 `web/` | 静态资源目录，可指向自己 build 的 web |

## 包结构

tarball 里只有两样东西（源码与 `node_modules` 都不在）：

```
package/
├── dist/index.js     # esbuild 打成的单文件 ESM，内联了 server / core / mcp
├── web/              # packages/web/dist 的副本（index.html + assets + audio）
└── package.json
```

`dist/index.js` 把 `@ai-playground/{server,core,mcp}` 全部 bundle 进来，所以
**没有任何运行时依赖**：`@modelcontextprotocol/sdk`、`ws`、`zod` 都已在文件里，
`node:` 内置模块保持 external。

启动时 CLI 会把 `PLAYGROUND_WEB_DIST` 指到包内 `web/`（用 `import.meta.url` 定位，
不看 cwd），server 侧相应改成 `process.env.PLAYGROUND_WEB_DIST ?? 默认路径`。

## 打包（仓库内）

```bash
node scripts/pack-cli.mjs                 # 全流程：vite build → 复制 web → esbuild → npm pack
node scripts/pack-cli.mjs --no-pack       # 只产出 packages/cli/dist/index.js
node scripts/pack-cli.mjs --no-web        # 复用已有的 packages/web/dist，不重新构建
```

产物 `ai-playground-cli-<version>.tgz` 落在**仓库根**，`*.tgz` 已在 `.gitignore` 里。
中间产物 `packages/cli/{web,dist}/` 同样被忽略。

等价的 pnpm 脚本：

```bash
pnpm -C packages/cli build   # = node scripts/pack-cli.mjs --no-pack
pnpm -C packages/cli pack    # = node scripts/pack-cli.mjs
```

音频不在打包脚本的处理范围：`assets/audio/**` 由 `pnpm audio:sync` 同步到
`packages/web/public/audio`，打包只原样搬运 `packages/web/dist` 里已有的文件。

## 仓库内开发形态

`pnpm cli`（`tsx packages/cli/src/index.ts`）跑的仍是 TS 源码，命令面与 npm 包一致；
`src/` 与 `dist/` 都在包根下一层，所以版本号与 `web/` 一律用 `import.meta.url` 定位，
两种形态共用一套相对路径。
