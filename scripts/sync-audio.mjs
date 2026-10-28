#!/usr/bin/env node
/**
 * sync-audio.mjs —— 把 assets/audio/** 同步到 packages/web/public/audio/**
 *
 * 用法：
 *   node scripts/sync-audio.mjs            # 同步一次
 *   node scripts/sync-audio.mjs --watch    # 监听 assets/audio 变化并自动同步
 *
 * 约定：
 * - 运行时 URL = /audio/<manifest 里的 file>
 * - assets/audio/manifest.json 缺失或格式异常时只警告，不阻断开发/构建；
 *   前端 AudioManager 会自动降级（BGM 静默、SFX 用 WebAudio 合成）。
 */

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'audio');
const DEST = path.join(ROOT, 'packages', 'web', 'public', 'audio');
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

async function walk(dir, base = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, rel)));
    } else if (entry.isFile()) {
      const info = await stat(full);
      files.push({ rel, size: info.size });
    }
  }
  return files;
}

function describeManifest(raw) {
  if (!raw || typeof raw !== 'object') return '（无法解析）';
  const bgm = Array.isArray(raw.bgm) ? raw.bgm.length : raw.bgm && typeof raw.bgm === 'object' ? Object.keys(raw.bgm).length : 0;
  let sfx = 0;
  if (Array.isArray(raw.sfx)) sfx = raw.sfx.length;
  else if (raw.sfx && typeof raw.sfx === 'object') sfx = Object.keys(raw.sfx).length;
  return `bgm=${bgm} sfx=${sfx}`;
}

async function validateManifest() {
  const manifestPath = path.join(SRC, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn('[audio] ⚠ assets/audio/manifest.json 不存在：BGM 将静默，SFX 使用合成兜底');
    return;
  }
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
    console.log(`[audio] manifest 校验通过 ${describeManifest(raw)}`);
  } catch (error) {
    console.warn(`[audio] ⚠ manifest.json 解析失败（前端会静默降级）：${error.message}`);
  }
}

async function syncOnce() {
  if (!existsSync(SRC)) {
    console.warn('[audio] 跳过同步：assets/audio/ 不存在');
    return;
  }

  await validateManifest();
  await mkdir(path.dirname(DEST), { recursive: true });
  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });
  await cp(SRC, DEST, { recursive: true, filter: (source) => !IGNORED.has(path.basename(source)) });

  const files = await walk(DEST);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  const mb = (bytes / 1024 / 1024).toFixed(2);
  console.log(`[audio] 已同步 ${files.length} 个文件（${mb} MB）→ packages/web/public/audio`);
  if (files.length > 0) {
    const preview = files.slice(0, 8).map((file) => `  · ${file.rel}`).join('\n');
    console.log(preview + (files.length > 8 ? `\n  … 共 ${files.length} 个` : ''));
  }
  if (!existsSync(path.join(DEST, 'manifest.json'))) {
    console.warn('[audio] public/audio/manifest.json 缺失：运行时将无 BGM（不报错）');
  }
}

await syncOnce();

if (process.argv.includes('--watch')) {
  console.log(`[audio] watching ${path.relative(ROOT, SRC)} … (Ctrl+C 退出)`);
  let timer;
  try {
    watch(SRC, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        syncOnce().catch((error) => console.warn(`[audio] 同步失败：${error.message}`));
      }, 250);
    });
  } catch (error) {
    console.warn(`[audio] 监听失败（可手动重跑）：${error.message}`);
  }
}
