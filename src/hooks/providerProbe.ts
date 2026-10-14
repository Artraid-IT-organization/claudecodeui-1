// Зонд выбора помощника: строка в журнал сайта (`[catchup-probe]`, reason
// prov-*) о каждом переключении Claude/Devin/Codex — кто переключил, на что, при
// каком открытом чате. Егор 14.10.26 (Mac): выбор Devin в меню аккаунтов на миг
// включается и сам откатывается на Claude; у тестовой учётки не повторяется —
// причину ищем по данным с его браузера. Не больше 60 строк за загрузку.
// Модуль api подгружается лениво: зонд не тянет браузерные зависимости в тесты
// и ни при каких ошибках не мешает самому переключению.
let providerProbesLeft = 60;
export function reportProviderProbe(reason: string, fields: Record<string, string | number | boolean> = {}) {
  try {
    if (providerProbesLeft <= 0 || typeof window === 'undefined' || typeof document === 'undefined') return;
    providerProbesLeft -= 1;
    const body = JSON.stringify({
      reason,
      path: window.location.pathname.slice(0, 20),
      visible: document.visibilityState === 'visible',
      ...fields,
    });
    void import('../utils/api')
      .then(({ authenticatedFetch }) => authenticatedFetch('/api/user/catchup-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }))
      .catch(() => undefined);
  } catch {
    /* зонд — только наблюдение */
  }
}
