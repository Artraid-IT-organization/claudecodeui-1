import type { MutableRefObject, RefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';

export type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  sessionId: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  /** Имя окна командной строки: у каждого окна свой процесс на сервере. */
  terminalId?: string | null;
  forceRestart?: boolean;
};

export type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

export type ShellInputMessage = {
  type: 'input';
  data: string;
};

/**
 * Клиент шлёт сохранённое состояние экрана перед закрытием вкладки. Сервер
 * запомнит его в живой сессии; когда та же вкладка снова откроется, оно
 * применится первым сообщением — экран восстановится в точности как был.
 */
export type ShellSnapshotMessage = {
  type: 'snapshot';
  data: string;
};

export type ShellOutgoingMessage =
  | ShellInitMessage
  | ShellResizeMessage
  | ShellInputMessage
  | ShellSnapshotMessage;

export type ShellIncomingMessage =
  | { type: 'output'; data: string }
  /**
   * Снапшот экрана от сервера при возврате в живой PTY.
   * Приходит один раз в самом начале реплея — как «здесь и было».
   */
  | { type: 'snapshot'; data: string }
  | { type: 'auth_url'; url?: string }
  | { type: 'url_open'; url?: string }
  | { type: string; [key: string]: unknown };

export type UseShellRuntimeOptions = {
  selectedProject: Project | null | undefined;
  selectedSession: ProjectSession | null | undefined;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  /** Имя окна командной строки — у каждого свой процесс на сервере. */
  terminalId?: string | null;
  minimal: boolean;
  autoConnect: boolean;
  isRestarting: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

export type ShellSharedRefs = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  /** Сериализатор экрана — снимает снапшот перед закрытием вкладки. */
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
};

export type UseShellRuntimeResult = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  isConnected: boolean;
  isInitialized: boolean;
  isConnecting: boolean;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};
