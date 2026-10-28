import type {
  AnyAction,
  CellCoord,
  GameResultSummary,
  GridCell,
  LegalAction,
  RevealEvent,
} from './types';

export function coordKey(cell: CellCoord): string {
  return `${cell[0]},${cell[1]}`;
}

export function isCoin(cell: GridCell): cell is 1 | 2 | 3 {
  return cell === 1 || cell === 2 || cell === 3;
}

/**
 * 当前是否有模态弹窗盖在上面。
 * 棋盘组件挂在 window 上的快捷键（猜拳 1/2/3、快艇 Enter）要先问一句，
 * 否则弹窗打开时按键会替玩家背后的棋盘出手。
 */
export function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/**
 * 动作是否落在 legalActions 里。
 * 语义与服务端一致：legalActions 的字段必须全部相等，动作里多出来的字段忽略。
 * 数组按长度 + 逐项严格比较（快艇骰子的 hold.indices 靠这个区分单颗/多颗）。
 */
export function matchesAction(legalActions: ReadonlyArray<object>, action: AnyAction): boolean {
  return legalActions.some((raw) => {
    const legal = raw as Record<string, unknown>;
    return Object.keys(legal).every((key) => {
      const expected = legal[key];
      const actual = action[key];
      if (Array.isArray(expected) && Array.isArray(actual)) {
        return (
          expected.length === actual.length && expected.every((item, i) => item === actual[i])
        );
      }
      return expected === actual;
    });
  });
}

export function gridToLegalActions(grid: GridCell[][]): LegalAction[] {
  const actions: LegalAction[] = [];
  grid.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell !== 'taken') actions.push({ action: 'grab', cell: [r, c] });
    });
  });
  return actions;
}

export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return '±0';
}

/** 把服务端 applied / delta 翻译成人话（仅用于已揭示的事件） */
export function describePick(reveal: RevealEvent, seat: number, label: string): string {
  if (reveal.collision) return `${label}撞车`;
  const applied = reveal.applied[String(seat)];
  const delta = reveal.delta[String(seat)] ?? 0;
  if (applied === 'coin') return `${label}抢到 +${delta}`;
  if (applied === 'bomb') return `${label}踩到 ${delta}`;
  if (applied === 'empty') return `${label}扑了个空`;
  if (applied === 'taken') return `${label}慢了一步`;
  return `${label}行动`;
}

/** 各游戏的胜负副标题（不同游戏赢法不同，别用同一句话） */
const WIN_SUBTITLES: Record<string, { win: string; lose: string; draw: string }> = {
  grab: {
    win: '金币都进了你的口袋～',
    lose: '下局换个策略，抢回来！',
    draw: '棋逢对手，再来一局分高下～',
  },
  connect4: {
    win: '四子连线，稳稳拿下～',
    lose: '差一格就反杀了，再来！',
    draw: '棋盘下满了，谁也没连成四子～',
  },
  yacht: {
    win: '骰子站在你这边，总分压过对手！',
    lose: '运气差了一口气，下一局再掷！',
    draw: '总分打平，罕见的一局～',
  },
  'rps-duel': {
    win: '读穿了对手的心思，决胜局拿下！',
    lose: '被读穿了，下一局换套假动作。',
    draw: '势均力敌，最后一手谁也没骗到谁～',
  },
  battleship: {
    win: '把对手的船全送进海底，这片海归你了！',
    lose: '舰队全沉了…下次换个布阵思路。',
    draw: '这片海域打了个平手。',
  },
  reversi: {
    win: '翻盘成功，最后的子数说明一切！',
    lose: '被翻回来了，下一局盯住边角。',
    draw: '子数打平，罕见的一盘。',
  },
};

/**
 * 注册表里没收录的游戏用这句中性文案，而不是退回抢宝的「金币都进了你的口袋」。
 * 以前兜底到 grab，结果深海猎手/黑白棋赢一局也会说金币——加游戏时最容易串场。
 */
const NEUTRAL_SUBTITLES = {
  win: '这一局你拿下了！',
  lose: '这局被 Agent 拿走，下局再来。',
  draw: '势均力敌的一局，再来一次分高下～',
};

export function resultHeadline(
  result: GameResultSummary,
  gameId = 'grab',
): { title: string; subtitle: string } {
  const copy = WIN_SUBTITLES[gameId] ?? NEUTRAL_SUBTITLES;
  if (result.winner === 0) {
    return { title: '你赢啦！', subtitle: copy.win };
  }
  if (result.winner === 1) {
    return { title: 'Agent 赢了', subtitle: copy.lose };
  }
  return { title: '平局！', subtitle: copy.draw };
}

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走兼容方案
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function absoluteUrl(path: string): string {
  try {
    return new URL(path, window.location.origin).toString();
  } catch {
    return path;
  }
}

