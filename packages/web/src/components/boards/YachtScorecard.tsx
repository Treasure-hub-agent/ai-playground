/**
 * 快艇骰子计分板（重做版）
 *
 * 设计要点：
 * - 每一行都是 ≥48px 的整行按钮，点击面积大
 * - 桌面两栏（上区 / 下区），≤900px 自动单栏
 * - 我的分数 21px 粗体；对手分数弱化显示
 * - 待确认条直接展开在被点击的行下面（不浮层、不 sticky）
 * - 上区 63 分进度 + 奖励状态；最划算的格子有左侧色条
 */
import { Fragment, useEffect, useRef } from 'react';
import type { YachtCategory, YachtScorecard as YachtScorecardData } from '../../types';
import '../../styles/scorecard.css';

export interface YachtScorecardProps {
  myCard: YachtScorecardData;
  oppCard: YachtScorecardData;
  preview: Record<YachtCategory, number | null>;
  canScore: boolean;
  pending: YachtCategory | null;
  best: YachtCategory | null;
  upperTarget: number;
  upperBonusValue: number;
  myTurn: boolean;
  phase: 'roll' | 'choice' | 'must_score';
  onPick: (category: YachtCategory) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

interface CategoryMeta {
  id: YachtCategory;
  label: string;
  hint?: string;
}

const UPPER_ROWS: CategoryMeta[] = [
  { id: 'ones', label: '一点' },
  { id: 'twos', label: '二点' },
  { id: 'threes', label: '三点' },
  { id: 'fours', label: '四点' },
  { id: 'fives', label: '五点' },
  { id: 'sixes', label: '六点' },
];

const LOWER_ROWS: CategoryMeta[] = [
  { id: 'three_kind', label: '三条', hint: '≥3 同点 · 五骰和' },
  { id: 'four_kind', label: '四条', hint: '≥4 同点 · 五骰和' },
  { id: 'full_house', label: '葫芦', hint: '恰好 3+2 · 25 分' },
  { id: 'small_straight', label: '小顺', hint: '4 连 · 30 分' },
  { id: 'large_straight', label: '大顺', hint: '5 连 · 40 分' },
  { id: 'yacht', label: '快艇', hint: '五骰同点 · 50 分' },
  { id: 'chance', label: '全骰', hint: '五骰总和' },
];

function scoreText(value: number | null): string {
  return value === null ? '·' : String(value);
}

export function YachtScorecard({
  myCard,
  oppCard,
  preview,
  canScore,
  pending,
  best,
  upperTarget,
  upperBonusValue,
  myTurn,
  phase,
  onPick,
  onConfirm,
  onCancel,
}: YachtScorecardProps) {
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const pendingPreview = pending ? preview[pending] : null;

  const upperSubtotal = myCard.upperSubtotal;
  const bonusHit = myCard.upperBonus > 0;
  const remainingForBonus = Math.max(0, upperTarget - upperSubtotal);
  const progress = upperTarget > 0 ? Math.max(0, Math.min(100, (upperSubtotal / upperTarget) * 100)) : 0;

  // 确认条展开在长列表底部时，尽量把它带进视野（不改变滚动容器）
  useEffect(() => {
    if (!pending || !confirmRef.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    confirmRef.current.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [pending]);

  let statusText = '等待 Agent 记分…';
  if (myTurn) {
    if (phase === 'roll') statusText = '先掷骰，再选一格记分';
    else if (phase === 'must_score') statusText = '掷骰次数用完，必须选一格记分';
    else if (!canScore) statusText = '等待当前动作结算…';
    else statusText = '点选一行，确认后记入';
  }

  const renderRow = (meta: CategoryMeta) => {
    const mine = myCard[meta.id];
    const opp = oppCard[meta.id];
    const previewValue = preview[meta.id];
    const filled = mine !== null;
    const pickable = canScore && !filled && previewValue !== null;
    const isPending = pending === meta.id;
    const isBest = pickable && best === meta.id;
    const isZeroPreview = !filled && previewValue === 0;

    const ariaLabel = filled
      ? `${meta.label} 已记 ${mine} 分`
      : pickable
        ? `记入${meta.label}，可得 ${previewValue} 分${isBest ? '（当前最划算）' : ''}`
        : `${meta.label} 暂不可记`;

    return (
      <Fragment key={meta.id}>
        <button
          type="button"
          className={[
            'ysc-row',
            filled ? 'is-filled' : '',
            pickable ? 'is-pickable' : '',
            isBest ? 'is-best' : '',
            isPending ? 'is-pending' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={!pickable}
          aria-expanded={isPending}
          aria-label={ariaLabel}
          title={isBest ? '当前骰面这一格最划算' : undefined}
          onClick={() => {
            if (!pickable) return;
            if (isPending) onCancel();
            else onPick(meta.id);
          }}
        >
          <span className="ysc-label">
            <span className="ysc-label-main">
              {isBest && <i className="ysc-best-dot" aria-hidden="true" />}
              {meta.label}
            </span>
            {meta.hint && <span className="ysc-hint">{meta.hint}</span>}
          </span>

          <span
            className={[
              'ysc-mine',
              filled ? 'is-filled' : '',
              !filled && previewValue !== null ? 'is-preview' : '',
              !filled && previewValue === null ? 'is-empty' : '',
              isZeroPreview ? 'is-zero-preview' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-hidden="true"
          >
            {filled ? mine : scoreText(previewValue)}
          </span>

          <span className="ysc-opp" aria-hidden="true">
            {scoreText(opp)}
          </span>
        </button>

        {isPending && (
          <div
            ref={confirmRef}
            className={`ysc-confirm ${pendingPreview === 0 ? 'is-zero' : ''}`}
            role="group"
            aria-label={`确认记入${meta.label}`}
          >
            <div className="ysc-confirm-text">
              <span className="ysc-confirm-title">
                记入 <b>{meta.label}</b>
                <span className="ysc-arrow" aria-hidden="true">
                  →
                </span>
                <b className="ysc-confirm-score">{pendingPreview === null ? '—' : `+${pendingPreview}`}</b>
              </span>
              {pendingPreview === 0 && <span className="ysc-confirm-warn">这一格拿不到分，确定要记 0 吗？</span>}
            </div>
            <div className="ysc-confirm-actions">
              <button type="button" className="ysc-btn ysc-btn-ghost" onClick={onCancel}>
                再想想
              </button>
              <button
                type="button"
                className="ysc-btn ysc-btn-primary"
                onClick={onConfirm}
                disabled={pendingPreview === null}
              >
                确认记分
              </button>
            </div>
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <section className="ysc" aria-label="快艇骰子计分板">
      <header className="ysc-head">
        <div className="ysc-head-main">
          <span className={`ysc-turn ${myTurn ? 'is-mine' : ''}`}>
            <i className="ysc-turn-dot" aria-hidden="true" />
            {myTurn ? '你的回合' : 'Agent 回合'}
          </span>
          <p className="ysc-status">{statusText}</p>
        </div>
        <div className="ysc-legend" aria-hidden="true">
          <span>
            <i className="ysc-key is-preview" />
            本手可得
          </span>
          <span>
            <i className="ysc-key is-filled" />
            已记
          </span>
          <span>
            <i className="ysc-key is-best" />
            最划算
          </span>
        </div>
      </header>

      <div className="ysc-columns">
        <section className="ysc-group" aria-label="上区">
          <header className="ysc-group-head">
            <h4 className="ysc-group-title">上区</h4>
            <span className="ysc-group-meta">
              {upperTarget} 分奖励 +{upperBonusValue}
            </span>
          </header>

          <div className={`ysc-meter ${bonusHit ? 'is-complete' : ''}`}>
            <div className="ysc-meter-head">
              <span className="ysc-meter-label">
                上区进度 <b>{upperSubtotal}</b> / {upperTarget}
              </span>
              <span className="ysc-meter-note">
                {bonusHit ? `+${myCard.upperBonus} 已到手` : remainingForBonus > 0 ? `再 ${remainingForBonus} 分拿 +${upperBonusValue}` : `+${upperBonusValue} 已到手`}
              </span>
            </div>
            <div
              className="ysc-meter-track"
              role="progressbar"
              aria-label="上区进度"
              aria-valuemin={0}
              aria-valuemax={upperTarget}
              aria-valuenow={Math.min(upperSubtotal, upperTarget)}
              aria-valuetext={`${upperSubtotal} / ${upperTarget} 分`}
            >
              <span className="ysc-meter-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="ysc-col-head" aria-hidden="true">
            <span>栏目</span>
            <span>你</span>
            <span>对手</span>
          </div>

          <div className="ysc-rows" role="group" aria-label="上区计分项">
            {UPPER_ROWS.map(renderRow)}
          </div>

          <footer className="ysc-group-foot">
            <div className="ysc-foot-stat">
              <span className="ysc-foot-label">上区小计</span>
              <b className="ysc-foot-value">{upperSubtotal}</b>
            </div>
            <div className="ysc-foot-stat is-opp">
              <span className="ysc-foot-label">对手</span>
              <span className="ysc-foot-opp">{oppCard.upperSubtotal}</span>
            </div>
            <span className={`ysc-bonus-chip ${bonusHit ? 'is-hit' : ''}`}>
              {bonusHit ? `奖励已获 +${myCard.upperBonus}` : `奖励 +${upperBonusValue}`}
            </span>
          </footer>
        </section>

        <section className="ysc-group" aria-label="下区">
          <header className="ysc-group-head">
            <h4 className="ysc-group-title">下区</h4>
            <span className="ysc-group-meta">7 格 · 固定牌型分</span>
          </header>

          <div className="ysc-col-head" aria-hidden="true">
            <span>栏目</span>
            <span>你</span>
            <span>对手</span>
          </div>

          <div className="ysc-rows" role="group" aria-label="下区计分项">
            {LOWER_ROWS.map(renderRow)}
          </div>

          <footer className="ysc-group-foot is-total">
            <div className="ysc-foot-stat">
              <span className="ysc-foot-label">总分</span>
              <b className="ysc-foot-value">{myCard.total}</b>
            </div>
            <div className="ysc-foot-stat is-opp">
              <span className="ysc-foot-label">对手</span>
              <span className="ysc-foot-opp">{oppCard.total}</span>
            </div>
          </footer>
        </section>
      </div>

      {phase === 'must_score' && myTurn && !pending && (
        <p className="ysc-note is-warn" role="status">
          这一手 3 次掷骰用完了，必须选一格记分（打不出也可以记 0 分）。
        </p>
      )}
    </section>
  );
}

export default YachtScorecard;
