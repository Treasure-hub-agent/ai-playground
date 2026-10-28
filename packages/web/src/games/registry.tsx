import { Suspense, lazy, type ReactElement } from 'react';
import type {
  AnyAction,
  BattleshipObservation,
  CellCoord,
  Connect4Observation,
  GrabObservation,
  RevealEvent,
  ReversiObservation,
  RoomObservation,
  RpsObservation,
  YachtObservation,
} from '../types';
import { Connect4Board } from '../components/boards/Connect4Board';
import { GrabBoard } from '../components/boards/GrabBoard';
import { DiceRow } from '../components/boards/DiceRow';
import { RpsDuelBoard } from '../components/boards/RpsDuelBoard';
import { BattleshipBoard } from '../components/boards/BattleshipBoard';
import { ReversiBoard } from '../components/boards/ReversiBoard';

/** 快艇骰子界面里带 three.js，单独 chunk 懒加载。 */
const YachtBoard = lazy(() =>
  import('../components/boards/YachtBoard').then((mod) => ({ default: mod.YachtBoard })),
);

export interface BoardRenderProps {
  obs: RoomObservation;
  disabled: boolean;
  reveal: RevealEvent | null;
  yourPick: CellCoord | null;
  /** 格子类游戏：点了一个坐标 */
  onPick: (cell: CellCoord) => void;
  /** 非格子类动作（快艇骰子的 roll / hold / score）：直接给服务端动作体 */
  onAction: (action: AnyAction) => void;
}

export interface GameUi {
  id: string;
  /** simultaneous = 同时暗选；turn = 轮流行动 */
  mode: 'simultaneous' | 'turn';
  /** 是否显示比分（棋类通常不显示） */
  showScores: boolean;
  /** 棋盘自带卡片外观时，让外层 board-wrap 让出宽度与白框（快艇骰子用） */
  plainBoard?: boolean;
  /** 棋盘自己已在盘内提示锁定态时，不要再叠浮层封盘条（猜拳用） */
  inlineSeal?: boolean;
  /** 计数单位：回合 / 手 / 局（要与棋盘内文案同一口径） */
  unitLabel: string;
  /** 比分单位（默认「分」；battleship=艘、reversi=子） */
  scoreUnit?: string;
  renderBoard: (props: BoardRenderProps) => ReactElement;
  /** 格子类游戏：前端点击坐标 → 服务端动作。非格子类游戏留空，改用 onAction。 */
  actionForPick?: (cell: CellCoord) => AnyAction;
  /** 规则速查（牌桌右下角） */
  rules: string[];
  /** 规则速查折叠条右侧的一句话摘要 */
  rulesSummary: string;
  /** 顶部计分条：轮到玩家时的文案 */
  turnLabel: string;
  /** 顶部计分条：等对手时的文案 */
  waitLabel: string;
  /** 桌边闲聊的快捷短语（按游戏取词，别让骰子游戏说「这枚金币归我」） */
  quickChat: string[];
  hints: {
    pick: string;
    waiting: string;
    sealed?: string;
    ended: string;
  };
}

const grab: GameUi = {
  id: 'grab',
  mode: 'simultaneous',
  showScores: true,
  unitLabel: '回合',
  renderBoard: ({ obs, disabled, reveal, yourPick, onPick }) => (
    <GrabBoard
      obs={obs as GrabObservation}
      disabled={disabled}
      reveal={reveal}
      yourPick={yourPick}
      onPick={onPick}
    />
  ),
  actionForPick: (cell) => ({ action: 'grab', cell }),
  rules: [
    '棋盘 3×3：6 枚金币（1/2/3 分）、1 枚炸弹（−2 分）、2 个空格。',
    '每回合双方同时暗选一格；金币归你，炸弹扣分，空格无事。',
    '撞车：双方选同一格，宝物被撞飞，谁都拿不到。',
    '场上金币被抢完即结束，总分高者胜，同分算平局。',
  ],
  rulesSummary: '金币抢完即结束',
  turnLabel: '轮到你出招',
  waitLabel: '已密封，等 Agent',
  quickChat: ['手下留情', '这枚金币归我', '承让承让'],
  hints: {
    // 可点格不再有常亮提示（theme.css 把 .is-legal::after 关了），所以别再写「点击亮起的格子」；
    // 「点一格」这类操作提示已经由棋盘顶部的 kicker 说了，这里只补撞车规则，避免同一屏说两遍。
    pick: '轮到你了：双方同时出招，撞车谁都拿不到。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    sealed: '已开牌 · 等 Agent 出招',
    ended: '对局结束，看看战报吧。',
  },
};

