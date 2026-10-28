/**
 * 席位令牌的本地存取。
 *
 * 服务端在入座时发一张令牌，之后每个「按座位视角」的请求都要带上它；
 * 没有令牌的请求一律降级为旁观视图。令牌按「房间 + 座位」存，
 * 放 sessionStorage 而不是 localStorage：关掉标签页就失效，减少残留。
 *
 * 注意：创建房间时服务端会把 0 号位的令牌放进 humanUrl 的查询串里，
 * 这样换标签页 / 换设备打开链接也能自动认回座位；GameRoom 读完后会
 * 立刻把 URL 里的令牌抹掉（history.replaceState），避免被截图或日志带走。
 */
const KEY_PREFIX = 'ai-playground:seat-token:';

type TokenMap = Record<string, string>;

function storageKey(roomId: string): string {
  return `${KEY_PREFIX}${roomId}`;
}

function readMap(roomId: string): TokenMap {
  try {
    const raw = window.sessionStorage.getItem(storageKey(roomId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TokenMap) : {};
  } catch {
    // 隐私模式 / 存储被禁用时当作没有令牌，退化为旁观，不要炸掉页面
    return {};
  }
}

function writeMap(roomId: string, map: TokenMap): void {
  try {
    if (Object.keys(map).length === 0) window.sessionStorage.removeItem(storageKey(roomId));
    else window.sessionStorage.setItem(storageKey(roomId), JSON.stringify(map));
  } catch {
    // 存不进去也不影响本次会话：调用方手里还有返回值
  }
}

export function rememberSeatToken(roomId: string, seat: number, token: string | null | undefined): void {
  if (!roomId || !token) return;
  const map = readMap(roomId);
  if (map[String(seat)] === token) return;
  map[String(seat)] = token;
  writeMap(roomId, map);
}

export function recallSeatToken(roomId: string, seat: number): string | null {
  if (!roomId) return null;
  return readMap(roomId)[String(seat)] ?? null;
}

export function forgetRoomTokens(roomId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(roomId));
  } catch {
    // 忽略
  }
}

/** 从？room=xxx&seat=0&token=<t> 里把令牌捞出来存好，返回是否有收获。 */
export function adoptTokenFromUrl(roomId: string, seat: number, search = window.location.search): boolean {
  if (!roomId) return false;
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (!token) return false;
  rememberSeatToken(roomId, seat, token);
  return true;
}

/**
 * 把 URL 里的 token 抹掉，但保留 room / seat 参数。
 * 令牌留在地址栏里会被截图、被复制到聊天窗口、进 proxy 日志。
 */
export function stripTokenFromUrl(search = window.location.search): void {
  const params = new URLSearchParams(search);
  if (!params.has('token')) return;
  params.delete('token');
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}
