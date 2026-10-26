import { useTranslation } from 'react-i18next';
import { memo, useCallback, useLayoutEffect, useMemo } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatMessage } from '../../types/types';
import type {
  Project,
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
} from '../../../../types/app';
import { getIntrinsicMessageKey } from '../../utils/messageKeys';
import { groupWorkStretches, isWorkStretchItem } from '../../utils/workStretch';

import MessageComponent from './MessageComponent';
import ProviderSelectionEmptyState from './ProviderSelectionEmptyState';
import WorkStretchContainer from './WorkStretchContainer';
import ChatExportMenu from './ChatExportMenu';

interface ChatMessagesPaneProps {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  /** True while the viewed session has an active provider run in flight. */
  isProcessing?: boolean;
  /** True while ChatComposer's floating activity/stop tab is rendered above the input. */
  hasActivityIndicator?: boolean;
  chatMessages: ChatMessage[];
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (provider: LLMProvider) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  opencodeModel: string;
  setOpenCodeModel: (model: string) => void;
  devinModel: string;
  setDevinModel: (model: string) => void;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: Dispatch<SetStateAction<string>>;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  /** Подгрузить порцию старых сообщений — нажатие на строку «Показано N из M». */
  onLoadOlderMessages?: () => void;
  /** Сторож у верха ленты: пока он ближе экрана к краю, грузится следующая порция. */
  topSentinelRef?: (element: HTMLDivElement | null) => void;
  /** Запрос истории упал — вместо «Продолжить разговор» ошибка с повтором. */
  historyLoadError?: boolean;
  /** Категория ошибки загрузки (auth/denied/notfound/server/timeout/network). */
  historyLoadErrorKind?: string | null;
  onRetryHistoryLoad?: () => void;
  /** Номер разговора есть, а переписка на диске не сохранилась. */
  transcriptMissing?: boolean;
  totalMessages: number;
  /** Дотянуть всю переписку — нужно меню выгрузки, чтобы сохранить её целиком. */
  loadAllMessages: () => void;
  sessionMessagesCount: number;
  visibleMessages: ChatMessage[];
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  createDiff: any;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  showRawParameters?: boolean;
  showThinking?: boolean;
  /** «Вернуться сюда» под своим сообщением; не задан — кнопки нет. */
  onRewindToMessage?: (message: ChatMessage) => void;
  selectedProject: Project;
}

/**
 * Сколько последних сообщений всегда рисуются полностью.
 *
 * Три — это ответ, который печатается прямо сейчас, и пара соседей: у них
 * высота меняется на каждом кадре, а по ней лента решает, держаться ли низа.
 */
const LIVE_TAIL_SIZE = 3;

// Форма экрана загрузки чата сверху вниз: человек справа, ответ слева; числа —
// ширина строк в процентах. Настоящих сообщений ещё нет — рисуем типичный ритм.
const LOADING_SKELETON_BLOCKS: Array<{ side: 'user' | 'assistant'; lines: number[] }> = [
  { side: 'assistant', lines: [92, 78, 55] },
  { side: 'user', lines: [88, 46] },
  { side: 'assistant', lines: [95, 90, 84, 40] },
  { side: 'user', lines: [64] },
  { side: 'assistant', lines: [90, 72] },
];

