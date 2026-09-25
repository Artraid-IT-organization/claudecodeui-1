/**
 * Пустая строка между абзацами при копировании ответа выделением.
 *
 * Абзацы ответа разделены только отступом (`mb-2.5`), а отступ в буфер обмена
 * не попадает: Егор выделял ответ на iPhone и вставлял в Telegram — жирный
 * сохранялся, а пункты слипались строка к строке (25.09.26: «чтобы внешне не
 * менялось, но при копировании копировалось с переносом строки»).
 *
 * Буфер не подменяем: так пропал бы жирный, который приложения берут из
 * «богатой» копии браузера, а она на iOS устроена по-своему. Вместо этого на
 * время самого копирования между выделенными блоками ставится пустая строка
 * `<div><br></div>` — ровно то, чем браузер сам обозначает пустую строку, — а
 * до ближайшей отрисовки она убирается. Браузер собирает копию синхронно после
 * обработчика `copy`, кадр рисуется позже, поэтому на экране ничего не
 * мелькает; нулевая высота — страховка на случай, если кадр всё же вклинится.
 *
 * Пустая строка ставится только между блоками верхнего уровня одного ответа
 * (абзац, заголовок, список, цитата, код, таблица) — там, где в исходной
 * разметке стоит пустая строка. Пункты одного списка идут, как и на экране,
 * подряд.
 */

export const MARKDOWN_ROOT_ATTR = 'data-md-copy-root';

const SPACER_ATTR = 'data-md-copy-spacer';

const makeSpacer = (): HTMLElement => {
  const spacer = document.createElement('div');
  spacer.setAttribute(SPACER_ATTR, '');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.height = '0';
  spacer.style.overflow = 'hidden';
  spacer.appendChild(document.createElement('br'));
  return spacer;
};

// Выделение после вставки строк надо поставить заново. Chrome числа границ
// сдвигает, но внутренний снимок выделения остаётся прежним и обрывает копию
// там, где раньше был его конец: из полного ответа в буфер попадала половина.
// Переустановка тем же отдельным Range снимок обновляет.
const reselect = (selection: Selection, range: Range) => {
  selection.removeAllRanges();
  selection.addRange(range);
};

const insertSpacers = (): { inserted: HTMLElement[]; selection: Selection; range: Range } | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0).cloneRange();
  const inserted: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(`[${MARKDOWN_ROOT_ATTR}]`).forEach((root) => {
    if (!range.intersectsNode(root)) return;
    const blocks = Array.from(root.children).filter(
      (el) => !el.hasAttribute(SPACER_ATTR) && range.intersectsNode(el),
    );
    for (let i = 1; i < blocks.length; i += 1) {
      const spacer = makeSpacer();
      root.insertBefore(spacer, blocks[i]);
      inserted.push(spacer);
    }
  });
  if (inserted.length > 0) reselect(selection, range);
  return { inserted, selection, range };
};

const handleCopy = () => {
  let result: ReturnType<typeof insertSpacers> = null;
  try {
    result = insertSpacers();
  } catch {
    return;
  }
  if (!result || result.inserted.length === 0) return;
  const { inserted, selection, range } = result;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    inserted.forEach((spacer) => spacer.remove());
    // Выделение человека остаётся ровно тем, что он выделил.
    try {
      reselect(selection, range);
    } catch {
      /* выделение уже сменилось — не трогаем */
    }
  };
  requestAnimationFrame(cleanup);
  // Вкладка в фоне не получает кадров — убрать и без них.
  setTimeout(cleanup, 100);
};

let installed = false;

export const installCopyParagraphBreaks = () => {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  // Захват: сработать раньше любых других обработчиков копирования.
  document.addEventListener('copy', handleCopy, true);
};
