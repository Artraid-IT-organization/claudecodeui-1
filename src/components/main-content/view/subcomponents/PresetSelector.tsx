import { Sparkles, Wand2 } from 'lucide-react';

import { ActionMenu } from '../../../../shared/view/ui';
import { usePromptPresetsContext } from '../../../../contexts/PromptPresetsContext';

/**
 * Переключатель активного пресета в шапке разговора.
 *
 * Смысл — быстро сменить роль модели, не открывая никаких настроек. Кнопка
 * стоит рядом с заголовком; в раскрытом виде показывает список сохранённых
 * пресетов и опцию «без пресета» — это тот самый режим, где системный промпт
 * не меняется, всё как раньше.
 *
 * Компонент читает список из общего контекста и просто вызывает setActiveId;
 * логика хранения — в usePromptPresets.
 */
export default function PresetSelector() {
  const { presets, activeId, setActiveId } = usePromptPresetsContext();

  if (presets.length === 0) return null;

  const active = activeId ? presets.find((preset) => preset.id === activeId) ?? null : null;
  const label = active?.name ?? 'Без пресета';

  const items = [
    {
      key: '__none__',
      label: 'Без пресета',
      description: 'Обычный режим — системный промпт не меняется',
      onSelect: () => setActiveId(null),
    },
    ...presets.map((preset) => ({
      key: String(preset.id),
      label: preset.name,
      description: preset.systemPrompt.slice(0, 60) + (preset.systemPrompt.length > 60 ? '…' : ''),
      onSelect: () => setActiveId(preset.id),
    })),
  ];

  return (
    <ActionMenu
      label={label}
      items={items}
      icon={active ? Sparkles : Wand2}
      ariaLabel="Выбрать пресет промпта"
      size="sm"
      variant="ghost"
      triggerClassName="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      // Портал = меню рисуется в fixed-позиции поверх всего, а не внутри шапки:
      // без этого меню наследовало полупрозрачный backdrop-blur шапки и на
      // мобильном сливалось с текстом переписки под собой.
      portal
      align="right"
      menuClassName="bg-background"
    />
  );
}
