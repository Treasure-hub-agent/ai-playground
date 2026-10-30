/**
 * AI 游乐场 MCP server（stdio）。
 *
 * - 工具：把 REST 契约包装成 Agent 可调用的 MCP tools；
 * - 资源：playground://games/grab/rules 返回规则全文；
 * - stdout 只留给 MCP 协议，所有日志走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CATEGORY_LABELS, games as gameRegistry } from '@ai-playground/core';
import { z } from 'zod';

import {
  PlaygroundApiError,
  bindSession,
  createRoom,
  exportLog,
  getBaseUrl,
  getResult,
  getState,
  humanUrlFor,
  joinRoom,
  listGames,
  say,
  submitAction,
  type GameEvent,
  type Observation,
  type RevealEvent,
  type Seat,
} from './client.ts';

export const SERVER_NAME = 'ai-playground';
export const SERVER_VERSION = '0.1.0';
/** 兼容旧引用：默认（抢宝大作战）规则资源 URI。 */
export const RULES_RESOURCE_URI = 'playground://games/grab/rules';
/** 任意游戏的规则资源 URI。 */
export function rulesResourceUri(gameId: string): string {
  return `playground://games/${gameId}/rules`;
}

const POLL_INTERVAL_MS = 500;

interface ToolReply {
  // SDK 的 CallToolResult 允许额外字段（协议中的 _meta 等），这里保留索引签名以便类型兼容。
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** 把任意 JSON 值当作 structuredContent 的键值包。 */
function payload(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

type ZodShape = z.ZodRawShape;
type InferShape<Shape extends ZodShape> = z.infer<z.ZodObject<Shape>>;

/**
 * 注册工具的薄封装。
 *
 * 说明：@modelcontextprotocol/sdk 1.32 的 registerTool 泛型在 TS 5.6 + zod v3 的组合下
 * 会触发 TS2589「Type instantiation is excessively deep」（运行时完全正常）。
 * 在 SDK 边界做一次窄化转换即可绕开类型实例化，同时入参与返回值仍由本文件的
 * Shape / ToolReply 做静态检查。
 */
function registerTool<Shape extends ZodShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: Shape },
  handler: (args: InferShape<Shape>) => Promise<ToolReply>,
): void {
  const register = server.registerTool as unknown as (
    this: McpServer,
    name: string,
    config: unknown,
    cb: (args: InferShape<Shape>) => Promise<ToolReply>,
  ) => void;
  register.call(server, name, config, handler);
}


function ok(text: string, data?: Record<string, unknown>): ToolReply {
  return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}) };
}

function fail(text: string, data?: Record<string, unknown>): ToolReply {
  return { content: [{ type: 'text', text }], ...(data ? { structuredContent: data } : {}), isError: true };
}

