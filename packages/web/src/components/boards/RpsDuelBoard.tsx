/**
 * 猜拳心理战（rps-duel）对局界面。
 *
 * 同时暗选：三局，第 1/2 局各 1 分，决胜局 2 分。
 * 本组件只依赖 RoomObservation 数据：提交后的锁定态记在本地 sessionStorage
 * （服务端不回传挂起动作，避免对手用 ?seat=X 读走暗选），
 * 揭示动画由 history.length 增加推导（刷新后仍能完整看到战报）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnyAction, RpsHistoryEntry, RpsObservation, RpsShape } from '../../types';
import { isDialogOpen } from '../../utils';
import { BoardShell } from '../BoardShell';
import '../../styles/rps-duel.css';

export interface RpsDuelBoardProps {
  obs: RpsObservation;
  disabled: boolean;
  onAction: (action: AnyAction) => void;
}

const SHAPES: RpsShape[] = ['rock', 'paper', 'scissors'];

const SHAPE_META: Record<RpsShape, { label: string; emoji: string; key: string }> = {
  rock: { label: '石头', emoji: '✊', key: '1' },
  paper: { label: '布', emoji: '✋', key: '2' },
  scissors: { label: '剪刀', emoji: '✌️', key: '3' },
};

const KEY_TO_SHAPE: Record<string, RpsShape> = {
  '1': 'rock',
  '2': 'paper',
  '3': 'scissors',
};

const DEFAULT_ROUND_POINTS = [1, 1, 2];
const REVEAL_SETTLE_MS = 680;
const REVEAL_TOTAL_MS = 1500;
const OPTIMISTIC_CLEAR_MS = 1800;

function isShape(value: unknown): value is RpsShape {
  return value === 'rock' || value === 'paper' || value === 'scissors';
}

function shapeMeta(shape: RpsShape) {
  return SHAPE_META[shape];
}

function outcomeLabel(entry: RpsHistoryEntry): string {
  if (entry.outcome === 'win') return `你赢 +${entry.yourDelta}`;
  if (entry.outcome === 'lose') return `Agent 赢 +${entry.opponentDelta}`;
  return '平局 0 : 0';
}

function currentRoundStatus(obs: RpsObservation, pendingShape: RpsShape | null): string {
  if (obs.status === 'ended') return '三局已打完';
  if (pendingShape) return '对手出手后立即揭示';
  if (obs.youSubmitted) return '本局已封盘，等待揭示';
  return '双方同时暗出，一起揭示';
}

interface ClashState {
  entry: RpsHistoryEntry;
  stage: 'clash' | 'done';
}

function ClashOverlay({ clash }: { clash: ClashState }) {
  const { entry, stage } = clash;
  return (
    <div
      className={`rps-clash is-${entry.outcome} ${stage === 'done' ? 'is-done' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="rps-clash-hands" aria-hidden="true">
        <span className="rps-clash-hand is-you">{shapeMeta(entry.yourShape).emoji}</span>
        <span className="rps-clash-spark">VS</span>
        <span className="rps-clash-hand is-opp">{shapeMeta(entry.opponentShape).emoji}</span>
      </div>
      <div className="rps-clash-result">
        {entry.outcome === 'win' ? '这一局你赢了' : entry.outcome === 'lose' ? '这一局 Agent 赢了' : '双方撞招，平局'}
        <b>{entry.outcome === 'win' ? ` +${entry.yourDelta}` : entry.outcome === 'lose' ? ` +${entry.opponentDelta}` : ''}</b>
      </div>
      <div className="rps-clash-sub">
        第 {entry.round} 局 · 值 {entry.points} 分 · 当前 {entry.scoreAfter.you} : {entry.scoreAfter.opponent}
      </div>
    </div>
  );
}

function FinalReport({ obs }: { obs: RpsObservation }) {
  let verdict = '势均力敌，平局收场。';
  if (obs.yourScore > obs.opponentScore) verdict = '你读穿了 Agent 的心思，赢下这场心理战。';
  else if (obs.yourScore < obs.opponentScore) verdict = 'Agent 读穿了你的心思，下次换套假动作。';
  const tone = obs.yourScore > obs.opponentScore ? 'win' : obs.yourScore < obs.opponentScore ? 'lose' : 'draw';

  return (
    <div className={`rps-report is-${tone}`} aria-label="三局战报">
      <div className="rps-report-head">
        <span className="rps-report-title">三局战报</span>
        <span className="rps-report-score">
          你 <b>{obs.yourScore}</b> <i>:</i> <b>{obs.opponentScore}</b> Agent
        </span>
      </div>
      <ol className="rps-report-list">
        {obs.history.map((entry) => (
          <li key={entry.round} className={`rps-report-row is-${entry.outcome}`}>
            <span className="rps-report-round">
              第 {entry.round} 局{entry.points === 2 ? <em>×2</em> : null}
            </span>
            <span className="rps-report-shapes">
              <span className="is-you">{shapeMeta(entry.yourShape).emoji}</span>
              <i>vs</i>
              <span className="is-opp">{shapeMeta(entry.opponentShape).emoji}</span>
            </span>
            <span className="rps-report-outcome">{outcomeLabel(entry)}</span>
          </li>
        ))}
      </ol>
      <p className="rps-report-verdict">{verdict}</p>
    </div>
  );
}

const PENDING_KEY = 'rps-pending';

/**
 * 自己这一手的锁定记录存在浏览器本地。
 * 为什么不从服务端读：服务端没有鉴权，`?seat=X` 任何客户端都能请求，
 * 一旦把「挂起动作」放进观测，对手就能读走你的暗选（审查报告 R1）。
 */