function ChatMessagesPane({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  isProcessing = false,
  hasActivityIndicator = false,
  chatMessages,
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  claudeModel,
  setClaudeModel,
  cursorModel,
  setCursorModel,
  codexModel,
  setCodexModel,
  opencodeModel,
  setOpenCodeModel,
  devinModel,
  setDevinModel,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  isLoadingMoreMessages,
  hasMoreMessages,
  onLoadOlderMessages,
  topSentinelRef,
  historyLoadError = false,
  historyLoadErrorKind = null,
  onRetryHistoryLoad,
  transcriptMissing = false,
  totalMessages,
  loadAllMessages,
  sessionMessagesCount,
  visibleMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  onRewindToMessage,
  selectedProject,
}: ChatMessagesPaneProps) {
  const { t } = useTranslation('chat');
  // Вся работа между сообщением и ответом — одной свёрнутой строкой «Ход работы»,
  // как в Claude Code для VS Code; внутри — ключевые мысли и сделанные шаги.
  // Егор 13.09.26: «должно быть только то, что мне нужно знать в размышлениях и
  // то что он сделал, только нужные отчётности».
  const groupedVisibleMessages = useMemo(
    () => groupWorkStretches(visibleMessages),
    [visibleMessages],
  );

  // Stable, deterministic keys for the messages rendered this pass.
  //
  // `normalizedToChatMessages` rebuilds fresh ChatMessage objects on every store
  // update, so caching keys by object identity (or via a cross-render allocation
  // Set) minted a brand-new key for the *same* logical message on each prepend —
  // remounting the whole list, which disconnects the scroll-restore anchor and
  // reflows heights, jumping the viewport to the bottom. Deriving keys purely
  // from this render's ordered messages (intrinsic key, disambiguated by
  // occurrence index on collision) yields the same key for the same message
  // order, so React preserves existing DOM nodes and component state on prepend.
  const messageKeyMap = useMemo(() => {
    const keys = new WeakMap<ChatMessage, string>();
    const occurrences = new Map<string, number>();
    const assign = (message: ChatMessage) => {
      const intrinsicKey = getIntrinsicMessageKey(message) ?? 'message-generated';
      const seen = occurrences.get(intrinsicKey) ?? 0;
      occurrences.set(intrinsicKey, seen + 1);
      keys.set(message, seen === 0 ? intrinsicKey : `${intrinsicKey}__${seen}`);
    };
    for (const item of groupedVisibleMessages) {
      if (isWorkStretchItem(item)) {
        item.messages.forEach(assign);
      } else {
        assign(item);
      }
    }
    return keys;
  }, [groupedVisibleMessages]);

  const getMessageKey = useCallback(
    (message: ChatMessage) =>
      messageKeyMap.get(message) ?? getIntrinsicMessageKey(message) ?? 'message-generated',
    [messageKeyMap],
  );

  // Строку, которую браузер сейчас пропускает (content-visibility), помечаем —
  // CSS рисует на её месте заглушку, а не пустоту (index.css, `data-cv-skipped`).
  // Событие не всплывает — слушаем на перехвате. До отрисовки (layout), чтобы
  // не пропустить первое состояние строк, пришедших вместе с панелью.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const onState = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.classList?.contains('chat-message')) return;
      target.toggleAttribute('data-cv-skipped', Boolean((event as Event & { skipped?: boolean }).skipped));
    };
    container.addEventListener('contentvisibilityautostatechange', onState, true);

    // Сторож «либо заглушка, либо текст» (Егор 24.10.26). Метка ставится по
    // событию браузера, а событие может запоздать или не прийти (в Chromium
    // задержки до 250 мс, на iPhone проверить нечем) — тогда полосы остаются
    // под настоящим текстом. Строка в окне просмотра пропущенной быть не
    // может, поэтому метка на ней дольше HOLD_MS — устаревшая, и мы её снимаем.
    // Не трогаем: строки вне экрана (их метка законна) и строки в режиме
    // `visible` (живой хвост, прогрев) — у них метку держит прежнее состояние,
    // а полосы скрыты правилом CSS; снятая там метка потом оставила бы
    // перепропущенную строку пустой (браузер новое событие не шлёт).
    const HOLD_MS = 250;
    const visibleSince = new Map<HTMLElement, number>();
    const sweepStaleMarks = () => {
      if (document.hidden) return;
      const marked = container.querySelectorAll<HTMLElement>('.chat-message[data-cv-skipped]');
      if (marked.length === 0) {
        if (visibleSince.size > 0) visibleSince.clear();
        return;
      }
      const pane = container.getBoundingClientRect();
      const now = performance.now();
      const stillVisible = new Set<HTMLElement>();
      marked.forEach((message) => {
        const rect = message.getBoundingClientRect();
        if (rect.bottom <= pane.top || rect.top >= pane.bottom) return;
        if (getComputedStyle(message).contentVisibility !== 'auto') return;
        stillVisible.add(message);
        const since = visibleSince.get(message);
        if (since === undefined) {
          visibleSince.set(message, now);
        } else if (now - since >= HOLD_MS) {
          message.removeAttribute('data-cv-skipped');
          visibleSince.delete(message);
          stillVisible.delete(message);
        }
      });
      visibleSince.forEach((_, message) => {
        if (!stillVisible.has(message)) visibleSince.delete(message);
      });
    };
    const sweepTimer = window.setInterval(sweepStaleMarks, 120);
    return () => {
      container.removeEventListener('contentvisibilityautostatechange', onState, true);
      window.clearInterval(sweepTimer);
    };
  }, [scrollContainerRef]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className={`chat-messages-pane relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4 ${
        hasActivityIndicator ? 'pb-12 sm:pb-14' : 'pb-3 sm:pb-4'
      }`}
    >
      {chatMessages.length > 0 && (
        <div className="pointer-events-none sticky right-4 top-3 z-10 mb-2 flex justify-end sm:px-4">
          <div className="pointer-events-auto">
            <ChatExportMenu
              loadedCount={chatMessages.length}
              totalCount={totalMessages}
              sessionId={selectedSession?.id}
              onLoadAll={loadAllMessages}
              getMessages={() => chatMessages}
              sessionTitle={selectedSession?.summary || selectedSession?.name || selectedSession?.title}
            />
          </div>
        </div>
      )}
      <div className="chat-rows mx-auto w-full max-w-[54.25rem] space-y-3 px-4 sm:space-y-4">
      {historyLoadError && chatMessages.length === 0 ? (
        // Переписка не пришла (обрыв связи, перезапуск сайта). Раньше здесь
        // вставал «Продолжить разговор» — как будто чат пуст (Егор, 15.09.26).
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <p>
            {historyLoadErrorKind && historyLoadErrorKind !== 'unknown'
              ? t(`session.loading.failed_${historyLoadErrorKind}`, {
                  defaultValue: t('session.loading.failed'),
                })
              : t('session.loading.failed')}
          </p>
          <button
            type="button"
            onClick={onRetryHistoryLoad}
            disabled={isLoadingSessionMessages}
            className="mt-3 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {isLoadingSessionMessages ? t('session.loading.retrying') : t('session.loading.retry')}
          </button>
        </div>
      ) : isLoadingSessionMessages && chatMessages.length === 0 ? (
        // Открытие чата: на месте будущей переписки — переливающиеся блоки в
        // форме сообщений (Егор 24.10.26: «понимаешь, что идёт загрузка»).
        // Стоят у низа, как встанет настоящая лента, — ничего не «выстреливает».
        <div className="chat-loading-skeleton" role="status" aria-live="polite">
          <span className="sr-only">{t('session.loading.sessionMessages')}</span>
          {LOADING_SKELETON_BLOCKS.map((block, index) => (
            <div
              key={index}
              aria-hidden="true"
              // Имена целиком, не шаблоном: Tailwind вырезает из @layer правила
              // с классами, которых не нашёл в исходниках буквально.
              className={block.side === 'user'
                ? 'chat-loading-skeleton__item chat-loading-skeleton__item--user'
                : 'chat-loading-skeleton__item'}
            >
              {block.lines.map((width, lineIndex) => (
                <span key={lineIndex} className="chat-shimmer" style={{ width: `${width}%` }} />
              ))}
            </div>
          ))}
        </div>
      ) : isProcessing && chatMessages.length === 0 ? (
        <div className="mt-8 text-center text-gray-500 dark:text-gray-400">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-spin rounded-full border-b-2 border-gray-400" />
            <p>{t('session.loading.sessionMessages')}</p>
          </div>
        </div>
      ) : transcriptMissing && chatMessages.length === 0 ? (
        // Первый ход чата оборвался до записи переписки (15.09.26, перезапуск
        // сайта). Следующее сообщение начнёт разговор под тем же номером.
        <div className="mt-8 px-6 text-center text-gray-500 dark:text-gray-400">
          <p className="font-medium text-gray-700 dark:text-gray-200">{t('session.loading.transcriptMissingTitle')}</p>
          <p className="mt-2 text-sm">{t('session.loading.transcriptMissingDescription')}</p>
        </div>
      ) : chatMessages.length === 0 ? (
        <ProviderSelectionEmptyState
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          selectedProject={selectedProject}
          provider={provider}
          setProvider={setProvider}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          devinModel={devinModel}
          setDevinModel={setDevinModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
        />
      ) : (
        <>
          {hasMoreMessages && !allMessagesLoaded && (
            <div ref={topSentinelRef} aria-hidden="true" className="h-px w-full" />
          )}

          {/* Indicator showing there are more messages to load (hide when all loaded) */}
          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded && (
            // Строка нажимается: запасной путь, если прокрутить вверх нечем
            // или неудобно (Егор, 14.09.26: «прокрутка вверх не работает»).
            <button
              type="button"
              onClick={onLoadOlderMessages}
              className="block w-full border-b border-gray-200 py-2 text-center text-sm text-gray-500 hover:text-gray-700 dark:border-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {totalMessages > 0 && (
                <span>
                  {t('session.messages.showingOf', { shown: sessionMessagesCount, total: totalMessages })}{' '}
                  <span className="text-xs underline decoration-dotted underline-offset-2">{t('session.messages.scrollToLoad')}</span>
                </span>
              )}
            </button>
          )}

          {/* Место под ещё не догруженные ранние сообщения: листая вверх во
              время подгрузки, человек видит заглушку, а не пустоту. Высотой
              в экран — короткая первая порция не стоит прижатой к верху и не
              переезжает вниз, когда сверху приходит следующая. Не .chat-row:
              опорой useScrollAnchor она не бывает. */}
          {hasMoreMessages && !allMessagesLoaded && (
            <div
              className={isLoadingMoreMessages || isLoadingAllMessages ? 'chat-skeleton chat-skeleton--loading' : 'chat-skeleton'}
              aria-hidden="true"
            />
          )}

          {(() => {
            let prevMessage: ChatMessage | null = null;
            // Последние сообщения не «замораживаем»: в них идёт поток, высота
            // меняется каждый кадр, и подменять её оценкой нельзя — именно по
            // ней лента решает, держаться ли низа.
            const liveTailFrom = groupedVisibleMessages.length - LIVE_TAIL_SIZE;

            return groupedVisibleMessages.map((item, index) => {
              const rowClassName = index >= liveTailFrom ? 'chat-row chat-row--live' : 'chat-row';

              if (isWorkStretchItem(item)) {
                const stretchPrevMessage = prevMessage;
                prevMessage = item.messages[item.messages.length - 1] || prevMessage;

                return (
                  <div className={rowClassName} key={`work-stretch-${getMessageKey(item.messages[0])}`}>
                  <WorkStretchContainer
                    stretch={item}
                    prevMessage={stretchPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    selectedProject={selectedProject}
                    provider={provider}
                    sessionId={selectedSession?.id}
                    // Живой хвост — только у идущей сейчас работы: последняя
                    // строка ленты и чат ещё работает. Закончил — свёрнуто.
                    isLive={isProcessing && index === groupedVisibleMessages.length - 1}
                  />
                  </div>
                );
              }

              const messagePrevMessage = prevMessage;
              prevMessage = item;

              return (
                <div className={rowClassName} key={getMessageKey(item)}>
                <MessageComponent
                  message={item}
                  prevMessage={messagePrevMessage}
                  createDiff={createDiff}
                  onFileOpen={onFileOpen}
                  onShowSettings={onShowSettings}
                  onGrantToolPermission={onGrantToolPermission}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  onRewindToMessage={onRewindToMessage}
                  selectedProject={selectedProject}
                  provider={provider}
                  sessionId={selectedSession?.id}
                />
                </div>
              );
            });
          })()}
        </>
      )}
      </div>
    </div>
  );
}

export default memo(ChatMessagesPane);
