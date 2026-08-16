import { db } from "../db/index.js";
import { config } from "../config.js";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

const upsertConversation = db.prepare(`
  INSERT INTO conversations (user_id, display_name)
  VALUES (?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    display_name = COALESCE(excluded.display_name, conversations.display_name),
    updated_at   = datetime('now')
`);

const insertMessage = db.prepare(
  `INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)`,
);

const selectRecent = db.prepare(`
  SELECT role, content FROM messages
  WHERE user_id = ?
  ORDER BY id DESC
  LIMIT ?
`);

const selectDisplayName = db.prepare(
  `SELECT display_name FROM conversations WHERE user_id = ?`,
);

const markProcessed = db.prepare(
  `INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?)`,
);

const selectPhone = db.prepare(`SELECT phone FROM identities WHERE user_id = ?`);

const upsertPhone = db.prepare(`
  INSERT INTO identities (user_id, phone)
  VALUES (?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    phone = excluded.phone,
    shared_at = datetime('now')
`);

const readOffset = db.prepare(`SELECT offset FROM polling_state WHERE id = 1`);

const writeOffset = db.prepare(`
  INSERT INTO polling_state (id, offset) VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET offset = excluded.offset
`);

export function touchConversation(
  userId: string,
  displayName: string | null,
): void {
  upsertConversation.run(userId, displayName);
}

export function getDisplayName(userId: string): string | null {
  const row = selectDisplayName.get(userId) as
    | { display_name: string | null }
    | undefined;
  return row?.display_name ?? null;
}

export function appendMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
): void {
  insertMessage.run(userId, role, content);
}

/** Devuelve el historial en orden cronológico, acotado a HISTORY_TURNS. */
export function getHistory(userId: string): StoredMessage[] {
  const rows = selectRecent.all(userId, config.historyTurns * 2) as StoredMessage[];
  return rows.reverse();
}

/**
 * Devuelve true la primera vez que se ve un update_id y false en los
 * reintentos.
 */
export function claimUpdate(updateId: number): boolean {
  return markProcessed.run(updateId).changes > 0;
}

/** Teléfono que este usuario de Telegram compartió, si ya lo hizo. */
export function getPhoneFor(userId: string): string | null {
  const row = selectPhone.get(userId) as { phone: string } | undefined;
  return row?.phone ?? null;
}

export function rememberPhone(userId: string, phone: string): void {
  upsertPhone.run(userId, phone);
}

export function getPollingOffset(): number {
  const row = readOffset.get() as { offset: number } | undefined;
  return row?.offset ?? 0;
}

export function setPollingOffset(offset: number): void {
  writeOffset.run(offset);
}
