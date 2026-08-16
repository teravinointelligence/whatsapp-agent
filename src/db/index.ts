import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    user_id      TEXT PRIMARY KEY,
    display_name TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages (user_id, id);

  -- Telegram no expone el teléfono: el usuario lo comparte con un botón y
  -- aquí guardamos la equivalencia para no volvérselo a pedir.
  CREATE TABLE IF NOT EXISTS identities (
    user_id     TEXT PRIMARY KEY,
    phone       TEXT NOT NULL,
    shared_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_identities_phone ON identities (phone);

  -- Deduplica reintentos: el webhook de Telegram reenvía el update si no
  -- respondemos 200, y el long polling los repite si no confirmamos el offset.
  CREATE TABLE IF NOT EXISTS processed_updates (
    update_id    INTEGER PRIMARY KEY,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Intentos fallidos de identificarse con un número de cliente ajeno. Los
  -- números son del 1 al 502, así que sin un tope cualquiera los prueba todos.
  -- No se borra con /reiniciar: si se borrara, el tope no serviría de nada.
  CREATE TABLE IF NOT EXISTS link_attempts (
    user_id    TEXT PRIMARY KEY,
    failures   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Offset confirmado del long polling, para no reprocesar tras un reinicio.
  CREATE TABLE IF NOT EXISTS polling_state (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    offset INTEGER NOT NULL
  );
`);

// Los pedidos, el catálogo y las cuentas viven en el CRM (Supabase). Aquí sólo
// queda el estado propio del canal: transcripción, identidades y deduplicación.
