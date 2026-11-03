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
 * На телефоне кнопки не видно вовсе. Прячем по сенсорному указателю
 * (pointer: coarse), а не только по ширине: в desktop-режиме Safari и на
 * PWA вьюпорт у телефона десктопный (≥768px), и одна медиа-ширина кнопку
 * показывала — она вытесняла из шапки «Без группы» и название чата
 * (Егор 03.11.26). Плюс hidden md:inline-flex как запасной рубеж и
 * !isMobile у вызова в шапке.
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

export default function ChatPromptsMenu() {
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

  if (isCoarsePointer) return null;

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
      className="hidden md:inline-flex"
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
