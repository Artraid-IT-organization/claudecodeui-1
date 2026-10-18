// Service Worker for Claude UI PWA
// Cache only manifest (needed for PWA install). HTML and JS are never pre-cached
// so a rebuild + refresh always picks up the latest assets.
// Имя меняется вместе с любым изменением этого файла: браузер переустанавливает
// служебный кэш только когда сам файл стал другим побайтово. Установленное на
// экран «Домой» приложение месяц отдавало старую сборку именно поэтому.
const CACHE_NAME = 'claude-ui-v9';
const urlsToCache = [
  '/manifest.json'
];

/**
 * Заранее кладёт в кэш куски новой сборки.
 *
 * Замер холодного запуска по мобильной сети: 9,5 секунды до рабочего экрана,
 * из них почти всё — скачивание. А холодным он у Егора оказывается почти
 * всегда: каждая выкатка меняет имена файлов, и телефон честно тянет их
 * заново при первом же открытии.
 *
 * Поэтому новый служебный файл, устанавливаясь, сам читает свежую страницу,
 * достаёт из неё имена кусков и складывает их в кэш — в фоне, пока человек
 * ещё ничего не открыл. К моменту, когда он зайдёт, всё уже лежит на
 * телефоне, и открытие идёт из памяти.
 *
 * Ошибки здесь намеренно проглатываются: не сумели прогреть — просто
 * скачается при открытии, как раньше. Установку это блокировать не должно.
 */
function precacheBuild() {
  return fetch('/index.html', { cache: 'no-store', signal: timeoutSignal(60000) })
    .then(response => (response.ok ? response.text() : Promise.reject(new Error('нет страницы'))))
    .then(html => {
      const assets = [];
      const pattern = /(?:src|href)="(\/assets\/[^"]+)"/g;
      let found = pattern.exec(html);
      while (found) {
        assets.push(found[1]);
        found = pattern.exec(html);
      }
      if (assets.length === 0) return undefined;
      // Без повторов: стиль программы упомянут в странице дважды (preload +
      // подключение, 01.10.26), а addAll с одинаковыми адресами падает целиком.
      return caches.open(CACHE_NAME).then(cache => cache.addAll([...new Set(assets)]));
    })
    .catch(() => undefined);
}

// Install event
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => precacheBuild()),
  );
  self.skipWaiting();
});

const OFFLINE_PAGE_KEY = '/__last-good-page';
const NAV_TIMEOUT_MS = 4000;

/**
 * Предел времени на один поход в сеть.
 *
 * Разбор утечки 18.10.26: на маке служебный воркер разросся до 5 ГБ и жёг
 * процессор. Часть причины — запрос без потолка: на нестабильной связи
 * (мак без VPN) соединение могло висеть часами, а воркер всё это время
 * держал накопленный буфер ответа и не засыпал. Теперь каждый поход
 * обрывается по времени — буфер освобождается, воркер умирает по
 * расписанию браузера.
 */
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * Поход в сеть с одной повторной попыткой.
 *
 * Перезапуск службы занимает секунды, и одиночный запрос, попавший ровно в
 * это окно, раньше означал мёртвый экран. Одна пауза в полторы секунды
 * закрывает почти все такие случаи.
 */
function fetchWithRetry(request, timeoutMs) {
  const attempt = () => fetch(request, { signal: timeoutSignal(timeoutMs) });
  return attempt().catch(() =>
    new Promise(resolve => setTimeout(resolve, 1500)).then(attempt),
  );
}

/** Страница-заглушка, которая сама пробует подключиться заново. */
function retryingPage() {
  const html = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    '<title>Соединяюсь…</title>',
    '<style>',
    'html,body{height:100%;margin:0;background:#0b0b0c;color:#e7e7ea;',
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'div{height:100%;display:flex;flex-direction:column;align-items:center;',
    'justify-content:center;gap:14px;padding:24px;text-align:center}',
    'b{font-size:17px;font-weight:600}',
    'p{margin:0;color:#a1a1aa;max-width:22rem}',
    'button{margin-top:6px;padding:10px 18px;border:0;border-radius:10px;',
    'background:#3b82f6;color:#fff;font-size:15px}',
    '</style></head><body><div>',
    '<b>Соединяюсь с сервером…</b>',
    '<p>Связь пропала или сервер обновляется. Нажмите кнопку, чтобы повторить подключение.</p>',
    '<button onclick="location.reload()">Попробовать сейчас</button>',
    '</div>',
    '</body></html>',
  ].join('');
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Fetch event — network-first for everything except hashed assets
let stalePageRecoveryDone = false;

