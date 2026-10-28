import { useEffect, useRef, type ReactNode } from 'react';
import '../styles/dialog.css';

/**
 * 可聚焦元素白名单（WAI-ARIA APG 对话框焦点陷阱的常用集合）。
 * 只挑键盘真的能到达的元素，被隐藏的再由 focusableInside 过滤。
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableInside(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    // offsetParent 为 null 通常意味着被 display:none 藏起来了；
    // position:fixed 的元素 offsetParent 也是 null，需要放行。
    return node.offsetParent !== null || window.getComputedStyle(node).position === 'fixed';
  });
}

export interface DialogProps {
  /** 标题元素 id：aria-labelledby 指向它，读屏才会念出弹窗名字 */
  labelledBy: string;
  /** Esc（以及开启 closeOnBackdrop 时的遮罩点击）触发 */
  onClose: () => void;
  /**
   * 点遮罩是否关闭。默认 false —— 结算浮层必须走「再来一桌 / 回大厅」，
   * 误点背景把战报关掉会更糟。
   */
  closeOnBackdrop?: boolean;
  /** 遮罩层类名：弹窗传 modal-backdrop，结算浮层传 result-overlay */
  backdropClassName: string;
  /** 内容壳类名：弹窗传 modal-shell，结算浮层传 result-card */
  shellClassName: string;
  children: ReactNode;
}

/**
 * 弹窗语义与焦点管理。
 *
 * 以前两处弹层各写一套：邀请弹窗没有 role/aria-modal、没有焦点陷阱，
 * 结算浮层有 role 却没有 Esc 和初始焦点，键盘用户 Tab 会走到背后的棋盘上。
 * 现在统一走这里：role="dialog" + aria-modal + aria-labelledby + 首焦点 +
 * Tab 循环 + Esc + 关闭后把焦点还给打开它的那个按钮。
 */
export function Dialog({
  labelledBy,
  onClose,
  closeOnBackdrop = false,
  backdropClassName,
  shellClassName,
  children,
}: DialogProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // 用 ref 持有最新的 onClose：父组件每次渲染都会传新的内联箭头函数，
  // 若把 onClose 放进依赖数组，effect 会反复重跑并把焦点抢回去。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const previous = document.activeElement;
    restoreFocusRef.current = previous instanceof HTMLElement ? previous : null;

    // 首焦点：优先 data-autofocus（主按钮），其次第一个可聚焦元素，最后容器自身。
    // 主按钮在「开桌中…」时是 disabled 的，此时不能让焦点落在它身上。
    const autofocus = shell.querySelector<HTMLElement>('[data-autofocus]');
    const initial =
      (autofocus && !autofocus.hasAttribute('disabled') ? autofocus : focusableInside(shell)[0]) ??
      shell;
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusableInside(shell);
      if (items.length === 0) {
        event.preventDefault();
        shell.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? shell.contains(active) : false;
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // 捕获阶段监听：弹窗的 Esc / Tab 必须先于棋盘挂在 window 上的快捷键处理。
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const restore = restoreFocusRef.current;
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className={backdropClassName}
      role="presentation"
      onClick={closeOnBackdrop ? () => onCloseRef.current() : undefined}
    >
      <div
        ref={shellRef}
        className={`dialog-shell ${shellClassName}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
