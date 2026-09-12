import { useState } from 'react';
import { Check, Pencil, Plus, Trash2, Save, X } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { usePromptPresetsContext } from '../../../../contexts/PromptPresetsContext';
import type { PromptPreset } from '../../../../hooks/usePromptPresets';

/**
 * Редактор пресетов промптов.
 *
 * Простой список: имя и первые строчки системного промпта — сверху в списке,
 * форма редактирования — снизу под каждым, разворачивается по нажатию.
 * Спорить с обычным разделением «список слева, форма справа» не стал: на
 * телефоне такой разделитель некрасиво уезжает, а один поток вниз работает
 * везде одинаково. Три пресета «из коробки» правятся как обычные — они не
 * помечены системными, чтобы человек не боялся их менять.
 */
type EditingState = {
  id: number | 'new';
  name: string;
  systemPrompt: string;
};

function makeNewDraft(): EditingState {
  return { id: 'new', name: '', systemPrompt: '' };
}

export default function PromptPresetsTab() {
  const { presets, isLoading, error, create, update, remove, refresh, activeId, setActiveId } =
    usePromptPresetsContext();
  const activePreset = activeId ? presets.find((preset) => preset.id === activeId) ?? null : null;
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const startEdit = (preset: PromptPreset) =>
    setEditing({ id: preset.id, name: preset.name, systemPrompt: preset.systemPrompt });

  const startNew = () => setEditing(makeNewDraft());
  const cancel = () => {
    setEditing(null);
    setSaveError(null);
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setSaveError('Дайте пресету имя.');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      if (editing.id === 'new') {
        await create({ name: editing.name.trim(), systemPrompt: editing.systemPrompt });
      } else {
        await update(editing.id, {
          name: editing.name.trim(),
          systemPrompt: editing.systemPrompt,
        });
      }
      setEditing(null);
    } catch (err: any) {
      setSaveError(err?.message || 'Не удалось сохранить');
    } finally {
      setIsSaving(false);
    }
  };

  const del = async (preset: PromptPreset) => {
    // Не диалог, а прямое действие с последующим тостом-подтверждением было бы
    // жёсткое: пресеты копятся неделями. Держим окно подтверждения браузера.
    if (!window.confirm(`Удалить пресет «${preset.name}»?`)) return;
    try {
      await remove(preset.id);
      if (editing && editing.id === preset.id) setEditing(null);
    } catch (err) {
      window.alert('Не получилось удалить: ' + (err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Пресеты промптов</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Сохранённые «роли» модели. Включённый пресет добавляется к каждому сообщению.
            Сейчас включён: <span className="font-medium text-foreground">{activePreset?.name ?? 'ни один'}</span>.
          </p>
        </div>
        <Button onClick={startNew} size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          Новый пресет
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          {error}{' '}
          <button className="underline" onClick={() => void refresh()}>
            Повторить
          </button>
        </div>
      )}

      {editing && editing.id === 'new' && (
        <PresetForm
          state={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={cancel}
          isSaving={isSaving}
          saveError={saveError}
        />
      )}

      {isLoading && presets.length === 0 && (
        <p className="text-xs text-muted-foreground">Загружаю пресеты…</p>
      )}

      {presets.length === 0 && !isLoading && !editing && (
        <p className="text-sm text-muted-foreground">Пусто. Первый пресет заведите кнопкой «Новый пресет».</p>
      )}

      <ul className="space-y-2">
        {presets.map((preset) => {
          const isEditingThis = editing && editing.id === preset.id;
          return (
            <li
              key={preset.id}
              className="rounded-md border border-border bg-muted/30 p-3"
            >
              {isEditingThis ? (
                <PresetForm
                  state={editing}
                  onChange={setEditing}
                  onSave={save}
                  onCancel={cancel}
                  isSaving={isSaving}
                  saveError={saveError}
                />
              ) : (
                <div className="flex gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{preset.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {preset.systemPrompt || '(пустой промпт)'}
                    </p>
                  </div>
                  <div className="flex flex-shrink-0 items-start gap-1">
                    {/*
                      Раньше пресет включался в шапке разговора. Там теперь
                      группа чата, а включение переехало сюда — рядом с самим
                      пресетом, чтобы было видно, что именно включаешь.
                    */}
                    <Button
                      size="sm"
                      variant={preset.id === activeId ? 'default' : 'outline'}
                      onClick={() => setActiveId(preset.id === activeId ? null : preset.id)}
                      className="h-8 gap-1 px-2 text-xs"
                    >
                      {preset.id === activeId && <Check className="h-3.5 w-3.5" />}
                      {preset.id === activeId ? 'Включён' : 'Включить'}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => startEdit(preset)}
                      title="Редактировать"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => void del(preset)}
                      title="Удалить"
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type PresetFormProps = {
  state: EditingState;
  onChange: (state: EditingState) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  saveError: string | null;
};

function PresetForm({ state, onChange, onSave, onCancel, isSaving, saveError }: PresetFormProps) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-background p-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Имя</label>
        <Input
          value={state.name}
          onChange={(event) => onChange({ ...state, name: event.target.value })}
          placeholder="Например, «Ревью кода»"
          maxLength={60}
          autoFocus
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          Системный промпт
        </label>
        <textarea
          value={state.systemPrompt}
          onChange={(event) => onChange({ ...state, systemPrompt: event.target.value })}
          placeholder="Пример: отвечай коротко и по делу, показывай проблемы блоками…"
          rows={6}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Приписка к системному промпту Claude Code. Базовое поведение и инструменты сохраняются.
        </p>
      </div>
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isSaving}>
          <X className="mr-1 h-4 w-4" />
          Отмена
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>
          <Save className="mr-1 h-4 w-4" />
          {isSaving ? 'Сохраняю…' : 'Сохранить'}
        </Button>
      </div>
    </div>
  );
}