const connect4: GameUi = {
  id: 'connect4',
  mode: 'turn',
  showScores: false,
  unitLabel: '手',
  renderBoard: ({ obs, disabled, onPick }) => (
    <Connect4Board obs={obs as Connect4Observation} disabled={disabled} onPick={onPick} />
  ),
  actionForPick: (cell) => ({ action: 'drop', column: cell[1] }),
  rules: [
    '7 列 × 6 行，双方轮流落子，棋子落在该列最底部的空位。',
    '横、竖、斜任意方向先连成 4 子者获胜；棋盘下满仍无四连算平局。',
    '点顶部「↓」按钮选择列，落子后立刻换手。',
    '偶发悔棋？没有悔棋——落子即生效。',
  ],
  rulesSummary: '四子连线即胜',
  turnLabel: '轮到你落子',
  waitLabel: '等 Agent 落子',
  quickChat: ['手下留情', '这局我连四', '承让承让'],
  hints: {
    pick: '轮到你落子：点顶部箭头选一列。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    ended: '对局结束，看看战报吧。',
  },
};

const yacht: GameUi = {
  id: 'yacht',
  mode: 'turn',
  showScores: true,
  plainBoard: true,
  unitLabel: '手',
  renderBoard: ({ obs, disabled, onAction }) => (
    <Suspense
      fallback={
        <div className="board-loading">
          <p>正在摆骰子…</p>
        </div>
      }
    >
      <YachtBoard obs={obs as YachtObservation} disabled={disabled} onAction={onAction} />
    </Suspense>
  ),
  rules: [
    '每手 5 颗骰子，最多掷 3 次；点骰子可以锁定它，重掷只掷没锁的。',
    '掷完后在 13 个栏目里选一格记分，记过就不能再用；选了就换手。',
    '上区（一点~六点）：只累计该点数，上区合计 ≥ 63 时额外 +35。',
    '下区：三条/四条=五骰总和，葫芦 25、小顺 30、大顺 40、快艇 50、全骰=总和。',
    '双方各填满 13 格（共 26 手）结算，总分高者胜。打不出分也必须记 0 分。',
  ],
  rulesSummary: '13 格填满比总分',
  turnLabel: '轮到你掷骰',
  waitLabel: '等 Agent 掷骰记分',
  quickChat: ['手下留情', '这把骰子站我这边', '承让承让'],
  hints: {
    pick: '轮到你：先掷骰，点骰子锁定想留的点数，再选一格记分。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    ended: '对局结束，看看战报吧。',
  },
};

const rpsDuel: GameUi = {
  id: 'rps-duel',
  mode: 'simultaneous',
  showScores: true,
  plainBoard: true,
  inlineSeal: true,
  unitLabel: '局',
  renderBoard: ({ obs, disabled, onAction }) => (
    <RpsDuelBoard obs={obs as RpsObservation} disabled={disabled} onAction={onAction} />
  ),
  rules: [
    '共 3 局，双方同时暗出手；石头赢剪刀、剪刀赢布、布赢石头。',
    '第 1、2 局各值 1 分；第 3 局是决胜局，赢下得 2 分。',
    '双方同出手 = 本局 0:0，谁都不得分，但该局照常消耗。',
    '先提交看不到对手出手；双方都出手后一起揭示，锁定状态刷新不丢。',
    '三局打完比总分，同分平局；决胜局落后也仍能追平或反超。',
  ],
  rulesSummary: '决胜局翻倍',
  turnLabel: '轮到你出手',
  waitLabel: '已锁定，等 Agent',
  quickChat: ['手下留情', '这一手我猜到了', '承让承让'],
  hints: {
    pick: '选一个手势，双方都出手后一起揭示。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    sealed: '已锁定 · 等 Agent 出招',
    ended: '对局结束，看看战报吧。',
  },
};

