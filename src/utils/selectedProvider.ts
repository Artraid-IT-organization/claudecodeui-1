/**
 * Выбранный помощник (claude / devin / codex …) — СВОЙ у каждой вкладки.
 *
 * Зачем (Егор 14.10.26, Mac). Выбор жил один на весь браузер (localStorage), и
 * другие открытые окна сайта тут же перезаписывали его своим: в меню аккаунтов
 * Devin на миг включался и сам возвращался на Claude (зонд prov-storage: 4–5
 * «чужих» записей claude в ту же секунду после каждого выбора). На телефоне окно
 * одно — там всё работало.
 *
 * Теперь: читаем сначала выбор этой вкладки (sessionStorage), а общий
 * (localStorage) — только как стартовый для новой вкладки. Пишем в оба: новая
 * вкладка открывается с последним выбором, но чужая вкладка открытую уже не
 * перебивает.
 */
const KEY = 'selected-provider';

export function readSelectedProviderRaw(): string | null {
  try {
    const own = sessionStorage.getItem(KEY);
    if (own) return own;
  } catch {
    /* нет sessionStorage (тесты, приватный режим) — берём общий */
  }
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeSelectedProvider(provider: string): void {
  try {
    sessionStorage.setItem(KEY, provider);
  } catch {
    /* нет sessionStorage — остаётся общий */
  }
  try {
    localStorage.setItem(KEY, provider);
  } catch {
    /* нет localStorage — выбор живёт до перезагрузки */
  }
}
