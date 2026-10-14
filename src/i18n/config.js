/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - Lazy-loading of translation namespaces
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
// eslint-disable-next-line import-x/order
import LanguageDetector from 'i18next-browser-languagedetector';

// Import translation resources
// Русский и английский грузятся статикой: ru — язык владельца по умолчанию,
// en — предохранитель fallbackLng, оба должны быть под рукой мгновенно.
// Остальные 9 языков (~460 КБ JSON суммарно) подтягиваются по требованию через
// ensureLanguage — раньше все 11 языков входили в стартовый бандл (14.10.26).
import enCommon from './locales/en/common.json';
import enSettings from './locales/en/settings.json';
import enAuth from './locales/en/auth.json';
import enSidebar from './locales/en/sidebar.json';
import enChat from './locales/en/chat.json';
import enCodeEditor from './locales/en/codeEditor.json';
// eslint-disable-next-line import-x/order
import enTasks from './locales/en/tasks.json';

import ruCommon from './locales/ru/common.json';
import ruSettings from './locales/ru/settings.json';
import ruAuth from './locales/ru/auth.json';
import ruSidebar from './locales/ru/sidebar.json';
import ruChat from './locales/ru/chat.json';
import ruCodeEditor from './locales/ru/codeEditor.json';
// eslint-disable-next-line import-x/order
import ruTasks from './locales/ru/tasks.json';

const LAZY_NAMESPACES = ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks'];

// Карта «язык → загрузчик семи пространств имён». Разные файлы грузим
// параллельно, чтобы переключение языка оставалось одним ожиданием.
const lazyLanguageLoaders = {
  fr: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/fr/${ns}.json`))),
  es: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/es/${ns}.json`))),
  ko: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/ko/${ns}.json`))),
  'zh-CN': () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/zh-CN/${ns}.json`))),
  ja: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/ja/${ns}.json`))),
  de: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/de/${ns}.json`))),
  tr: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/tr/${ns}.json`))),
  it: () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/it/${ns}.json`))),
  'zh-TW': () => Promise.all(LAZY_NAMESPACES.map((ns) => import(`./locales/zh-TW/${ns}.json`))),
};

// Import supported languages configuration
import { languages } from './languages.js';

// Get saved language preference from localStorage
// Language used when this browser has never chosen one. Russian, because this
// fork is run for a Russian-speaking owner: an English interface is the single
// biggest thing standing between him and the app. An explicit choice in
// Settings still wins and is remembered, so switching back is one click.
const DEFAULT_LANGUAGE = 'ru';

const getSavedLanguage = () => {
  try {
    const saved = localStorage.getItem('userLanguage');
    // Validate that the saved language is supported
    if (saved && languages.some(lang => lang.value === saved)) {
      return saved;
    }
    return DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
};

// Initialize i18next
i18n
  .use(LanguageDetector) // Detect user language
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Resources containing all translations
    // Resources containing all translations
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        auth: enAuth,
        sidebar: enSidebar,
        chat: enChat,
        codeEditor: enCodeEditor,
        tasks: enTasks,
      },
      ru: {
        common: ruCommon,
        settings: ruSettings,
        auth: ruAuth,
        sidebar: ruSidebar,
        chat: ruChat,
        codeEditor: ruCodeEditor,
        tasks: ruTasks,
      },
    },

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    // Russian first, English as the safety net: a key that has no Russian text
    // yet must show English words, not a bare key like "sidebar.pulse.title".
    fallbackLng: [DEFAULT_LANGUAGE, 'en'],

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      useSuspense: true, // Use Suspense for lazy-loading
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },

    // Detection options
    detection: {
      // Order of language detection (local storage first)
      order: ['localStorage'],

      // Keys to look for in localStorage
      lookupLocalStorage: 'userLanguage',

      // Cache user language
      caches: ['localStorage'],
    },
  });

// Догрузка языка по требованию: ресурсы ленивого языка приезжают сетью,
// после чего повторный changeLanguage перерисовывает уже с переводом.
// Запрос того же языка параллельно — дедуплицируем; гонку «сменил язык, пока
// грузился» закрывает проверка i18n.language перед повторным вызовом.
const languageLoads = new Map();
const ensureLanguage = (lng) => {
  const loader = lazyLanguageLoaders[lng];
  if (!loader || i18n.hasResourceBundle(lng, 'common')) return Promise.resolve();
  let task = languageLoads.get(lng);
  if (!task) {
    task = loader().then((modules) => {
      modules.forEach((mod, index) => {
        i18n.addResourceBundle(lng, LAZY_NAMESPACES[index], mod.default ?? mod, true, true);
      });
    }).finally(() => {
      languageLoads.delete(lng);
    });
    languageLoads.set(lng, task);
  }
  return task;
};

// Save language preference when it changes
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem('userLanguage', lng);
  } catch (error) {
    console.error('Failed to save language preference:', error);
  }
  void ensureLanguage(lng).then(() => {
    // Ресурсы приехали после фактической смены — переизбираем язык, чтобы
    // интерфейс перерисовался уже переведённым, а не fallback-текстами.
    if (i18n.language === lng && lazyLanguageLoaders[lng]) {
      void i18n.changeLanguage(lng);
    }
  });
});

// Сохранённый выбор мог быть ленивым языком — догружаем его сразу при старте.
void ensureLanguage(getSavedLanguage());

export default i18n;
