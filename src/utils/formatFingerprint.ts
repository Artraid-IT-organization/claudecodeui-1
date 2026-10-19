/**
 * Порт fingerprint и доменного классификатора из референса
 * ~/response-format-memory (app/fingerprint.py, app/domain.py).
 *
 * Клиент считает их по тексту ответа перед PUT оценки: у боевого сервера
 * сообщений в базе нет (транскрипты — JSONL), поэтому domain и format_hash
 * приезжают в теле запроса и денормализуются в запись message_feedback.
 *
 * ВАЖНО: держать одинаковыми с референсом — hash сравнивается с будущими
 * выборками оптимизатора. Меняем формулу — меняем её в обоих местах.
 */

export type FormatFingerprint = {
  has_headings: boolean;
  heading_count: number;
  list_count: number;
  table_count: number;
  code_block_count: number;
  paragraph_count: number;
  tone: 'formal' | 'neutral';
  length_bucket: 'short' | 'medium' | 'long';
  word_count: number;
};

const HEADING_RE = /^#{1,6}\s+/;
const LIST_ITEM_RE = /^\s*(?:[-*+] |\d+[.)]\s)/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
// Python \w в UNICODE-режиме — буквы и цифры всех письменностей; JS \w — только ASCII.
const WORD_RE = /[\p{L}\p{N}_'-]+/gu;
const FORMAL_RE = /\b(?:therefore|consequently|следовательно|рекомендуется)\b/i;

export function extractFormatFingerprint(text: string): FormatFingerprint {
  const lines = text.split(/\r?\n/);
  const words = text.match(WORD_RE) ?? [];
  const headingCount = lines.filter((line) => HEADING_RE.test(line)).length;
  const listCount = lines.filter((line) => LIST_ITEM_RE.test(line)).length;
  const tableCount = lines.filter((line) => TABLE_ROW_RE.test(line)).length;
  const codeBlockCount = Math.floor((text.split('```').length - 1) / 2);
  const trimmed = text.trim();
  const paragraphCount = trimmed
    ? trimmed.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length
    : 0;
  const wordCount = words.length;
  const lengthBucket: FormatFingerprint['length_bucket'] =
    wordCount < 80 ? 'short' : wordCount < 300 ? 'medium' : 'long';
  return {
    has_headings: headingCount > 0,
    heading_count: headingCount,
    list_count: listCount,
    table_count: tableCount,
    code_block_count: codeBlockCount,
    paragraph_count: paragraphCount,
    tone: FORMAL_RE.test(text) ? 'formal' : 'neutral',
    length_bucket: lengthBucket,
    word_count: wordCount,
  };
}

/**
 * SHA-256 от канонического JSON fingerprint БЕЗ word_count — точное число слов
 * исключается, чтобы объединять ответы одной формы внутри length_bucket
 * (как fingerprint_hash в референсе).
 */
export async function formatFingerprintHash(fp: FormatFingerprint): Promise<string> {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(fp).sort()) {
    if (key === 'word_count') continue;
    canonical[key] = fp[key as keyof FormatFingerprint];
  }
  const payload = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Ключевые слова доменов — копия KEYWORDS из app/domain.py референса.
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  code: ['code', 'bug', 'api', 'python', 'javascript', 'код', 'ошибка', 'функция', 'тест', 'база данных'],
  business: ['business', 'revenue', 'sales', 'strategy', 'бизнес', 'выручка', 'продажи', 'стратегия', 'клиент'],
  writing: ['write', 'rewrite', 'article', 'copy', 'напиши', 'перепиши', 'текст', 'статья', 'письмо'],
  analytics: ['analyze', 'metric', 'trend', 'data', 'анализ', 'метрика', 'динамика', 'данные', 'отчёт'],
};

const TOKEN_RE = /[\p{L}\p{N}_-]+/gu;

/**
 * Tier-1 классификатор домена по словарю (правила, без LLM — как в референсе).
 * Референс классифицировал текст запроса; здесь классифицируется текст
 * ответа — у компонента сообщения запроса пользователя нет, а форма ответа
 * сама несёт доменные признаки (код-ответ содержит код-слова).
 */
export function classifyFormatDomain(text: string): string {
  const tokens = new Set((text.toLowerCase().match(TOKEN_RE) ?? []));
  let best = 'general';
  let bestScore = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const score = keywords.filter((k) => tokens.has(k)).length;
    if (score > bestScore) {
      bestScore = score;
      best = domain;
    }
  }
  return best;
}
