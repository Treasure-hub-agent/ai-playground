/**
 * Agent 玩家 play-agent：以 1 号位通过 MCP over HTTP 打完整局。
 *
 * 运行：
 *   pnpm -C packages/mcp exec tsx test/play-agent.ts
 * 预检（只连接 + 入座 + 读状态，不进入对局循环）：
 *   $env:PLAY_AGENT_PREFLIGHT="1"; pnpm -C packages/mcp exec tsx test/play-agent.ts
 *
 * 环境变量：
 *   PLAYGROUND_MCP  默认 http://127.0.0.1:8787/mcp
 *   PLAYGROUND_ROOM 默认 dvj0lg
 *   PLAYGROUND_SEAT 默认 1
 *   PLAY_AGENT_BUDGET_MS 默认 330000（整个对局循环的时间预算）
 *
 * 产出：
 *   06-tmp/play-agent-run.log       全过程原始日志（每次工具调用、返回、异常）
 *   06-tmp/dvj0lg-log.json          export_log 原始返回
 *   06-tmp/play-agent-summary.json  回合摘要 + 异常清单（供汇报）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- 配置 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '../../..');
const OUT_DIR = resolve(PROJECT_ROOT, '06-tmp');
const RUN_LOG = resolve(OUT_DIR, 'play-agent-run.log');
const SUMMARY = resolve(OUT_DIR, 'play-agent-summary.json');

const MCP_URL = process.env.PLAYGROUND_MCP ?? 'http://127.0.0.1:8787/mcp';
const ROOM = process.env.PLAYGROUND_ROOM ?? 'dvj0lg';
const SEAT = Number(process.env.PLAYGROUND_SEAT ?? 1);
const OPP = SEAT === 0 ? 1 : 0;
const BUDGET_MS = Number(process.env.PLAY_AGENT_BUDGET_MS ?? 330_000);
const PREFLIGHT = process.env.PLAY_AGENT_PREFLIGHT === '1';

/* ---------------------------------------------------------------- 日志 */

