import { db } from "../db/index.js";
import { config } from "../config.js";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

const upsertConversation = db.prepare(`
  INSERT INTO conversations (phone, profile_name)
  VALUES (?, ?)
  ON CONFLICT (phone) DO UPDATE SET
    profile_name = COALESCE(excluded.profile_name, conversations.profile_name),
    updated_at   = datetime('now')
`);

const insertMessage = db.prepare(
  `INSERT INTO messages (phone, role, content) VALUES (?, ?, ?)`,
);

const selectRecent = db.prepare(`
  SELECT role, content FROM messages
  WHERE phone = ?
  ORDER BY id DESC
  LIMIT ?
`);

const selectProfile = db.prepare(
  `SELECT profile_name FROM conversations WHERE phone = ?`,
);

const markProcessed = db.prepare(
  `INSERT OR IGNORE INTO processed_messages (message_id) VALUES (?)`,
);

export function touchConversation(phone: string, profileName: string | null): void {
  upsertConversation.run(phone, profileName);
}

export function getProfileName(phone: string): string | null {
  const row = selectProfile.get(phone) as { profile_name: string | null } | undefined;
  return row?.profile_name ?? null;
}

export function appendMessage(
  phone: string,
  role: "user" | "assistant",
  content: string,
): void {
  insertMessage.run(phone, role, content);
}

/** Devuelve el historial en orden cronológico, acotado a HISTORY_TURNS. */
export function getHistory(phone: string): StoredMessage[] {
  const rows = selectRecent.all(phone, config.historyTurns * 2) as StoredMessage[];
  return rows.reverse();
}

/**
 * Devuelve true la primera vez que se ve un message_id y false en los
 * reintentos. Meta reenvía el webhook si no contestamos 200 rápido.
 */
export function claimMessage(messageId: string): boolean {
  return markProcessed.run(messageId).changes > 0;
}
