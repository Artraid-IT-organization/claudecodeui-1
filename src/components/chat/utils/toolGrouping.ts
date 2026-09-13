import type { ChatMessage } from '../types/types';

// Одиночный вызов сворачивается так же, как группа.
//
// Раньше компактной строкой показывались только повторы от двух подряд, а
// одиночный Bash или Read разворачивался на пол-экрана вместе со своим вводом
// и выводом. В эталонной панели Клода любой вызов — это одна строка «→ Bash»,
// которую при желании разворачивают. Егор: «я вижу только то, что нужно».
export const TOOL_GROUP_THRESHOLD = 1;

export interface ToolGroupItem {
  _isGroup: true;
  toolName: string;
  messages: ChatMessage[];
  timestamp: ChatMessage['timestamp'];
}

export type MessageListItem = ChatMessage | ToolGroupItem;

export function isToolGroupItem(item: MessageListItem): item is ToolGroupItem {
  return '_isGroup' in item && (item as ToolGroupItem)._isGroup === true;
}

function isGroupableToolMessage(message: ChatMessage): message is ChatMessage & { toolName: string } {
  return Boolean(message.isToolUse && message.toolName && !message.isSubagentContainer);
}

/**
 * Блок размышления без единого слова внутри.
 *
 * Модель на подписке Егора своих размышлений не отдаёт: приходит только сам
 * факт «думал N секунд» и пустое содержимое. Такой блок в ленте — строка
 * «Думал несколько секунд», которую нечем развернуть. Егор 13.09.26: «это не
 * информативно, не вижу в этом смысла… чтобы лишней воды вообще не было».
 * То, что ИИ сейчас думает, показывает плашка над полем ввода, а не эти строки.
 */
export function isEmptyThinking(message: ChatMessage): boolean {
  return Boolean(message.isThinking && !String(message.content ?? '').trim());
}

// Messages that render nothing (reasoning hidden when showThinking is off, or an
// empty thinking block) shouldn't split an otherwise-continuous run of the same
// tool — providers interleave reasoning between consecutive tool calls.
function rendersNothing(message: ChatMessage, showThinking: boolean): boolean {
  return Boolean(message.isThinking && (!showThinking || isEmptyThinking(message)));
}

export function groupConsecutiveTools(
  messages: ChatMessage[],
  showThinking: boolean = true,
): MessageListItem[] {
  const items: MessageListItem[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (!isGroupableToolMessage(message)) {
      items.push(message);
      index += 1;
      continue;
    }

    const run: ChatMessage[] = [message];
    let nextIndex = index + 1;

    while (nextIndex < messages.length) {
      const candidate = messages[nextIndex];

      // Skip invisible interleaved messages so they don't break the run.
      if (rendersNothing(candidate, showThinking)) {
        nextIndex += 1;
        continue;
      }

      if (isGroupableToolMessage(candidate) && candidate.toolName === message.toolName) {
        run.push(candidate);
        nextIndex += 1;
        continue;
      }

      break;
    }

    if (run.length >= TOOL_GROUP_THRESHOLD) {
      items.push({
        _isGroup: true,
        toolName: message.toolName,
        messages: run,
        timestamp: message.timestamp,
      });
    } else {
      items.push(...run);
    }

    index = nextIndex;
  }

  return items;
}
