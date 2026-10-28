#!/usr/bin/env node
/**
 * pack-cli.mjs —— 一条命令产出可 `npm i ./xxx.tgz` 的 CLI 包
 *
 *   node scripts/pack-cli.mjs               # 全流程：构建 web → 复制 → esbuild → npm pack
 *   node scripts/pack-cli.mjs --no-pack     # 只做到 dist/index.js（不给 tarball）
 *   node scripts/pack-cli.mjs --no-web      # 跳过 web 构建，直接用已有的 packages/web/dist
 *
 * 为什么不直接把 workspace 包发出去：`@ai-playground/{server,core,mcp}` 都是
 * `private: true` + `main: src/*.ts` 的 TS 源码包，没有构建产物，也不打算发布。
 * 所以这里用 esbuild 把它们全内联进 `packages/cli/dist/index.js`，tarball 里只剩
 * 一个 JS 文件 + 静态资源，装完不依赖任何 workspace 链接。
 *
 * 音频不做任何处理：`assets/audio/**` 由 Lead 单独重编码后经 sync-audio 同步，
 * 打包脚本只负责原样搬运 packages/web/dist 里已有的文件。
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_PKG = join(ROOT, 'packages', 'web');
const CLI_PKG = join(ROOT, 'packages', 'cli');
const WEB_DIST = join(WEB_PKG, 'dist');
const CLI_WEB = join(CLI_PKG, 'web');
const CLI_DIST = join(CLI_PKG, 'dist');

const argv = new Set(process.argv.slice(2));
const SKIP_PACK = argv.has('--no-pack');
const SKIP_WEB_BUILD = argv.has('--no-web');

/** 包名/版本从 CLI 的 package.json 读，tarball 名与 npm pack 保持一致。 */
const cliPkg = JSON.parse(readFileSync(join(CLI_PKG, 'package.json'), 'utf8'));

function step(title) {
  console.log(`\n\x1b[36m▸ ${title}\x1b[0m`);
}

/** shell 模式下参数需要自己加引号（Node 会直接拼接字符串，不做转义）。 */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * 统一用 shell 跑外部命令：Windows 上 pnpm/npm 是 .cmd，不借 shell 起不来；
 * 但 shell 模式下不能再把 args 数组交给 spawnSync（会触发 DEP0190 并丢掉转义），
 * 所以这里自己拼成一行命令。
 */
function spawnLine(command, args, options = {}) {
  return spawnSync([command, ...args].map(quoteArg).join(' '), { shell: true, ...options });
}

