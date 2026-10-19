import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { checkSocksProxy, createMacStatusService } from '../mac-status.service.js';

describe('mac-status service', () => {
  let server: net.Server;
  let port: number;
  let statusFile: string;
  let service: ReturnType<typeof createMacStatusService>;

  beforeEach(async () => {
    // Поднимаем минимальный SOCKS5-заглушку.
    server = net.createServer((socket) => {
      socket.on('data', (data) => {
        if (data.length >= 3 && data[0] === 0x05 && data[1] === 0x01 && data[2] === 0x00) {
          socket.write(Buffer.from([0x05, 0x00]));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = (server.address() as net.AddressInfo).port;
    statusFile = path.join(os.tmpdir(), `mac-status-test-${Date.now()}.json`);
  });

  afterEach(() => {
    service?.stop();
    server.close();
    try {
      fs.unlinkSync(statusFile);
    } catch {
      // ignore
    }
  });

  it('detects a connected SOCKS5 proxy', async () => {
    const result = await checkSocksProxy({
      host: '127.0.0.1',
      port,
      checkSocks: true,
      connectTimeoutMs: 1000,
    });
    assert.equal(result.ok, true);
  });

  it('reports disconnected when port is closed', async () => {
    const result = await checkSocksProxy({
      host: '127.0.0.1',
      port: port + 1, // заведомо закрытый порт
      checkSocks: true,
      connectTimeoutMs: 200,
    });
    assert.equal(result.ok, false);
    assert.ok(result.details);
  });

  it('writes status file and tracks state transitions', async () => {
    service = createMacStatusService({
      host: '127.0.0.1',
      port,
      intervalMs: 100,
      statusFilePath: statusFile,
      checkSocks: true,
      connectTimeoutMs: 1000,
    });

    service.start();
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.equal(service.getStatus().connected, true);
    assert.equal(fs.existsSync(statusFile), true);

    const fileStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(fileStatus.connected, true);
    assert.equal(fileStatus.method, 'socks5-tunnel');
  });
});
