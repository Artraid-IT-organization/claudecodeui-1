/**
 * Мост «кнопка в шапке → поле ввода».
 *
 * Шапка разговора (MainContentHeader) и поле ввода (ChatComposer внутри
 * ChatInterface) живут в разных ветках дерева, общего предка с состоянием
 * поля у них нет. Поэтому вставка текста идёт оконным событием — так же, как
 * CONTINUE_IN_PROVIDER_EVENT для «продолжить у другого помощника».
 *
 * Клик по сохранённому промпту шлёт событие с текстом; слушатель в
 * useChatComposerState вставляет его в поле в позицию курсора, ничего
 * не отправляет и оставляет фокус в поле за концом вставки.
 */

export const INSERT_COMPOSER_TEXT_EVENT = 'cloudcli:insert-composer-text';

/** Вызывается компонентами вне чата (меню промптов в шапке). */
export function insertComposerText(text: string): void {
  if (!text) return;
  window.dispatchEvent(new CustomEvent(INSERT_COMPOSER_TEXT_EVENT, { detail: { text } }));
}
