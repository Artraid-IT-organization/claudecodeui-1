/**
 * Voice transcripts repository.
 *
 * One row per client recording id (`rec_id`) per web user. The row appears
 * when the upload reaches `/api/voice/transcribe`, gets `text` after a
 * successful transcription, and keeps serving it to the client until the
 * client reports the transcript placed into the chat draft or the send queue
 * (`delivered_at`). Until then it is also the dedupe key for outbox retries:
 * a repeated upload of the same recording returns the stored text instead of
 * archiving and transcribing a second copy (12.10.26 the same 9.9 MB note was
 * uploaded, archived and pushed to Telegram twice after one network drop).
 *
 * Every read/write swallows its own errors like the rest of this layer:
 * transcript bookkeeping must never break the dictation request itself.
 */

import { getConnection } from '@/modules/database/connection.js';

export type VoiceTranscriptTarget = {
  recId: string;
  sessionId: string | null;
  scope: string | null;
  send: boolean;
};

export type StoredVoiceTranscript = VoiceTranscriptTarget & {
  text: string | null;
  createdAt: number;
};

type VoiceTranscriptRow = {
  rec_id: string;
  session_id: string | null;
  scope: string | null;
  send: number;
  text: string | null;
  created_at: number;
};

function toStored(row: VoiceTranscriptRow): StoredVoiceTranscript {
  return {
    recId: row.rec_id,
    sessionId: row.session_id,
    scope: row.scope,
    send: row.send !== 0,
    text: row.text,
    createdAt: row.created_at,
  };
}

export const voiceTranscriptsDb = {
  /** Returns the row for one recording, or null when the server never saw it. */
  get(recId: string, userId: number): StoredVoiceTranscript | null {
    try {
      const row = getConnection()
        .prepare('SELECT * FROM voice_transcripts WHERE rec_id = ? AND user_id = ?')
        .get(recId, userId) as VoiceTranscriptRow | undefined;
      return row ? toStored(row) : null;
    } catch {
      return null;
    }
  },

  /**
   * Remembers the upload and its delivery target. `send` is OR-ed in: a retry
   * carrying the flag must not let an earlier `0` row hide it, and the flag
   * itself can only be raised by the client before it uploads.
   */
  upsertReceived(target: VoiceTranscriptTarget, userId: number): void {
    try {
      getConnection()
        .prepare(
          `INSERT INTO voice_transcripts (rec_id, user_id, session_id, scope, send, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(rec_id, user_id) DO UPDATE SET
             session_id = COALESCE(excluded.session_id, voice_transcripts.session_id),
             scope = COALESCE(excluded.scope, voice_transcripts.scope),
             send = MAX(voice_transcripts.send, excluded.send)`,
        )
        .run(target.recId, userId, target.sessionId, target.scope, target.send ? 1 : 0, Date.now());
    } catch {
      /* bookkeeping must not break the upload */
    }
  },

  /** Stores the transcript once transcription succeeded. */
  setText(recId: string, userId: number, text: string): void {
    try {
      getConnection()
        .prepare('UPDATE voice_transcripts SET text = ? WHERE rec_id = ? AND user_id = ?')
        .run(text, recId, userId);
    } catch {
      /* same reason as above */
    }
  },

  /**
   * Transcripts the client has not confirmed yet and can actually route: only
   * rows that know their chat (session or draft scope) are returned - the
   * rest would sit in the inbox forever with nowhere to go.
   */
  listUndelivered(userId: number): StoredVoiceTranscript[] {
    try {
      const rows = getConnection()
        .prepare(
          `SELECT * FROM voice_transcripts
           WHERE user_id = ? AND delivered_at IS NULL AND TRIM(text) != ''
             AND (session_id IS NOT NULL OR scope IS NOT NULL)
           ORDER BY created_at`,
        )
        .all(userId) as VoiceTranscriptRow[];
      return rows.map(toStored);
    } catch {
      return [];
    }
  },

  /** Client reports the transcript reached its destination; the inbox closes. */
  markDelivered(recId: string, userId: number): void {
    try {
      getConnection()
        .prepare('UPDATE voice_transcripts SET delivered_at = ? WHERE rec_id = ? AND user_id = ?')
        .run(Date.now(), recId, userId);
    } catch {
      /* same reason as above */
    }
  },
};
