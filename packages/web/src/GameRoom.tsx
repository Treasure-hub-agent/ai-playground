import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createRoom,
  fetchChat,
  fetchState,
  joinRoom,
  sendChat,
  submitAction,
} from './api';
import { AudioControls } from './components/AudioControls';
import { ChatPanel } from './components/ChatPanel';
import { Dialog } from './components/Dialog';
import { ResultOverlay } from './components/ResultOverlay';
import { RoomInvite } from './components/RoomInvite';
import { ScoreBar } from './components/ScoreBar';
import { Toast, type ToastState } from './components/Toast';
import { uiFor } from './games/registry';
import { adoptTokenFromUrl, stripTokenFromUrl } from './seatToken';
import { useSfx } from './audio/useAudio';
import type {
  AnyAction,
  CellCoord,
  ChatMessage,
  GameEvent,
  GameResultSummary,
  GrabObservation,
  RevealEvent,
  RoomObservation,
  RoomSummary,
  RoundRecord,
} from './types';
import { copyText, describePick, formatDelta, gridToLegalActions, matchesAction } from './utils';
import { useRoomSocket } from './useRoomSocket';

interface GameRoomProps {
  roomId: string;
  onNavigate: (path: string) => void;
  onLobby: () => void;
}

const REVEAL_ANIMATION_MS = 2600;
const RESULT_DELAY_MS = 2300;

const ERROR_TEXT: Record<string, string> = {
  waiting_for_opponent: 'Agent 还没上桌，等它入座再出招～',
  room_ended: '这局已经结束啦',
  seat_not_joined: '入座状态丢了，正在重新入座…',
  seat_taken: '这个座位已经被占用了（可能是别的浏览器先入座）',
  seat_token_required: '没有这个座位的令牌，只能以旁观身份观看',
  action_already_submitted: '你已经选好这一回合啦，等对手出招～',
  illegal_action: '这一步现在做不了，已经帮你刷新可选项',
  not_your_turn: '还没轮到你，等 Agent 落子',
  network_error: '网络打了个嗝，再试一次～',
};

/** grab 的 reveal 带 picks/grid；猜拳等新同时暗选游戏的 reveal 结构不同，不能套用 grab 动画。 */
function isGrabReveal(event: GameEvent): event is RevealEvent {
  return event.type === 'reveal' && 'grid' in event && Array.isArray((event as { grid?: unknown }).grid);
}

/** 坐标转成人类可读的棋盘坐标（列用字母、行从 1 开始）：抢宝是 3×3，A1–C3。 */
function cellLabel(cell: CellCoord): string {
  return `${String.fromCharCode(65 + cell[1])}${cell[0] + 1}`;
}

/** 把一条回合记录翻译成「谁 在哪 拿了多少」，给侧栏的本局记录用。 */
function describeRound(record: RoundRecord, seat: 0 | 1): string {
  const who = seat === 0 ? '你' : 'Agent';
  if (record.collision) return `${who} 撞车`;
  const cell = record.picks?.[String(seat)];
  if (!cell) return `${who} 没出手`;
  return `${who} ${cellLabel(cell)} ${formatDelta(record.delta?.[String(seat)] ?? 0)}`;
}

