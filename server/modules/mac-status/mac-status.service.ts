/**
 * Мониторинг подключения MacBook через SSH SOCKS-туннель.
 *
 * MacBook запускает `ru-exit.command`, который поднимает динамический SSH-туннель
 * (-D 1080) к серверу. На сервере появляется SOCKS5-прокси на 127.0.0.1:1080.
 * Сервис каждые 10–15 секунд проверяет, жив ли прокси, пишет JSON-статус в файл
 * и рассылает обновления клиентам через SSE.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { Response } from 'express';

/** Снимок состояния подключения MacBook. */
export type MacStatus = {
  /** Есть ли живое SOCKS-соединение с MacBook прямо сейчас. */
  connected: boolean;
  /** ISO-время, с которого действует текущее состояние (подключения/отключения). */
  since: string;
  /** Способ подключения — всегда SOCKS5-туннель. */
  method: string;
  /** ISO-время последней проверки. */
  lastCheck: string;
  /** Причина неудачи проверки, если соединение потеряно. */
  details?: string;
};

/** Параметры проверки, читаемые из переменных окружения. */
export type MacStatusConfig = {
  /** Хост прокси (обычно 127.0.0.1). */
  host: string;
  /** Порт прокси (обычно 1080). */
  port: number;
  /** Период проверки в миллисекундах. */
  intervalMs: number;
  /** Путь к JSON-файлу, в который пишется статус для внешних скриптов. */
  statusFilePath: string;
  /** Проверять не только TCP-порт, но и SOCKS5-рукопожатие. */
  checkSocks: boolean;
  /** Таймаут TCP-соединения в миллисекундах. */
  connectTimeoutMs: number;
};

/** Результат одной попытки проверки прокси. */
export type MacStatusCheckResult = {
  ok: boolean;
  details?: string;
};

function defaultStatusFilePath(): string {
  return path.join(os.homedir(), '.cloudcli', 'macbook-status.json');
}

/**
 * Читает настройки мониторинга из переменных окружения.
 * Все значения имеют разумные дефолты, чтобы фича работала «из коробки»
 * для стандартного туннеля MacBook (127.0.0.1:1080).
 */
export function getMacStatusConfig(): MacStatusConfig {
  return {
    host: process.env.MAC_STATUS_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.MAC_STATUS_PORT || '1080', 10),
    intervalMs: Number.parseInt(process.env.MAC_STATUS_INTERVAL_MS || '15000', 10),
    statusFilePath: process.env.MAC_STATUS_FILE_PATH || defaultStatusFilePath(),
    checkSocks: process.env.MAC_STATUS_CHECK_SOCKS !== 'false',
    connectTimeoutMs: Number.parseInt(process.env.MAC_STATUS_CONNECT_TIMEOUT_MS || '5000', 10),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Проверяет, отвечает ли SOCKS5-прокси на заданном хосте/порту.
 * Делает TCP-соединение с таймаутом и, если checkSocks=true, шлёт минимальное
 * SOCKS5-рукопожатие без авторизации.
 */
export async function checkSocksProxy(config: Pick<MacStatusConfig, 'host' | 'port' | 'checkSocks' | 'connectTimeoutMs'>): Promise<MacStatusCheckResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      socket.removeAllListeners();
      socket.destroy();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ ok: false, details: 'connect timeout' });
    }, config.connectTimeoutMs);

    socket.once('error', (error) => {
      clearTimeout(timeout);
      cleanup();
      resolve({ ok: false, details: error.message });
    });

    socket.once('connect', () => {
      if (!config.checkSocks) {
        clearTimeout(timeout);
        cleanup();
        resolve({ ok: true });
        return;
      }
      // SOCKS5 greeting: ver 5, 1 method, no auth (0x00)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
      socket.once('data', (data) => {
        clearTimeout(timeout);
        cleanup();
        if (data.length >= 2 && data[0] === 0x05 && data[1] === 0x00) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, details: 'invalid socks5 handshake' });
        }
      });
    });

    socket.connect(config.port, config.host);
  });
}

/** Публичный контракт сервиса — используется роутами и server/index.ts. */
export type MacStatusService = {
  /** Текущий статус подключения. */
  getStatus(): MacStatus;
  /** Запустить периодические проверки. */
  start(): void;
  /** Остановить периодические проверки. */
  stop(): void;
  /** Подписать SSE-клиента на изменения статуса. */
  addSseClient(response: Response): void;
  /** Отписать SSE-клиента. */
  removeSseClient(response: Response): void;
};

/**
 * Создаёт сервис мониторинга MacBook.
 *
 * Сервис пишет статус в файл при каждой проверке (чтобы внешние скрипты видели
 * `lastCheck`), но логирует и рассылает SSE только при смене состояния.
 */
export function createMacStatusService(config: MacStatusConfig): MacStatusService {
  const method = 'socks5-tunnel';
  let currentStatus: MacStatus = {
    connected: false,
    since: nowIso(),
    method,
    lastCheck: nowIso(),
    details: 'initial',
  };

  let timer: NodeJS.Timeout | null = null;
  const sseClients = new Set<Response>();
  let isRunning = false;

  function broadcastStatus(): void {
    const payload = JSON.stringify(currentStatus);
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        // Клиент отключился во время записи — очистка произойдёт по событию close.
      }
    }
  }

  function updateStatus(next: MacStatus): void {
    const changed = currentStatus.connected !== next.connected;
    currentStatus = next;
    try {
      writeJsonFile(config.statusFilePath, next);
    } catch (error) {
      console.error('[mac-status] failed to write status file:', error);
    }
    if (changed) {
      const transition = next.connected
        ? `[mac-status] MacBook connected since ${next.since}`
        : `[mac-status] MacBook disconnected, last check ${next.lastCheck}`;
      console.log(transition, next.details || '');
      broadcastStatus();
    }
  }

  async function tick(): Promise<void> {
    const check = await checkSocksProxy(config);
    const lastCheck = nowIso();
    if (check.ok) {
      if (!currentStatus.connected) {
        updateStatus({ connected: true, since: lastCheck, method, lastCheck });
      } else {
        updateStatus({ ...currentStatus, lastCheck });
      }
    } else if (currentStatus.connected) {
      updateStatus({
        connected: false,
        since: currentStatus.since,
        method,
        lastCheck,
        details: check.details,
      });
    } else {
      updateStatus({ ...currentStatus, lastCheck, details: check.details });
    }
  }

  return {
    getStatus: () => currentStatus,
    start: () => {
      if (isRunning) return;
      isRunning = true;
      void tick();
      timer = setInterval(() => void tick(), config.intervalMs);
    },
    stop: () => {
      isRunning = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    addSseClient: (response) => {
      sseClients.add(response);
      response.on('close', () => {
        sseClients.delete(response);
      });
      response.write(`data: ${JSON.stringify(currentStatus)}\n\n`);
    },
    removeSseClient: (response) => {
      sseClients.delete(response);
    },
  };
}
