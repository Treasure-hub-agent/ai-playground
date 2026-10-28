import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createRoom, fetchGames } from './api';
import { AudioControls } from './components/AudioControls';
import { WhaleMascot } from './components/Decor';
import { ArrowIcon, GameGlyph, LockIcon, SparkIcon } from './components/Icons';
import { Dialog } from './components/Dialog';
import { RoomInvite } from './components/RoomInvite';
import type { CreateRoomResponse, GameMeta } from './types';

interface LobbyProps {
  onNavigate: (path: string) => void;
}

type StatusFilter = 'all' | 'playable' | 'wip';

/** 基础状态筛选；「开发中」只在真的存在非 playable 游戏时才追加，避免空入口。 */
const BASE_STATUS_TABS: Array<{ id: StatusFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'playable', label: '可开桌' },
];

const WIP_TAB: { id: StatusFilter; label: string } = { id: 'wip', label: '开发中' };

/** 把各游戏的时长文案（如「30–60 秒」「3–5 分钟」）汇总成 hero 用的区间。 */
function formatDurationRange(games: GameMeta[]): string {
  const ranges: Array<[number, number]> = [];
  for (const game of games) {
    const match = /(\d+)\s*[–—~～-]\s*(\d+)\s*(秒|分钟)/.exec(game.duration);
    if (!match) continue;
    const unit = match[3] === '分钟' ? 60 : 1;
    ranges.push([Number(match[1]) * unit, Number(match[2]) * unit]);
  }
  if (ranges.length === 0) return '30 秒 – 8 分钟';
  const low = Math.min(...ranges.map(([min]) => min));
  const high = Math.max(...ranges.map(([, max]) => max));
  const label = (seconds: number) =>
    seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
  return `${label(low)} – ${label(high)}`;
}

