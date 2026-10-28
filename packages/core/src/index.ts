export * from './types.ts';
export * from './rng.ts';
export * from './games/grab.ts';
export * from './games/connect4.ts';
export * from './games/yacht.ts';
export * from './games/rps-duel.ts';
export * from './games/battleship.ts';
export * from './games/reversi.ts';
export * from './catalog.ts';

import { grab } from './games/grab.ts';
import { connect4 } from './games/connect4.ts';
import { yacht } from './games/yacht.ts';
import { rpsDuel } from './games/rps-duel.ts';
import { battleship } from './games/battleship.ts';
import { reversi } from './games/reversi.ts';
import { plannedGames } from './catalog.ts';
import type { GameMeta, GameSpec } from './types.ts';

/** 游戏注册表：新增一款可玩游戏，在这里登记即可（大厅会自动展示）。 */
export const games: Record<string, GameSpec<any, any>> = {
  grab,
  connect4,
  yacht,
  'rps-duel': rpsDuel,
  battleship,
  reversi,
};

export function getGame(id: string): GameSpec<any, any> | undefined {
  return games[id];
}

/** 大厅目录：可玩游戏 + 路线图占位（wip）。 */
export function listGameMeta(): GameMeta[] {
  return [...Object.values(games).map((g) => g.meta), ...plannedGames];
}

export function getGameMeta(id: string): GameMeta | undefined {
  return listGameMeta().find((m) => m.id === id);
}