mkdirSync(OUT_DIR, { recursive: true });
function log(line: string) {
  appendFileSync(RUN_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  console.log(line);
}

type Severity = 'high' | 'medium' | 'low';
interface Anomaly { severity: Severity; where: string; detail: string; at: string }
const anomalies: Anomaly[] = [];
function anomaly(severity: Severity, where: string, detail: string) {
  anomalies.push({ severity, where, detail, at: new Date().toISOString() });
  log(`!! ANOMALY [${severity}] ${where}: ${detail}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n = 1200) => (s.length > n ? `${s.slice(0, n)}…(${s.length}B)` : s);

/* ---------------------------------------------------------------- MCP */

let client: Client;
const toolNames: string[] = [];
const toolSchemas: Record<string, any> = {};
const transcript: any[] = [];

async function callTool(name: string, args: Record<string, unknown>, timeout = 90_000) {
  const t0 = Date.now();
  try {
    const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const ms = Date.now() - t0;
    const sc = res?.structuredContent;
    const text = Array.isArray(res?.content)
      ? res.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' | ')
      : '';
    log(`→ ${name}(${JSON.stringify(args)}) ${ms}ms${res?.isError ? ' isError=true' : ''}`);
    log(`   ${sc ? `sc=${clip(JSON.stringify(sc), 2600)}` : `text=${clip(text, 900)}`}`);
    transcript.push({ name, args, ms, isError: !!res?.isError, sc: sc ?? null, text: clip(text, 2000) });
    return { res, ms, sc, text };
  } catch (err: any) {
    const ms = Date.now() - t0;
    anomaly('high', name, `callTool 抛异常（${ms}ms）：${err?.message ?? String(err)}`);
    transcript.push({ name, args, ms, threw: String(err?.message ?? err) });
    throw err;
  }
}

/* ---------------------------------------------------------------- 观测校验 */

function checkObservation(obs: any, where: string) {
  if (!obs || typeof obs !== 'object') {
    anomaly('high', where, 'observation 缺失或不是对象');
    return;
  }
  for (const key of ['round', 'status', 'scores', 'legalActions', 'grid'] as const) {
    if (obs[key] === undefined) anomaly('medium', where, `observation 缺字段 ${key}`);
  }
  if (!Array.isArray(obs.legalActions) || obs.legalActions.length === 0) {
    anomaly('medium', where, `legalActions 为空（status=${obs.status} round=${obs.round} youSubmitted=${obs.youSubmitted}）`);
  }
}

/* ---------------------------------------------------------------- 选格策略 */

function cellText(v: any): string {
  if (typeof v === 'number') return `coin${v}`;
  if (v === 'bomb') return 'bomb';
  if (v === 'empty') return 'empty';
  return String(v);
}

function boardLines(grid: any): string[] {
  if (!Array.isArray(grid)) return ['<no grid>'];
  return grid.map((row: any, r: number) =>
    `   row${r}: ${(Array.isArray(row) ? row : []).map((v: any) => cellText(v).padEnd(7)).join('| ')}`,
  );
}

/** 优先面值最高的金币；没有金币则优先空格；只剩炸弹才选炸弹；同分随机。 */
function chooseCell(obs: any): { cell: [number, number]; val: any; reason: string } {
  const legal: Array<[number, number]> = (obs.legalActions ?? [])
    .filter((a: any) => a && a.action === 'grab' && Array.isArray(a.cell))
    .map((a: any) => [Number(a.cell[0]), Number(a.cell[1])] as [number, number]);
  const grid = obs.grid;
  const valOf = ([r, c]: [number, number]) => (Array.isArray(grid) && grid[r] ? grid[r][c] : undefined);

  const withVal = legal.map((cell) => ({ cell, val: valOf(cell) }));
  const coins = withVal.filter((x) => typeof x.val === 'number' && x.val > 0);
  const empties = withVal.filter((x) => x.val === 'empty');
  const bombs = withVal.filter((x) => x.val === 'bomb');
  const others = withVal.filter((x) => typeof x.val !== 'number' && x.val !== 'empty' && x.val !== 'bomb');

  let pool = coins.length ? coins : empties.length ? empties : others.length ? others : bombs;
  let reason = coins.length ? '最高面值金币' : empties.length ? '无金币→空格' : others.length ? '未知格' : '只剩炸弹';
  const best = Math.max(...pool.map((x) => (typeof x.val === 'number' ? x.val : -1)));
  const top = pool.filter((x) => (typeof x.val === 'number' ? x.val : -1) === best);
  const pick = top[Math.floor(Math.random() * top.length)];
  // 同分并列时说明一下
  if (top.length > 1) reason += `（同分${top.length}选1随机）`;
  return { cell: pick.cell, val: pick.val, reason };
}

function scoreOf(obs: any, seat: number): number | undefined {
  const s = obs?.scores;
  if (!s) return undefined;
  const v = s[String(seat)] ?? s[seat];
  return typeof v === 'number' ? v : undefined;
}

/* ---------------------------------------------------------------- 主流程 */

interface RoundLog {
  round?: number;
  cell?: [number, number];
  cellVal?: string;
  reason?: string;
  ok?: boolean;
  resolved?: boolean;
  events: string[];
  you?: number;
  opp?: number;
  collision?: boolean;
  error?: string;
  tookMs?: number;
}

const rounds: RoundLog[] = [];
let result: any = null;
let exportedPath: string | null = null;
let endReason = 'unknown';

async function main() {
  log('');
  log('================ play-agent 启动 ================');
  log(`room=${ROOM} seat=${SEAT} mcp=${MCP_URL} budget=${BUDGET_MS}ms preflight=${PREFLIGHT}`);

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  client = new Client({ name: 'play-agent', version: '0.1.0' });
  await client.connect(transport);
  log('✅ MCP handshake ok');

  const tools = await client.listTools();
  for (const t of tools.tools) {
    toolNames.push(t.name);
    toolSchemas[t.name] = t.inputSchema;
  }
  log(`tools(${tools.tools.length}): ${toolNames.join(', ')}`);
  for (const t of tools.tools) {
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const req = t.inputSchema?.required ?? [];
    log(`   ${t.name} args=[${props.join(',')}] required=[${req.join(',')}]`);
  }

  // --- 入座 ---
  try {
    const joined = await callTool('playground_join_room', { roomId: ROOM, seat: SEAT });
    if (joined.res?.isError) {
      anomaly('high', 'join_room', `isError=true：${clip(JSON.stringify(joined.sc ?? joined.text), 600)}`);
    } else {
      log(`✅ join_room ok occupied=${JSON.stringify(joined.sc?.occupied ?? 'n/a')} status=${joined.sc?.status ?? 'n/a'}`);
    }
  } catch (err: any) {
    anomaly('high', 'join_room', `入座抛异常，继续尝试读状态：${err?.message ?? err}`);
  }

  // --- 读初始状态 ---
  let obs: any = {};
  try {
    const st = await callTool('playground_get_state', { roomId: ROOM, seat: SEAT });
    obs = st.sc?.observation ?? st.sc ?? {};
    checkObservation(obs, 'get_state');
    log(`state: round=${obs.round}/${obs.roundsTotal} status=${obs.status} you=${scoreOf(obs, SEAT)} opp=${scoreOf(obs, OPP)} youSubmitted=${obs.youSubmitted}`);
    for (const line of boardLines(obs.grid)) log(line);
  } catch (err: any) {
    anomaly('high', 'get_state', `读状态失败：${err?.message ?? err}`);
    endReason = 'get_state_failed';
    await finish();
    return;
  }

  if (PREFLIGHT) {
    log('PREFLIGHT 结束（未进入对局循环）');
    await finish();
    return;
  }

  // --- 开局垃圾话（失败不算致命）---
  if (obs.status !== 'ended') {
    try {
      const said = await callTool('playground_say', { roomId: ROOM, seat: SEAT, text: '这局的金币归我' });
      if (said.res?.isError) anomaly('low', 'say', `isError=true：${clip(JSON.stringify(said.sc ?? said.text), 400)}`);
      else log('✅ say ok');
    } catch (err: any) {
      anomaly('low', 'say', `say 抛异常（不致命）：${err?.message ?? err}`);
    }
  }

  const deadline = Date.now() + BUDGET_MS;
  let timeouts = 0;
  let idleLoops = 0;
  let lastRoundSeen = Number(obs.round ?? 0);

  while (Date.now() < deadline) {
    if (obs.status === 'ended') break;

    // ---- 等轮到我 ----
    let waited: any;
    try {
      waited = await callTool('playground_wait_for_turn', { roomId: ROOM, seat: SEAT, timeoutSeconds: 60 });
    } catch (err: any) {
      anomaly('high', 'wait_for_turn', `调用失败，2s 后重试：${err?.message ?? err}`);
      await sleep(2000);
      idleLoops += 1;
      if (idleLoops > 20) { endReason = 'wait_for_turn_repeated_failures'; break; }
      continue;
    }
    const wsc = waited.sc ?? {};
    const wobs = wsc.observation ?? {};
    if (wobs && Object.keys(wobs).length) obs = wobs;

    if (waited.res?.isError) {
      anomaly('high', 'wait_for_turn', `isError=true：${clip(JSON.stringify(wsc), 500)}`);
      const code = String(wsc.error ?? '');
      if (/not_found|unknown_room|expired/i.test(code)) { endReason = 'room_gone'; break; }
      await sleep(1500);
      idleLoops += 1;
      if (idleLoops > 20) { endReason = 'wait_for_turn_repeated_errors'; break; }
      continue;
    }

    checkObservation(obs, 'wait_for_turn');
    if (obs.status === 'ended') { log('wait_for_turn: status=ended'); break; }

    if (wsc.timedOut) {
      timeouts += 1;
      log(`wait_for_turn 超时 #${timeouts} → status=${obs.status} round=${obs.round} youSubmitted=${obs.youSubmitted}`);
      if (obs.status === 'waiting') log('   （status=waiting：人类尚未入座，开局未开始）');
      idleLoops += 1;
      if (idleLoops > 12) { endReason = 'idle_timeout'; break; }
      continue;
    }

    if (!wsc.ready) {
      log(`wait_for_turn ready=${wsc.ready} timedOut=${wsc.timedOut} status=${obs.status} round=${obs.round} → 等 1.2s 重试`);
      await sleep(1200);
      idleLoops += 1;
      if (idleLoops > 120) { endReason = 'never_ready'; break; }
      continue;
    }
    if (obs.youSubmitted) {
      log(`轮到我但 youSubmitted=true（round=${obs.round}）→ 等 1.2s 再看`);
      await sleep(1200);
      idleLoops += 1;
      if (idleLoops > 120) { endReason = 'stuck_you_submitted'; break; }
      continue;
    }

    idleLoops = 0;

    // ---- 选格 ----
    let pick = chooseCell(obs);
    let attempt = 0;
    let submitted = false;
    while (attempt < 3 && !submitted) {
      attempt += 1;
      const rec: RoundLog = {
        round: Number(obs.round ?? lastRoundSeen),
        cell: pick.cell,
        cellVal: cellText(pick.val),
        reason: pick.reason,
        events: [],
      };
      if (rec.round !== lastRoundSeen) {
        log(`---- Round ${rec.round} ----`);
        for (const line of boardLines(obs.grid)) log(line);
        lastRoundSeen = rec.round!;
      }

      let sub: any;
      try {
        sub = await callTool('playground_submit_action', { roomId: ROOM, seat: SEAT, cell: pick.cell }, 60_000);
        rec.tookMs = sub.ms;
      } catch (err: any) {
        rec.error = `抛异常：${err?.message ?? err}`;
        rounds.push(rec);
        anomaly('high', 'submit_action', rec.error!);
        await sleep(1500);
        break;
      }
      const ssc = sub.sc ?? {};
      rec.ok = ssc.ok;
      rec.resolved = ssc.resolved;
      rec.events = Array.isArray(ssc.events) ? ssc.events.map((e: any) => String(e?.type)) : [];
      if (sub.res?.isError) {
        rec.error = String(ssc.error ?? 'isError');
        rounds.push(rec);
        anomaly('medium', 'submit_action', `isError=${rec.error} cell=[${pick.cell}] → 按返回的 legalActions 换格重试（第 ${attempt} 次）`);
        const legalAlt = (ssc.legalActions ?? []).filter(
          (a: any) => Array.isArray(a?.cell) && !(a.cell[0] === pick.cell[0] && a.cell[1] === pick.cell[1]),
        );
        if (!legalAlt.length) { anomaly('high', 'submit_action', '服务端返回 409 但没有可替换的 legalActions'); break; }
        const alt: any = obs;
        alt.legalActions = legalAlt;
        pick = chooseCell(alt);
        continue;
      }

      // 结算信息
      const reveal = (ssc.events ?? []).find((e: any) => e?.type === 'reveal');
      const nextObs = ssc.observation ?? {};
      const scoreSrc = reveal?.scores ?? ssc.scores ?? nextObs.scores ?? obs.scores;
      rec.you = scoreSrc ? (scoreSrc[String(SEAT)] ?? scoreSrc[SEAT]) : scoreOf(nextObs, SEAT);
      rec.opp = scoreSrc ? (scoreSrc[String(OPP)] ?? scoreSrc[OPP]) : scoreOf(nextObs, OPP);
      if (reveal?.picks) {
        const mine = reveal.picks[String(SEAT)];
        const theirs = reveal.picks[String(OPP)];
        rec.collision = !!(mine && theirs && mine[0] === theirs[0] && mine[1] === theirs[1]);
        log(`   reveal: picks me=${JSON.stringify(mine)} opp=${JSON.stringify(theirs)}${rec.collision ? ' ⚡撞车' : ''}`);
      }
      if (!reveal && ssc.resolved !== true) log('   本回合尚未结算（对手还没提交）');
      if (!reveal && ssc.resolved === true) anomaly('medium', 'submit_action', 'resolved=true 但 events 里没有 reveal 事件');

      log(
        `R${rec.round} pick=[${pick.cell}] ${rec.cellVal} (${pick.reason}) → resolved=${ssc.resolved} ` +
          `score ${rec.you ?? '?'}:${rec.opp ?? '?'} events=[${rec.events.join(',') || 'none'}] ${sub.ms}ms`,
      );
      rounds.push(rec);
      submitted = true;

      // 用返回的观测继续（若有）
      if (nextObs && Object.keys(nextObs).length) obs = nextObs;
      else {
        // 没有观测就主动拉一次
        try {
          const st2 = await callTool('playground_get_state', { roomId: ROOM, seat: SEAT });
          obs = st2.sc?.observation ?? obs;
        } catch (err: any) {
          anomaly('low', 'get_state', `提交后补拉状态失败：${err?.message ?? err}`);
        }
      }
      if (obs.status === 'ended') {
        log('status=ended（提交后）');
      }
    }

    if (!submitted) {
      endReason = 'submit_gave_up';
      break;
    }
  }

  if (!endReason || endReason === 'unknown') {
    endReason = obs.status === 'ended' ? 'ended' : 'budget_exhausted';
  }
  await finish();
}