export function GameRoom({ roomId, onNavigate, onLobby }: GameRoomProps) {
  const [obs, setObs] = useState<RoomObservation | null>(null);
  const [youSubmitted, setYouSubmitted] = useState(false);
  const [yourPick, setYourPick] = useState<CellCoord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState<RevealEvent | null>(null);
  const [result, setResult] = useState<GameResultSummary | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [summary, setSummary] = useState<RoomSummary | null>(null);
  /**
   * 旁观模式：这个浏览器没有 0 号位的令牌（不是房主、也没带 token 链接）。
   * 服务端会返回只读的旁观观测，UI 上必须明确提示，否则玩家会以为棋盘卡死了。
   */
  const [spectator, setSpectator] = useState(false);

  const obsRef = useRef<RoomObservation | null>(null);
  const playSfx = useSfx();
  const revealRef = useRef<RevealEvent | null>(null);
  const submittingRef = useRef(false);
  const fetchingStateRef = useRef(false);
  const joinedRef = useRef(false);
  const seenRevealRef = useRef<Set<string>>(new Set());
  const seenChatRef = useRef<Set<number>>(new Set());
  const lastChatIdRef = useRef(0);
  const revealTimerRef = useRef<number | undefined>(undefined);
  const resultTimerRef = useRef<number | undefined>(undefined);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const pendingResultRef = useRef(false);

  useEffect(() => {
    obsRef.current = obs;
  }, [obs]);

  useEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  const showToast = useCallback((text: string, tone: ToastState['tone'] = 'info') => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), text, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const addMessages = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    // 去重放在 updater 外：StrictMode 在开发环境会重复调用 updater，不能在里面写 ref。
    const fresh = incoming.filter((message) => !seenChatRef.current.has(message.id));
    if (fresh.length === 0) return;
    for (const message of fresh) {
      seenChatRef.current.add(message.id);
      if (message.id > lastChatIdRef.current) lastChatIdRef.current = message.id;
    }
    setChatMessages((prev) => {
      const map = new Map(prev.map((message) => [message.id, message] as const));
      for (const message of fresh) map.set(message.id, message);
      return [...map.values()].sort((a, b) => a.id - b.id).slice(-30);
    });
  }, []);

  const syncChat = useCallback(async () => {
    try {
      const messages = await fetchChat(roomId, lastChatIdRef.current);
      addMessages(messages);
    } catch {
      // 聊天补齐失败不打断对局，下次重连/轮询还会再拉
    }
  }, [roomId, addMessages]);

  const refreshState = useCallback(async () => {
    if (fetchingStateRef.current) return;
    fetchingStateRef.current = true;
    try {
      const next = await fetchState(roomId, 0);
      const current = obsRef.current;
      // 忽略迟到的旧观测（例如揭示前发出的请求在揭示后才返回）
      if (current && next.round < current.round) return;
      if (current && current.status === 'playing' && next.status === 'waiting') return;
      if (current?.status === 'waiting' && next.status === 'playing') {
        showToast('Agent 入座啦，开局！🎉', 'success');
      }
      obsRef.current = next;
      setObs(next);
      if (!submittingRef.current) {
        setYouSubmitted(next.youSubmitted);
        if (!next.youSubmitted && !revealRef.current) setYourPick(null);
      }
      if (next.status === 'ended' && next.result && !pendingResultRef.current) {
        pendingResultRef.current = true;
        playSfx(next.result.winner === 0 ? 'win' : next.result.winner === 1 ? 'lose' : 'reveal');
        setResult(next.result);
        setReveal(null);
        revealRef.current = null;
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setFatal('房间不存在，可能已经被收起来了～');
      }
    } finally {
      fetchingStateRef.current = false;
    }
  }, [roomId, showToast, playSfx]);

  const ensureJoined = useCallback(async () => {
    if (joinedRef.current) return;
    try {
      await joinRoom(roomId, 0);
      joinedRef.current = true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setFatal('房间不存在，回大厅重新开一桌吧～');
      } else if (error instanceof ApiError && error.code === 'seat_taken') {
        // 座位被占：这个浏览器不是房主、也没有带 token 的链接。
        // 不要反复重试，直接切旁观——服务端会给只读观测。
        joinedRef.current = true;
        setSpectator(true);
      }
    }
  }, [roomId]);

  const applyReveal = useCallback((event: RevealEvent) => {
    const key = `reveal:${event.round}`;
    if (seenRevealRef.current.has(key)) return;
    seenRevealRef.current.add(key);
    playSfx('reveal');
    window.clearTimeout(revealTimerRef.current);
    setReveal(event);
    revealRef.current = event;
    setObs((prev) => {
      if (!prev) return prev;
      const grabPrev = prev as GrabObservation;
      return {
        ...grabPrev,
        round: Math.max(grabPrev.round, event.round + 1),
        scores: event.scores,
        yourScore: event.scores['0'] ?? grabPrev.yourScore,
        opponentScore: event.scores['1'] ?? grabPrev.opponentScore,
        grid: event.grid,
        legalActions: gridToLegalActions(event.grid),
        history: [
          ...grabPrev.history.filter((record) => record.round !== event.round),
          { round: event.round, picks: event.picks, delta: event.delta, collision: event.collision },
        ],
        youSubmitted: false,
      } as GrabObservation;
    });
    setYouSubmitted(false);
    setYourPick(null);
    revealTimerRef.current = window.setTimeout(() => {
      setReveal((current) => (current && current.round === event.round ? null : current));
    }, REVEAL_ANIMATION_MS);
  }, [playSfx]);

  const applyEnd = useCallback((nextResult: GameResultSummary) => {
    if (pendingResultRef.current) return;
    pendingResultRef.current = true;
    window.clearTimeout(resultTimerRef.current);
    resultTimerRef.current = window.setTimeout(() => {
      playSfx(nextResult.winner === 0 ? 'win' : nextResult.winner === 1 ? 'lose' : 'reveal');
      setResult(nextResult);
      setReveal(null);
      revealRef.current = null;
    }, RESULT_DELAY_MS);
  }, [playSfx]);

  const applyEvents = useCallback(
    (events: GameEvent[]) => {
      for (const event of events) {
        if (event.type === 'reveal') {
          // grab 的 reveal 带 grid，走旧的揭示动画；其它同时暗选游戏（猜拳）
          // 只拉一次最新观测，由各自的棋盘根据 history 播放动画。
          if (isGrabReveal(event)) applyReveal(event);
          else window.setTimeout(() => void refreshState(), 60);
        } else if (event.type === 'end') applyEnd(event.result);
        else if (event.type === 'chat') addMessages([event.message]);
        else if (event.type === 'pass') {
          // 黑白棋：轮到的一方无子可下，服务端自动跳过
          showToast(event.seat === 1 ? 'Agent 无子可下，跳过' : '你这边无子可下，已自动跳过', 'info');
        }
      }
    },
    [applyReveal, applyEnd, addMessages, refreshState, showToast],
  );

  // 房间切换时重置所有本地状态
  useEffect(() => {
    setObs(null);
    obsRef.current = null;
    setYouSubmitted(false);
    setYourPick(null);
    setSubmitting(false);
    submittingRef.current = false;
    setReveal(null);
    revealRef.current = null;
    setResult(null);
    pendingResultRef.current = false;
    setChatMessages([]);
    setToast(null);
    setFatal(null);
    setInviteOpen(false);
    setReplaying(false);
    setSummary(null);
    setSpectator(false);
    joinedRef.current = false;
    fetchingStateRef.current = false;
    seenRevealRef.current = new Set();
    seenChatRef.current = new Set();
    lastChatIdRef.current = 0;
    window.clearTimeout(revealTimerRef.current);
    window.clearTimeout(resultTimerRef.current);
    window.clearTimeout(toastTimerRef.current);
  }, [roomId]);

  // 入座 + 首次拉取
  useEffect(() => {
    let cancelled = false;
    // humanUrl 里可能带着 0 号位令牌（换标签页 / 换设备打开链接时），先收下再清地址栏：
    // 令牌留在 URL 里会被截图、被转发、进代理日志。
    adoptTokenFromUrl(roomId, 0);
    stripTokenFromUrl();
    const bootstrap = async () => {
      await ensureJoined();
      if (cancelled) return;
      await Promise.all([refreshState(), syncChat()]);
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [roomId, ensureJoined, refreshState, syncChat]);

  const handleHello = useCallback(
    (nextSummary: RoomSummary | null) => {
      setSummary(nextSummary);
      void ensureJoined();
      void refreshState();
      void syncChat();
    },
    [ensureJoined, refreshState, syncChat],
  );

  const handleWsEvents = useCallback(
    (events: GameEvent[]) => {
      applyEvents(events);
      // 轮流制没有 reveal 事件，收到落子事件后主动拉一次观测刷新棋盘
      if (events.some((event) => event.type !== 'chat' && event.type !== 'reveal' && event.type !== 'end')) {
        window.setTimeout(() => void refreshState(), 60);
      }
    },
    [applyEvents, refreshState],
  );

  const { connected } = useRoomSocket(fatal ? '' : roomId, { onHello: handleHello, onEvents: handleWsEvents });

  // 轮询兜底：主要用来发现 Agent 入座与 WS 断线期间的揭示
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible' || fatal) return;
      // 对局已结束就别再轮询了（以前 ended 后仍 2.2s 一次，一小时 3000+ 请求）
      if (obsRef.current?.status === 'ended') return;
      void refreshState();
      void syncChat();
    };
    const interval = window.setInterval(tick, 2200);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshState, syncChat, fatal]);

  // Esc 关闭接入弹窗的逻辑已搬进 components/Dialog.tsx（那里同时管焦点陷阱与回焦），
  // 这里不再重复注册 window keydown，否则同一次 Esc 会被两处处理。

  useEffect(
    () => () => {
      window.clearTimeout(revealTimerRef.current);
      window.clearTimeout(resultTimerRef.current);
      window.clearTimeout(toastTimerRef.current);
    },
    [],
  );

  const handleAction = useCallback(
    async (action: AnyAction, cell: CellCoord | null = null) => {
      const current = obsRef.current;
      if (!current || submittingRef.current) return;
      // 旁观者没有座位令牌，服务端也会拒；这里先挡一道，避免把请求发出去再收 403
      if (spectator || current.spectator) {
        showToast('旁观模式不能出招', 'info');
        return;
      }
      const ui = uiFor(current.gameId);
      const myTurn = ui.mode === 'turn' ? current.isYourTurn !== false : !current.youSubmitted;
      if (current.status !== 'playing') return;
      if (!myTurn || revealRef.current) {
        // 以前这里直接静默 return：非自己回合点棋盘毫无反馈，像卡死了
        showToast(
          revealRef.current
            ? '正在揭示这一回合…'
            : ui.mode === 'turn'
              ? '还没轮到你，等 Agent 出招'
              : '这一回合已经提交了，等 Agent',
          'info',
        );
        return;
      }
      if (pendingResultRef.current) return;
      // 和服务端同一套匹配规则：legalActions 里的字段全等才算合法
      if (!matchesAction(current.legalActions, action)) {
        if (current.legalActions.length === 0) {
          showToast(current.isYourTurn === false ? ERROR_TEXT.not_your_turn : '现在还不能这么做', 'error');
        } else {
          showToast(ERROR_TEXT.illegal_action, 'error');
        }
        return;
      }

      submittingRef.current = true;
      setSubmitting(true);
      if (ui.mode === 'simultaneous') setYouSubmitted(true);
      if (cell) setYourPick(cell);
      try {
        const response = await submitAction(roomId, 0, action);
        applyEvents(response.events);
        if (!response.resolved && ui.mode === 'simultaneous') setYouSubmitted(true);
        window.setTimeout(() => void refreshState(), 80);
      } catch (error) {
        setYouSubmitted(false);
        setYourPick(null);
        if (error instanceof ApiError) {
          showToast(ERROR_TEXT[error.code] ?? `出招失败：${error.code}`, 'error');
          if (error.code === 'seat_not_joined') {
            joinedRef.current = false;
            void ensureJoined();
          }
          if (error.code === 'action_already_submitted') setYouSubmitted(true);
          void refreshState();
        } else {
          showToast('网络打了个嗝，再试一次～', 'error');
        }
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [roomId, applyEvents, refreshState, ensureJoined, showToast],
  );

  const handlePick = useCallback(
    (cell: CellCoord) => {
      const current = obsRef.current;
      if (!current) return;
      const action = uiFor(current.gameId).actionForPick?.(cell);
      if (!action) return;
      void handleAction(action, cell);
    },
    [handleAction],
  );

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      if (spectator || obsRef.current?.spectator) {
        showToast('旁观模式不能发言', 'info');
        return false;
      }
      try {
        const message = await sendChat(roomId, 0, text);
        addMessages([message]);
        return true;
      } catch (error) {
        if (error instanceof ApiError) showToast(error.message, 'error');
        else showToast('消息没发出去，再试一次～', 'error');
        return false;
      }
    },
    [roomId, addMessages, showToast, spectator],
  );

  const handleReplay = useCallback(async () => {
    setReplaying(true);
    try {
      const room = await createRoom(summary?.gameId ?? obsRef.current?.gameId ?? 'grab');
      // 新房间的 0 号位令牌已经由 api.createRoom 存进 sessionStorage；
      // 沿用服务端给的 humanUrlPath（含 token）可以兼顾「换浏览器也能进」。
      onNavigate(room.humanUrlPath || `/?room=${room.roomId}&seat=0`);
    } catch {
      showToast('开新桌失败，稍后再试～', 'error');
      setReplaying(false);
    }
  }, [onNavigate, showToast, summary?.gameId]);

  const handleCopyRoom = useCallback(async () => {
    const ok = await copyText(roomId);
    showToast(ok ? `房间号 ${roomId} 已复制` : '复制失败，请手动选中', ok ? 'success' : 'error');
  }, [roomId, showToast]);

  if (fatal) {
    return (
      <div className="room-page">
        <div className="waiting-card">
          <h2>桌子不见了</h2>
          <p>{fatal}</p>
          <div className="waiting-actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={onLobby}>
              回大厅开新桌
            </button>
          </div>
        </div>
      </div>
    );
  }

  const status = obs?.status ?? 'waiting';
  const ui = uiFor(summary?.gameId ?? obs?.gameId);
  const isTurnMode = ui.mode === 'turn';
  // 服务端也会在观测里标 spectator；本地 join 被拒时先按旁观渲染，等观测回来再对齐
  const isSpectator = spectator || Boolean(obs?.spectator);
  // 回合数：有 history 的游戏按手数；battleship / reversi 没有 history，用观测里的 round
  const roundsPlayed = obs ? ('history' in obs ? obs.history.length : obs.round) : 0;
  // 只有抢宝有「每回合谁选了哪格」的完整记录；倒序展示，最近的回合不用滚动就能看到。
  const historyRecords =
    obs && obs.gameId === 'grab' ? [...((obs as GrabObservation).history ?? [])].reverse() : [];
  // 轮流制：不是自己回合 = 在等对方；同时暗选：本回合已提交 = 在等对方
  const waitingForAgent = isTurnMode ? obs?.isYourTurn === false : youSubmitted;
  const boardDisabled =
    !obs || status !== 'playing' || waitingForAgent || submitting || !!reveal || !!result || isSpectator;
  const yourPickDisplay = reveal ? null : yourPick;
  const lastRound = reveal
    ? { you: describePick(reveal, 0, '你 '), agent: describePick(reveal, 1, 'Agent ') }
    : null;

  // 默认态（轮到你、连接正常）不再重复一句话：棋盘顶部的 kicker 已经说了怎么下手，
  // 这里只负责「非默认态」的状态播报（等对手 / 揭示中 / 断线 / 终局）。
  let hint: string | null = null;
  if (isSpectator) hint = '旁观中 —— 这个浏览器没有 0 号位的座位令牌，只能看不能出招。';
  else if (status === 'waiting') hint = ui.hints.waiting;
  else if (result || status === 'ended') hint = ui.hints.ended;
  else if (!isTurnMode && reveal) hint = '同时亮牌！这一回合的选择已经揭晓。';
  else if (waitingForAgent) hint = isTurnMode ? ui.waitLabel + '…' : (ui.hints.sealed ?? ui.hints.pick);
  else if (!connected) hint = '实时连接断开，正在重连 —— 这期间的出招可能失败，稍等一两秒再点。';

  return (
    <div className="room-page">
      <header className="room-header">
        <button type="button" className="room-back" onClick={onLobby} aria-label="回大厅">
          ← 大厅
        </button>
        <div className="room-meta">
          <span className="room-code">
            房间 <b>{roomId}</b>
          </span>
          <span className={`conn-dot ${connected ? 'is-on' : 'is-off'}`}>{connected ? '实时在线' : '重连中'}</span>
          {/* 旁观者没有座位，别在顶栏写「你 · seat 0」——那是别人的座位 */}
          {summary && <span className="seat-pill">{isSpectator ? '旁观' : '你 · seat 0'}</span>}
        </div>
        <div className="room-header-actions">
          <AudioControls compact />
          <button type="button" className="btn btn-mini" onClick={() => setInviteOpen(true)}>
            Agent 接入
          </button>
        </div>
      </header>

      {!obs ? (
        <div className="room-loading">
          <p>正在进入牌桌…</p>
          <small>房间 {roomId}</small>
        </div>
      ) : (
        <>
          {isSpectator && (
            <div className="spectator-banner" role="status">
              <b>旁观模式</b>
              <span>
                这个浏览器没有 0 号位的座位令牌，只能看不能出招。要上桌请回到<strong>创建房间的那个浏览器</strong>，
                或让对方发你带 <code>token</code> 的房间链接。
              </span>
            </div>
          )}
          <main className="game-layout">
          <section className="play-column">
            <ScoreBar
              scores={obs.scores}
              round={obs.round}
              roundsTotal={obs.roundsTotal}
              status={status}
              youSubmitted={waitingForAgent}
              connected={connected}
              reveal={reveal}
              resultShown={!!result}
              mode={ui.mode}
              showScores={ui.showScores}
              unitLabel={ui.unitLabel}
              scoreUnit={ui.scoreUnit}
              turnLabel={ui.turnLabel}
              waitLabel={ui.waitLabel}
              spectator={isSpectator}
            />

            <div className={`board-wrap ${ui.plainBoard ? 'is-plain' : ''} ${reveal?.collision ? 'is-shaking' : ''}`}>
              {ui.renderBoard({
                obs,
                disabled: boardDisabled,
                reveal,
                yourPick: yourPickDisplay,
                onPick: handlePick,
                onAction: (action) => void handleAction(action),
              })}

              {status === 'waiting' && (
                <div className="board-cover">
                  <div className="board-cover-card">
                    <h3>Agent 还没上桌</h3>
                    <p>
                      房间号 <b>{roomId}</b>，把接入方式交给它，入座后自动开局。
                    </p>
                    <div className="board-cover-actions">
                      <button type="button" className="btn btn-primary" onClick={() => setInviteOpen(true)}>
                        查看接入方式
                      </button>
                      <button type="button" className="btn btn-quiet" onClick={() => void handleCopyRoom()}>
                        复制房间号
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {!isTurnMode && !ui.inlineSeal && youSubmitted && !reveal && !result && status === 'playing' && (
                <div className="seal-strip" role="status">
                  {ui.hints.sealed ?? '已开牌 · 等 Agent 出招'}
                </div>
              )}

            </div>

            {/* 揭示条以前是绝对定位在 .board-wrap 里的，会压住棋盘最后一排；
                现在挪到棋盘下方走文档流，错过的回合还能在侧栏「本局记录」里回看。 */}
            {!isTurnMode && reveal && lastRound && (
              <div className={`reveal-strip ${reveal.collision ? 'is-collision' : ''}`} role="status">
                <span className="reveal-round">第 {reveal.round} 回合</span>
                <span className="reveal-seat reveal-you">{lastRound.you}</span>
                <span className="reveal-seat reveal-agent">{lastRound.agent}</span>
                {reveal.collision ? (
                  <span className="collision-tag">撞车，宝物被撞飞</span>
                ) : (
                  (reveal.delta['0'] ?? 0) !== 0 && (
                    <span className={`reveal-float ${(reveal.delta['0'] ?? 0) > 0 ? 'is-plus' : 'is-minus'}`}>
                      你 {formatDelta(reveal.delta['0'] ?? 0)}
                    </span>
                  )
                )}
              </div>
            )}

            {hint && <p className={`turn-hint ${youSubmitted ? 'is-sealed' : ''}`}>{hint}</p>}
          </section>

          <aside className="side-column">
            <ChatPanel
              messages={chatMessages}
              onSend={handleSend}
              disabled={!!result || isSpectator}
              placeholder={isSpectator ? '旁观模式不能发言' : undefined}
              quickPhrases={isSpectator ? [] : ui.quickChat}
            />
            <details className="rules-card">
              <summary>
                规则速查
                <span className="summary-hint">{ui.rulesSummary}</span>
              </summary>
              <ul>
                {ui.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </details>
            {/* 抢宝的揭示只亮 2.6 秒，切个标签页就永远错过这一回合；
                历史本来就在观测里，直接摊开给玩家回看，成本几乎为零。 */}
            {historyRecords.length > 0 && (
              <details className="rules-card">
                <summary>
                  本局记录
                  <span className="summary-hint">{historyRecords.length} 回合 · 最新在上</span>
                </summary>
                <ul>
                  {historyRecords.map((record) => (
                    <li key={record.round}>
                      第 {record.round} 回合 · {describeRound(record, 0)} ｜ {describeRound(record, 1)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </aside>
        </main>
        </>
      )}

      {inviteOpen && !result && (
        <Dialog
          labelledBy="invite-title"
          backdropClassName="modal-backdrop"
          shellClassName="modal-shell"
          onClose={() => setInviteOpen(false)}
          closeOnBackdrop
        >
          <RoomInvite
            roomId={roomId}
            humanUrlPath={`/?room=${roomId}&seat=0`}
            onClose={() => setInviteOpen(false)}
            onEnter={() => setInviteOpen(false)}
            enterLabel="知道啦，回牌桌"
            closeLabel="关掉弹窗"
            mode={ui.mode}
            gameId={ui.id}
          />
        </Dialog>
      )}

      {result && (
        <ResultOverlay
          result={result}
          roundsPlayed={roundsPlayed}
          replaying={replaying}
          onReplay={() => void handleReplay()}
          onLobby={onLobby}
          gameId={ui.id}
          unitLabel={ui.unitLabel}
          scoreUnit={ui.scoreUnit}
          showScores={ui.showScores}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}








