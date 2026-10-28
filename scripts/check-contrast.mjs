#!/usr/bin/env node
/**
 * 对比度回归检查：从 theme.css 读配色 token，按 WCAG 2.1 复算文字对比度。
 *
 * 为什么要有这个：第 10 轮把 --ink-4 调深到「差一点」，第 11 轮压到 AA 之后
 * 又发现 --ink-3 反而比 --ink-4 更浅、层级反转且不达标——纯靠肉眼很难发现。
 * 以后加游戏、换配色，跑一遍这个脚本比截图看半天可靠。
 *
 * 用法：pnpm check:contrast
 * 退出码：0 全部达标；1 有不达标的组合。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const themePath = join(here, '..', 'packages', 'web', 'src', 'theme.css');
const css = readFileSync(themePath, 'utf8');

/** 从 :root 块里抓 `--name: #rrggbb;` 形式的色值。 */
function readTokens(source) {
  const tokens = new Map();
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (!tokens.has(match[1])) tokens.set(match[1], match[2].toLowerCase());
  }
  return tokens;
}

function toLinear(channel) {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const clean = hex.replace('#', '');
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

const tokens = readTokens(css);

// 底色：正文实际会落在的三种背景
const backgrounds = {
  white: tokens.get('surface') ?? '#ffffff',
  paper: tokens.get('paper'),
  'surface-2': tokens.get('surface-2'),
};

// 文字色：小字/正文用到的 token（amber 只用于装饰与大图标，单独标出来）
const textTokens = ['ink-2', 'ink-3', 'ink-4', 'amber-ink'];
const decorative = ['amber'];

const AA = 4.5;
const rows = [];
let failed = false;

for (const name of textTokens) {
  const color = tokens.get(name);
  if (!color) {
    rows.push({ token: name, bg: '-', ratio: null, note: 'theme.css 里没有这个 token' });
    failed = true;
    continue;
  }
  for (const [bgName, bg] of Object.entries(backgrounds)) {
    if (!bg) continue;
    const ratio = contrastRatio(color, bg);
    failed ||= ratio < AA;
    rows.push({ token: `--${name}`, hex: color, bg: bgName, ratio, note: ratio >= AA ? 'PASS' : 'FAIL' });
  }
}

for (const name of decorative) {
  const color = tokens.get(name);
  if (!color) continue;
  const ratio = contrastRatio(color, backgrounds.white);
  rows.push({
    token: `--${name}`,
    hex: color,
    bg: 'white',
    ratio,
    note: '装饰/大字号，参考 3:1',
  });
}

console.log('token             色值      底色       对比度   判定');
for (const row of rows) {
  const ratio = row.ratio === null ? '  n/a ' : row.ratio.toFixed(2).padStart(6);
  console.log(
    `${row.token.padEnd(17)} ${(row.hex ?? '').padEnd(9)} ${row.bg.padEnd(10)} ${ratio}   ${row.note}`,
  );
}

if (failed) {
  console.error('\n有文字配色未达 WCAG AA 4.5:1');
  process.exit(1);
}
console.log('\n全部文字配色达到 WCAG AA 4.5:1');