async function finish() {
  log('================ 收尾 ================');

  // 结果
  for (let i = 0; i < 2; i += 1) {
    try {
      const r = await callTool('playground_get_result', { roomId: ROOM });
      result = r.sc ?? result;
      if (result?.ended === true) break;
      await sleep(1200);
    } catch (err: any) {
      anomaly('medium', 'get_result', `调用失败：${err?.message ?? err}`);
      break;
    }
  }
  log(`result: ${clip(JSON.stringify(result ?? {}), 1500)}`);

  // 日志导出
  try {
    const lg = await callTool('playground_export_log', { roomId: ROOM, seat: SEAT });
    const sc = lg.sc ?? {};
    const target = resolve(OUT_DIR, `${ROOM}-log.json`);
    writeFileSync(target, JSON.stringify(sc, null, 2), 'utf8');
    exportedPath = target;
    log(`✅ export_log 成功：events=${Array.isArray(sc.events) ? sc.events.length : 'n/a'} → ${target}`);
  } catch (err: any) {
    anomaly('medium', 'export_log', `导出失败：${err?.message ?? err}`);
  }

  // 摘要
  const summary = {
    room: ROOM,
    seat: SEAT,
    mcp: MCP_URL,
    startedAt: new Date(Date.now() - BUDGET_MS).toISOString(),
    finishedAt: new Date().toISOString(),
    endReason,
    tools: toolNames,
    toolArgSummary: Object.fromEntries(
      Object.entries(toolSchemas).map(([name, schema]) => [name, Object.keys(schema?.properties ?? {})]),
    ),
    rounds,
    result,
    scores: result?.scores ?? null,
    winner: result?.winner ?? null,
    exportedLog: exportedPath,
    anomalies,
  };
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2), 'utf8');
  log(`summary → ${SUMMARY}`);

  log('');
  log(`回合数=${rounds.length} 结束原因=${endReason}`);
  log(`比分=${JSON.stringify(result?.scores ?? null)} 胜者=${JSON.stringify(result?.winner ?? null)} ended=${result?.ended}`);
  log(`异常 ${anomalies.length} 条：`);
  for (const a of anomalies) log(`  [${a.severity}] ${a.where}: ${a.detail}`);
  log('================ 结束 ================');

  try { await client.close(); } catch { /* ignore */ }

  const ok = result?.ended === true && exportedPath;
  process.exitCode = ok ? 0 : 2;
}

main().catch(async (err: any) => {
  console.error('\n❌ play-agent 崩溃：', err?.message ?? err);
  log(`!! FATAL: ${err?.stack ?? err}`);
  try { await client?.close(); } catch { /* ignore */ }
  process.exit(1);
});
