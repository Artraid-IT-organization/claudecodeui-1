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

type Restore = () => void;

// Номер пункта — как на экране: от `start` списка, с учётом `value` у пункта.
// Сам тег списка на время копирования убирается совсем: Telegram читает из
// «богатой» копии <ol> и дорисовывает свои номера поверх вставленных текстом —
// `list-style: none` его не останавливал, и вставка давала «1. 1.» (12.10.26).
// Плоские div такой разметки не дают ни в одном приложении.
const flattenOrderedLists = (range: Range, restores: Restore[]) => {
  // Перенос детей пункта в промежуточный div для движка — «удаление узла»:
  // он сам пересаживает границы диапазона на место бывшего списка, и выделение
  // сползало на весь список. Исходные границы запоминаем до перестановок
  // и после ставим заново: переехавшие узлы — те же самые.
  const startNode = range.startContainer;
  const startOffset = range.startOffset;
  const endNode = range.endContainer;
  const endOffset = range.endOffset;
  type Pair = { li: HTMLLIElement; item: HTMLDivElement; label: HTMLSpanElement };
  const flats: { ol: HTMLOListElement; container: HTMLDivElement; pairs: Pair[] }[] = [];
  const lists = Array.from(
    document.querySelectorAll<HTMLOListElement>(`[${MARKDOWN_ROOT_ATTR}] ol`),
  ).filter((ol) => range.intersectsNode(ol));
  lists.forEach((ol) => {
    const container = document.createElement('div');
    const pairs: Pair[] = [];
    let counter = ol.start || 1;
    const step = ol.reversed ? -1 : 1;
    Array.from(ol.childNodes).forEach((child) => {
      if (!(child instanceof HTMLLIElement)) {
        container.appendChild(child);
        return;
      }
      const li = child;
      if (li.hasAttribute('value')) counter = li.value;
      const item = document.createElement('div');
      while (li.firstChild) item.appendChild(li.firstChild);
      // Абзац пункта — это div, номер ставится внутрь него,
      // иначе номер окажется отдельной строкой над текстом.
      const first = item.firstElementChild;
      const host = first && first.tagName === 'DIV' && item.firstChild === first ? first : item;
      const label = document.createElement('span');
      label.textContent = `${counter}. `;
      host.insertBefore(label, host.firstChild);
      counter += step;
      container.appendChild(item);
      pairs.push({ li, item, label });
    });
    ol.replaceWith(container);
    flats.push({ ol, container, pairs });
    restores.push(() => {
      pairs.forEach(({ li, item, label }) => {
        label.remove();
        while (item.firstChild) li.appendChild(item.firstChild);
        item.replaceWith(li);
      });
      while (container.firstChild) ol.appendChild(container.firstChild);
      container.replaceWith(ol);
    });
  });
  if (flats.length === 0) return;
  // Границы, стоявшие на самих тегах списка или пункта (выделение «по блокам»),
  // пересадить на новые элементы — снятые узлы вне документа, иначе копия
  // обрывается. Если номер стал ребёнком пункта-обёртки (абзац — не div),
  // смещение больше нуля сдвигается на 1.
  const mapBoundary = (node: Node, offset: number): [Node, number] => {
    for (const { ol, container, pairs } of flats) {
      if (node === ol) return [container, offset];
      for (const { li, item, label } of pairs) {
        if (node === li) {
          const shift = item.firstChild === label ? 1 : 0;
          return [item, offset === 0 ? 0 : offset + shift];
        }
      }
    }
    return [node, offset];
  };
  const [sN, sO] = mapBoundary(startNode, startOffset);
  const [eN, eO] = mapBoundary(endNode, endOffset);
  range.setStart(sN, sO);
  range.setEnd(eN, eO);
  // Выделение пальцем или мышью от первой буквы пункта начинается правее
  // вставленного номера: если до начала выделения в пункте ничего нет —
  // захватить номер, иначе первый «1.» терялся.
  flats.forEach(({ pairs }) => pairs.forEach(({ label }) => {
    if (range.comparePoint(label, 0) >= 0) return;
    const gap = document.createRange();
    gap.setStartAfter(label);
    gap.setEnd(range.startContainer, range.startOffset);
    if (gap.toString().trim() === '') range.setStartBefore(label);
  }));
};

// Пометка «не проверено» (подчёркнутая фраза, Markdown.tsx) — только для глаз в
// чате. Егор копирует ответ дальше (списки, должности), и черта не должна уехать
// в Telegram или «Заметки» оформлением. На время копирования снимаем с фразы
// только стиль черты: узлы не переставляем — ими владеет React, ответ может ещё
// печататься.
const neutralizeUncertain = (range: Range, restores: Restore[]) => {
  document.querySelectorAll<HTMLElement>(`[${MARKDOWN_ROOT_ATTR}] .md-uncertain`).forEach((el) => {
    if (!range.intersectsNode(el)) return;
    const previous = el.style.textDecoration;
    el.style.textDecoration = 'none';
    restores.push(() => {
      el.style.textDecoration = previous;
    });
  });
};

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

const insertSpacers = (): { restores: Restore[]; selection: Selection; range: Range } | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0).cloneRange();
  const restores: Restore[] = [];
  document.querySelectorAll<HTMLElement>(`[${MARKDOWN_ROOT_ATTR}]`).forEach((root) => {
    if (!range.intersectsNode(root)) return;
    const blocks = Array.from(root.children).filter(
      (el) => !el.hasAttribute(SPACER_ATTR) && range.intersectsNode(el),
    );
    for (let i = 1; i < blocks.length; i += 1) {
      const spacer = makeSpacer();
      root.insertBefore(spacer, blocks[i]);
      restores.push(() => spacer.remove());
    }
  });
  flattenOrderedLists(range, restores);
  neutralizeUncertain(range, restores);
  if (restores.length > 0) reselect(selection, range);
  return { restores, selection, range };
};

const handleCopy = () => {
  let result: ReturnType<typeof insertSpacers> = null;
  try {
    result = insertSpacers();
  } catch {
    return;
  }
  if (!result || result.restores.length === 0) return;
  const { restores, selection, range } = result;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    restores.forEach((restore) => restore());
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
