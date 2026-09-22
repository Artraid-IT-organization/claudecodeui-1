import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getClaudeConfigDir } from '@/shared/utils.js';

/**
 * Размер контекстного окна чата Claude.
 *
 * Порядок источников — как у ccstatusline (src/utils/model-context.ts) и в
 * документации строки состояния Claude Code (context_window.context_window_size:
 * «200000 by default, or 1000000 for models with extended context»):
 *   1. То, что сообщил сам Claude: итог ответа SDK несёт `modelUsage[модель].contextWindow`.
 *      Запоминаем по чату (файл рядом с базой), чтобы пережить перезапуск сайта.
 *   2. Пометка размера в имени модели: `sonnet[1m]`, `opus[1m]`. Для чата с моделью
 *      `default` — модель из settings.json папки Claude (там `opus[1m]`).
 *   3. Чат уже держал больше 200 000 (заполненность или «было» у сжатия) — окно 1 000 000.
 *   4. 200 000.
 * Раньше здесь стояло жёсткое 160 000: у чатов на 1 млн «Context window» был
 * меньше занятого (742 818 из 160 000, замер 22.09.26).
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

const STORE_LIMIT = 2000;

type StoredWindow = { contextWindow: number; model: string; at: number };

let cache: Record<string, StoredWindow> | null = null;

function storePath(): string {
  const dbPath = process.env.DATABASE_PATH;
  const dir = dbPath ? path.dirname(dbPath) : path.join(os.homedir(), '.cloudcli');
  return path.join(dir, 'claude-context-windows.json');
}

function load(): Record<string, StoredWindow> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Record<string, StoredWindow>;
    cache = raw && typeof raw === 'object' ? raw : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  const data = load();
  const keys = Object.keys(data);
  if (keys.length > STORE_LIMIT) {
    keys
      .sort((a, b) => data[a].at - data[b].at)
      .slice(0, keys.length - STORE_LIMIT)
      .forEach((key) => { delete data[key]; });
  }
  try {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error('[context-window] размер окна не сохранился:', error instanceof Error ? error.message : error);
  }
}

function baseModelId(model: string): string {
  return model.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

/**
 * Из итога ответа SDK (`result.modelUsage`) берёт окно той модели, что вела
 * разговор. В итог попадают и служебные модели (у сайта — Sonnet на 200 000
 * рядом с Opus на 1 000 000, проба 23.09.26), поэтому сверяемся с моделью
 * последнего ответа; не нашли — берём наибольшее окно.
 */
export function pickContextWindowFromModelUsage(
  modelUsage: unknown,
  mainModel?: string | null,
): { contextWindow: number; model: string } | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: unknown }>)
    .map(([model, usage]) => ({ model, contextWindow: Number(usage?.contextWindow) }))
    .filter((entry) => Number.isFinite(entry.contextWindow) && entry.contextWindow > 0);
  if (entries.length === 0) return null;
  if (mainModel) {
    const wanted = baseModelId(mainModel);
    const match = entries.find((entry) => baseModelId(entry.model) === wanted);
    if (match) return match;
  }
  return entries.reduce((best, entry) => (entry.contextWindow > best.contextWindow ? entry : best));
}

export function rememberContextWindow(sessionIds: Array<string | null | undefined>, contextWindow: number, model: string): void {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const data = load();
  let changed = false;
  for (const id of sessionIds) {
    if (!id) continue;
    const prev = data[id];
    if (prev && prev.contextWindow === contextWindow && prev.model === model) continue;
    data[id] = { contextWindow, model, at: Date.now() };
    changed = true;
  }
  if (changed) save();
}

export function getRememberedContextWindow(sessionIds: Array<string | null | undefined>): number | null {
  const data = load();
  for (const id of sessionIds) {
    if (id && data[id]) return data[id].contextWindow;
  }
  return null;
}

/** `[1m]`, `(200k)` в имени модели → число токенов (регулярка ccstatusline). */
export function contextWindowFromModelMarker(model: string | null | undefined): number | null {
  if (!model) return null;
  const match = /(?:\(|\[)\s*(\d+(?:[,_]\d+)*(?:\.\d+)?)\s*([km])\s*(?:\)|\])/i.exec(model);
  if (!match) return null;
  const value = Number.parseFloat(match[1].replace(/[,_]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000));
}

let settingsModelCache: { at: number; dir: string; model: string | null } | null = null;

/** Модель по умолчанию из settings.json папки Claude (ей работает чат с моделью `default`). */
export function readDefaultClaudeModel(): string | null {
  const dir = getClaudeConfigDir();
  if (settingsModelCache && settingsModelCache.dir === dir && Date.now() - settingsModelCache.at < 60_000) {
    return settingsModelCache.model;
  }
  let model: string | null = null;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as { model?: unknown };
    model = typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : null;
  } catch {
    model = null;
  }
  settingsModelCache = { at: Date.now(), dir, model };
  return model;
}

export function resolveClaudeContextWindow(input: {
  sessionIds: Array<string | null | undefined>;
  sessionModel?: string | null;
  maxObservedContext?: number;
}): number {
  const configured = Number.parseInt(process.env.CONTEXT_WINDOW ?? '', 10);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const remembered = getRememberedContextWindow(input.sessionIds);
  if (remembered) return remembered;

  const sessionModel = input.sessionModel && input.sessionModel !== 'default' ? input.sessionModel : null;
  const fromMarker = contextWindowFromModelMarker(sessionModel ?? readDefaultClaudeModel());
  if (fromMarker) return fromMarker;

  if ((input.maxObservedContext ?? 0) > DEFAULT_CONTEXT_WINDOW) return EXTENDED_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}