function describeError(err: unknown): string {
  if (err instanceof PlaygroundApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 统一兜底：把异常转成可读的 MCP 工具错误，而不是让整个 server 崩掉。 */
async function guard(fn: () => Promise<ToolReply>): Promise<ToolReply> {
  try {
    return await fn();
  } catch (err) {
    return fail(`❌ 操作失败\n\n${describeError(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusText(status: string): string {
  if (status === 'waiting') return '等待双方入座';
  if (status === 'playing') return '对局中';
  if (status === 'ended') return '已结束';
  return status;
}

function seatName(seat: number): string {
  return seat === 0 ? '人类' : 'Agent';
}

function cellText(cell: unknown): string {
  return Array.isArray(cell) && cell.length === 2 ? `[${cell[0]},${cell[1]}]` : JSON.stringify(cell);
}

/** 13 个栏目 id → 中文名（未知 id 原样返回）。 */
function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

function isYachtActionShape(actions: unknown[]): boolean {
  return actions.some((a) => {
    if (a === null || typeof a !== 'object') return false;
    const action = (a as { action?: unknown }).action;
    return action === 'roll' || action === 'hold' || action === 'score';
  });
}

/** 猜拳心理战：出手值 → 中文名。 */
const RPS_SHAPE_LABEL: Record<string, string> = {
  rock: '石头',
  paper: '布',
  scissors: '剪刀',
};

function isRpsActionShape(actions: unknown[]): boolean {
  return actions.some((a) => {
    if (a === null || typeof a !== 'object') return false;
    return (a as { action?: unknown }).action === 'throw';
  });
}

/** 把单个 legalAction 渲染成人话：兼容 grab.cell / connect4.column / yacht 的 roll|hold|score / rps 的 throw。 */
function formatLegalAction(a: unknown): string {
  if (a === null || typeof a !== 'object') return JSON.stringify(a);
  const rec = a as Record<string, unknown>;
  const cell = rec.cell;
  if (Array.isArray(cell)) return cellText(cell);
  const column = rec.column;
  if (typeof column === 'number') return `第 ${column + 1} 列`;
  if (rec.action === 'throw' && typeof rec.shape === 'string') {
    return `throw ${rec.shape}（${RPS_SHAPE_LABEL[rec.shape] ?? rec.shape}）`;
  }
  if (rec.action === 'roll') return 'roll（掷骰）';
  if (rec.action === 'hold' && Array.isArray(rec.indices)) {
    const indices = rec.indices as unknown[];
    return indices.length === 0
      ? 'hold []（全部解锁）'
      : `hold [${indices.join(',')}]（切换第 ${indices.join('/')} 颗锁定）`;
  }
  if (rec.action === 'score' && typeof rec.category === 'string') {
    return `score ${rec.category}（${categoryLabel(rec.category)}）`;
  }
  return JSON.stringify(rec);
}

/** 把 legalActions 渲染成人话：yacht 的 19 个动作按 roll / hold / score 分组压缩展示。 */
function formatLegalActions(actions: unknown[] | undefined): string {
  if (!Array.isArray(actions) || actions.length === 0) return '（没有可选动作）';
  if (isRpsActionShape(actions)) {
    const shapes = actions
      .filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object')
      .map((a) => (typeof a.shape === 'string' ? a.shape : '?'))
      .map((s) => `${RPS_SHAPE_LABEL[s] ?? s}(${s})`);
    return `throw：${shapes.join('、')} —— 用 actionJson 提交，例如 {"action":"throw","shape":"rock"}`;
  }
  if (isYachtActionShape(actions)) {
    const recs = actions.filter((a): a is Record<string, unknown> => a !== null && typeof a === 'object');
    const hasRoll = recs.some((a) => a.action === 'roll');
    const holdIndices: Array<string | null> = recs
      .filter((a) => a.action === 'hold')
      .map((a) => {
        const indices = a.indices;
        return Array.isArray(indices) && indices.length > 0 ? String(indices[0]) : null;
      });
    const scoreCategories = recs
      .filter((a) => a.action === 'score')
      .map((a) => (typeof a.category === 'string' ? a.category : '?'));

    const parts: string[] = [];
    if (hasRoll) parts.push('roll（掷骰）');
    if (holdIndices.length > 0) {
      const single = holdIndices.filter((x): x is string => x !== null);
      const allUnlock = holdIndices.includes(null);
      const holdParts: string[] = [];
      if (single.length > 0) holdParts.push(`hold 第 ${single.join('/')} 颗（单颗切换）`);
      if (allUnlock) holdParts.push('hold []（全部解锁）');
      parts.push(holdParts.join(' + '));
    }
    if (scoreCategories.length > 0) {
      parts.push(`score：${scoreCategories.map((c) => `${c}(${categoryLabel(c)})`).join('、')}`);
    }
    return parts.join('；');
  }
  return actions.map(formatLegalAction).join('、');
}

/** 409 返回的 legalActions 是 unknown[]，与正常 legalActions 用同一套渲染。 */
function formatUnknownLegalActions(actions: unknown[]): string {
  if (!Array.isArray(actions) || actions.length === 0) return '（服务端没有返回 legalActions）';
  return formatLegalActions(actions);
}

/** 快艇骰子三种动作的 JSON 示例（工具描述与错误提示共用）。 */
const YACHT_ACTION_FORMS = [
  '{"action":"roll"}                          掷骰（只重掷未锁定的骰）',
  '{"action":"hold","indices":[0]}            切换第 0 颗锁定（一次只切一颗；indices:[] = 全部解锁）',
  '{"action":"score","category":"ones"}       记分（13 栏目之一；记分后换手）',
].join('\n');

/**
 * legalActions 为空 / 不能按坐标映射时，按场景给出可读原因。
 * 覆盖任务要求的三种：不是你的回合、对局已结束、必须记分（phase=must_score）。
 */
function describeNoLegalActions(obs: Observation, roomId: string): string {
  // 旁观视图不是「规则问题」，必须先说清楚，否则 Agent 会一直等 legalActions 出现。
  if (obs.spectator === true) {
    return (
      '当前是旁观视图（spectator=true）：没有该座位的有效席位令牌，legalActions 恒为空，也不能提交动作。\n' +
      `请先调用 playground_join_room({ roomId: "${roomId}", seat: 1 }) 入座拿令牌，再重新读观测。`
    );
  }
  if (obs.status === 'ended') {
    return (
      '对局已经结束（status=ended），不能再行动。' +
      '请调用 playground_get_result 查看结算，或 playground_export_log 导出日志。'
    );
  }
  if (obs.status === 'waiting') {
    return `房间还在等双方入座（status=waiting）。请把人类入口发给人类：${humanUrlFor(roomId)}`;
  }
  if (obs.isYourTurn === false) {
    const current = obs.currentSeat;
    const currentText =
      current === null || current === undefined
        ? ''
        : `，当前行动方：座位 ${current}（${seatName(current)}）`;
    return (
      `现在不是你的回合（isYourTurn=false${currentText}）。` +
      '轮流制（四子棋 / 快艇骰子）只有轮到你时 legalActions 才非空；' +
      '请先调用 playground_wait_for_turn 等到自己的回合，不要抢对方的行动。'
    );
  }
  if (obs.phase === 'must_score') {
    return (
      '3 次掷骰已用完（phase=must_score），现在只能记分：' +
      '用 actionJson 提交 {"action":"score","category":"<13 栏目之一>"}。'
    );
  }
  return '当前 legalActions 为空：可能不是你的回合、房间未开始或对局已结束。请先 playground_get_state / playground_wait_for_turn 再决定。';
}

/** 轮到你时，下一步该用哪种参数形状（yacht / rps-duel 不能用 cell）。 */
function nextActionHint(obs: Observation, roomId: string, seat: number): string {
  if (obs.gameId === 'rps-duel') {
    return (
      '猜拳心理战请用 actionJson 提交：{"action":"throw","shape":"rock"}（石头）/ "paper"（布）/ "scissors"（剪刀）。' +
      '先提交的一方看不到对手这一手，双方都提交后才一起揭示；3 局打完比总分，第 3 局翻倍（2 分）。'
    );
  }
  if (obs.gameId === 'yacht') {
    if (obs.phase === 'must_score') {
      return (
        '掷骰次数已用完，只能记分。下一步：' +
        `playground_submit_action({ roomId: "${roomId}", seat: ${seat}, actionJson: '{"action":"score","category":"<栏目>"}' })`
      );
    }
    return (
      '快艇骰子请用 actionJson 提交：' +
      '{"action":"roll"} / {"action":"hold","indices":[0]}（一次一颗，[] 全解锁）/ ' +
      '{"action":"score","category":"<栏目>"}。'
    );
  }
  return `下一步：选一格调用 playground_submit_action({ roomId: "${roomId}", seat: ${seat}, cell: [行, 列] })。`;
}

function summarizeRules(rules: string): string {
  const lines = rules
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 2).join(' · ');
}

/**
 * 揭示事件渲染。**必须容错**：同时暗选现在有两套 reveal 形状
 * （grab 的 picks/delta/collision、rps-duel 的 shapes/points），
 * 以前这里硬编码读 `ev.picks[...]`，猜拳后提交方会直接抛
 * "Cannot read properties of undefined"，而且动作其实已经结算了 —— 盲重试会把同一手交到下一局。
 */
function formatReveal(raw: unknown): string {
  const ev = (raw ?? {}) as Record<string, any>;
  const scores = (ev.scores ?? {}) as Record<string, number>;
  const scoreText = `比分 ${scores['0'] ?? '?'} : ${scores['1'] ?? '?'}`;
  const round = ev.round ?? '?';

  // grab：双方选坐标
  if (ev.picks && typeof ev.picks === 'object') {
    const picks = [0, 1]
      .map((s) => `座位${s}→${cellText((ev.picks as Record<string, unknown>)[String(s)])}`)
      .join('，');
    const deltas = [0, 1]
      .map((s) => {
        const d = (ev.delta as Record<string, number>)?.[String(s)] ?? 0;
        return `座位${s} ${d >= 0 ? '+' : ''}${d}`;
      })
      .join(' / ');
    return (
      `第 ${round} 回合：${picks}；得分 ${deltas}；${scoreText}；` +
      (ev.collision ? '撞车，双方都没拿到' : '正常结算')
    );
  }

  // rps-duel：双方出手
  if (ev.shapes && typeof ev.shapes === 'object') {
    const labels = (ev.labels ?? {}) as Record<string, string>;
    const shapes = [0, 1]
      .map((s) => `座位${s}→${labels[String(s)] ?? (ev.shapes as Record<string, string>)[String(s)]}`)
      .join('，');
    const verdict =
      ev.winner === null || ev.winner === undefined
        ? '本局平手，无人得分'
        : `座位${ev.winner} +${ev.points ?? '?'} 分`;
    return `第 ${round} 局（值 ${ev.points ?? '?'} 分）：${shapes}；${verdict}；${scoreText}`;
  }

  return `第 ${round} 回合揭示（${JSON.stringify(ev).slice(0, 180)}）；${scoreText}`;
}

function formatEvents(rawEvents: unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of rawEvents ?? []) {
    const ev = (raw ?? {}) as Record<string, any>;
    if (ev.type === 'reveal') lines.push(`🔍 ${formatReveal(ev)}`);
    else if (ev.type === 'end') lines.push(`🏁 ${ev.result?.text ?? '对局结束'}`);
    else if (ev.type === 'chat') lines.push(`💬 座位${ev.message?.seat}：${ev.message?.text}`);
    else if (ev.type === 'roll') {
      const dice = (ev.dice as number[])
        .map((face, index) => ((ev.held as boolean[])[index] ? `[${face}*]` : `[${face}]`))
        .join(' ');
      lines.push(`🎲 座位${ev.seat} 掷骰：${dice}（本手还剩 ${ev.rollsLeft} 次）`);
    } else if (ev.type === 'hold') {
      const held = (ev.held as boolean[]).map((locked, index) => `${index}${locked ? '🔒' : ''}`).join(' ');
      lines.push(`📌 座位${ev.seat} 锁定状态：${held}`);
    } else if (ev.type === 'score') {
      const nextText = ev.nextSeat === null ? '（终局）' : `，换座位 ${ev.nextSeat}`;
      lines.push(`📝 座位${ev.seat} 记「${categoryLabel(ev.category)}」得 ${ev.gained} 分${nextText}`);
    } else if (ev.type === 'drop') {
      lines.push(`🔻 座位${ev.seat} 落子：第 ${ev.column + 1} 列 / 第 ${ev.row} 行`);
    } else if (ev.type === 'fire') {
      const result = ev.hit ? (ev.sunk ? `命中并击沉${ev.sunk}` : '命中') : '打空';
      const next =
        ev.nextSeat === null
          ? '（对局结束）'
          : ev.nextSeat === ev.seat
            ? '，**你继续开炮**'
            : `，换座位 ${ev.nextSeat}`;
      lines.push(
        `💥 座位${ev.seat} 炮击 ${ev.label ?? cellText(ev.cell)}：${result}${next}` +
          `（对手剩 ${ev.opponentShipsLeft} 艘）`,
      );
    } else if (ev.type === 'place') {
      const flips = Array.isArray(ev.flips) ? ev.flips.length : 0;
      const counts = (ev.counts ?? {}) as Record<string, number>;
      lines.push(
        `⚫ 座位${ev.seat} 落子 ${cellText(ev.cell)}：翻 ${flips} 子` +
          `（当前 ${counts['0'] ?? '?'} : ${counts['1'] ?? '?'}）`,
      );
    } else if (ev.type === 'pass') {
      lines.push(`⏭ 座位${ev.seat} 无子可下，自动跳过（仍由座位 ${ev.nextSeat} 落子）`);
    } else {
      lines.push(`ℹ️ 事件 ${String(ev.type)}：${JSON.stringify(ev).slice(0, 180)}`);
    }
  }
  return lines;
}

function normalizeActionJson(raw: string | Record<string, unknown>): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text) {
    throw new Error('actionJson 不能是空字符串。示例：actionJson = {"action":"grab","cell":[0,1]}');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `actionJson 不是合法 JSON：${(err as Error).message}\n` +
        `收到的内容：${text.slice(0, 200)}\n` +
        '正确示例：{"action":"grab","cell":[0,1]}',
    );
  }
}

function registerTools(server: McpServer): void {
  const roomIdSchema = z
    .string()
    .min(1, 'roomId 不能为空（来自 playground_create_room 的 roomId）')
    .describe('房间 id，来自 playground_create_room 的 roomId');
  const seatSchema = z
    .number()
    .int('seat 必须是整数')
    .min(0, 'seat 只能是 0（人类）或 1（Agent）')
    .max(1, 'seat 只能是 0（人类）或 1（Agent）')
    .default(1)
    .describe('座位：0=人类，1=Agent（默认 1）');
  // 唤醒桥的会话 id：形状与平台 / 插件两侧的校验保持一致，脏数据在工具层就挡掉。
  const sessionIdRequiredSchema = z
    .string()
    .min(1, 'sessionId 不能为空（DSH 里通常是环境变量 DSH_SESSION_ID）')
    .max(128, 'sessionId 最长 128 字符')
    .regex(/^[A-Za-z0-9._:-]+$/, 'sessionId 只允许 A-Za-z0-9._:-')
    .describe('DSH 会话 id（形如 session-…；通常取环境变量 DSH_SESSION_ID）');
  const sessionIdSchema = sessionIdRequiredSchema
    .optional()
    .describe('可选：建桌 / 入座后立即绑定这个会话，等价于再调一次 playground_bind_session');

  registerTool(server, 
    'playground_list_games',
    {
      title: '列出可玩游戏',
      description:
        '列出 AI 游乐场里可玩的游戏（id、名称、简介、规则全文）。第一次使用或想换游戏时先调用它。',
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const all = await listGames();
        const playable = all.filter((g) => g.status !== 'wip');
        const planned = all.filter((g) => g.status === 'wip');
        if (playable.length === 0) {
          return fail('❌ 当前没有可开桌的游戏：后端可能还在启动，或全部处于开发中。');
        }
        const lines = [
          `✅ 可玩 ${playable.length} 款${planned.length ? `（另有 ${planned.length} 款开发中）` : ''}：`,
        ];
        for (const g of playable) {
          lines.push(`- ${g.id}（${g.name}，${g.seats} 人）：${g.tagline}`);
          lines.push(`  规则：${summarizeRules(g.rules)}`);
          lines.push(`  规则资源：${rulesResourceUri(g.id)}`);
        }
        if (planned.length) {
          lines.push(
            '',
            `🚧 开发中（暂不在大厅开桌）：${planned.map((g) => `${g.id}（${g.name}）`).join('、')}`,
            '需要自动化测试时可用 playground_create_room：它会按服务端 hint 自动带 allowWip 重试。',
          );
        }
        lines.push('', `想开一局就调用 playground_create_room({ gameId: "${playable[0].id}" })。`);
        return ok(lines.join('\n'), { games: playable, planned });
      }),
  );

  registerTool(server, 
    'playground_create_room',
    {
      title: '创建房间',
      description:
        '创建一个双人房间（人类 seat 0 / Agent seat 1），返回 roomId、人类入口 humanUrl 和游戏规则。' +
        '建桌响应同时带着人类座位（0 号位）的席位令牌，并已拼进 humanUrl —— 人类打开链接即可入座，不用手抄令牌。' +
        '建完后：把 humanUrl 发给人类打开，并调用 playground_join_room(seat=1) 占 Agent 座位。',
      inputSchema: {
        gameId: z
          .string()
          .min(1, 'gameId 不能为空')
          .optional()
          .describe(
            '游戏 id：grab（抢宝）/ connect4（四子棋）/ yacht（快艇骰子）/ rps-duel（猜拳心理战）/ battleship（深海猎手）/ reversi（黑白棋），默认 grab',
          ),
        sessionId: sessionIdSchema,
      },
    },
    async ({ gameId, sessionId }) =>
      guard(async () => {
        const room = await createRoom(gameId ?? 'grab', sessionId);
        const lines = [
          '✅ 房间已创建',
          `- roomId: ${room.roomId}`,
          `- 游戏: ${room.gameId}`,
          `- 人类入口（发给人类打开）: ${room.humanUrl}`,
          `- Agent 座位: ${room.agentSeat}`,
        ];
        const humanToken = room.seatTokens?.['0'];
        if (humanToken) {
          lines.push(
            `- 人类席位令牌（已写进上面的链接）: ${humanToken}`,
            '  ⚠️ 这个链接等于人类的入场券，只发给人类本人，不要贴到公开频道。',
          );
        }
        lines.push(
          '',
          `规则摘要：${summarizeRules(room.rules)}`,
          '',
          '下一步：',
          `1. 调用 playground_join_room({ roomId: "${room.roomId}", seat: 1 }) 占 Agent 座；` +
            '这一步会拿到 **1 号位席位令牌**，客户端会自动保存并在之后每个请求里附加；',
          '2. 把 humanUrl 发给人类，等人类打开链接入座（房间状态会变成 playing）；',
          '3. 调用 playground_wait_for_turn 等待轮到你。',
          '',
          '注意：没有入座就拿不到令牌，get_state 只会看到旁观视图（legalActions 恒为空），也不能出招。',
          '',
          sessionId
            ? `🔔 已把本房间绑定到会话 ${sessionId}：之后人类落子、轮到 Agent 时服务端会自动唤醒它。`
            : '🔔 想让服务端在你该出招时自动叫醒你（不必自己定闹钟轮询）：' +
              '调用 playground_bind_session({ roomId, sessionId: 你的 DSH_SESSION_ID })，' +
              '或在 create_room / join_room 时直接传 sessionId。',
          '',
          `完整规则见 MCP 资源 ${rulesResourceUri(room.gameId)}，或本结果 structuredContent.rules。`,
        );
        if (room.wipBypass) {
          lines.push(
            '',
            'ℹ️ 该游戏仍标记为开发中（wip）：本次已按服务端 hint 自动带 {"allowWip":true} 重试开桌。',
            'Agent / 自动化测试可以照常打；人类大厅可能还没有对应界面。',
          );
        }
        return ok(lines.join('\n'), {
          roomId: room.roomId,
          gameId: room.gameId,
          humanUrl: room.humanUrl,
          humanUrlPath: room.humanUrlPath,
          agentSeat: room.agentSeat,
          rules: room.rules,
          // 令牌对 Agent 透明，但结构化返回里保留，方便人类 / 调试时核对。
          seatTokens: room.seatTokens ?? null,
          wipBypass: room.wipBypass === true,
          // 唤醒桥：建桌时传了 sessionId 才有值，null = 没绑定（行为与以前一致）。
          wake: room.wake ?? null,
        });
      }),
  );

  registerTool(server, 
    'playground_join_room',
    {
      title: '入座',
      description:
        '在房间里入座（幂等），返回该座位的**席位令牌**。Agent 默认 seat=1；seat=0 是人类座位（自动化测试时可用来模拟人类）。' +
        '双方都入座后房间状态变为 playing。' +
        '席位鉴权之后，`seat` 参数不再代表身份：只有拿到该座位令牌才能读私有观测 / 提交动作 / 说话。' +
        '令牌由 MCP 客户端自动保存并附加到后续请求，Agent 不需要手动传递；如果之后看到 spectator: true 或 403 seat_token_required，' +
        '说明未入座或令牌失效，重新调用本工具入座即可。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
        sessionId: sessionIdSchema,
      },
    },
    async ({ roomId, seat, sessionId }) =>
      guard(async () => {
        const joined = await joinRoom(roomId, seat as Seat, sessionId);
        const lines = [
          `✅ 已入座：roomId=${joined.roomId}，seat=${seat}（${seatName(seat)}）`,
          `席位令牌：${joined.token ?? '（服务端未返回，可能还是旧版本）'}`,
          '  ↳ 已由客户端保存，之后 playground_get_state / submit_action / say / export_log 都会自动带上。',
          `房间状态：${statusText(joined.status)}（${joined.status}）`,
          `座位占用：人类=${joined.occupied[0] ? '已入座' : '空'}，Agent=${joined.occupied[1] ? '已入座' : '空'}`,
          `待提交动作的座位：${joined.pendingSeats.length > 0 ? joined.pendingSeats.join('、') : '无'}`,
          `人类入口：${joined.humanUrl}`,
        ];
        if (joined.wake?.boundSessionId) {
          lines.push(`🔔 唤醒桥已绑定会话：${joined.wake.boundSessionId}（轮到 Agent 时服务端会主动叫醒它）`);
        }
        if (joined.status === 'waiting') {
          lines.push('', '下一步：把人类入口发给人类入座；双方到齐后可调用 playground_wait_for_turn 等待轮到你。');
        } else if (joined.status === 'playing') {
          lines.push('', '下一步：调用 playground_get_state 查看盘面与 legalActions，再选格 submit_action；不确定是否轮到你就用 playground_wait_for_turn。');
        } else {
          lines.push('', '对局已结束：可调用 playground_get_result 查看结算，或 playground_export_log 导出日志。');
        }
        if (!joined.wake?.boundSessionId) {
          lines.push(
            '',
            '🔔 想让服务端在你该出招时自动叫醒你：playground_bind_session({ roomId, sessionId: 你的 DSH_SESSION_ID })，' +
              '或在 join_room 时直接传 sessionId。唤醒失败只记服务端日志，不影响对局。',
          );
        }
        return ok(lines.join('\n'), payload(joined));
      }),
  );

  registerTool(server,
    'playground_bind_session',
    {
      title: '绑定会话（唤醒桥）',
      description:
        '把房间绑定到一个 DSH 会话（sessionId 一般取环境变量 DSH_SESSION_ID）：之后人类每次落子、轮到 Agent 时，' +
        '服务端会主动 POST 唤醒该会话，Agent 不必自己定闹钟轮询。' +
        '也可以在 playground_create_room / playground_join_room 时直接传 sessionId，一步到位。' +
        '绑定幂等（重复绑定只刷新时间，换 sessionId 即改绑）；它只决定「叫醒谁」，不改变对局规则，也不影响席位令牌；' +
        '唤醒失败只记服务端日志（GET /api/rooms/{id} 的 wake 字段可查），绝不影响对局。',
      inputSchema: {
        roomId: roomIdSchema,
        sessionId: sessionIdRequiredSchema,
      },
    },
    async ({ roomId, sessionId }) =>
      guard(async () => {
        const bound = await bindSession(roomId, sessionId);
        const lines = [
          `✅ 已绑定唤醒会话：roomId=${bound.roomId}`,
          `- sessionId: ${bound.sessionId}`,
          `- boundAt: ${new Date(bound.boundAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          '',
          '之后人类落子、轮到 Agent 时，服务端会主动唤醒这个会话（同一回合最多 2 次、间隔 ≥3 秒）。',
          `想确认绑定是否生效：GET /api/rooms/${bound.roomId} 的 wake.boundSessionId。`,
          '唤醒失败只记服务端日志，不影响对局；人类那边照旧可以发消息叫你。',
        ];
        return ok(lines.join('\n'), {
          roomId: bound.roomId,
          sessionId: bound.sessionId,
          bound: true,
          boundAt: bound.boundAt,
        });
      }),
  );

  registerTool(server, 
    'playground_wait_for_turn',
    {
      title: '等待轮到你',
      description:
        '轮询房间状态（每 500ms），直到：轮到你行动（轮流制看 isYourTurn=true；同时暗选看本回合 youSubmitted=false）、' +
        '或对局结束、或超时。返回你这个座位的观测（textView、legalActions、比分）。' +
        '四子棋 / 快艇骰子只有轮到你时 legalActions 才非空；快艇骰子 phase=must_score 时仍是你行动，只能记分。' +
        '需要先 playground_join_room 入座拿席位令牌；如果拿到的是旁观视图（spectator=true），本工具会直接提示先入座，而不是空等到超时。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
        timeoutSeconds: z
          .number()
          .int('timeoutSeconds 必须是整数')
          .min(1, 'timeoutSeconds 至少 1 秒')
          .max(300, 'timeoutSeconds 最多 300 秒')
          .default(60)
          .describe('最长等待秒数，默认 60'),
      },
    },
    async ({ roomId, seat, timeoutSeconds }) =>
      guard(async () => {
        const startedAt = Date.now();
        const deadline = startedAt + timeoutSeconds * 1000;
        let polls = 0;
        let obs: Observation = await getState(roomId, seat as Seat);
        polls += 1;

        const elapsedSec = (): string => ((Date.now() - startedAt) / 1000).toFixed(1);

        while (true) {
          if (obs.status === 'ended') {
            const resultText = obs.result?.text ?? '（结果待同步）';
            const text = [
              '🏁 对局已经结束。',
              resultText,
              `比分：座位0 ${obs.result?.scores['0'] ?? '?'} : 座位1 ${obs.result?.scores['1'] ?? '?'}`,
              '',
              '下一步：playground_get_result 查看结算，playground_export_log 导出对局日志。',
            ].join('\n');
            return ok(text, {
              ready: false,
              timedOut: false,
              ended: true,
              polls,
              elapsedSeconds: Number(elapsedSec()),
              observation: payload(obs),
            });
          }

          // 旁观视图：不是「还没轮到你」，而是根本没有这个座位的令牌。
          // 继续在这里轮询只会白等一个 timeout，直接告诉 Agent 去 join。
          if (obs.spectator === true) {
            return fail(
              '❌ 当前是旁观视图，不能等待自己的回合。\n\n' +
                `房间 ${roomId} 的座位 ${seat} 没有有效令牌：可能还没入座，或令牌已失效（服务重启 / 房间过期）。\n` +
                `下一步：调用 playground_join_room({ roomId: "${roomId}", seat: ${seat} }) 入座拿令牌，再调用本工具。`,
              {
                ready: false,
                timedOut: false,
                ended: false,
                spectator: true,
                polls,
                elapsedSeconds: Number(elapsedSec()),
                observation: payload(obs),
              },
            );
          }

          if (obs.status === 'playing' && (obs.isYourTurn ?? !obs.youSubmitted)) {
            const text = [
              `✅ 轮到你行动了！（第 ${obs.round}/${obs.roundsTotal} 回合，等待 ${elapsedSec()} 秒，轮询 ${polls} 次）`,
              '',
              obs.textView,
              '',
              `合法动作（legalActions）：${formatLegalActions(obs.legalActions)}`,
              '',
              nextActionHint(obs, roomId, seat),
            ].join('\n');
            return ok(text, {
              ready: true,
              timedOut: false,
              ended: false,
              polls,
              elapsedSeconds: Number(elapsedSec()),
              observation: payload(obs),
            });
          }

          const now = Date.now();
          if (now >= deadline) {
            const reason =
              obs.status === 'waiting'
                ? `房间还在等人入座。请把人类入口发给人类：${humanUrlFor(roomId)}`
                : obs.youSubmitted
                  ? '你本回合已经提交过动作，对手还没提交，暂时不会结算。可以再次调用本工具继续等。'
                  : obs.isYourTurn === false
                    ? `还没轮到你（当前行动方：${
                        obs.currentSeat === null || obs.currentSeat === undefined
                          ? '未知'
                          : `座位 ${obs.currentSeat}（${seatName(obs.currentSeat)}）`
                      }${obs.phase ? `，phase=${obs.phase}` : ''}）。可以再次调用本工具继续等，不要抢对方的行动。`
                    : '房间还没准备好，可以稍后再次调用本工具。';
            const text = [
              `⏳ 等待超时（${timeoutSeconds} 秒，轮询 ${polls} 次）。`,
              `当前状态：${obs.status}（${statusText(obs.status)}），isYourTurn=${String(obs.isYourTurn)}，phase=${obs.phase ?? '-'}，你本回合已提交：${obs.youSubmitted ? '是' : '否'}`,
              reason,
            ].join('\n');
            return ok(text, {
              ready: false,
              timedOut: true,
              ended: false,
              polls,
              elapsedSeconds: Number(elapsedSec()),
              observation: payload(obs),
            });
          }

          await sleep(Math.min(POLL_INTERVAL_MS, deadline - now));
          obs = await getState(roomId, seat as Seat);
          polls += 1;
        }
      }),
  );

  registerTool(server, 
    'playground_get_state',
    {
      title: '读取当前观测',
      description:
        '读取某个座位能看到的观测（唯一读数出口）：文字盘面 textView、合法动作 legalActions、比分、历史、状态。' +
        '只根据这里返回的信息做决策，不要猜对手本回合的选择。' +
        '需要先 playground_join_room 入座拿该座位的席位令牌（客户端会自动附加）；' +
        '没有令牌 / 令牌失效时读到的会是旁观视图（spectator=true、legalActions 恒为空），那时请先入座。' +
        '想看公开盘面（围观）可以传 spectate=true。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
        spectate: z
          .boolean()
          .optional()
          .describe('true = 故意以旁观者身份读取（不发送席位令牌，用于围观；legalActions 恒为空）'),
      },
    },
    async ({ roomId, seat, spectate }) =>
      guard(async () => {
        const obs = await getState(roomId, seat as Seat, spectate ? { spectator: true } : {});
        const myScore = obs.yourScore ?? obs.scores?.[String(seat)] ?? '?';
        const oppScore = obs.opponentScore ?? obs.scores?.[String(1 - seat)] ?? '?';

        // 旁观视图必须明说：否则 Agent 会把「legalActions 恒为空」误判成规则不允许行动而空转。
        if (obs.spectator === true) {
          const lines = [
            `👀 房间 ${roomId} · 旁观视图 · ${statusText(obs.status)}`,
            '',
            obs.textView,
            '',
            `比分（座位0 : 座位1）：${obs.scores?.['0'] ?? '?'} : ${obs.scores?.['1'] ?? '?'}`,
            '',
            '⚠️ **当前是旁观视图，请先 join**：没有该座位的有效席位令牌，legalActions 恒为空，也不能提交动作 / 聊天。',
            spectate
              ? '（本次是你主动传 spectate=true 围观的；要真的行动请去掉 spectate。）'
              : `原因：座位 ${seat} 未入座或令牌已失效（服务重启 / 房间过期会让令牌一起失效）。`,
            `下一步：调用 playground_join_room({ roomId: "${roomId}", seat: ${seat} }) 入座拿令牌，再读一次。`,
            '如果你只是想围观，就保持旁观视图——不要尝试提交动作（会被 403 seat_token_required 拒绝）。',
          ];
          return ok(lines.join('\n'), { observation: payload(obs), spectator: true });
        }

        const lines = [
          `📍 房间 ${roomId} · 座位 ${seat}（${seatName(seat)}）· ${statusText(obs.status)}`,
          '',
          obs.textView,
          '',
          `比分：你 ${myScore} · 对手 ${oppScore}`,
        ];
        if (obs.status === 'waiting') {
          lines.push(
            '',
            '房间还在等双方入座，现在不能提交动作。',
            `请把人类入口发给人类：${humanUrlFor(roomId)}`,
            '双方入座后再调用 playground_wait_for_turn / playground_submit_action。',
          );
        } else if (obs.status === 'ended') {
          lines.push('', `🏁 对局已结束：${obs.result?.text ?? '（结果待同步）'}`, '可调用 playground_get_result / playground_export_log。');
        } else if (obs.youSubmitted) {
          lines.push('', '你已经提交过本回合动作，等待对手。可调用 playground_wait_for_turn 继续等。');
        } else if (obs.isYourTurn === false || obs.legalActions.length === 0) {
          lines.push('', describeNoLegalActions(obs, roomId));
        } else {
          lines.push('', `合法动作（legalActions）：${formatLegalActions(obs.legalActions)}`);
          lines.push(nextActionHint(obs, roomId, seat));
        }
        return ok(lines.join('\n'), { observation: payload(obs), spectator: false });
      }),
  );

  registerTool(server, 
    'playground_submit_action',
    {
      title: '提交本回合动作',
      description:
        '提交本轮/本手动作。两种写法二选一：\n' +
        'A) cell=[行,列]：按当前 legalActions 自动映射（抢宝 → grab.cell；四子棋 → drop.column；深海猎手 → fire.cell；黑白棋 → place.cell）。\n' +
        'B) actionJson：原样提交完整动作 JSON。快艇骰子（yacht）与猜拳心理战（rps-duel）必须用这种写法：\n' +
        `${YACHT_ACTION_FORMS}\n` +
        '{"action":"throw","shape":"rock"}        猜拳出手（shape 取 rock 石头 / paper 布 / scissors 剪刀）\n' +
        '只能选 legalActions 里的动作；如果被拒绝（HTTP 409），结果会附带 legalActions，请据此重选。' +
        '快艇骰子的一手内可以连续 roll / hold，只有 score 会换手；猜拳每局双方各提交一次，都到齐才揭示。' +
        '提交动作必须带该座位的有效席位令牌（客户端自动附加）；如果返回 403 seat_token_required，' +
        '说明还没入座或令牌失效 —— 先 playground_join_room 重新入座再提交（那次动作没有生效）。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
        cell: z
          .tuple([
            z.number().int('行/列必须是整数').min(0, '行/列最小为 0').max(8, '行/列最大为 8'),
            z.number().int('行/列必须是整数').min(0, '行/列最小为 0').max(8, '行/列最大为 8'),
          ])
          .optional()
          .describe('目标坐标 [行, 列]：抢宝取格子、四子棋取列；快艇骰子不支持 cell，请用 actionJson'),
        actionJson: z
          .union([z.string(), z.record(z.unknown())])
          .optional()
          .describe(
            '完整动作 JSON（字符串或对象），原样提交。快艇骰子三种：{"action":"roll"} / ' +
              '{"action":"hold","indices":[0]} / {"action":"score","category":"ones"}；' +
              '猜拳心理战：{"action":"throw","shape":"rock"}（shape 取 rock/paper/scissors）',
          ),
      },
    },
    async ({ roomId, seat, cell, actionJson }) =>
      guard(async () => {
        let action: unknown;
        if (actionJson !== undefined) {
          action = normalizeActionJson(actionJson as string | Record<string, unknown>);
        } else if (cell !== undefined) {
          // 按当前局面把 [row,col] 映射成该游戏真实动作形状（兼容 grab.cell 与 connect4.column）。
          // yacht 没有坐标概念，走 actionJson 通道；这里给明确指引而不是笼统的「不合法」。
          const state = await getState(roomId, seat as Seat);
          const legal = (state.legalActions ?? []) as Array<Record<string, unknown>>;
          if (legal.length === 0) {
            const reason = describeNoLegalActions(state, roomId);
            return fail(`❌ 现在没有可提交的动作，cell 无处映射。\n\n${reason}`, {
              ok: false,
              gameId: state.gameId,
              status: state.status,
              isYourTurn: state.isYourTurn ?? null,
              phase: state.phase ?? null,
              legalActions: [],
            });
          }
          if (state.gameId === 'yacht') {
            const phaseText =
              state.phase === 'must_score'
                ? '\n当前 phase=must_score：3 次掷骰已用完，只能记分（score）。'
                : '';
            return fail(
              '❌ 快艇骰子不能用 cell 提交动作（cell 只适用于 grab / connect4 / battleship / reversi）。' +
                phaseText +
                '\n请改用 actionJson，三种动作：\n' +
                `${YACHT_ACTION_FORMS}\n` +
                `当前 legalActions：${formatLegalActions(legal)}`,
              {
                ok: false,
                gameId: state.gameId,
                phase: state.phase ?? null,
                legalActions: legal,
              },
            );
          }
          if (state.gameId === 'rps-duel') {
            return fail(
              '❌ 猜拳心理战不能用 cell 提交动作（cell 只适用于 grab / connect4 / battleship / reversi）。\n' +
                '请改用 actionJson：{"action":"throw","shape":"rock"}（石头）/ "paper"（布）/ "scissors"（剪刀）。\n' +
                `当前 legalActions：${formatLegalActions(legal)}`,
              {
                ok: false,
                gameId: state.gameId,
                legalActions: legal,
              },
            );
          }
          const sameCell = legal.find((a) => {
            const c = a.cell;
            return Array.isArray(c) && c[0] === cell[0] && c[1] === cell[1];
          });
          const sameColumn = legal.find((a) => typeof a.column === 'number' && a.column === cell[1]);
          const picked = sameCell ?? sameColumn;
          if (!picked) {
            return fail(
              `❌ [${cell[0]},${cell[1]}] 不是当前可选动作。当前 legalActions：${formatUnknownLegalActions(legal)}`,
            );
          }
          action = picked;
        } else {
          return fail(
            '❌ 缺少动作：请传入 cell（如 [0, 1]，抢宝/四子棋）或 actionJson（完整动作 JSON，快艇骰子必用）。\n' +
              `快艇骰子动作示例：\n${YACHT_ACTION_FORMS}`,
          );
        }

        try {
          const result = await submitAction(roomId, seat as Seat, action);
          const types = new Set(result.events.map((e) => e.type));
          const lines = [`✅ 动作已提交（seat ${seat} / ${seatName(seat)}）：${JSON.stringify(action)}`];
          if (result.resolved && result.events.length > 0) {
            lines.push('', types.has('reveal') ? '双方动作到齐，本回合已结算：' : '动作已生效：');
            lines.push(...formatEvents(result.events));
          } else if (!result.resolved) {
            lines.push('', '已记录你的选择，正在等对手提交。');
          }
          if (types.has('end')) {
            lines.push('', '🏁 对局结束！下一步：playground_get_result 查看最终结果。');
          } else if (types.has('score') || types.has('drop')) {
            lines.push('', '已换手。下一步：playground_wait_for_turn 等下一手，或 playground_get_state 查看盘面。');
          } else if (types.has('roll') || types.has('hold')) {
            lines.push('', '还在你的回合：可以继续 roll / hold，或直接 score 记分换手。');
          } else if (types.has('fire')) {
            const fires = result.events.filter((e) => (e as any).type === 'fire') as any[];
            const last = fires[fires.length - 1];
            if (last && last.nextSeat === last.seat) {
              lines.push(
                '',
                '💥 命中！还在你的回合：继续调用 playground_submit_action(cell=[行,列]) 开炮。',
              );
            } else {
              lines.push('', '已换手。下一步：playground_wait_for_turn 等对手开炮。');
            }
          } else if (types.has('place') || types.has('pass')) {
            lines.push(
              '',
              '下一步：playground_wait_for_turn 等对手落子（对手无子可下时服务端会自动跳过，仍可能是你继续下）。',
            );
          } else if (types.has('reveal')) {
            lines.push('', '下一步：playground_wait_for_turn 等待下一回合，或 playground_get_state 查看盘面。');
          } else if (!result.resolved) {
            lines.push('', '下一步：playground_wait_for_turn 等待对手提交 / 下一回合。');
          }
          return ok(lines.join('\n'), {
            ok: true,
            resolved: result.resolved,
            events: result.events,
            submitted: action,
          });
        } catch (err) {
          if (err instanceof PlaygroundApiError && (err.status === 409 || err.code === 'illegal_action')) {
            const legal = err.legalActions ?? [];
            // 409 只带 legalActions，不带局面；补读一次观测，才能区分「不是你的回合 / 已结束 / 必须记分」。
            let obs: Observation | null = null;
            try {
              obs = await getState(roomId, seat as Seat);
            } catch {
              obs = null;
            }
            const lines = [
              `❌ 提交被拒绝（HTTP ${err.status ?? 409}${err.code ? ` · ${err.code}` : ''}）`,
              '',
            ];
            if (err.code === 'not_your_turn' || (obs?.status === 'playing' && obs.isYourTurn === false)) {
              lines.push(
                obs
                  ? describeNoLegalActions(obs, roomId)
                  : '现在不是你的回合，请先调用 playground_wait_for_turn 等到自己的回合。',
              );
            } else if (err.code === 'room_ended' || obs?.status === 'ended') {
              lines.push(
                obs
                  ? describeNoLegalActions(obs, roomId)
                  : '对局已经结束，请调用 playground_get_result 查看结算。',
              );
            } else if (err.code === 'illegal_action') {
              if (obs?.gameId === 'yacht') {
                if (obs.phase === 'must_score') {
                  lines.push('当前 phase=must_score：3 次掷骰已用完，只能记分（score）。');
                }
                lines.push('快艇骰子动作要求：');
                lines.push(YACHT_ACTION_FORMS);
                lines.push('提示：hold 一次只能切一颗（indices 必须是单个数）；score 只能记还没用过的栏目。');
              } else {
                lines.push('这个动作不可选（可能已被占 / 不是该游戏的动作形状 / 不在 legalActions 里）。');
              }
              lines.push('', `当前 legalActions：${formatLegalActions(legal)}`);
              lines.push('');
              lines.push(
                obs?.gameId === 'yacht'
                  ? `重试示例：playground_submit_action({ roomId: "${roomId}", seat: ${seat}, actionJson: '{"action":"roll"}' })`
                  : `重试示例：playground_submit_action({ roomId: "${roomId}", seat: ${seat}, cell: [行, 列] })`,
              );
            } else {
              lines.push(err.message);
              if (legal.length > 0) lines.push('', `当前 legalActions：${formatLegalActions(legal)}`);
            }
            return fail(lines.join('\n'), {
              ok: false,
              status: err.status,
              error: err.code,
              gameId: obs?.gameId ?? null,
              phase: obs?.phase ?? null,
              isYourTurn: obs?.isYourTurn ?? null,
              legalActions: legal,
              observation: obs ? payload(obs) : null,
              submitted: action,
            });
          }

          // 403：令牌缺失 / 不匹配。动作**没有被执行**，必须明确告诉 Agent 不要盲重试同一手。
          if (
            err instanceof PlaygroundApiError &&
            (err.status === 403 || err.code === 'seat_token_required')
          ) {
            return fail(
              `❌ 席位令牌无效，动作没有被执行（HTTP ${err.status ?? 403} · ${err.code ?? 'seat_token_required'}）。\n\n` +
                '原因：这个座位没有有效令牌 —— 可能还没入座，或令牌已失效（房间只在内存里，服务重启 / 房间过期会让令牌一起失效）。\n' +
                `下一步：调用 playground_join_room({ roomId: "${roomId}", seat: ${seat} }) 重新入座拿令牌` +
                '（客户端会自动保存并附加），再提交一次。\n' +
                '这个动作没有生效，不需要担心重复提交；重试前可以先 playground_get_state 确认局面。',
              {
                ok: false,
                status: err.status,
                error: err.code ?? 'seat_token_required',
                roomId,
                seat,
                submitted: action,
              },
            );
          }
          throw err;
        }
      }),
  );

  registerTool(server, 
    'playground_say',
    {
      title: '发气泡聊天',
      description:
        '在对局里发一句气泡聊天（≤200 字；同一座位 800ms 内只能发一次）。用来和人类互动。' +
        '需要该座位的有效席位令牌（客户端自动附加）：未入座 / 令牌失效会返回 403 seat_token_required，' +
        '先 playground_join_room 入座再发。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
        text: z
          .string()
          .min(1, '聊天内容不能为空')
          .max(200, '聊天内容最多 200 字')
          .describe('聊天内容，最多 200 字'),
      },
    },
    async ({ roomId, seat, text }) =>
      guard(async () => {
        const content = text.trim();
        if (!content) return fail('❌ 聊天内容不能为空。');
        const result = await say(roomId, seat as Seat, content);
        return ok(`💬 已发送（seat ${seat} / ${seatName(seat)}）：${result.message.text}`, {
          ok: true,
          message: payload(result.message),
        });
      }),
  );

  registerTool(server, 
    'playground_get_result',
    {
      title: '查询结算结果',
      description: '查询房间的结算结果。对局未结束时返回 null；结束后返回 winner / scores / text。',
      inputSchema: {
        roomId: roomIdSchema,
      },
    },
    async ({ roomId }) =>
      guard(async () => {
        const result = await getResult(roomId);
        if (result === null) {
          return ok(
            `⏳ 对局还没结束（result 为 null）。\n` +
              '可以调用 playground_wait_for_turn 等待，或 playground_get_state 查看当前回合。',
            { ended: false, result: null },
          );
        }
        const winnerText =
          result.winner === null
            ? '平局'
            : `座位 ${result.winner}（${seatName(result.winner)}）获胜`;
        const text = [
          '🏁 对局结束',
          result.text,
          `比分：座位0 ${result.scores['0'] ?? '?'} : 座位1 ${result.scores['1'] ?? '?'}`,
          `结果：${winnerText}`,
        ].join('\n');
        return ok(text, { ended: true, result: payload(result) });
      }),
  );

  registerTool(server, 
    'playground_export_log',
    {
      title: '导出对局日志',
      description:
        '导出对局日志（含 seed、rules、events，可用于回放/复盘）。聊天记录不在日志里；' +
        'events 只包含 reveal / end 事件。GET /log 按契约是公开接口，旁观者也能导出；' +
        '已入座时客户端仍会自动带上该座位令牌（便于服务端以后收紧权限）。',
      inputSchema: {
        roomId: roomIdSchema,
        seat: seatSchema,
      },
    },
    async ({ roomId, seat }) =>
      guard(async () => {
        const log = await exportLog(roomId, seat as Seat);
        const events = Array.isArray(log.events) ? log.events : [];
        const typeCounts = events.reduce<Record<string, number>>((acc, e) => {
          const t = e.event?.type ?? 'unknown';
          acc[t] = (acc[t] ?? 0) + 1;
          return acc;
        }, {});
        const json = JSON.stringify(log, null, 2);
        const MAX_TEXT_JSON = 8000;
        const shownJson =
          json.length > MAX_TEXT_JSON
            ? `${json.slice(0, MAX_TEXT_JSON)}\n……（完整内容在 structuredContent 里，共 ${json.length} 字符）`
            : json;
        const lines = [
          `📜 对局日志已导出：roomId=${log.roomId}，gameId=${log.gameId}，seed=${log.seed}，seat=${log.seat}`,
          `事件数：${events.length}（${Object.entries(typeCounts)
            .map(([k, v]) => `${k}×${v}`)
            .join('、') || '无'}）`,
          `结果：${log.result?.text ?? '未结束'}`,
          '',
          shownJson,
        ];
        return ok(lines.join('\n'), payload(log));
      }),
  );
}

