import { config } from "./config.js";
import { db } from "./db/index.js";
import { tellAdmins } from "./notify.js";

/**
 * Señal de vida del proceso.
 *
 * Un proceso caído no puede avisar de su propia caída: para eso hace falta
 * alguien de afuera. Lo que sí puede es dejar constancia de que estuvo vivo, y
 * al volver darse cuenta del hueco. Así la caída se entera igual —tarde, al
 * recuperarse— en vez de descubrirla porque un cliente reclamó.
 *
 * Y si `HEARTBEAT_URL` está configurada, cada latido se avisa también hacia
 * afuera: es el vigilante que sí puede hablar cuando este proceso ya no está.
 */

const readSeen = db.prepare(`SELECT seen_at FROM heartbeat WHERE id = 1`);

const writeSeen = db.prepare(`
  INSERT INTO heartbeat (id, seen_at) VALUES (1, ?)
  ON CONFLICT (id) DO UPDATE SET seen_at = excluded.seen_at
`);

/** Cada cuánto se deja la señal. */
const BEAT_MS = 60_000;

/**
 * Hueco a partir del cual se considera que el bot estuvo caído.
 *
 * Con margen sobre el latido: un reinicio normal —un despliegue, un `git pull`
 * y volver a arrancar— tarda menos que esto y no tiene por qué avisar.
 */
const DOWN_THRESHOLD_MS = 5 * 60_000;

function minutesSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
}

async function pingOutside(): Promise<void> {
  if (!config.heartbeatUrl) return;

  try {
    await fetch(config.heartbeatUrl, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // El vigilante que no contesta no es razón para tumbar al bot: su trabajo
    // es enterarse de que dejamos de latir, y de eso se entera solo.
    console.warn("[latido] no se pudo avisar al vigilante:", error);
  }
}

/**
 * Compara la última señal con el reloj y avisa del hueco.
 *
 * Silencioso en el primer arranque —no hay con qué comparar— y en los
 * reinicios cortos, que son trabajo normal y no una caída.
 */
export async function reportDowntime(): Promise<void> {
  const row = readSeen.get() as { seen_at: string } | undefined;
  writeSeen.run(new Date().toISOString());

  if (!row) return;

  const gapMs = Date.now() - new Date(row.seen_at).getTime();
  if (gapMs < DOWN_THRESHOLD_MS) return;

  const minutos = minutesSince(row.seen_at);
  const cuanto =
    minutos >= 120 ? `${Math.round(minutos / 60)} hora(s)` : `${minutos} minuto(s)`;

  console.warn(`[latido] el bot estuvo sin dar señales ${cuanto}.`);

  await tellAdmins(
    [
      "🔌 <b>El bot volvió</b>",
      "",
      `Estuvo sin dar señales ${cuanto} —desde las ${new Date(row.seen_at).toLocaleString("es-MX", { timeZone: config.avisos.timezone })}—.`,
      "",
      "Los mensajes que hayan llegado en ese rato están en cola y se contestan ahora.",
      "Si esto se repite, el proceso se está muriendo por algo: hay que ver el log.",
    ].join("\n"),
  );
}

/** Deja la señal cada minuto, mientras el proceso viva. */
export function startHeartbeat(): void {
  const beat = (): void => {
    writeSeen.run(new Date().toISOString());
    void pingOutside();
  };

  beat();
  setInterval(beat, BEAT_MS).unref();
}
