import { BookOpen, Brain, Hourglass, PenLine, Rocket, Send, Users, WifiOff, Wrench, type LucideIcon } from 'lucide-react';

/*
 * Значок и цвет фазы работы чата — одни и те же в плашке над полем ввода и во
 * вкладках открытых чатов. Егор: «всегда в первую очередь понимать, думает ли
 * чат» — и в открытом, и в соседних вкладках. «Думает» узнаётся по фиолетовому
 * мозгу, «пишет ответ» — по зелёному перу, работа инструмента — по ключу.
 */
export const PHASE_ICONS: Record<string, LucideIcon> = {
  thinking: Brain,
  writing: PenLine,
  tool: Wrench,
  agents: Users,
  waiting: Hourglass,
  reconnecting: WifiOff,
  starting: Rocket,
  requesting: Send,
  reading: BookOpen,
};

export const PHASE_TONES: Record<string, string> = {
  thinking: 'text-violet-600 dark:text-violet-400',
  writing: 'text-emerald-600 dark:text-emerald-400',
  tool: 'text-sky-600 dark:text-sky-400',
  agents: 'text-sky-600 dark:text-sky-400',
  waiting: 'text-muted-foreground',
  reconnecting: 'text-amber-600 dark:text-amber-400',
  starting: 'text-muted-foreground',
  requesting: 'text-indigo-500 dark:text-indigo-400',
  reading: 'text-sky-600 dark:text-sky-400',
};

/** Короткая подпись фазы для подсказки на вкладке. */
export const PHASE_SHORT_LABELS: Record<string, string> = {
  thinking: 'Думает',
  writing: 'Пишет ответ',
  tool: 'Работает',
  agents: 'Работают агенты',
  waiting: 'Ожидает модель',
  reconnecting: 'Связь восстанавливается',
  starting: 'Запускаю чат',
  requesting: 'Модель получила запрос',
  reading: 'Модель читает результат',
};