const battleship: GameUi = {
  id: 'battleship',
  mode: 'turn',
  showScores: true,
  plainBoard: true,
  // 「炮」是双方合计的全局炮数（round），不是我这边的开炮次数（shotsFired）；
  // 叫「回合」才不会和盘内「本局已开炮 N 次」的自家口径打架。
  unitLabel: '回合',
  scoreUnit: '艘',
  renderBoard: ({ obs, disabled, onPick }) => (
    <BattleshipBoard obs={obs as BattleshipObservation} disabled={disabled} onPick={onPick} />
  ),
  actionForPick: (cell) => ({ action: 'fire', cell }),
  rules: [
    '5×5 海域，双方各藏 2 艘船：2 格驱逐舰 + 1 格潜艇，开局随机布阵。',
    '轮流开炮，打中就继续由你开炮，打空才换手；打过的格子不能再打。',
    '敌方海域只透出你打过的格子；己方舰队对你是公开的。',
    '一艘船的所有格子都被命中即沉没，会公开宣告。',
    '先把对手 2 艘船全部击沉者获胜，没有平局。',
  ],
  rulesSummary: '命中继续开炮',
  turnLabel: '轮到你开炮',
  waitLabel: '等 Agent 开炮',
  quickChat: ['这片海我熟', '继续炸', '承让承让'],
  hints: {
    pick: '点敌方海域里的一格开炮；命中可以继续开炮。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    ended: '对局结束，看看战报吧。',
  },
};

const reversi: GameUi = {
  id: 'reversi',
  mode: 'turn',
  showScores: true,
  plainBoard: true,
  unitLabel: '手',
  scoreUnit: '子',
  renderBoard: ({ obs, disabled, onPick }) => (
    <ReversiBoard obs={obs as ReversiObservation} disabled={disabled} onPick={onPick} />
  ),
  actionForPick: (cell) => ({ action: 'place', cell }),
  rules: [
    '8×8 棋盘，落子必须沿横/竖/斜夹住至少一枚对手棋子。',
    '被夹住的对手棋子全部翻成你的颜色；你执亮色，Agent 执深色。',
    '轮到的一方无合法落点会自动跳过；双方都无子可下或棋盘下满即终局。',
    '终局数子：棋子多者胜，数量相同算平局。',
    '点棋盘上的小圆点落子，留意对手被跳过时的提示。',
  ],
  rulesSummary: '夹住就翻面',
  turnLabel: '轮到你落子',
  waitLabel: '等 Agent 落子',
  quickChat: ['手下留情', '这角我要了', '承让承让'],
  hints: {
    pick: '点棋盘上的小圆点落子；被夹住的对手棋子会翻面。',
    waiting: '等 Agent 在 1 号座位入座后，自动开局。',
    ended: '对局结束，看看战报吧。',
  },
};

/** 前端游戏注册表：新增游戏时在这里登记渲染/动作/规则/hint。 */
export const GAME_UI: Record<string, GameUi> = {
  grab,
  connect4,
  yacht,
  'rps-duel': rpsDuel,
  battleship,
  reversi,
};

/** 兜底界面：万一某个 gameId 还没注册，用最朴素的骰子行占位而不是错渲染别的游戏。 */
const unknown: GameUi = {
  id: 'unknown',
  mode: 'turn',
  showScores: false,
  unitLabel: '手',
  renderBoard: ({ obs }) => (
    <div className="board-loading">
      <p>这款游戏的界面还没做好</p>
      <small>gameId: {obs.gameId}</small>
      <DiceRow dice={[1, 2, 3, 4, 5]} held={[false, false, false, false, false]} canHold={false} onToggleHold={() => {}} />
    </div>
  ),
  rules: ['界面还没接上，但规则在这里：' + '（见 /api/games）'],
  rulesSummary: '界面开发中',
  turnLabel: '轮到你',
  waitLabel: '等 Agent',
  quickChat: ['手下留情', '承让承让'],
  hints: {
    pick: '这款游戏的界面还在做。',
    waiting: '等 Agent 入座。',
    ended: '对局结束。',
  },
};

export function uiFor(gameId: string | undefined | null): GameUi {
  if (gameId && GAME_UI[gameId]) return GAME_UI[gameId];
  return unknown;
}
