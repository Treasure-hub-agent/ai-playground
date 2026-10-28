/**
 * 六款棋盘共用的骨架。
 *
 * 为什么不含大标题：计分条已经给出「第 N 回合 / 双方比分 / 轮到谁」，
 * 棋盘上再写一遍「深海猎手」只是重复信息，还把首屏高度吃掉；六款统一成
 * 一行 kicker（怎么下手）+ 右侧 meta（本局角标）后，视觉层级才一致。
 *
 * 卡片外观不在这里：各游戏自己的根类名（bs-board / rv-board / rps-board…）
 * 继续由各自 CSS 提供描边、配色与内边距，BoardShell 只负责结构。
 */
import type { ReactNode } from 'react';
import '../styles/board-shell.css';

export interface BoardShellProps {
  /** 一行玩法提示，例如「点敌方海域开炮，命中可以继续开炮」 */
  kicker: string;
  /** 右上角角标（剩余舰船 / 落点数 / 回合芯片…），窄屏自动换到下一行 */
  meta?: ReactNode;
  children: ReactNode;
  /** 各游戏自己的根类名，叠加在 .board-shell 上 */
  className?: string;
  /** 无障碍名称：棋盘没有可见大标题了，区域仍需要一个能念出来的名字 */
  label?: string;
}

export function BoardShell({ kicker, meta, children, className, label }: BoardShellProps) {
  return (
    <section className={`board-shell${className ? ` ${className}` : ''}`} aria-label={label}>
      <header className="board-shell-head">
        <p className="board-kicker">{kicker}</p>
        {meta ? <div className="board-shell-meta">{meta}</div> : null}
      </header>
      {children}
    </section>
  );
}

export default BoardShell;