/**
 * Выбрасывает запомненную страницу и сообщает открытым вкладкам об обновлении.
 *
 * Вызывается, когда кусок сборки отдал 404 — верный признак, что страница, из
 * которой стартовали, осталась от снятой с сервера сборки. Вкладки нельзя
 * перезагружать через client.navigate(): этот вызов обходит защиту страницы и
 * на нестабильном пути Mac без VPN создаёт бесконечный цикл сбросов.
 */
function recoverFromStalePage() {
  if (stalePageRecoveryDone) {
    return Promise.resolve();
  }
  stalePageRecoveryDone = true;
  return caches.open(CACHE_NAME)
    .then(cache => cache.delete(OFFLINE_PAGE_KEY))
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(clients => clients.forEach(client => client.postMessage({ type: 'sw:stale-page' })))
    .catch(() => undefined);
}

/**
 * Дополнение к разбору утечки 18.10.26 (см. timeoutSignal выше).
 *
 * Раньше воркер перехватывал ВООБЩЕ всё, что не /api/ и не /ws/: чужие домены,
 * POST с телом, любые статические адреса. Каждый перехваченный ответ целиком
 * проходит буфером через процесс воркера — а оборванный или бесконечный запрос
 * (перезагрузка во время закачки, мёртвое соединение без VPN) оставлял этот
 * буфер висеть в памяти воркера. На iPhone воркер умирает в фоне за секунды и
 * накопить не успевает; на маке вкладка живёт часами — отсюда гигабайты.
 *
 * Теперь воркер берёт только то, ради чего он нужен: открытие страницы,
 * куски сборки и маленькая статика. Всё остальное браузер гоняет напрямую,
 * и воркер не участвует и не буферизует.
 */
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  const path = url.pathname;

  // Never intercept API requests or WebSocket upgrades
  if (path.startsWith('/api/') || path.startsWith('/ws')) {
    return;
  }

  // Открытие страницы: сеть, но с запасом и без тупика.
  //
  // Разбор аварии 09.09. Раньше здесь был ровно один поход в сеть, и если он
  // не удался — отдавалась намертво статичная страница «Offline» без единой
  // кнопки. Хуже всего, что попасть в неё было проще простого: при выкатке
  // служба перезапускается и секунд пять недоступна. То есть собственные
  // обновления выбивали Егора в мёртвый экран, и он оставался там, пока не
  // догадается перезагрузить вручную.
  //
  // Теперь три ступени: сеть → последняя удачная страница из кэша → страница,
  // которая сама повторяет попытку. Ни одна из них не оставляет человека
  // перед неподвижной надписью.
  if (event.request.mode === 'navigate') {
    // 26.09.26: сеть ждём не дольше NAV_TIMEOUT_MS. Раньше запрос страницы
    // висел без предела — на слабой мобильной связи до минуты, и всё это
    // время у Егора был чисто чёрный экран. Теперь через 4 с показываем
    // последнюю удачную страницу (она откроет приложение из памяти телефона
    // и сама подключится к серверу) или страницу «Соединяюсь…». Запрос в
    // сеть не бросаем: он дойдёт и запомнится для следующего открытия.
    // Navigation preload: браузер начинает грузить страницу ещё до старта
    // воркера — на медленном телефоне это до полусекунды из общего времени
    // открытия (паттерн из Workbox для network-first навигации). Если
    // прелоад не сработал или его нет — обычный поход с повтором.
    const goFetch = () => fetchWithRetry(request, 45000);
    const start = event.preloadResponse
      ? event.preloadResponse.then(r => r || goFetch(), goFetch)
      : goFetch();
    const network = start.then(response => {
      // Запоминаем последнюю удачную страницу: пригодится, пока сервер
      // перезапускается. Собранные куски (JS и стили) лежат в том же
      // кэше и берутся из него, поэтому пара «страница + куски» остаётся
      // согласованной.
      // Страницы-файлы (api-docs.html и т.п.) не запоминаем: они подменили
      // бы приложение в офлайн-заглушке. Запись дожидается через waitUntil —
      // иначе воркер может умереть до сохранения.
      if (response.ok && !/\.[a-z0-9]{2,5}$/i.test(path)) {
        const clone = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(OFFLINE_PAGE_KEY, clone)));
      }
      // Ошибка сервера (500/503 — окно рестарта при выкатке) показывает
      // последнюю удачную страницу вместо голой ошибки браузера.
      if (!response.ok) {
        return caches.match(OFFLINE_PAGE_KEY).then(cached => cached || response);
      }
      return response;
    });
    // Отказ кэша не должен вешать навигацию: без второго колбэка промис
    // respondWith не разрешался бы никогда — чёрный экран до убийства воркера.
    const fallback = () => caches.match(OFFLINE_PAGE_KEY).then(
      cached => cached || retryingPage(),
      () => retryingPage(),
    );
    event.waitUntil(network.catch(() => undefined));
    event.respondWith(new Promise(resolve => {
      let settled = false;
      const finish = response => { if (!settled) { settled = true; clearTimeout(timer); resolve(response); } };
      const timer = setTimeout(() => { fallback().then(finish); }, NAV_TIMEOUT_MS);
      network.then(finish, () => { fallback().then(finish); });
    }));
    return;
  }

  // Куски сборки (JS/CSS в /assets/) — сначала из кэша: имена содержат
  // отпечаток содержимого и меняются с каждой сборкой, поэтому устаревшим
  // ответ быть не может.
  //
  // Разбор белого экрана 11.09.26. Запомненная страница («последняя удачная»)
  // ссылается на куски ТОЙ сборки. После нескольких выкаток этих файлов на
  // сервере уже нет — сервер отвечает 404. Если человек загрузился из
  // запомненной страницы, приложению нечем запуститься, и он видит пустой
  // белый экран. Попасть туда легко: связь до сервера в США без VPN рвётся
  // чаще, а на каждый обрыв подставляется как раз запомненная страница.
  //
  // Поэтому 404 на кусок сборки трактуется как «страница протухла»: запись
  // выбрасывается, и вкладки перезагружаются — следующий заход пойдёт в сеть
  // и принесёт актуальную страницу. Один раз на запуск воркера, чтобы не
  // устроить круг перезагрузок.
  if (path.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request, { signal: timeoutSignal(120000) }).then(response => {
          if (response.status === 404) {
            return recoverFromStalePage().then(() => response);
          }
          // В кэш — только полноценный ответ: раньше 500-я или редирект
          // ложились навсегда и отдавались из памяти вместо живого файла.
          if (response.ok) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, clone)));
          }
          return response;
        });
      })
    );
    return;
  }

  // Маленькая статика (шрифты, иконки, манифест) — из кэша с фоновым
  // обновлением: имена без отпечатка содержимого, поэтому чистый cache-first
  // отдавал бы заменённую иконку вечно. Личный манифест (?enter=<токен>)
  // не кэшируем — сервер отдаёт его с no-store и логин-токеном в start_url,
  // осевший токен в кэше = протухшая ссылка входа навсегда.
  const isSmallStatic =
    path.startsWith('/fonts/') ||
    path.startsWith('/icons/') ||
    (path === '/manifest.json' && url.search === '') ||
    path === '/favicon.png' ||
    path === '/favicon.svg' ||
    path === '/logo.svg' ||
    path === '/logo-128.png' ||
    path === '/logo-256.png';
  if (isSmallStatic) {
    event.respondWith(
      caches.match(request).then(cached => {
        const update = fetch(request, { signal: timeoutSignal(30000) }).then(response => {
          if (response.ok) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, clone)));
          }
          return response;
        });
        if (cached) {
          event.waitUntil(update.catch(() => undefined));
          return cached;
        }
        return update;
      })
    );
    return;
  }

  // Всё прочее воркер не трогает: без respondWith браузер обслуживает запрос
  // напрямую, и ответ не буферизуется в процессе воркера.
});

