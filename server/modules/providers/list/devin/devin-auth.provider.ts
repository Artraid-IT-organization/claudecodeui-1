import path from 'node:path';
import fsSync from 'node:fs';

import spawn from 'cross-spawn';

import { devinConnectionsDb } from '@/modules/database/index.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { getDevinDataDir, resolveDevinCliCommand } from '@/shared/utils.js';

/**
 * Auth facet for Devin CLI — теперь поверх Connection Layer.
 *
 * Креды живут по одному credentials.toml на канал
 * (`<devin_connections.xdg_data_home>/devin/credentials.toml`); legacy-канал
 * «default» указывает на машинный `~/.local/share` и покрывает старую
 * установку. Провайдер аутентифицирован, когда у ХОТЯ БЫ ОДНОГО годного канала
 * есть непустая креда; текст — имя канала, по которому работает провайдер.
 * Содержимое кред никогда не читается и не возвращается.
 */
export class DevinProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync(resolveDevinCliCommand(), ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
      });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    // Годные каналы: enabled, без auth_failed, без живого cooldown. Статус —
    // о том, есть ли у них креда вообще; живая проба — у админки каналов.
    const usable = devinConnectionsDb.list().filter(
      (conn) => conn.enabled
        && conn.health_status !== 'auth_failed'
        && this.checkCredentialsFile(path.join(conn.xdg_data_home, 'devin', 'credentials.toml')),
    );
    const legacyPath = path.join(getDevinDataDir(), 'credentials.toml');
    const hasLegacy = this.checkCredentialsFile(legacyPath);
    const hasCredentials = usable.length > 0 || hasLegacy;

    return {
      installed,
      provider: 'devin',
      authenticated: hasCredentials,
      email: usable[0]?.name ?? (hasLegacy ? 'default (machine credential)' : null),
      method: hasCredentials ? 'devin_cli' : null,
      error: hasCredentials
        ? undefined
        : installed ? 'Devin CLI not authenticated (no usable corporate connection)' : 'Devin CLI not installed',
    };
  }

  private checkCredentialsFile(credentialsPath: string): boolean {
    try {
      const stat = fsSync.statSync(credentialsPath);
      // An empty placeholder file counts as not authenticated.
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }
}
