import { recallSeatToken, rememberSeatToken } from './seatToken';
import type {
  ChatMessage,
  CreateRoomResponse,
  GameMeta,
  LegalAction,
  RoomObservation,
  RoomSummary,
  Seat,
  SubmitActionResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly legalActions: LegalAction[];

  constructor(message: string, status: number, code: string, legalActions: LegalAction[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.legalActions = legalActions;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError('连不上游戏服务，检查一下 8787 端口的小服务器～', 0, 'network_error');
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = (body ?? {}) as { error?: string; legalActions?: LegalAction[] };
    throw new ApiError(
      typeof err.error === 'string' ? err.error : `HTTP ${response.status}`,
      response.status,
      typeof err.error === 'string' ? err.error : 'unknown_error',
      err.legalActions ?? [],
    );
  }
  return body as T;
}

export async function fetchGames(): Promise<GameMeta[]> {
  const data = await request<{ games: GameMeta[] }>('/api/games');
  return data.games ?? [];
}

export async function createRoom(gameId: string): Promise<CreateRoomResponse> {
  const data = await request<CreateRoomResponse>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ gameId }),
  });
  // 0 号位的令牌随建桌响应下发，先存好；之后 join / state / action 都靠它。
  rememberSeatToken(data.roomId, 0, data.seatTokens?.['0']);
  return data;
}

/**
 * 入座。请求体里带上已知令牌（如果有），服务端据此判断是「新入座」还是「同一个人重连」。
 * 座位已被别人占用时会抛 409 seat_taken —— 调用方据此切旁观模式。
 */
export async function joinRoom(roomId: string, seat: Seat): Promise<RoomSummary & { seat?: Seat; token?: string }> {
  const token = recallSeatToken(roomId, seat);
  const data = await request<{ ok: boolean; seat?: Seat; token?: string } & RoomSummary>(
    `/api/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: 'POST',
      body: JSON.stringify(token ? { seat, token } : { seat }),
    },
  );
  rememberSeatToken(roomId, seat, data.token);
  return data;
}

export function fetchState(roomId: string, seat: Seat): Promise<RoomObservation> {
  const token = recallSeatToken(roomId, seat);
  const query = `seat=${seat}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  return request<RoomObservation>(`/api/rooms/${encodeURIComponent(roomId)}/state?${query}`);
}

export function submitAction(roomId: string, seat: Seat, action: Record<string, unknown>): Promise<SubmitActionResponse> {
  const token = recallSeatToken(roomId, seat);
  return request<SubmitActionResponse>(`/api/rooms/${encodeURIComponent(roomId)}/action`, {
    method: 'POST',
    body: JSON.stringify({ seat, action, ...(token ? { token } : {}) }),
  });
}

export async function sendChat(roomId: string, seat: Seat, text: string): Promise<ChatMessage> {
  const token = recallSeatToken(roomId, seat);
  const data = await request<{ ok: boolean; message: ChatMessage }>(
    `/api/rooms/${encodeURIComponent(roomId)}/say`,
    {
      method: 'POST',
      body: JSON.stringify({ seat, text, ...(token ? { token } : {}) }),
    },
  );
  return data.message;
}

export async function fetchChat(roomId: string, since = 0): Promise<ChatMessage[]> {
  const data = await request<{ messages: ChatMessage[] }>(
    `/api/rooms/${encodeURIComponent(roomId)}/chat?since=${since}`,
  );
  return data.messages ?? [];
}