export function Lobby({ onNavigate }: LobbyProps) {
  const [games, setGames] = useState<GameMeta[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateRoomResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [category, setCategory] = useState<string>('all');

  const loadGames = useCallback(async () => {
    setLoadError(null);
    try {
      setGames(await fetchGames());
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : '加载游戏列表失败');
      setGames(null);
    }
  }, []);

  useEffect(() => {
    void loadGames();
  }, [loadGames]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    (games ?? []).forEach((g) => set.add(g.category));
    return ['all', ...Array.from(set)];
  }, [games]);

  const visible = useMemo(() => {
    return (games ?? []).filter((g) => {
      if (status !== 'all' && g.status !== status) return false;
      if (category !== 'all' && g.category !== category) return false;
      return true;
    });
  }, [games, status, category]);

  const playableCount = useMemo(() => (games ?? []).filter((g) => g.status === 'playable').length, [games]);
  const hasWip = useMemo(() => (games ?? []).some((g) => g.status !== 'playable'), [games]);
  const statusTabs = useMemo(() => (hasWip ? [...BASE_STATUS_TABS, WIP_TAB] : BASE_STATUS_TABS), [hasWip]);
  const durationText = useMemo(() => formatDurationRange(games ?? []), [games]);

  // 游戏全部上线后「开发中」tab 会消失，别让筛选状态留在看不见的 tab 上
  useEffect(() => {
    if (!hasWip && status === 'wip') setStatus('all');
  }, [hasWip, status]);

  const openTable = async (gameId: string) => {
    if (creatingId) return;
    setCreatingId(gameId);
    setActionError(null);
    try {
      setCreated(await createRoom(gameId));
    } catch (error) {
      setActionError(error instanceof ApiError ? error.message : '开桌失败，请再试一次');
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <div className="lobby-page">
      <header className="site-head">
        <div className="brand">
          <span className="brand-mark">
            <WhaleMascot className="brand-whale" />
          </span>
          <span className="brand-text">
            AI 游乐场
            <em>agent × human</em>
          </span>
        </div>
        <nav className="site-nav" aria-label="快捷入口">
          <a href="/llms.txt" target="_blank" rel="noreferrer">
            Agent 接入
          </a>
          <a href="/api/games" target="_blank" rel="noreferrer">
            API
          </a>
          <span className="site-nav-sep" aria-hidden="true" />
          <AudioControls />
          <span className="site-nav-sep" aria-hidden="true" />
          <span className="site-version">v0.1 · MIT</span>
        </nav>
      </header>

      <section className="lobby-hero">
        <div className="hero-text">
          <p className="eyebrow">
            <SparkIcon /> 人类 × Agent · 同桌小游戏
          </p>
          <h1>
            开一桌，
            <br />
            把你的 Agent 叫上来
          </h1>
          <p className="lede">浏览器当牌桌，Agent 当对手，服务器只当裁判。规则由引擎裁决，玩法交给你们的 Agent。</p>
          <div className="hero-cta">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              去挑一款游戏
              <ArrowIcon />
            </button>
            <a className="btn btn-quiet" href="/AGENTS.md" target="_blank" rel="noreferrer">
              给 Agent 的接入说明
            </a>
          </div>
          <dl className="hero-stats">
            <div>
              <dt>可开桌</dt>
              <dd>{games === null ? '—' : `${playableCount} 款`}</dd>
            </div>
            <div>
              <dt>单局时长</dt>
              <dd>{durationText}</dd>
            </div>
            <div>
              <dt>数据</dt>
              <dd>只在本机</dd>
            </div>
          </dl>
        </div>

        <aside className="hero-preview" aria-hidden="true">
          <div className="preview-card">
            <div className="preview-top">
              <span className="preview-dot" />
              <span className="preview-title">ROOM 桌 · 抢宝大作战</span>
              <span className="preview-round">第 4 回合</span>
            </div>
            <div className="preview-board">
              {['coin', 'coin', 'empty', 'taken', 'coin', 'bomb', 'coin', 'empty', 'taken'].map((kind, i) => (
                <span key={i} className={`preview-cell preview-${kind}`}>
                  {kind === 'coin' ? '＋' : kind === 'bomb' ? '✕' : kind === 'taken' ? '·' : ''}
                </span>
              ))}
            </div>
            <div className="preview-foot">
              <span className="preview-you">你 5</span>
              <span className="preview-vs">:</span>
              <span className="preview-agent">Agent 4</span>
            </div>
          </div>
        </aside>
      </section>

      <section className="catalog" id="catalog">
        <header className="catalog-head">
          <div>
            <p className="eyebrow">GAME LIBRARY</p>
            <h2>游戏库</h2>
          </div>
          <div className="catalog-filters">
            <div className="filter-group" role="tablist" aria-label="按状态筛选">
              {statusTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={status === tab.id}
                  className={`filter-chip ${status === tab.id ? 'is-active' : ''}`}
                  onClick={() => setStatus(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="filter-group" aria-label="按分类筛选">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`filter-chip ${category === cat ? 'is-active' : ''}`}
                  onClick={() => setCategory(cat)}
                >
                  {cat === 'all' ? '全部分类' : cat}
                </button>
              ))}
            </div>
          </div>
        </header>

        {games === null && !loadError && (
          <div className="game-grid">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="game-card is-skeleton" key={i}>
                <div className="skeleton-row" />
                <div className="skeleton-row wide" />
                <div className="skeleton-row" />
              </div>
            ))}
          </div>
        )}

        {loadError && (
          <div className="notice notice-error" role="alert">
            <div>
              <h3>没能连上游戏服务</h3>
              <p>{loadError}</p>
              <p className="muted">确认 8787 端口的服务在运行，然后重试。</p>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void loadGames()}>
              重新加载
            </button>
          </div>
        )}

        {games !== null && visible.length === 0 && (
          <div className="notice">
            <div>
              <h3>这个筛选下还没有游戏</h3>
              <p className="muted">换个状态或分类看看。</p>
            </div>
          </div>
        )}

        <div className="game-grid">
          {visible.map((game, index) => {
            const playable = game.status === 'playable';
            const creating = creatingId === game.id;
            return (
              <article
                key={game.id}
                className={`game-card ${playable ? 'is-playable' : 'is-wip'}`}
                style={{ ['--accent' as string]: game.accent, ['--i' as string]: index }}
              >
                <div className="game-card-top">
                  <span className="game-glyph">
                    <GameGlyph gameId={game.id} />
                  </span>
                  <span className={`status-badge ${playable ? 'is-live' : 'is-wip'}`}>
                    {playable ? (
                      <>
                        <i aria-hidden="true" /> 可开桌
                      </>
                    ) : (
                      <>
                        <LockIcon /> 开发中
                      </>
                    )}
                  </span>
                </div>

                <h3 className="game-name">{game.name}</h3>
                <p className="game-tagline">{game.tagline}</p>

                <ul className="game-meta">
                  <li>{game.seats} 人座</li>
                  <li>{game.duration}</li>
                  <li>{game.category}</li>
                </ul>

                <div className="game-tags">
                  {game.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>

                {playable && (
                  <details className="game-rules">
                    <summary>查看规则</summary>
                    <pre>{game.rules}</pre>
                  </details>
                )}

                <div className="game-actions">
                  {playable ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-block"
                      onClick={() => void openTable(game.id)}
                      disabled={creatingId !== null}
                    >
                      {creating ? '开桌中…' : '开一桌'}
                    </button>
                  ) : (
                    <button type="button" className="btn btn-quiet btn-block" disabled>
                      敬请期待
                    </button>
                  )}
                  <p className="game-hint">{playable ? '开桌后把房间号或 MCP 端点交给 Agent' : '已排进路线图，先玩可开桌的那款'}</p>
                </div>
              </article>
            );
          })}
        </div>

        {actionError && <p className="inline-error">{actionError}</p>}
      </section>

      <section className="how">
        <header className="catalog-head">
          <div>
            <p className="eyebrow">HOW IT WORKS</p>
            <h2>三步开玩</h2>
          </div>
          <p className="muted">无需注册、无需装客户端；人类在浏览器，Agent 走 MCP。</p>
        </header>
        <ol className="how-list">
          <li>
            <span className="how-num">01</span>
            <h3>开一桌</h3>
            <p>选一款游戏，拿到房间号与人类链接。</p>
          </li>
          <li>
            <span className="how-num">02</span>
            <h3>喊 Agent 上桌</h3>
            <p>
              把 <code>http://127.0.0.1:8787/mcp</code> 交给你的 Agent，或直接把房间号发它。
            </p>
          </li>
          <li>
            <span className="how-num">03</span>
            <h3>同时暗选 / 轮流行动</h3>
            <p>同时暗选：双方同时出招，服务端收齐才揭示；轮流行动：按座位依次出手，每一步即时结算。</p>
          </li>
        </ol>
      </section>

      <footer className="lobby-footer">
        <span>AI 游乐场 · 人类与 Agent 的同桌小游戏</span>
        <span className="muted">
          只监听本机 · 不保存任何模型密钥 · MIT ·{' '}
          <a href="/CREDITS.md" target="_blank" rel="noreferrer">
            音乐与音效署名
          </a>
        </span>
      </footer>

      {created && (
        <Dialog
          labelledBy="invite-title"
          backdropClassName="modal-backdrop"
          shellClassName="modal-shell"
          onClose={() => setCreated(null)}
          closeOnBackdrop
        >
          <RoomInvite
            roomId={created.roomId}
            humanUrlPath={created.humanUrlPath}
            gameId={created.gameId}
            onEnter={() => onNavigate(created.humanUrlPath)}
            onClose={() => setCreated(null)}
            enterLabel="进入牌桌"
            mode={
              games?.find((game) => game.id === created.gameId)?.resolution === 'turn'
                ? 'turn'
                : 'simultaneous'
            }
          />
        </Dialog>
      )}
    </div>
  );
}