function readPending(roomId: string, round: number): RpsShape | null {
  try {
    const value = window.sessionStorage.getItem(`${PENDING_KEY}:${roomId}:${round}`);
    return isShape(value) ? value : null;
  } catch {
    return null;
  }
}

function writePending(roomId: string, round: number, shape: RpsShape | null): void {
  try {
    const key = `${PENDING_KEY}:${roomId}:${round}`;
    if (shape) window.sessionStorage.setItem(key, shape);
    else window.sessionStorage.removeItem(key);
  } catch {
    // 隐私模式下写不进去就只是丢刷新恢复，不影响对局
  }
}

export function RpsDuelBoard({ obs, disabled, onAction }: RpsDuelBoardProps) {
  const [pendingShape, setPendingShape] = useState<RpsShape | null>(() =>
    readPending(obs.roomId, obs.round),
  );
  const [clash, setClash] = useState<ClashState | null>(null);
  const historyCountRef = useRef(obs.history.length);

  const ended = obs.status === 'ended';
  const locked = Boolean(pendingShape) || obs.youSubmitted;

  const availableShapes = useMemo(() => {
    const set = new Set<RpsShape>();
    for (const action of obs.legalActions) {
      if (action.action === 'throw') set.add(action.shape);
    }
    return set;
  }, [obs.legalActions]);

  const canThrow = !disabled && !ended && !locked && !clash && obs.status === 'playing';
  const roundPoints = obs.roundPoints?.length === obs.roundsTotal ? obs.roundPoints : DEFAULT_ROUND_POINTS;
  const currentRound = Math.min(obs.round, obs.roundsTotal);

  const throwShape = useCallback(
    (shape: RpsShape) => {
      if (!canThrow || !availableShapes.has(shape)) return;
      setPendingShape(shape);
      writePending(obs.roomId, obs.round, shape);
      onAction({ action: 'throw', shape });
    },
    [availableShapes, canThrow, obs.roomId, obs.round, onAction],
  );

  // 提交失败（网络错误 / 409）时解除锁定，避免按钮永久卡死；
  // 服务端已确认收到（youSubmitted）就保持锁定，让「你出的这一手」继续显示。
  useEffect(() => {
    if (!pendingShape || obs.youSubmitted) return;
    const timer = window.setTimeout(() => {
      setPendingShape(null);
      writePending(obs.roomId, obs.round, null);
    }, OPTIMISTIC_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [pendingShape, obs.youSubmitted, obs.roomId, obs.round]);

  // 换局 / 换房间：按当前局重新取本地记录（新局没有记录 => 自动解锁）
  useEffect(() => {
    setPendingShape(readPending(obs.roomId, obs.round));
  }, [obs.roomId, obs.round, obs.history.length]);

  // history 增长 = 一局已结算：播放一次「对撞 → 结果」动画，不依赖 grab 的 reveal prop
  useEffect(() => {
    const nextLength = obs.history.length;
    const previousLength = historyCountRef.current;
    if (nextLength <= previousLength) {
      historyCountRef.current = nextLength;
      return;
    }
    historyCountRef.current = nextLength;
    const entry = obs.history[nextLength - 1];
    if (!entry) return;

    setClash({ entry, stage: 'clash' });
    const settleTimer = window.setTimeout(() => {
      setClash((current) => (current && current.entry.round === entry.round ? { entry, stage: 'done' } : current));
    }, REVEAL_SETTLE_MS);
    const clearTimer = window.setTimeout(() => {
      setClash((current) => (current && current.entry.round === entry.round ? null : current));
    }, REVEAL_TOTAL_MS);

    return () => {
      window.clearTimeout(settleTimer);
      window.clearTimeout(clearTimer);
    };
    // 只关心「长度变化」，避免轮询换新数组时反复重置动画计时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obs.history.length]);

  // 键盘 1/2/3：排除输入控件，避免吃掉聊天框按键
  useEffect(() => {
    if (!canThrow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 弹窗盖在上面时不能让快捷键穿透到棋盘：邀请 / 结算都是 aria-modal 对话框
      if (isDialogOpen()) return;
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      const shape = KEY_TO_SHAPE[event.key];
      if (!shape) return;
      if (!availableShapes.has(shape)) return;
      event.preventDefault();
      throwShape(shape);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [availableShapes, canThrow, throwShape]);

  const statusText = clash ? '正在揭示…' : currentRoundStatus(obs, pendingShape);

  return (
    <BoardShell
      className="rps-board"
      label="猜拳心理战"
      kicker="选一个手势，双方亮牌"
      meta={
        <div className="rps-head-meta">
          <span className="rps-round-chip">
            第 <b>{currentRound}</b> / {obs.roundsTotal} 局
          </span>
          {!ended && obs.currentRoundPoints !== null && (
            <span className={`rps-points-chip ${obs.currentRoundPoints === 2 ? 'is-final' : ''}`}>
              本局值 {obs.currentRoundPoints} 分
            </span>
          )}
          {ended && <span className="rps-points-chip is-done">已结束</span>}
        </div>
      }
    >
      <ol className="rps-track" aria-label="三局比分轨道">
        {roundPoints.map((points, index) => {
          const roundNo = index + 1;
          const entry = obs.history[index];
          const isFinal = points === 2;
          const isCurrent = !entry && !ended && index === obs.history.length;
          const classes = [
            'rps-track-cell',
            isFinal ? 'is-final' : '',
            entry ? `is-played is-${entry.outcome}` : '',
            isCurrent ? 'is-current' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li key={roundNo} className={classes}>
              <div className="rps-track-head">
                <span className="rps-track-round">第 {roundNo} 局</span>
                <span className="rps-track-points">{isFinal ? '×2' : `${points} 分`}</span>
              </div>
              <div className="rps-track-shapes">
                {entry ? (
                  <>
                    <span className="rps-track-shape is-you" title={`你：${shapeMeta(entry.yourShape).label}`}>
                      {shapeMeta(entry.yourShape).emoji}
                    </span>
                    <span className="rps-track-vs">vs</span>
                    <span className="rps-track-shape is-opp" title={`Agent：${shapeMeta(entry.opponentShape).label}`}>
                      {shapeMeta(entry.opponentShape).emoji}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`rps-track-shape is-you ${isCurrent && pendingShape ? 'is-locked' : 'is-unknown'}`}>
                      {isCurrent && pendingShape ? shapeMeta(pendingShape).emoji : '?'}
                    </span>
                    <span className="rps-track-vs">vs</span>
                    <span className="rps-track-shape is-opp is-unknown">?</span>
                  </>
                )}
              </div>
              <div className="rps-track-foot">
                {entry ? outcomeLabel(entry) : isCurrent ? (pendingShape ? '你已锁定' : '本局进行中') : '未开始'}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="rps-stage">
        {ended ? (
          <FinalReport obs={obs} />
        ) : (
          <>
            <div className={`rps-actions ${locked ? 'is-locked' : ''}`} role="group" aria-label="选择出手">
              {SHAPES.map((shape) => {
                const meta = shapeMeta(shape);
                const selected = pendingShape === shape;
                const isDim = locked && !selected;
                return (
                  <button
                    key={shape}
                    type="button"
                    className={`rps-throw ${selected ? 'is-selected' : ''} ${isDim ? 'is-dim' : ''}`}
                    disabled={!canThrow}
                    aria-label={
                      selected
                        ? `已锁定${meta.label}`
                        : locked
                          ? `${meta.label}（本轮已锁定）`
                          : `出${meta.label}，也可以按键盘 ${meta.key}`
                    }
                    onClick={() => throwShape(shape)}
                  >
                    <span className="rps-throw-key" aria-hidden="true">
                      {meta.key}
                    </span>
                    <span className="rps-throw-emoji" aria-hidden="true">
                      {meta.emoji}
                    </span>
                    <span className="rps-throw-copy">
                      <span className="rps-throw-name">{meta.label}</span>
                      <span className="rps-throw-sub">{selected ? '已锁定' : '出手'}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className={`rps-status ${locked ? 'is-locked' : ''}`} role="status">
              <span className="rps-status-main">
                {locked && pendingShape ? (
                  <>
                    你：<b className="rps-status-shape">{shapeMeta(pendingShape).emoji} {shapeMeta(pendingShape).label}</b> · 已锁定
                  </>
                ) : (
                  <>
                    键盘 <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> 也能出招
                  </>
                )}
              </span>
              <span className="rps-status-sub">{statusText}</span>
            </div>
          </>
        )}

        {clash && <ClashOverlay clash={clash} />}
      </div>
    </BoardShell>
  );
}

export default RpsDuelBoard;
