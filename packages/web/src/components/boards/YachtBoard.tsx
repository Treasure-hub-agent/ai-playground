/**
 * 快艇骰子对局界面。
 *
 * 结构：上方是骰子托盘（3D，可点击锁定）+ 掷骰按钮，下方是双方计分板。
 * 记分走「先选格、再确认」两步：13 格挤在一起，误触代价太大。
 * 动作与格子解耦（roll / hold / score），统一走 onAction。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnyAction, YachtCategory, YachtObservation, YachtScorecard as YachtScorecardData } from '../../types';
import { isDialogOpen, matchesAction } from '../../utils';
import { useSfx } from '../../audio/useAudio';
import { BoardShell } from '../BoardShell';
import { DiceRow } from './DiceRow';
import { YachtScorecard } from './YachtScorecard';

/** three.js 只在进入快艇骰子时才下载（单独 chunk）。 */
const DiceTray3D = lazy(() => import('./DiceTray3D'));

interface CategoryRow {
  id: YachtCategory;
  label: string;
  hint: string;
}

const UPPER_ROWS: CategoryRow[] = [
  { id: 'ones', label: '一点', hint: '' },
  { id: 'twos', label: '二点', hint: '' },
  { id: 'threes', label: '三点', hint: '' },
  { id: 'fours', label: '四点', hint: '' },
  { id: 'fives', label: '五点', hint: '' },
  { id: 'sixes', label: '六点', hint: '' },
];

const LOWER_ROWS: CategoryRow[] = [
  { id: 'three_kind', label: '三条', hint: '≥3 颗同点 = 五骰总和' },
  { id: 'four_kind', label: '四条', hint: '≥4 颗同点 = 五骰总和' },
  { id: 'full_house', label: '葫芦', hint: '3 + 2 = 25 分' },
  { id: 'small_straight', label: '小顺', hint: '4 连 = 30 分' },
  { id: 'large_straight', label: '大顺', hint: '5 连 = 40 分' },
  { id: 'yacht', label: '快艇', hint: '五骰同点 = 50 分' },
  { id: 'chance', label: '全骰', hint: '五骰总和，随便记' },
];

const ALL_ROWS = [...UPPER_ROWS, ...LOWER_ROWS];

/** 3D 托盘是桌面优先的实现：窄屏先走平面骰子，等安卓移植时再按真实设备调相机。 */
const USE_3D_MIN_WIDTH = 720;

function prefers3d(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true; // 3D 仍可，只是不翻滚
  return window.innerWidth >= USE_3D_MIN_WIDTH;
}

export interface YachtBoardProps {
  obs: YachtObservation;
  disabled: boolean;
  onAction: (action: AnyAction) => void;
}

