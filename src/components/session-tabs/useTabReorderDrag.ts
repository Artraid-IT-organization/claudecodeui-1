import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Перетаскивание вкладок чатов в полосе (Егор 16.09.26: «взять чат и
 * перенести между другими, с анимацией, без лагов»).
 *
 * Почему своё, а не dnd-kit: у dnd-kit на телефоне ломается прокрутка
 * полосы, в которой лежат сортируемые элементы (issue #272), а касание
 * элемента перерисовывает все остальные (issue #1379). Полоса и так
 * перерисовывается на каждое сообщение сокета.
 *
 * Как добиться плавности:
 * - во время перетаскивания React не участвует: слушатели навешаны на DOM,
 *   сдвиги пишутся прямо в `style.transform` раз в кадр (requestAnimationFrame);
 *   `transform` не пересчитывает раскладку страницы;
 * - размеры вкладок меряются ОДИН раз при старте, дальше только арифметика;
 * - соседи расступаются CSS-переходом, а не покадровым расчётом;
 * - порядок в состоянии меняется только после того, как вкладка «доехала» на
 *   место; сдвиги снимаются в useLayoutEffect — до отрисовки, без мигания.
 *
 * Мышь: тянуть сразу, после сдвига на 5 px (короткий щелчок — выбор вкладки).
 * Палец: подержать ~0,35 с, потом тянуть. Иначе обычное листание полосы
 * пальцем перестало бы работать. Касания — через touch-события, а не pointer:
 * только так iOS Safari даёт отменить прокрутку уже после начала жеста.
 */

const MOUSE_SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 350;
const SETTLE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const EDGE = 48;
const MAX_AUTOSCROLL = 14;

type Pending = {
  id: string;
  kind: 'mouse' | 'touch';
  startX: number;
  startY: number;
  touchId?: number;
  timer?: number;
};

type Drag = {
  id: string;
  kind: 'mouse' | 'touch';
  touchId?: number;
  els: HTMLElement[];
  lefts: number[];
  widths: number[];
  from: number;
  target: number;
  startX: number;
  pointerX: number;
  scrollStart: number;
  lastDx: number;
  /** Сдвигали ли вкладку по-настоящему: без сдвига отпускание — обычный щелчок. */
  moved: boolean;
  overflowX: string;
  raf: number;
  settling: boolean;
};

type Options = {
  containerRef: RefObject<HTMLElement | null>;
  /** Порядок вкладок, которые можно переставлять (sessionId). */
  itemIds: string[];
  onReorder?: (id: string, toIndex: number) => void;
};

const clearStyles = (els: HTMLElement[]) => {
  for (const el of els) {
    el.style.transition = 'none';
    el.style.transform = '';
    el.style.zIndex = '';
    el.style.willChange = '';
    el.removeAttribute('data-dragging');
  }
  // Принудительная раскладка фиксирует «без сдвига» без анимации, после чего
  // переходы из классов снова работают.
  void els[0]?.offsetWidth;
  for (const el of els) el.style.transition = '';
};

export function useTabReorderDrag({ containerRef, itemIds, onReorder }: Options) {
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const dragRef = useRef<Drag | null>(null);
  const pendingResetRef = useRef<HTMLElement[] | null>(null);
  const idsKey = itemIds.join('|');

  // Порядок сменился: если это наша перестановка — снять сдвиги до отрисовки.
  // Если состав поменялся посреди перетаскивания (открыли/закрыли чат) —
  // перетаскивание отменяется, иначе замеры устарели.
  useLayoutEffect(() => {
    if (pendingResetRef.current) {
      clearStyles(pendingResetRef.current);
      pendingResetRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (drag && !drag.settling) {
      cancelAnimationFrame(drag.raf);
      clearStyles(drag.els);
      if (containerRef.current) containerRef.current.style.overflowX = drag.overflowX;
      dragRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!onReorder || !container) return undefined;

    let pending: Pending | null = null;
    let suppressClickUntil = 0;

    const tabFromEvent = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      if (target.closest('button')) return null; // крестик закрытия
      return target.closest<HTMLElement>('[data-reorder-id]');
    };

    const clearPending = () => {
      if (pending?.timer) window.clearTimeout(pending.timer);
      pending = null;
    };

    const frame = () => {
      const drag = dragRef.current;
      if (!drag || drag.settling) return;

      // Автопрокрутка у краёв полосы.
      const box = container.getBoundingClientRect();
      let speed = 0;
      if (drag.pointerX < box.left + EDGE) {
        speed = -MAX_AUTOSCROLL * Math.min(1, (box.left + EDGE - drag.pointerX) / EDGE);
      } else if (drag.pointerX > box.right - EDGE) {
        speed = MAX_AUTOSCROLL * Math.min(1, (drag.pointerX - (box.right - EDGE)) / EDGE);
      }
      if (speed !== 0) container.scrollLeft += speed;

      const { lefts, widths, from } = drag;
      const last = lefts.length - 1;
      let dx = drag.pointerX - drag.startX + (container.scrollLeft - drag.scrollStart);
      const minDx = lefts[0] - lefts[from];
      const maxDx = lefts[last] + widths[last] - (lefts[from] + widths[from]);
      dx = Math.max(minDx, Math.min(maxDx, dx));

      if (dx !== drag.lastDx) {
        drag.lastDx = dx;
        if (Math.abs(dx) > 3) drag.moved = true;
        drag.els[from].style.transform = `translate3d(${dx}px, 0, 0)`;

        const center = lefts[from] + widths[from] / 2 + dx;
        let target = from;
        while (target < last && center > lefts[target + 1] + widths[target + 1] / 2) target += 1;
        while (target > 0 && center < lefts[target - 1] + widths[target - 1] / 2) target -= 1;

        if (target !== drag.target) {
          drag.target = target;
          const w = widths[from];
          drag.els.forEach((el, i) => {
            if (i === from) return;
            const shift = from < i && i <= target ? -w : target <= i && i < from ? w : 0;
            el.style.transform = shift ? `translate3d(${shift}px, 0, 0)` : '';
          });
        }
      }

      drag.raf = requestAnimationFrame(frame);
    };

    const startDrag = (p: Pending, pointerX: number) => {
      const els = Array.from(container.querySelectorAll<HTMLElement>('[data-reorder-id]'));
      const from = els.findIndex((el) => el.dataset.reorderId === p.id);
      clearPending();
      if (from === -1 || els.length < 2) return;

      const box = container.getBoundingClientRect();
      const lefts: number[] = [];
      const widths: number[] = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        lefts.push(r.left - box.left + container.scrollLeft);
        widths.push(r.width);
      }

      // Пока тянем, полоса не прокручивается сама: иначе iOS, успевший признать
      // жест листанием, уводит полосу из-под пальца одновременно с перестановкой.
      // scrollLeft из кода (автопрокрутка у краёв) при этом работает.
      const overflowX = container.style.overflowX;
      container.style.overflowX = 'hidden';

      els.forEach((el, i) => {
        el.style.willChange = 'transform';
        if (i === from) {
          el.style.transition = 'box-shadow 150ms ease, background-color 150ms ease';
          el.style.zIndex = '20';
          el.setAttribute('data-dragging', 'true');
        } else {
          el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
        }
      });

      dragRef.current = {
        id: p.id,
        kind: p.kind,
        touchId: p.touchId,
        els,
        lefts,
        widths,
        from,
        target: from,
        startX: p.startX,
        pointerX,
        scrollStart: container.scrollLeft,
        lastDx: 0,
        moved: false,
        overflowX,
        raf: 0,
        settling: false,
      };
      if (p.kind === 'touch') navigator.vibrate?.(10);
      dragRef.current.raf = requestAnimationFrame(frame);
    };

    const drop = () => {
      const drag = dragRef.current;
      if (!drag || drag.settling) return;
      cancelAnimationFrame(drag.raf);
      container.style.overflowX = drag.overflowX;

      // Подержал и отпустил, не сдвинув, — это нажатие, чат должен открыться.
      if (!drag.moved && drag.target === drag.from) {
        clearStyles(drag.els);
        dragRef.current = null;
        return;
      }
      drag.settling = true;
      suppressClickUntil = performance.now() + 400;

      const { from, target, lefts, widths, els } = drag;
      const finalDx = target > from
        ? lefts[target] + widths[target] - (lefts[from] + widths[from])
        : lefts[target] - lefts[from];
      const dragged = els[from];
      dragged.style.transition = `transform ${SETTLE_MS}ms ${EASE}, box-shadow 150ms ease`;
      dragged.style.transform = finalDx ? `translate3d(${finalDx}px, 0, 0)` : '';
      dragged.removeAttribute('data-dragging');

      window.setTimeout(() => {
        dragRef.current = null;
        if (target !== from && onReorderRef.current) {
          pendingResetRef.current = els;
          onReorderRef.current(drag.id, target);
          // Страховка: если порядок почему-то не сменился, эффект не сработает.
          window.setTimeout(() => {
            if (pendingResetRef.current === els) {
              clearStyles(els);
              pendingResetRef.current = null;
            }
          }, 150);
        } else {
          clearStyles(els);
        }
      }, SETTLE_MS);
    };

    // ── Мышь и перо ──────────────────────────────────────────────────────
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0 || dragRef.current) return;
      const tab = tabFromEvent(event.target);
      if (!tab?.dataset.reorderId) return;
      clearPending();
      pending = { id: tab.dataset.reorderId, kind: 'mouse', startX: event.clientX, startY: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const drag = dragRef.current;
      if (drag?.kind === 'mouse') {
        drag.pointerX = event.clientX;
        return;
      }
      if (pending?.kind === 'mouse' && Math.abs(event.clientX - pending.startX) > MOUSE_SLOP) {
        startDrag(pending, event.clientX);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (dragRef.current?.kind === 'mouse') drop();
      else if (pending?.kind === 'mouse') clearPending();
    };

    // ── Палец ────────────────────────────────────────────────────────────
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || dragRef.current) {
        clearPending();
        return;
      }
      const tab = tabFromEvent(event.target);
      if (!tab?.dataset.reorderId) return;
      const touch = event.touches[0];
      clearPending();
      const p: Pending = {
        id: tab.dataset.reorderId,
        kind: 'touch',
        startX: touch.clientX,
        startY: touch.clientY,
        touchId: touch.identifier,
      };
      p.timer = window.setTimeout(() => {
        if (pending === p) startDrag(p, p.startX);
      }, LONG_PRESS_MS);
      pending = p;
    };
    const findTouch = (list: TouchList, id?: number) =>
      Array.from(list).find((t) => t.identifier === id) ?? null;
    const onTouchMove = (event: TouchEvent) => {
      const drag = dragRef.current;
      if (drag?.kind === 'touch') {
        if (event.cancelable) event.preventDefault(); // полоса не листается под пальцем
        const touch = findTouch(event.touches, drag.touchId);
        if (touch) drag.pointerX = touch.clientX;
        return;
      }
      if (pending?.kind === 'touch') {
        const touch = findTouch(event.touches, pending.touchId);
        if (!touch || Math.hypot(touch.clientX - pending.startX, touch.clientY - pending.startY) > TOUCH_SLOP) {
          clearPending(); // это листание, а не удержание
        }
      }
    };
    const onTouchEnd = () => {
      if (dragRef.current?.kind === 'touch') drop();
      else if (pending?.kind === 'touch') clearPending();
    };

    const onClickCapture = (event: MouseEvent) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onContextMenu = (event: Event) => {
      if (dragRef.current || pending?.kind === 'touch') event.preventDefault();
    };

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    container.addEventListener('click', onClickCapture, true);
    container.addEventListener('contextmenu', onContextMenu);

    return () => {
      clearPending();
      const drag = dragRef.current;
      if (drag && !drag.settling) {
        cancelAnimationFrame(drag.raf);
        clearStyles(drag.els);
        container.style.overflowX = drag.overflowX;
        dragRef.current = null;
      }
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('click', onClickCapture, true);
      container.removeEventListener('contextmenu', onContextMenu);
    };
    // Слушатели зависят от наличия onReorder и от того, отрисована ли полоса
    // (без вкладок её нет, контейнер появится позже); сам колбэк — через ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, Boolean(onReorder), itemIds.length > 0]);
}