function registerResources(server: McpServer): void {
  // 按 core 的 games 注册表动态生成，新增游戏（如 yacht）自动获得规则资源，
  // 不用再手动加一个 registerResource 块。
  for (const spec of Object.values(gameRegistry)) {
    const { id, name, rules, status } = spec.meta;
    server.registerResource(
      `${id}-rules`,
      rulesResourceUri(id),
      {
        title: `${name} · 规则`,
        description: `《${name}》（${id}）完整规则文本${status === 'wip' ? '（开发中）' : ''}。`,
        mimeType: 'text/markdown',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: rules,
          },
        ],
      }),
    );
  }
}

/** 构造（但不连接）MCP server；方便测试复用。 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'AI 游乐场：人类和 Agent 同桌玩小游戏。座位：0=人类，1=Agent。' +
        '标准流程：playground_create_room → 把 humanUrl 发给人类 → playground_join_room(seat=1) → ' +
        'playground_wait_for_turn → 读 textView/legalActions → playground_submit_action → 循环直到结束 → ' +
        'playground_get_result / playground_export_log。只依据观测做决策，不猜对手本回合选择。' +
        '席位鉴权（第 12 轮）：join_room 会返回该座位的席位令牌，客户端自动保存并附加到之后每个请求；' +
        '`seat` 参数不再代表身份，没有令牌只能看旁观视图（spectator=true、legalActions 恒为空）且不能行动。' +
        '看到 spectator=true 或 403 seat_token_required 时，重新 playground_join_room 入座即可。' +
        '唤醒桥（第 14 轮）：想被自动叫醒就 playground_bind_session({roomId, sessionId: 你的 DSH_SESSION_ID})，' +
        '或在 create_room / join_room 时直接传 sessionId；绑定后轮到 Agent 时服务端会主动唤醒会话（不是自动出招，仍需你自己读盘面）。' +
        '对局结束也会唤醒一次（reason=ended，带结算文案）——人类赢了，你不该事后才知道。' +
        '对局聊天（第 15 轮）：每一手出招后顺手 playground_say 说一句（≤200 字，同座位 800ms 限流）。' +
        '放嘴炮、报战况、夸夸人类都行；只闷头下棋的话，人类会觉得在跟机器对局。' +
        '规则资源：playground://games/<gameId>/rules（grab / connect4 / yacht / rps-duel / battleship / reversi）。' +
        '快艇骰子（yacht）用 actionJson 提交三种动作：{"action":"roll"}、' +
        '{"action":"hold","indices":[0]}（一次只切一颗，[] 全解锁）、{"action":"score","category":"..."}（记分换手）。' +
        '猜拳心理战（rps-duel）用 actionJson 提交 {"action":"throw","shape":"rock"|"paper"|"scissors"}，' +
        '3 局定胜负、第 3 局翻倍（2 分），双方都提交后才揭示。',
    },
  );
  registerTools(server);
  registerResources(server);
  return server;
}

/**
 * 启动 stdio MCP server。
 * 注意：绝不能往 stdout 写日志，否则会污染 MCP 协议帧。
 */
export async function startMcpServer(): Promise<McpServer> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[ai-playground-mcp] ✅ 已连接 MCP stdio，等待请求…');
  console.error(`[ai-playground-mcp] 后端地址：${getBaseUrl()}（可用 PLAYGROUND_URL 覆盖）`);
  return server;
}

