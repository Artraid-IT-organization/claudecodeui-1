import { authenticatedFetch } from '../../../utils/api';

// Зонд догрузки: строка в журнал сайта (`[catchup-probe]`) о каждой догрузке
// хвоста после возврата, переподключения или конца хода, о неудачах и о долгих
// запросах. Застывший экран на iPhone в эмуляторе не повторился (22.09.26) —
// причину ищем по данным с самого телефона. Не больше 40 строк за загрузку.
let catchupProbesLeft = 40;
export function reportCatchupProbe(entry: Record<string, string | number | boolean>) {
  const notable = entry.outcome === 'failed'
    || entry.outcome === 'unbridged'
    || Number(entry.ms) > 3_000
    || String(entry.reason) !== 'other';
  if (!notable || catchupProbesLeft <= 0) return;
  catchupProbesLeft -= 1;
  void authenticatedFetch('/api/user/catchup-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  }).catch(() => undefined);
}
