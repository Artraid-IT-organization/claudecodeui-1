/**
 * Пометка стенограмм чатов, рождённых на общем инстансе (cc2): каталог
 * `projects/<slug>--cc2`. Синхронизатор соседнего экземпляра такие
 * каталоги пропускает — чужой чат не всплывает в списке основного
 * Claude (Егор 25.10.26).
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  cc2BornProjectDirName,
  defaultProjectDirName,
  isCc2BornProjectDir,
} from '@/shared/utils.js';
import {
  isCc2BornTranscriptPath,
  resolveBornTranscriptDirName,
} from '@/modules/providers/list/claude/transcript-presence.js';

const PROMPTS_PATH = '/home/claude/prompts';
const SESSION_ID = 'a4661733-013f-4428-8c2b-cefbb03eed46';

async function withTempConfigDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-cc2-born-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('cc2-born transcript marker', () => {
  it('имя каталога: slug проекта + суффикс --cc2', () => {
    assert.equal(defaultProjectDirName(PROMPTS_PATH), '-home-claude-prompts');
    assert.equal(cc2BornProjectDirName(PROMPTS_PATH), '-home-claude-prompts--cc2');
    assert.equal(isCc2BornProjectDir('-home-claude-prompts--cc2'), true);
    assert.equal(isCc2BornProjectDir('-home-claude-prompts'), false);
    assert.equal(isCc2BornProjectDir('-home-claude-cc2'), false);
  });

  it('свежий чат пишется в помеченный каталог', async () => {
    await withTempConfigDir(async (configDir) => {
      const dirName = await resolveBornTranscriptDirName(configDir, PROMPTS_PATH, null);
      assert.equal(dirName, '-home-claude-prompts--cc2');
    });
  });

  it('продолжение пишет туда, где лежит файл: помеченный каталог', async () => {
    await withTempConfigDir(async (configDir) => {
      const dir = path.join(configDir, 'projects', '-home-claude-prompts--cc2');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), '{}\n');
      const dirName = await resolveBornTranscriptDirName(configDir, PROMPTS_PATH, SESSION_ID);
      assert.equal(dirName, '-home-claude-prompts--cc2');
    });
  });

  it('продолжение старого чата остаётся в обычном каталоге', async () => {
    await withTempConfigDir(async (configDir) => {
      const dir = path.join(configDir, 'projects', '-home-claude-prompts');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), '{}\n');
      const dirName = await resolveBornTranscriptDirName(configDir, PROMPTS_PATH, SESSION_ID);
      assert.equal(dirName, '-home-claude-prompts');
    });
  });

  it('синхронизатор отличает помеченные пути, включая вложенные subagents', () => {
    const home = path.join(path.sep, 'tmp', 'cfg');
    assert.equal(
      isCc2BornTranscriptPath(
        path.join(home, 'projects', '-home-claude-prompts--cc2', `${SESSION_ID}.jsonl`),
        home,
      ),
      true,
    );
    assert.equal(
      isCc2BornTranscriptPath(
        path.join(home, 'projects', '-home-claude-prompts--cc2', SESSION_ID, 'subagents', 'agent-1.jsonl'),
        home,
      ),
      true,
    );
    assert.equal(
      isCc2BornTranscriptPath(
        path.join(home, 'projects', '-home-claude-prompts', `${SESSION_ID}.jsonl`),
        home,
      ),
      false,
    );
    assert.equal(
      isCc2BornTranscriptPath(path.join(home, 'other', `${SESSION_ID}.jsonl`), home),
      false,
    );
  });
});
