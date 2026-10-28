import type { GameMeta } from './types.ts';

/**
 * 大厅目录：可玩游戏来自各 GameSpec 的 meta，占位游戏（路线图）在这里登记。
 * 新增一款游戏后，把它从 plannedGames 移到 games 注册表即可，大厅自动切换状态。
 *
 * 2026-10-27：路线图上的三款（猜拳心理战 / 深海猎手 / 黑白棋）已全部上线，
 * 这里暂时为空——保留结构，下一批候选游戏（见 docs/2026-10-25-preplan.md 的评分表）登记进来即可。
 */
export const plannedGames: GameMeta[] = [];

export function findCatalogGame(id: string, playable: GameMeta[]): GameMeta | undefined {
  return playable.find((g) => g.id === id) ?? plannedGames.find((g) => g.id === id);
}
