/**
 * Мониторинг подключения MacBook через SSH SOCKS-туннель.
 *
 * MacBook запускает `ru-exit.command`, который поднимает динамический SSH-туннель
 * (-D 1080) к серверу. На сервере появляется SOCKS5-прокси на 127.0.0.1:1080.
 * Сервис каждые 10–15 секунд проверяет, жив ли прокси, пишет JSON-статус в файл
 * и рассылает обновления клиентам через SSE.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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
  /** Разрешены ли поиски через текущий выход. */
  searchReady: boolean;
  /** Публичный IP выхода через MacBook. */
  exitIp?: string;
  /** Страна выхода в ISO-формате. */
  countryCode?: string;
  /** Обнаружен ли VPN на выходном IP. */
  isVpn?: boolean;
  /** Причина неудачи проверки или запрета поиска. */
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
  /** Ожидаемая страна выхода в ISO-формате. */
  expectedCountryCode: string;
  /** Endpoint, возвращающий публичный IP запроса. */
  exitIpUrl: string;
  /** Endpoint геолокации, к которому добавляется IP. */
  geoLookupUrl: string;
  /** Endpoint VPN-проверки, к которому добавляется IP. */
  vpnLookupUrl: string;
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
    expectedCountryCode: (process.env.MAC_STATUS_EXPECTED_COUNTRY || 'RU').toUpperCase(),
    exitIpUrl: process.env.MAC_STATUS_EXIT_IP_URL || 'https://api.ipify.org',
    geoLookupUrl: process.env.MAC_STATUS_GEO_LOOKUP_URL || 'https://api.ipapi.is/?q=',
    vpnLookupUrl: process.env.MAC_STATUS_VPN_LOOKUP_URL || 'https://api.vpndetection.io/',
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const execFileAsync = promisify(execFile);

type ExitQuality = {
  exitIp: string;
  countryCode: string;
  isVpn: boolean;
};

const exitQualityCache = new Map<string, Omit<ExitQuality, 'exitIp'>>();

async function checkExitQuality(config: Pick<MacStatusConfig, 'host' | 'port' | 'connectTimeoutMs' | 'expectedCountryCode' | 'exitIpUrl' | 'geoLookupUrl' | 'vpnLookupUrl'>): Promise<MacStatusCheckResult & Partial<ExitQuality>> {
  try {
    const timeoutSeconds = Math.max(1, Math.ceil(config.connectTimeoutMs / 1000));
    const proxy = `socks5h://${config.host}:${config.port}`;
    const { stdout: ipOutput } = await execFileAsync('curl', [
      '--silent', '--show-error', '--fail', '--max-time', String(timeoutSeconds), '--proxy', proxy, config.exitIpUrl,
    ]);
    const exitIp = ipOutput.trim();
    if (!net.isIP(exitIp)) return { ok: false, details: 'exit IP response is invalid' };

    let quality = exitQualityCache.get(exitIp);
    if (!quality) {
      const [{ stdout: geoOutput }, { stdout: vpnOutput }] = await Promise.all([
        execFileAsync('curl', ['--silent', '--show-error', '--fail', '--max-time', String(timeoutSeconds), `${config.geoLookupUrl}${encodeURIComponent(exitIp)}`]),
        execFileAsync('curl', ['--silent', '--show-error', '--fail', '--max-time', String(timeoutSeconds), `${config.vpnLookupUrl}${encodeURIComponent(exitIp)}`]),
      ]);
      const geo = JSON.parse(geoOutput) as { country?: string };
      const vpn = JSON.parse(vpnOutput) as { is_vpn?: boolean };
      const countryCode = geo.country === 'Russia' ? 'RU' : geo.country || '';
      if (!countryCode || typeof vpn.is_vpn !== 'boolean') {
        return { ok: false, exitIp, details: 'exit quality response is incomplete' };
      }
      quality = { countryCode, isVpn: vpn.is_vpn };
      exitQualityCache.set(exitIp, quality);
    }

    const ok = quality.countryCode === config.expectedCountryCode && !quality.isVpn;
    return {
      ok,
      exitIp,
      ...quality,
      details: ok ? undefined : quality.isVpn ? 'VPN detected' : `unexpected country: ${quality.countryCode}`,
    };
  } catch (error) {
    return { ok: false, details: error instanceof Error ? error.message : 'exit quality check failed' };
  }
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
export function createMacStatusService(
  config: MacStatusConfig,
  checks = { socks: checkSocksProxy, exit: checkExitQuality },
): MacStatusService {
  const method = 'socks5-tunnel';
  let currentStatus: MacStatus = {
    connected: false,
    since: nowIso(),
    method,
    lastCheck: nowIso(),
    searchReady: false,
    details: 'initial',
  };

  let timer: NodeJS.Timeout | null = null;
  const sseClients = new Set<Response>();
  let started = false;
  let checking = false;

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
    const changed = currentStatus.connected !== next.connected
      || currentStatus.searchReady !== next.searchReady
      || currentStatus.exitIp !== next.exitIp;
    currentStatus = next;
    try {
      writeJsonFile(config.statusFilePath, next);
    } catch (error) {
      console.error('[mac-status] failed to write status file:', error);
    }
    if (changed) {
      const transition = !next.connected
        ? `[mac-status] MacBook disconnected, last check ${next.lastCheck}`
        : next.searchReady
          ? `[mac-status] Russian exit ready: ${next.exitIp}`
          : `[mac-status] MacBook connected, search blocked: ${next.details}`;
      console.log(transition, next.details || '');
      broadcastStatus();
    }
  }

  async function tick(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const check = await checks.socks(config);
      const lastCheck = nowIso();
      if (!check.ok) {
        updateStatus({
          connected: false,
          since: currentStatus.connected ? lastCheck : currentStatus.since,
          method,
          lastCheck,
          searchReady: false,
          details: check.details,
        });
        return;
      }

      const quality = await checks.exit(config);
      const connectedSince = currentStatus.connected ? currentStatus.since : lastCheck;
      updateStatus({
        connected: true,
        since: connectedSince,
        method,
        lastCheck,
        searchReady: quality.ok,
        exitIp: quality.exitIp,
        countryCode: quality.countryCode,
        isVpn: quality.isVpn,
        details: quality.details,
      });
    } finally {
      checking = false;
    }
  }

  return {
    getStatus: () => currentStatus,
    start: () => {
      if (started) return;
      started = true;
      void tick();
      timer = setInterval(() => void tick(), config.intervalMs);
    },
    stop: () => {
      started = false;
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