export function YachtBoard({ obs, disabled, onAction }: YachtBoardProps) {
  const [pending, setPending] = useState<YachtCategory | null>(null);
  const [rollToken, setRollToken] = useState(0);
  const play = useSfx();
  const lastDiceKeyRef = useRef(obs.dice.join(','));
  const [use3d] = useState(prefers3d);

  const legal = obs.legalActions;
  const playing = obs.status === 'playing';
  const myTurn = obs.isYourTurn !== false;
  const interactive = playing && myTurn && !disabled;

  const canRoll = interactive && matchesAction(legal, { action: 'roll' });
  const canHold = interactive && matchesAction(legal, { action: 'hold', indices: [0] });
  const canScore = interactive && legal.some((action) => action.action === 'score');

  // 旁观者 seat 是 null：按「座位 0 视角」呈现（服务端就是这么给公开数据的），
  // 前端另有 spectator 标记，计分板标题会改成「座位 0 / 座位 1」。
  const viewSeat = obs.seat ?? 0;
  const myCard: YachtScorecardData = obs.scorecards[String(viewSeat)];
  const oppCard: YachtScorecardData = obs.scorecards[String(1 - viewSeat)];
  const notRolled = obs.phase === 'roll';

  // 换手 / 进度变化后，之前悬着的待确认格子作废
  useEffect(() => {
    setPending(null);
  }, [obs.round, obs.isYourTurn, obs.dice.join(',')]);

  // 骰面变化 → 落定音（首次挂载不响，避免一进来就叮一声）
  useEffect(() => {
    const key = obs.dice.join(',');
    if (key === lastDiceKeyRef.current) return;
    lastDiceKeyRef.current = key;
    if (obs.dice.some((value) => value > 0)) play('dice-land');
  }, [obs.dice, play]);

  // 建议记分：预览分最高的那一格（0 分不推荐）
  const best = useMemo(() => {
    let bestId: YachtCategory | null = null;
    let bestValue = 0;
    for (const row of ALL_ROWS) {
      const value = obs.previewScores[row.id];
      if (value !== null && value > bestValue) {
        bestValue = value;
        bestId = row.id;
      }
    }
    return bestId;
  }, [obs.previewScores]);

  const handleRoll = useCallback(() => {
    play('dice-roll');
    setRollToken((token) => token + 1);
    onAction({ action: 'roll' });
  }, [onAction, play]);

  const handleHold = useCallback(
    (index: number) => {
      play(obs.held[index] ? 'hold-off' : 'hold-on');
      onAction({ action: 'hold', indices: [index] });
    },
    [obs.held, onAction, play],
  );

  const confirmScore = useCallback(() => {
    if (!pending) return;
    play('score');
    onAction({ action: 'score', category: pending });
    setPending(null);
  }, [onAction, pending, play]);

  // 键盘：Enter 确认、Esc 取消。
  // 注意：必须排除输入框 —— 以前在聊天框按 Enter 会直接「确认记分」，
  // 既吃掉一手分数，还导致消息发不出去。
  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent) => {
      // 弹窗（邀请 / 结算）盖在上面时，不能让 Enter 穿透下来点掉一手记分
      if (isDialogOpen()) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setPending(null);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        confirmScore();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, confirmScore]);

  // 未掷的骰子就是 0：不要再映射成 1 点。三个骰子组件都按 0 渲染成「未掷」
  // （半透明骰面 + 读屏念「未掷」），未掷时还有 .y-veil 盖着，视觉不受影响。
  return (
    <BoardShell
      className="yacht-board"
      label="快艇骰子"
      kicker="先掷骰，点骰子锁定，再记分"
      meta={
        <span className="board-chip">
          上区 <b>{myCard.upperSubtotal}</b> / {obs.upperTarget}
        </span>
      }
    >
      <div className={`y-tray ${notRolled ? 'is-fresh' : ''}`}>
        <div className="y-dice-slot">
          {use3d ? (
            <Suspense
              fallback={
                <DiceRow dice={obs.dice} held={obs.held} canHold={canHold} onToggleHold={handleHold} />
              }
            >
              <DiceTray3D
                dice={obs.dice}
                held={obs.held}
                rollToken={rollToken}
                settleKey={`${obs.round}:${obs.rollsLeft}:${obs.dice.join(',')}`}
                canHold={canHold}
                onToggleHold={handleHold}
              />
            </Suspense>
          ) : (
            <DiceRow dice={obs.dice} held={obs.held} canHold={canHold} onToggleHold={handleHold} />
          )}
          {notRolled && (
            <div className="y-veil">
              <span>{canRoll ? '点「掷骰」开始这一手' : '等 Agent 掷骰…'}</span>
            </div>
          )}
        </div>

        <div className="y-tray-foot">
          <div className="y-tray-meta">
            <div className="y-rolls" aria-label={`本手还剩 ${obs.rollsLeft} 次掷骰`}>
              {[0, 1, 2].map((index) => (
                <span key={index} className={`y-roll-pip ${index < obs.rollsLeft ? 'is-on' : ''}`} />
              ))}
              <span className="y-rolls-text">剩 {obs.rollsLeft} 次</span>
            </div>
            <div className="y-held-text">
              {obs.phase === 'must_score'
                ? '掷骰次数用完，直接选一格记分'
                : obs.held.some(Boolean)
                  ? `锁定 ${obs.held.filter(Boolean).length} 颗，重掷其余`
                  : canHold
                    ? '点骰子可以锁定它'
                    : ' '}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary y-roll-btn"
            onClick={handleRoll}
            disabled={!canRoll}
          >
            {canRoll ? (obs.phase === 'roll' ? '掷骰' : '再掷一次') : obs.phase === 'must_score' ? '只能记分了' : '等待中'}
          </button>
        </div>
      </div>

      <div className="y-panel">
        <div className="y-panel-head">
          <span className="y-panel-title">计分板</span>
        </div>

        <YachtScorecard
          myCard={myCard}
          oppCard={oppCard}
          preview={obs.previewScores}
          canScore={canScore}
          pending={pending}
          best={best}
          upperTarget={obs.upperTarget}
          upperBonusValue={obs.upperBonusValue}
          myTurn={myTurn}
          phase={obs.phase}
          onPick={setPending}
          onConfirm={confirmScore}
          onCancel={() => setPending(null)}
        />
      </div>
    </BoardShell>
  );
}

export default YachtBoard;
