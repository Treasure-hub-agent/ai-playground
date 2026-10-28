/**
 * 深海猎手（battleship）对局界面。
 *
 * 主区：敌方 5×5 海域（unknown / miss / hit / sunk 四态，命中继续开炮）。
 * 侧区：我方舰队 5×5 小图 + 舰船状态 + 上一炮信息。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BattleshipObservation, BattleshipShipView, CellCoord, EnemyCell } from '../../types';
import { BoardShell } from '../BoardShell';
import '../../styles/battleship.css';

export interface BattleshipBoardProps {
  obs: BattleshipObservation;
  disabled: boolean;
  onPick: (cell: CellCoord) => void;
}

const SEA_SIZE = 5;
const COLS = ['A', 'B', 'C', 'D', 'E'];

const CELL_TEXT: Record<EnemyCell, string> = {
  unknown: '未探索',
  miss: '打空',
  hit: '命中',
  sunk: '已沉没',
};

function keyOf(r: number, c: number): string {
  return `${r},${c}`;
}

function coordLabel(r: number, c: number): string {
  return `${COLS[c] ?? '?'}${r + 1}`;
}

function sameCell(a: CellCoord | null | undefined, r: number, c: number): boolean {
  return Boolean(a && a[0] === r && a[1] === c);
}

function shipAt(fleet: BattleshipShipView[], r: number, c: number): BattleshipShipView | undefined {
  return fleet.find((ship) => ship.cells.some(([sr, sc]) => sr === r && sc === c));
}

interface SunkNotice {
  id: number;
  text: string;
  tone: 'good' | 'bad';
}

export function BattleshipBoard({ obs, disabled, onPick }: BattleshipBoardProps) {
  const [notice, setNotice] = useState<SunkNotice | null>(null);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const lastShotRoundRef = useRef(obs.lastShot?.round ?? 0);

  const canFire = !disabled && obs.status === 'playing' && obs.isYourTurn === true;
  const legalSet = useMemo(
    () => new Set(obs.legalActions.map((action) => keyOf(action.cell[0], action.cell[1]))),
    [obs.legalActions],
  );

  const enemyLeft = obs.scores['1'] ?? obs.enemyShipsLeft;
  const yourLeft = obs.scores['0'] ?? obs.yourShipsLeft;
  const lastShot = obs.lastShot;
  const lastShotMine = lastShot?.seat === 0;
  const lastShotHit = Boolean(lastShot?.hit);

  // 击沉时短暂宣告（只在新的一炮出现时触发，刷新页面不重播）
  useEffect(() => {
    const round = obs.lastShot?.round ?? 0;
    if (round <= lastShotRoundRef.current) {
      lastShotRoundRef.current = round;
      return;
    }
    lastShotRoundRef.current = round;
    const shot = obs.lastShot;
    if (!shot?.sunk) return;
    const mine = shot.seat === 0;
    setNotice({
      id: round,
      text: mine ? `击沉对手${shot.sunk}！` : `我方${shot.sunk}被击沉…`,
      tone: mine ? 'good' : 'bad',
    });
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2800);
  }, [obs.lastShot]);

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const streak = canFire && lastShotMine && lastShotHit;

  // 默认态不再复述操作规则——棋盘顶部的 kicker 已经写了「点敌方海域开炮，命中继续」，
  // 这里只在没人开过炮时给一句轮次提示（同时也是 aria-live 的初始内容）。
  let noticeText = '轮到你了：选一格开炮。';
  let noticeTone = 'idle';
  if (notice) {
    noticeText = notice.text;
    noticeTone = notice.tone;
  } else if (streak) {
    noticeText = '命中！继续开炮';
    noticeTone = 'hit';
  } else if (lastShot) {
    const who = lastShotMine ? '你' : 'Agent';
    const result = lastShot.hit ? (lastShot.sunk ? `命中并击沉 ${lastShot.sunk}` : '命中') : '打空';
    noticeText = `上一炮：${who} 打 ${coordLabel(lastShot.cell[0], lastShot.cell[1])} · ${result}`;
    noticeTone = lastShot.hit ? (lastShotMine ? 'hit' : 'incoming') : 'idle';
  }

  return (
    <BoardShell
      className="bs-board"
      label="深海猎手"
      kicker="点敌方海域开炮，命中继续"
      meta={
        <div className="bs-fleet-counts">
          <span className="bs-count">
            敌舰剩余 <b>{enemyLeft}</b> 艘
          </span>
          <span className="bs-count is-mine">
            我方剩 <b>{yourLeft}</b> 艘
          </span>
        </div>
      }
    >
      <div className="bs-layout">
        <div className="bs-main">
          <div className="bs-main-head">
            <span className="bs-main-title">敌方海域</span>
            <span className="bs-main-meta">本局已开炮 {obs.shotsFired} 次</span>
          </div>

          <div
            className={`bs-notice ${noticeTone === 'idle' ? '' : `is-${noticeTone}`}`}
            role="status"
            aria-live="polite"
          >
            <span className="bs-notice-dot" aria-hidden="true" />
            {noticeText}
          </div>

          <div className="bs-enemy-grid" role="group" aria-label="敌方海域，5 乘 5">
            {obs.enemyGrid.map((row, r) =>
              row.map((cell, c) => {
                const interactive = canFire && legalSet.has(keyOf(r, c));
                const isLast = lastShotMine && sameCell(lastShot?.cell, r, c);
                const classes = [
                  'bs-cell',
                  `is-${cell}`,
                  interactive ? 'is-legal' : '',
                  isLast ? 'is-last' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button
                    key={keyOf(r, c)}
                    type="button"
                    className={classes}
                    disabled={!interactive}
                    onClick={() => onPick([r, c])}
                    aria-label={`${coordLabel(r, c)}，${CELL_TEXT[cell]}${interactive ? '，点击开炮' : ''}`}
                    title={`${coordLabel(r, c)} · ${CELL_TEXT[cell]}`}
                  >
                    <span className="bs-cell-inner">
                      {cell === 'unknown' && interactive && <span className="bs-reticle" aria-hidden="true" />}
                      {cell === 'miss' && <span className="bs-miss-mark" aria-hidden="true" />}
                      {cell === 'hit' && (
                        <span className="bs-hit-mark" aria-hidden="true">
                          ✕
                        </span>
                      )}
                      {cell === 'sunk' && (
                        <span className="bs-sunk-mark" aria-hidden="true">
                          ☠
                        </span>
                      )}
                    </span>
                  </button>
                );
              }),
            )}
          </div>

          <div className="bs-legend" aria-hidden="true">
            <span>
              <i className="bs-swatch is-unknown" /> 未探索
            </span>
            <span>
              <i className="bs-swatch is-miss" /> 打空
            </span>
            <span>
              <i className="bs-swatch is-hit" /> 命中
            </span>
            <span>
              <i className="bs-swatch is-sunk" /> 沉没
            </span>
          </div>
        </div>

        <aside className="bs-side" aria-label="我方海域">
          <div className="bs-panel">
            <div className="bs-panel-head">
              <span className="bs-panel-title">我方海域</span>
              <span className="bs-panel-sub">
                存活 {yourLeft} / {obs.yourFleet.length} 艘
              </span>
            </div>

            <div className="bs-own-grid" role="img" aria-label={`我方海域，${yourLeft} 艘舰船存活`}>
              {Array.from({ length: SEA_SIZE }, (_, r) =>
                Array.from({ length: SEA_SIZE }, (_, c) => {
                  const ship = shipAt(obs.yourFleet, r, c);
                  const hit = Boolean(ship && ship.hitCells.some(([hr, hc]) => hr === r && hc === c));
                  const incoming = lastShot?.seat === 1 && sameCell(lastShot.cell, r, c);
                  const classes = [
                    'bs-own-cell',
                    ship ? 'has-ship' : '',
                    hit ? 'is-hit' : '',
                    ship?.sunk ? 'is-sunk' : '',
                    incoming ? 'is-incoming' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <span
                      key={keyOf(r, c)}
                      className={classes}
                      title={`${coordLabel(r, c)}${ship ? ` · ${ship.name}` : ''}${hit ? ' · 中弹' : ''}`}
                      aria-hidden="true"
                    >
                      {ship && (hit ? <span className="bs-own-hit">✕</span> : <span className="bs-own-ship" />)}
                    </span>
                  );
                }),
              )}
            </div>

            <ul className="bs-ship-list">
              {obs.yourFleet.map((ship) => (
                <li key={ship.id} className={ship.sunk ? 'is-sunk' : ''}>
                  <span className="bs-ship-dot" aria-hidden="true" />
                  <span className="bs-ship-name">{ship.name}</span>
                  <span className="bs-ship-size">{ship.size} 格</span>
                  <span className="bs-ship-status">
                    {ship.sunk ? '已沉没' : ship.hitCells.length > 0 ? `中弹 ${ship.hitCells.length}/${ship.size}` : '完好'}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {lastShot && (
            <div className={`bs-last-shot ${lastShotMine ? 'is-mine' : ''}`}>
              <span className="bs-last-label">上一炮</span>
              <span className="bs-last-text">
                {lastShotMine ? '你' : 'Agent'} 打 {coordLabel(lastShot.cell[0], lastShot.cell[1])} ·{' '}
                {lastShot.hit ? (lastShot.sunk ? `击沉 ${lastShot.sunk}` : '命中') : '打空'}
              </span>
            </div>
          )}
        </aside>
      </div>
    </BoardShell>
  );
}

export default BattleshipBoard;
