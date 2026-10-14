import { reportProviderProbe } from './providerProbe';
import { readSelectedProviderRaw, writeSelectedProvider } from '../utils/selectedProvider';

/** Событие выбора помощника для нового чата: из меню аккаунтов в поле ввода. */
export const SELECT_PROVIDER_EVENT = 'ccui:select-provider';

/**
 * Выбор в меню аккаунтов (а не синхронизация при открытии чата): открытый чат
 * другого помощника сменяется новым пустым чатом выбранного. Переписка не
 * переносится — каждый помощник держит свой список чатов (useServerScope).
 */
export const CONTINUE_IN_PROVIDER_EVENT = 'ccui:continue-in-provider';

/** Выбор помощника человеком в меню аккаунтов: запомнить и открыть его список. */
export type ChatProviderChoice = 'claude' | 'codex' | 'devin';

/**
 * localStorage-ключ подписки, выбранной в пикере; уходит серверу с каждым
 * ходом Devin — и в новом чате, и в открытом (история чата живёт в его линии,
 * платить за ход может любая подписка: devin-connections.service).
 */
const SELECTED_DEVIN_CONNECTION_KEY = 'selected-devin-connection';

/**
 * Выбрать помощника (claude / codex / devin) для следующего нового чата — так же, как
 * это делает выбор модели на пустом экране: запись в localStorage плюс событие
 * для уже открытого поля ввода.
 */
export function selectChatProvider(provider: ChatProviderChoice): void {
  reportProviderProbe('prov-select', { to: provider, was: readSelectedProviderRaw() ?? '' });
  writeSelectedProvider(provider);
  window.dispatchEvent(new CustomEvent(SELECT_PROVIDER_EVENT, { detail: provider }));
}

export function switchChatProvider(provider: ChatProviderChoice): void {
  selectChatProvider(provider);
  window.dispatchEvent(new CustomEvent(CONTINUE_IN_PROVIDER_EVENT, { detail: provider }));
}

/** Выбрать канал Devin для новых чатов: запоминает его и переключает помощника на Devin. */
export function selectDevinConnection(connectionId: number): void {
  localStorage.setItem(SELECTED_DEVIN_CONNECTION_KEY, String(connectionId));
  switchChatProvider('devin');
}

/** Канал, выбранный в пикере; null — сервер выбирает сам (первый годный по приоритету). */
export function readSelectedDevinConnectionId(): number | null {
  const id = Number(localStorage.getItem(SELECTED_DEVIN_CONNECTION_KEY));
  return id > 0 ? id : null;
}
