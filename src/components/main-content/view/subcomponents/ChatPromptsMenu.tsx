import { useCallback, useEffect, useState } from 'react';
import { FileText, Zap } from 'lucide-react';

import { ActionMenu, type ActionMenuItem } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';
import { insertComposerText } from '../../../chat/utils/composerInsert';

/**
 * Сохранённые промпты в шапке разговора — слева от группы чата.
 *
 * Зачем. Егор начинает многие чаты одним и тем же длинным текстом («Разбор
 * задачи» перед ссылкой на YouGile, инструкция «Промпт промптов»). Здесь это
 * одно нажатие: пункт вставляет полный текст в поле ввода — НЕ отправляет —
 * чтобы человек дописал своё (ссылку, уточнение) и отправил сам.
 *
 * Список читает сервер из файла saved-prompts.json рядом с базой инстанса;
 * «добавь промпт X» — одна правка файла, интерфейса редактирования нет.
 * Подгружаем список при каждом открытии: свежая правка файла видна сразу.
 *
 * На телефоне кнопка показывается ТОЛЬКО в новом чате (Егор 03.11.26):
 * там «Без группы» всё равно не появляется — пустой чат в группу не
 * положишь — а промпты человек вписывает именно в начале. Как только чат
 * завёлся, «Промпты» уступают место «Без группы». Признак телефона —
 * сенсорный указатель (pointer: coarse): у телефона в desktop-режиме
 * Safari/PWA вьюпорт широкий, и ширина не отличает его от компьютера.
 * Плюс у вызова в шапке рубеж по isMobile.
 */

type SavedPrompt = {
  name: string;
  text: string;
};

async function readJson(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error || `ошибка ${response.status}`);
  return json;
}

type Props = {
  /** Открыт ли уже существующий чат (не новый, не пустой). */
  hasSession: boolean;
};

export default function ChatPromptsMenu({ hasSession }: Props) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  // Телефон/планшет — coarse независимо от режима «десктопная версия сайта».
  const [isCoarsePointer, setIsCoarsePointer] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
  );

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = () => setIsCoarsePointer(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const loadPrompts = useCallback(async () => {
    try {
      const json = await readJson(await api.savedPrompts());
      setPrompts(Array.isArray(json.prompts) ? json.prompts : []);
    } catch (error) {
      console.error('[prompts] список промптов не прочитан:', error);
    }
  }, []);

  // На сенсорном устройстве при открытом чате места в шапке нет — там
  // работает «Без группы»; «Промпты» нужны телефону в новом чате.
  if (isCoarsePointer && hasSession) return null;

  const items: ActionMenuItem[] = prompts.length
    ? prompts.map((prompt, index) => ({
        key: `prompt-${index}`,
        label: prompt.name,
        icon: FileText,
        onSelect: () => insertComposerText(prompt.text),
      }))
    : [
        {
          key: '__empty__',
          label: 'Список пуст',
          description: 'Промпты лежат в saved-prompts.json рядом с базой сайта',
          disabled: true,
          onSelect: () => {},
        },
      ];

  return (
    <ActionMenu
      label="Промпты"
      items={items}
      icon={Zap}
      ariaLabel="Сохранённые промпты"
      size="sm"
      variant="ghost"
      className="inline-flex"
      triggerClassName="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      // Меню поверх всего, не внутри полупрозрачной шапки — как у группы чата.
      portal
      align="left"
      menuClassName="bg-background w-[260px]"
      onOpenChange={(open) => {
        if (open) void loadPrompts();
      }}
    />
  );
}