// Activate event — purge old caches
self.addEventListener('activate', event => {
  // Страница начинает грузиться параллельно с запуском воркера.
  if (self.registration.navigationPreload) {
    event.waitUntil(self.registration.navigationPreload.enable().catch(() => undefined));
  }
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      )
    )
  );
  event.waitUntil(self.clients.claim().then(() =>
    self.clients.matchAll({ type: 'window' }).then(clients => {
      // Страница, оставшаяся от прошлой сборки, сама себя перезагрузит:
      // на телефоне закрыть и открыть приложение бывает недостаточно.
      clients.forEach(client => client.postMessage({ type: 'sw:updated' }));
    })
  ));
});

// Push notification event
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Claude UI', body: event.data.text() };
  }

  const options = {
    body: payload.body || '',
    icon: '/logo-256.png',
    badge: '/logo-128.png',
    data: payload.data || {},
    tag: payload.data?.tag || `${payload.data?.sessionId || 'global'}:${payload.data?.code || 'default'}`,
    renotify: true
  };

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Claude UI', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const sessionId = event.notification.data?.sessionId;
  const provider = event.notification.data?.provider || null;
  const urlPath = sessionId ? `/session/${sessionId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin)) {
          await client.focus();
          client.postMessage({
            type: 'notification:navigate',
            sessionId: sessionId || null,
            provider,
            urlPath
          });
          return;
        }
      }
      return self.clients.openWindow(urlPath);
    })
  );
});
