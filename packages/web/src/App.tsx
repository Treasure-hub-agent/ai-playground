import { useCallback, useEffect, useState } from 'react';
import { GameRoom } from './GameRoom';
import { Lobby } from './Lobby';

interface Route {
  roomId: string | null;
  seat: number;
}

function readRoute(): Route {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  const rawSeat = params.get('seat');
  return {
    roomId: roomId && roomId.trim() ? roomId.trim() : null,
    seat: rawSeat === null ? 0 : Number(rawSeat),
  };
}

export function App() {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState({}, '', path);
    setRoute(readRoute());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goLobby = useCallback(() => {
    window.history.pushState({}, '', '/');
    setRoute(readRoute());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  if (route.roomId && route.seat !== 0) {
    return (
      <div className="app-shell">
        <div className="seat-mismatch">
          <div className="seat-mismatch-card">
            <span className="fatal-emoji" aria-hidden="true">🤖🔑</span>
            <h1>这好像是 Agent 的座位</h1>
            <p>
              这个链接是给 <b>1 号座位（Agent）</b> 的。人类请坐 0 号座位，从大厅开桌或让朋友把
              seat=0 的链接发给你。
            </p>
            <div className="seat-mismatch-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => navigate(`/?room=${encodeURIComponent(route.roomId ?? '')}&seat=0`)}
              >
                以人类身份进入 →
              </button>
              <button type="button" className="btn btn-ghost" onClick={goLobby}>
                回大厅
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {route.roomId ? (
        <GameRoom roomId={route.roomId} onNavigate={navigate} onLobby={goLobby} />
      ) : (
        <Lobby onNavigate={navigate} />
      )}
    </div>
  );
}
