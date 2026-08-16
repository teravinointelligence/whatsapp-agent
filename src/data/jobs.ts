import { db } from "../db/index.js";

const readRun = db.prepare(`SELECT last_day FROM job_runs WHERE job = ?`);

const writeRun = db.prepare(`
  INSERT INTO job_runs (job, last_day) VALUES (?, ?)
  ON CONFLICT (job) DO UPDATE SET last_day = excluded.last_day
`);

const claimOrderAlert = db.prepare(
  `INSERT OR IGNORE INTO order_alerts (order_id) VALUES (?)`,
);

const forgetOrderAlert = db.prepare(`DELETE FROM order_alerts WHERE order_id = ?`);

/**
 * Marca que este aviso ya corrió hoy y dice si le tocaba correr.
 *
 * Devuelve false si ya se había mandado en el mismo día: el proceso puede
 * reiniciarse varias veces en una mañana y el resumen debe llegar una sola vez.
 */
export function claimDailyJob(job: string, day: string): boolean {
  const row = readRun.get(job) as { last_day: string } | undefined;
  if (row?.last_day === day) return false;

  writeRun.run(job, day);
  return true;
}

/**
 * Devuelve true la primera vez que se avisa de este pedido atorado.
 *
 * Sin esto el aviso se repetiría en cada revisión hasta que alguien mueva el
 * pedido, que es la forma más rápida de que se dejen de leer los avisos.
 */
export function claimOrderStuckAlert(orderId: string): boolean {
  return claimOrderAlert.run(orderId).changes > 0;
}

const claimFile = db.prepare(
  `INSERT OR IGNORE INTO inventory_files (file_id) VALUES (?)`,
);

/**
 * Devuelve true la primera vez que se ve un archivo de inventario.
 *
 * Los archivos de Drive no cambian una vez subidos: cada corte es uno nuevo.
 * Con esto, la revisión diaria sólo escribe cuando de verdad hay algo nuevo, y
 * no vuelve a avisar del mismo corte.
 */
export function claimInventoryFile(fileId: string): boolean {
  return claimFile.run(fileId).changes > 0;
}

/** Se olvida del pedido cuando ya salió de borrador, por si vuelve a caer. */
export function clearOrderStuckAlert(orderId: string): void {
  forgetOrderAlert.run(orderId);
}
