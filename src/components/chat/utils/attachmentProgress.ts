/*
  Проценты загрузки вложений чата (ITO-468). Без зависимостей от браузера —
  чтобы расчёт гонялся тестом в node. Сама загрузка — attachmentUpload.ts.

  Тело запроса одно на все файлы, поэтому проценты каждого файла считаем из
  общего числа отправленных байт: файлы идут в теле по порядку, так что первый
  доходит до конца раньше второго, а не все ползут одинаково.
*/

/** Ход загрузки: ключ — имя файла (как в fileErrors), значение — 0..99. */
export type AttachmentUploadProgress = Map<string, number>;

/**
 * 100% не показываем до ответа сервера: байты ушли, но файл ещё пишется на
 * диск. Карточка держит 99% и снимает затемнение только по готовому ответу.
 */
export const MAX_IN_FLIGHT_PERCENT = 99;

/**
 * Проценты каждого файла по общему числу отправленных байт.
 *
 * `total` из браузера больше суммы файлов: в него входят заголовки частей
 * multipart. Эту надбавку делим поровну между файлами — иначе последний файл
 * навсегда застревал бы ниже 99%, а первый «доходил» раньше, чем ушёл.
 */
export const computeAttachmentProgress = (
  files: ReadonlyArray<Pick<File, 'name' | 'size'>>,
  loaded: number,
  total: number,
): AttachmentUploadProgress => {
  const progress: AttachmentUploadProgress = new Map();
  if (files.length === 0) return progress;

  const sizes = files.map((file) => Math.max(0, file.size || 0));
  const payload = sizes.reduce((sum, size) => sum + size, 0);
  const overheadPerFile = total > payload ? (total - payload) / files.length : 0;
  let remaining = Math.max(0, loaded);

  files.forEach((file, index) => {
    const share = sizes[index] + overheadPerFile;
    const sent = Math.min(remaining, share);
    remaining -= sent;
    const percent = share > 0 ? Math.floor((sent / share) * 100) : 0;
    const clamped = Math.min(MAX_IN_FLIGHT_PERCENT, Math.max(0, percent));
    // Два файла с одинаковым именем делят одну строку карты — показываем
    // того, кто отстаёт, чтобы индикатор не погас раньше времени.
    const previous = progress.get(file.name);
    progress.set(file.name, previous === undefined ? clamped : Math.min(previous, clamped));
  });

  return progress;
};

/** Все файлы на старте загрузки — 0%, чтобы затемнение появилось сразу. */
export const startAttachmentProgress = (
  files: ReadonlyArray<Pick<File, 'name' | 'size'>>,
): AttachmentUploadProgress => computeAttachmentProgress(files, 0, 0);
