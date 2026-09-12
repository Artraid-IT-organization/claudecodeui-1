import { useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, Folder, FolderOpen, FolderPlus, FolderX } from 'lucide-react';

import { ActionMenu, type ActionMenuItem } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';

/**
 * Группа чата в шапке разговора. Встал на место переключателя пресетов.
 *
 * Зачем. Чатов сотни, и по датам не найти «тот разговор про школу». Здесь
 * человек одним нажатием кладёт чат в группу («SunSchool», «Сайт Claude»…) или
 * убирает его в архив. Сервер и сам раскладывает чаты по словам из названия, а
 * ручной выбор отсюда закрепляется и автоматикой больше не пересматривается.
 *
 * Порядок пунктов задан Егором: архив — первым, сверху; ниже группы, свежие
 * наверху. Список длинный, поэтому меню прокручивается внутри себя.
 */

type ChatGroup = {
  id: string;
  name: string;
  sessionCount: number;
};

type Props = {
  sessionId: string | null;
  /** Группа чата из списка слева — меняется, когда сервер разложил чат сам. */
  sessionGroupId?: string | null;
  onArchived?: (sessionId: string) => void;
  onRestored?: (sessionId: string) => void;
};

function chatsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return 'чатов';
  if (ones === 1) return 'чат';
  if (ones >= 2 && ones <= 4) return 'чата';
  return 'чатов';
}

async function readJson(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error || `ошибка ${response.status}`);
  return json;
}

export default function ChatGroupSelector({ sessionId, sessionGroupId, onArchived, onRestored }: Props) {
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [isArchived, setIsArchived] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    try {
      const json = await readJson(await api.chatGroups());
      setGroups(Array.isArray(json.groups) ? json.groups : []);
    } catch (error) {
      console.error('[groups] список групп не прочитан:', error);
    }
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  // Своё состояние чата спрашиваем у сервера: новый чат ещё не в списке слева,
  // а чат, открытый из архива, в нём и не появится.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setIsArchived(false);
    void (async () => {
      try {
        const json = await readJson(await api.sessionChatGroup(sessionId));
        if (cancelled) return;
        setGroupId(json.groupId ?? null);
        setIsArchived(Boolean(json.isArchived));
      } catch {
        // Чат ещё не записан на сервере (первое сообщение в пути) — это не ошибка.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (sessionGroupId !== undefined) setGroupId(sessionGroupId ?? null);
  }, [sessionGroupId]);

  if (!sessionId) return null;

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyKey(key);
    try {
      await action();
    } catch (error) {
      window.alert('Не получилось: ' + (error as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const assign = (nextGroupId: string | null) =>
    run(nextGroupId ?? '__none__', async () => {
      const previous = groupId;
      setGroupId(nextGroupId);
      try {
        await readJson(await api.setSessionChatGroup(sessionId, nextGroupId));
      } catch (error) {
        setGroupId(previous);
        throw error;
      }
      await loadGroups();
    });

  const archive = () =>
    run('__archive__', async () => {
      await readJson(await api.deleteSession(sessionId));
      setIsArchived(true);
      onArchived?.(sessionId);
    });

  const restore = () =>
    run('__archive__', async () => {
      await readJson(await api.restoreSession(sessionId));
      setIsArchived(false);
      onRestored?.(sessionId);
    });

  const createGroup = () => {
    const name = window.prompt('Название новой группы')?.trim();
    if (!name) return;
    void run('__new__', async () => {
      // Имя группы сразу служит словом для подбора: чаты с этим словом в
      // названии дальше будут попадать в неё сами.
      const json = await readJson(await api.createChatGroup(name, [name]));
      await readJson(await api.setSessionChatGroup(sessionId, json.group.id));
      setGroupId(json.group.id);
      await loadGroups();
    });
  };

  const current = groupId ? groups.find((group) => group.id === groupId) ?? null : null;

  const items: ActionMenuItem[] = [
    isArchived
      ? {
          key: '__archive__',
          label: 'Вернуть из архива',
          description: 'Чат снова появится в списке слева',
          icon: ArchiveRestore,
          loading: busyKey === '__archive__',
          onSelect: () => void restore(),
        }
      : {
          key: '__archive__',
          label: 'В архив',
          description: 'Убрать чат из списка слева',
          icon: Archive,
          loading: busyKey === '__archive__',
          onSelect: () => void archive(),
        },
    ...groups.map((group, index) => ({
      key: group.id,
      label: group.name,
      description: `${group.sessionCount} ${chatsWord(group.sessionCount)}`,
      icon: group.id === groupId ? FolderOpen : Folder,
      checked: group.id === groupId,
      loading: busyKey === group.id,
      showDividerBefore: index === 0,
      onSelect: () => void assign(group.id),
    })),
    {
      key: '__none__',
      label: 'Без группы',
      icon: FolderX,
      checked: groupId === null,
      loading: busyKey === '__none__',
      showDividerBefore: true,
      onSelect: () => void assign(null),
    },
    {
      key: '__new__',
      label: 'Новая группа…',
      icon: FolderPlus,
      loading: busyKey === '__new__',
      onSelect: createGroup,
    },
  ];

  const label = isArchived ? 'В архиве' : current?.name ?? 'Без группы';

  return (
    <ActionMenu
      label={label}
      items={items}
      icon={isArchived ? Archive : current ? FolderOpen : Folder}
      ariaLabel={`Группа чата: ${label}`}
      size="sm"
      variant="ghost"
      triggerClassName={
        isArchived
          ? 'h-7 max-w-[11rem] gap-1 px-2 text-xs text-amber-600 dark:text-amber-400 [&>span]:min-w-0 [&>span]:truncate'
          : 'h-7 max-w-[11rem] gap-1 px-2 text-xs text-muted-foreground hover:text-foreground [&>span]:min-w-0 [&>span]:truncate'
      }
      // Меню поверх всего, а не внутри шапки: иначе оно наследует
      // полупрозрачность шапки и на телефоне сливается с перепиской под ним.
      portal
      align="right"
      menuClassName="bg-background w-[260px]"
      onOpenChange={(open) => {
        if (open) void loadGroups();
      }}
    />
  );
}