function run(command, args, options = {}) {
  const result = spawnLine(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`命令失败（exit ${result.status}）：${command} ${args.join(' ')}`);
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnLine(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`命令失败（exit ${result.status}）：${command} ${args.join(' ')}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

async function walk(dir, base = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, rel)));
    else if (entry.isFile()) files.push({ rel, size: (await stat(full)).size });
  }
  return files;
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 找 esbuild：pnpm 只把「直接依赖」链接到包的 node_modules，脚本本身在仓库根，
 * 不能裸 `import('esbuild')`。这里按「cli 包 → 仓库根 → pnpm store」顺序兜底，
 * 三种布局都能跑（devDependencies 装好 / 被 hoist / 只在 .pnpm 里）。
 */
async function loadEsbuild() {
  const candidates = [];
  try {
    candidates.push(createRequire(join(CLI_PKG, 'package.json')).resolve('esbuild'));
  } catch {
    /* 未安装到 cli 包，继续兜底 */
  }
  try {
    candidates.push(createRequire(join(ROOT, 'package.json')).resolve('esbuild'));
  } catch {
    /* 根也没有，继续兜底 */
  }
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      /* 换下一个 */
    }
  }
  // 最后兜底：pnpm store 里的 esbuild（`node_modules/.pnpm/esbuild@x.y.z/node_modules/esbuild`）
  const storeDir = join(ROOT, 'node_modules', '.pnpm');
  if (existsSync(storeDir)) {
    const versions = (await readdir(storeDir))
      .filter((name) => name.startsWith('esbuild@'))
      .map((name) => name.slice('esbuild@'.length))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const version of versions.reverse()) {
      const entry = join(storeDir, `esbuild@${version}`, 'node_modules', 'esbuild', 'lib', 'main.js');
      if (!existsSync(entry)) continue;
      try {
        return await import(pathToFileURL(entry).href);
      } catch {
        /* 换下一个 */
      }
    }
  }
  throw new Error('找不到 esbuild：请先在仓库根执行 `pnpm install`（esbuild 已在 cli 的 devDependencies 里）');
}

// ── 1. 构建 web ────────────────────────────────────────────────────────────
if (SKIP_WEB_BUILD) {
  step('跳过 web 构建（--no-web）');
} else {
  step('构建 web（vite build）');
  run('pnpm', ['-C', 'packages/web', 'build'], { cwd: ROOT });
}

if (!existsSync(join(WEB_DIST, 'index.html'))) {
  throw new Error(`web 产物不存在：${WEB_DIST}/index.html，先去构建 packages/web`);
}

// ── 2. 复制 web/dist → packages/cli/web ────────────────────────────────────
step('复制静态资源到 packages/cli/web');
await rm(CLI_WEB, { recursive: true, force: true });
await cp(WEB_DIST, CLI_WEB, { recursive: true });
const webFiles = await walk(CLI_WEB);
const webBytes = webFiles.reduce((sum, file) => sum + file.size, 0);
console.log(`  ${webFiles.length} 个文件，${formatMb(webBytes)}`);

// ── 3. esbuild 单文件打包 ──────────────────────────────────────────────────
step('esbuild 打包 dist/index.js');
const esbuild = await loadEsbuild();
await rm(CLI_DIST, { recursive: true, force: true });
await mkdir(CLI_DIST, { recursive: true });

await esbuild.build({
  entryPoints: [join(CLI_PKG, 'src', 'index.ts')],
  outfile: join(CLI_DIST, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // node: 内置模块与 ws 的两个可选原生加速依赖都留在外面：
  // - node:* 由平台提供；
  // - bufferutil / utf-8-validate 是 ws 的 try/catch 可选 require，装着才加速，不强求存在。
  external: ['node:*', 'bufferutil', 'utf-8-validate'],
  // bin 的 JS 必须有 shebang，否则 POSIX 上 npm 生成的可执行文件跑不起来。
  // 第二段是 ESM 里跑 CJS 依赖的必需品：ws 之类的 CJS 包会 `require('events')`，
  // esbuild 在 format=esm 下把这句转成自己的 __require 垫片，而垫片只有在作用域里
  // 存在 `require` 时才能工作，否则运行期抛 `Dynamic require of "events" is not supported`。
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  legalComments: 'none',
  logLevel: 'warning',
});

const bundleStat = await stat(join(CLI_DIST, 'index.js'));
console.log(`  dist/index.js ${formatMb(bundleStat.size)}`);

// ── 4. npm pack ────────────────────────────────────────────────────────────
if (SKIP_PACK) {
  step('跳过 npm pack（--no-pack）');
  console.log(`\n\x1b[32m✓ 构建完成\x1b[0m ${relative(ROOT, join(CLI_DIST, 'index.js'))}`);
  process.exit(0);
}

step('npm pack');
// 先清掉上次的 tarball，避免拿到旧产物
const expectedName = `${cliPkg.name.replace(/^@/, '').replace('/', '-')}-${cliPkg.version}.tgz`;
await rm(join(ROOT, expectedName), { force: true });
await rm(join(CLI_PKG, expectedName), { force: true });

const packOutput = runCapture('npm', ['pack', '--json', '--pack-destination', ROOT], { cwd: CLI_PKG });
let packedFilename = expectedName;
try {
  const parsed = JSON.parse(packOutput);
  packedFilename = parsed?.[0]?.filename ?? expectedName;
} catch {
  /* --json 解析失败就按约定名兜底 */
}
const tarball = join(ROOT, packedFilename);
if (!existsSync(tarball)) throw new Error(`npm pack 没有产出 ${tarball}`);
const tarballStat = await stat(tarball);

// 自检：tarball 里不能有 node_modules、不能有 TS 源码（设计稿 §3 验收项）
step('tarball 自检');
let listing = [];
try {
  listing = runCapture('tar', ['-tzf', packedFilename], { cwd: ROOT })
    .split(/\r?\n/)
    .filter(Boolean);
} catch (error) {
  // 极老的系统可能没有 tar；不影响出包，只是跳过自检
  console.warn(`  ⚠ 跳过自检（tar 不可用）：${error.message.split('\n')[0]}`);
}
if (listing.length > 0) {
  const scopes = new Set(listing.map((entry) => entry.replace(/^package\//, '').split('/')[0]));
  const badEntries = listing.filter((entry) => {
    if (entry.includes('/node_modules/')) return true;
    // .d.ts 不算“源码”，真要带类型声明是合法产物
    return /\.ts$/.test(entry) && !entry.endsWith('.d.ts');
  });
  if (badEntries.length > 0) {
    throw new Error(`tarball 里混进了不该有的文件：\n${badEntries.slice(0, 10).join('\n')}`);
  }
  console.log(`  ${listing.length} 个条目，顶层：${[...scopes].sort().join(' / ')}`);
  console.log(`  无 node_modules、无 .ts 源码 ✓`);
}

console.log(`\n\x1b[32m✓ tarball\x1b[0m ${tarball}`);
console.log(`  体积 ${formatMb(tarballStat.size)}（dist ${formatMb(bundleStat.size)} + web ${formatMb(webBytes)}）`);
console.log(`  安装 ${pathForDocs(tarball)}`);
console.log('');

function pathForDocs(file) {
  // 报告里给个可直接复制的安装命令，Windows 反斜杠在 shell 里容易被吃掉，统一成正斜杠
  return `npm i ${file.replace(/\\/g, '/')}`;
}
