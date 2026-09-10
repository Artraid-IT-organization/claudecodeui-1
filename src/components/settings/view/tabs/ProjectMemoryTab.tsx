import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Brain, Loader2 } from 'lucide-react';

import { Button, Input } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';
import type { SettingsProject } from '../../types/types';

/**
 * Память проекта: короткие выводы, которые агент видит в каждом новом разговоре.
 *
 * Здесь человек их читает, дописывает и убирает лишнее. Список намеренно
 * плоский и без поиска: если фактов станет столько, что понадобится поиск, —
 * это уже не память, а свалка, и лечится она прополкой, а не поиском.
 */
type Fact = {
  id: number;
  text: string;
  source: 'human' | 'agent';
  createdAt: string;
};

type Props = {
  projects: SettingsProject[];
};

export default function ProjectMemoryTab({ projects }: Props) {
  const [projectPath, setProjectPath] = useState<string>('');
  const [facts, setFacts] = useState<Fact[]>([]);
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // По умолчанию — первый проект в списке: чаще всего он и нужен.
  useEffect(() => {
    if (!projectPath && projects.length > 0) {
      const first = projects[0];
      setProjectPath(first.fullPath || first.path || '');
    }
  }, [projects, projectPath]);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ projectPath });
      const response = await authenticatedFetch(`/api/project-memory?${params.toString()}`);
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || 'не удалось прочитать');
      setFacts(Array.isArray(json?.facts) ? json.facts : []);
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать память');
      setFacts([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const text = draft.trim();
    if (!text || !projectPath) return;
    setError(null);
    try {
      const response = await authenticatedFetch('/api/project-memory', {
        method: 'POST',
        body: JSON.stringify({ projectPath, text, source: 'human' }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || 'не удалось запомнить');
      setDraft('');
      void load();
    } catch (err: any) {
      setError(err?.message || 'Не удалось запомнить');
    }
  };

  const remove = async (id: number) => {
    try {
      const params = new URLSearchParams({ projectPath });
      const response = await authenticatedFetch(`/api/project-memory/${id}?${params.toString()}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const json = await response.json();
        throw new Error(json?.error || 'не удалось удалить');
      }
      setFacts((prev) => prev.filter((item) => item.id !== id));
    } catch (err: any) {
      setError(err?.message || 'Не удалось удалить');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Brain className="h-4 w-4" />
          Память проекта
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Короткие выводы, которые агент видит в каждом новом разговоре по этому проекту.
          Не пересказ переписки, а то, что пригодится в следующий раз: как запускается сборка,
          чего не трогать, обо что уже спотыкались.
        </p>
      </div>

      {projects.length > 1 && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Проект</label>
          <select
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          >
            {projects.map((project) => {
              const value = project.fullPath || project.path || '';
              return (
                <option key={value} value={value}>
                  {project.displayName || value}
                </option>
              );
            })}
          </select>
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void add();
            }
          }}
          placeholder="Например: сборка запускается через npm run build"
          maxLength={500}
        />
        <Button onClick={() => void add()} disabled={!draft.trim()} className="flex-shrink-0 gap-1">
          <Plus className="h-4 w-4" />
          Запомнить
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {isLoading && facts.length === 0 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Читаю…
        </p>
      )}

      {!isLoading && facts.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          Пока пусто. Добавьте первый факт — и агент будет знать его в каждом новом разговоре.
        </p>
      )}

      <ul className="space-y-1">
        {facts.map((fact) => (
          <li
            key={fact.id}
            className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">{fact.text}</p>
              {fact.source === 'agent' && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">записал агент</p>
              )}
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => void remove(fact.id)}
              aria-label="Забыть"
              title="Забыть"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>

      {facts.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Всего {facts.length} из 200. Когда список заполнится, вытеснится то, чем ни разу
          не пользовались.
        </p>
      )}
    </div>
  );
}
