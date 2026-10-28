import { useEffect, useRef, useState } from 'react';
import type { GameEvent, RoomSummary, ServerWsMessage } from './types';

export interface RoomSocketHandlers {
  onHello?: (summary: RoomSummary | null) => void;
  onEvents?: (events: GameEvent[]) => void;
  onDisconnect?: () => void;
}

interface RoomSocketState {
  connected: boolean;
  reconnects: number;
}

const MAX_BACKOFF_MS = 8000;

/**
 * 连接 /ws?room=<id>，断线按指数退避自动重连。
 * 每次 hello（含重连后的 hello）都会触发 onHello，调用方借此补齐 /state 与 /chat。
 */
export function useRoomSocket(roomId: string, handlers: RoomSocketHandlers): RoomSocketState {
  const [connected, setConnected] = useState(false);
  const [reconnects, setReconnects] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (!alive) return;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) + Math.random() * 300;
      attempt += 1;
      setReconnects((count) => count + 1);
      retryTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (!alive) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws?room=${encodeURIComponent(roomId)}`;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }

      socket.onopen = () => {
        if (!alive) return;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        if (!alive) return;
        let message: ServerWsMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerWsMessage;
        } catch {
          return;
        }
        if (message.type === 'hello') {
          attempt = 0;
          handlersRef.current.onHello?.(message.summary ?? null);
        } else if (message.type === 'events') {
          handlersRef.current.onEvents?.(message.events ?? []);
        }
      };

      socket.onclose = () => {
        if (!alive) return;
        socket = null;
        setConnected(false);
        handlersRef.current.onDisconnect?.();
        scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose 会紧随其后，统一在那里做重连
      };
    };

    connect();

    return () => {
      alive = false;
      window.clearTimeout(retryTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [roomId]);

  return { connected, reconnects };
}
