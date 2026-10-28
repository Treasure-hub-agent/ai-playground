import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { formatClock } from '../utils';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string) => Promise<boolean>;
  disabled?: boolean;
  /** 输入框占位文案（旁觀模式 / 终局各说各的，别一律写「对局已结束」） */
  placeholder?: string;
  /** 快捷短语：不同游戏用不同的垃圾话 */
  quickPhrases?: string[];
}

const DEFAULT_PHRASES = ['手下留情', '承让承让'];

export function ChatPanel({
  messages,
  onSend,
  disabled = false,
  placeholder,
  quickPhrases = DEFAULT_PHRASES,
}: ChatPanelProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const canSend = text.trim().length > 0 && !sending && !disabled;

  const submit = async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    try {
      const ok = await onSend(value);
      if (ok) setText('');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  /** 快捷短语：点一下直接发出去（发失败则回填输入框，方便重试）。 */
  const sendQuick = async (phrase: string) => {
    if (sending || disabled) return;
    setSending(true);
    try {
      const ok = await onSend(phrase);
      if (!ok) setText(phrase);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <section className="chat-panel">
      <header className="panel-head">
        <h2>桌边闲聊</h2>
        <span className="panel-sub">说点垃圾话，不影响出招</span>
      </header>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <span className="chat-empty-emoji" aria-hidden="true">
              🐳💭
            </span>
            <p>Agent 还没开口。</p>
            <p className="muted">先打个招呼，探探它的虚实～</p>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`chat-row ${message.seat === 0 ? 'is-mine' : 'is-theirs'}`}
            >
              <span className="chat-avatar" aria-hidden="true">
                {message.seat === 0 ? '🐳' : '🤖'}
              </span>
              <div className="chat-bubble">
                <div className="chat-meta">
                  <b>{message.seat === 0 ? '你' : 'Agent'}</b>
                  <time>{formatClock(message.at)}</time>
                </div>
                <p>{message.text}</p>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="quick-phrases">
        {quickPhrases.map((phrase) => (
          <button
            key={phrase}
            type="button"
            className="quick-chip"
            disabled={disabled || sending}
            onClick={() => void sendQuick(phrase)}
          >
            {phrase}
          </button>
        ))}
      </div>

      <form
        className="chat-input-row"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          className="chat-input"
          type="text"
          value={text}
          maxLength={200}
          disabled={disabled || sending}
          placeholder={placeholder ?? (disabled ? '对局已结束' : '说两句…（Enter 发送）')}
          onChange={(event) => setText(event.target.value)}
          aria-label="聊天输入框"
        />
        <button type="submit" className="btn btn-send" disabled={!canSend}>
          {sending ? '发送中' : '发送'}
          <span aria-hidden="true">➤</span>
        </button>
      </form>
      {text.length > 150 && <span className="char-count">{text.length} / 200</span>}
    </section>
  );
}
