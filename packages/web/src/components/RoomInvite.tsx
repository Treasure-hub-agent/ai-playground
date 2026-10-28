import { useEffect, useRef, useState } from 'react';
import { absoluteUrl, copyText } from '../utils';

interface RoomInviteProps {
  roomId: string;
  humanUrlPath: string;
  onEnter?: () => void;
  onClose?: () => void;
  enterLabel?: string;
  /** 次要按钮文案：大厅里是「先留在大厅」，牌桌里其实是「关掉弹窗」 */
  closeLabel?: string;
  /** 结算模式：同时暗选的游戏和轮流制的游戏，引导词不一样 */
  mode?: 'simultaneous' | 'turn';
  /** 游戏 id：引导词按游戏取（同是 simultaneous 的抢宝和猜拳不能共用一句话） */
  gameId?: string;
}

/** 同时暗选游戏的入座引导词（以前这里只按 mode 二选一，猜拳被当成了抢宝）。 */
const SIMULTANEOUS_COPY: Record<string, { tagline: string; step3: string }> = {
  grab: {
    tagline: '让 Agent 坐到 1 号座位，你们就能同时暗选、一起抢宝。',
    step3: '双方入座后，每回合同时选一格，金币加分、炸弹 −2、撞车谁都没份。',
  },
  'rps-duel': {
    tagline: '让 Agent 坐到 1 号座位，你们就能同时暗选、连赌三局。',
    step3: '双方入座后，每局同时出一个手势；第 3 局翻倍，三局打完比总分。',
  },
};

const SIMULTANEOUS_FALLBACK = {
  tagline: '让 Agent 坐到 1 号座位，入座后双方同时出手。',
  step3: '双方入座后同时出手，一起揭示结果。',
};

function mcpConfig(): string {
  return JSON.stringify(
    {
      mcpServers: {
        'ai-playground': {
          type: 'http',
          url: 'http://127.0.0.1:8787/mcp',
        },
      },
    },
    null,
    2,
  );
}

export function RoomInvite({
  roomId,
  humanUrlPath,
  onEnter,
  onClose,
  enterLabel = '进入牌桌 →',
  closeLabel = '先留在大厅',
  mode = 'simultaneous',
  gameId,
}: RoomInviteProps) {
  const humanUrl = absoluteUrl(humanUrlPath);
  const config = mcpConfig();
  const agentPrompt = `请用 MCP 连接 http://127.0.0.1:8787/mcp（Streamable HTTP），然后调用 playground_join_room({ roomId: "${roomId}", seat: 1 }) 加入《AI 游乐场》的 1 号座位，开始对局。`;
  const isTurn = mode === 'turn';
  const simCopy = (gameId && SIMULTANEOUS_COPY[gameId]) || SIMULTANEOUS_FALLBACK;
  const tagline = isTurn
    ? '让 Agent 坐到 1 号座位，入座后你们轮流出手。'
    : simCopy.tagline;
  const step3 = isTurn
    ? '双方入座后轮流行动：轮到你时按牌桌上的提示出招，另一边交给 Agent。'
    : simCopy.step3;
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async (label: string, value: string) => {
    const ok = await copyText(value);
    setCopied(ok ? label : '复制失败，请手动选中');
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(null), 2200);
  };

  return (
    <section className="invite-card">
      <div className="invite-head">
        <div className="invite-head-text">
          <span className="invite-badge">牌桌已开</span>
          <h2 id="invite-title">把 Agent 叫上桌</h2>
          <p>{tagline}</p>
        </div>
        {onClose && (
          <button type="button" className="icon-btn invite-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        )}
      </div>

      <div className="field">
        <span className="field-label">房间号</span>
        <div className="copy-line">
          <strong className="roomcode">{roomId}</strong>
          <button type="button" className="btn btn-mini" onClick={() => void copy('房间号', roomId)}>
            复制
          </button>
        </div>
      </div>

      <label className="field">
        <span className="field-label">人类链接（你自己打开）</span>
        <div className="copy-line">
          <input readOnly value={humanUrl} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn btn-mini" onClick={() => void copy('链接', humanUrl)}>
            复制
          </button>
        </div>
      </label>

      <ol className="invite-steps">
        <li className="invite-step">
          <span className="step-num">1</span>
          <p>
            把 <b>房间号</b> 交给你的 Agent。
          </p>
        </li>
        <li className="invite-step">
          <span className="step-num">2</span>
          <p>
            用下面的 <b>MCP 配置</b> 连接本机服务（默认 8787）。
          </p>
        </li>
        <li className="invite-step">
          <span className="step-num">3</span>
          <p>{step3}</p>
        </li>
      </ol>

      <details className="mcp-details">
        <summary>
          <span>MCP 配置</span>
          <span className="summary-hint">Claude Code / Codex / DSH 通用</span>
        </summary>
        <div className="code-block-wrap">
          <pre className="code-block">{config}</pre>
          <button type="button" className="btn btn-mini code-copy" onClick={() => void copy('配置', config)}>
            复制配置
          </button>
        </div>
        <p className="field-note">在项目根目录使用；服务地址默认 http://127.0.0.1:8787。</p>
      </details>

      <label className="field">
        <span className="field-label">或者，直接把这句话发给 Agent</span>
        <div className="copy-line">
          <input readOnly value={agentPrompt} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="btn btn-mini" onClick={() => void copy('指令', agentPrompt)}>
            复制
          </button>
        </div>
      </label>

      <div className="invite-actions">
        {onEnter && (
          <button type="button" className="btn btn-primary btn-lg" onClick={onEnter} data-autofocus>
            {enterLabel}
          </button>
        )}
        {onClose && (
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {closeLabel}
          </button>
        )}
      </div>

      {copied && <div className="copy-toast">{copied === '复制失败，请手动选中' ? copied : `已复制${copied}`}</div>}
    </section>
  );
}
