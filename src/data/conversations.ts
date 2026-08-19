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
  `INSERT OR IGNORE INTO processed_updates (update_id, done) VALUES (?, 0)`,
);

const markDone = db.prepare(
  `UPDATE processed_updates SET done = 1 WHERE update_id = ?`,
);

const dropClaim = db.prepare(`DELETE FROM processed_updates WHERE update_id = ?`);

const dropUnfinished = db.prepare(`DELETE FROM processed_updates WHERE done = 0`);

const selectPhone = db.prepare(`SELECT phone FROM identities WHERE user_id = ?`);

const upsertPhone = db.prepare(`
  INSERT INTO identities (user_id, phone)
  VALUES (?, ?)
  ON CONFLICT (user_id) DO UPDATE SET
    phone = excluded.phone,
    shared_at = datetime('now')
`);

const deleteMessages = db.prepare(`DELETE FROM messages WHERE user_id = ?`);

const deleteIdentity = db.prepare(`DELETE FROM identities WHERE user_id = ?`);

const readFailures = db.prepare(
  `SELECT failures FROM link_attempts WHERE user_id = ?`,
);

const bumpFailures = db.prepare(`
  INSERT INTO link_attempts (user_id, failures) VALUES (?, 1)
  ON CONFLICT (user_id) DO UPDATE SET
    failures   = link_attempts.failures + 1,
    updated_at = datetime('now')
`);

const resetFailures = db.prepare(`DELETE FROM link_attempts WHERE user_id = ?`);

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
 * Aparta un update para atenderlo. Devuelve true la primera vez que se ve y
 * false en los reintentos.
 *
 * Apartar no es lo mismo que haberlo contestado: eso lo marca `finishUpdate`.
 * La diferencia importa porque un update apartado y nunca terminado —el
 * proceso se murió a media respuesta— tiene que poder atenderse cuando
 * Telegram lo reentregue, en vez de quedar descartado para siempre como
 * "duplicado".
 */
export function claimUpdate(updateId: number): boolean {
  return markProcessed.run(updateId).changes > 0;
}

/** El update ya se atendió: los reintentos de Telegram se pueden descartar. */
export function finishUpdate(updateId: number): void {
  markDone.run(updateId);
}

/**
 * Suelta el update para que la reentrega lo vuelva a intentar.
 *
 * Se usa cuando atenderlo falló de un modo del que sí se puede volver: si no
 * se soltara, el cliente se quedaría sin respuesta y su mensaje contaría como
 * ya contestado.
 */
export function releaseUpdate(updateId: number): void {
  dropClaim.run(updateId);
}

/**
 * Al arrancar: lo que quedó apartado sin terminar es de la corrida anterior,
 * que se murió a media respuesta. Se suelta para que la reentrega se atienda.
 *
 * Dentro de una misma corrida esto no se toca: ahí un update apartado sí es
 * un mensaje que se está atendiendo en este momento.
 */
export function releaseUnfinishedUpdates(): number {
  return dropUnfinished.run().changes;
}

/** Teléfono que este usuario de Telegram compartió, si ya lo hizo. */
export function getPhoneFor(userId: string): string | null {
  const row = selectPhone.get(userId) as { phone: string } | undefined;
  return row?.phone ?? null;
}

export function rememberPhone(userId: string, phone: string): void {
  upsertPhone.run(userId, phone);
}

/**
 * Usuarios de Telegram cuyo teléfono coincide con alguno de los dados.
 *
 * La comparación es sobre los últimos 10 dígitos, igual que en el CRM: el
 * número guardado viene de Telegram en E.164 y el del CRM está capturado a
 * mano en formatos variados.
 */
export function getTelegramIdsForPhones(phones: string[]): string[] {
  if (phones.length === 0) return [];

  const wanted = new Set(phones.map((phone) => phone.replace(/\D/g, "").slice(-10)));
  const rows = db
    .prepare(`SELECT user_id, phone FROM identities`)
    .all() as Array<{ user_id: string; phone: string }>;

  return rows
    .filter((row) => wanted.has(row.phone.replace(/\D/g, "").slice(-10)))
    .map((row) => row.user_id);
}

/**
 * Cuántas veces ha fallado este usuario al dar un número de cliente.
 *
 * A propósito NO se borra al reiniciar la conversación: si bastara con darle
 * /reiniciar para reponer los intentos, el tope no serviría de nada.
 */
export function getLinkFailures(userId: string): number {
  const row = readFailures.get(userId) as { failures: number } | undefined;
  return row?.failures ?? 0;
}

export function recordLinkFailure(userId: string): number {
  bumpFailures.run(userId);
  return getLinkFailures(userId);
}

/** Se limpia al identificarse bien: los intentos ya cumplieron su función. */
export function clearLinkFailures(userId: string): void {
  resetFailures.run(userId);
}

/** Borra la transcripción de este usuario, conservando su teléfono. */
export function clearHistory(userId: string): void {
  deleteMessages.run(userId);
}

/** Desvincula el teléfono: el usuario tendrá que volver a compartirlo. */
export function forgetIdentity(userId: string): void {
  deleteIdentity.run(userId);
}

export function getPollingOffset(): number {
  const row = readOffset.get() as { offset: number } | undefined;
  return row?.offset ?? 0;
}

export function setPollingOffset(offset: number): void {
  writeOffset.run(offset);
}
