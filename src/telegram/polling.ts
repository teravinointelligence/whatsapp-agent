import { config } from "../config.js";
import { getPollingOffset, setPollingOffset } from "../data/conversations.js";
import { tellAdmins } from "../notify.js";
import {
  deleteWebhook,
  getUpdates,
  getWebhookInfo,
  TelegramError,
} from "./client.js";
import { handleMessage } from "./handler.js";
import { parseUpdate } from "./updates.js";
import type { IncomingMessage } from "./types.js";

let running = false;

/**
 * Tope de lo que puede tardar un mensaje antes de soltar el bucle.
 *
 * Los mensajes se atienden en serie, así que uno atorado —una llamada que
 * nunca vuelve— deja al bot mudo para todo el mundo, no sólo para quien
 * escribió. Vencido el plazo se sigue con los demás.
 */
const MESSAGE_TIMEOUT_MS = 180_000;

/**
 * Fallos seguidos antes de avisarle a la administración.
 *
 * Con el backoff son cerca de treinta segundos sin poder hablar con Telegram:
 * ya no es un tropiezo de red. Este aviso sí puede salir —el proceso está
 * vivo, sólo no lo dejan trabajar—, y es el que descubre el caso de las dos
 * instancias peleándose los mensajes.
 */
const ALERT_AFTER_FAILURES = 5;

interface PollingStatus {
  /** Última vez que Telegram contestó, aunque fuera sin updates. */
  lastPollAt: string | null;
  lastMessageAt: string | null;
  failures: number;
  lastError: string | null;
}

const status: PollingStatus = {
  lastPollAt: null,
  lastMessageAt: null,
  failures: 0,
  lastError: null,
};

/**
 * Estado del bucle, para /health.
 *
 * Cuando el bot "no contesta", lo primero que hay que saber es si el proceso
 * sigue hablando con Telegram. Un `lastPollAt` de hace horas y un `lastError`
 * dicen en un vistazo si el bucle murió, si Telegram lo está rechazando o si
 * simplemente nadie ha escrito.
 */
export function pollingStatus(): PollingStatus {
  return { ...status };
}

async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`el mensaje no se resolvió en ${ms / 1000} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Marca cuáles mensajes de la tanda se contestan: de cada persona, sólo el
 * último.
 *
 * Cuando el bot vuelve de estar caído, Telegram entrega de golpe todo lo que
 * quedó encolado. Contestar cada mensaje por separado le deja al cliente una
 * ráfaga de respuestas sueltas —y desordenadas, porque cada una se resuelve
 * por su lado—. Los anteriores igual quedan en el historial, así que el agente
 * los lee y responde a todo junto.
 */
export function collapseBatch(
  batch: IncomingMessage[],
): Array<{ message: IncomingMessage; reply: boolean }> {
  const lastOf = new Map<string, number>();
  batch.forEach((message, index) => lastOf.set(message.userId, index));

  return batch.map((message, index) => ({
    message,
    reply: lastOf.get(message.userId) === index,
  }));
}

export function stopPolling(): void {
  running = false;
}

/**
 * Long polling: dejamos una petición abierta hasta pollTimeout segundos y
 * Telegram responde en cuanto llega algo. No necesita dominio público.
 *
 * El offset confirma los updates ya vistos y se persiste, de modo que un
 * reinicio no reprocesa la cola.
 */
export async function startPolling(): Promise<void> {
  // Si Telegram tenía un webhook puesto, los mensajes se estaban yendo a otro
  // lado: conviene que quede dicho en el log antes de quitarlo, porque explica
  // por qué el bot llevaba rato sin contestar.
  const info = await getWebhookInfo().catch(() => null);
  if (info?.url) {
    console.warn(
      `[telegram] había un webhook registrado en ${info.url} ` +
        `(${info.pending_update_count} update(s) en cola). Lo quito para escuchar por polling.` +
        (info.last_error_message ? ` Último error suyo: ${info.last_error_message}` : ""),
    );
  }

  // Telegram no entrega por getUpdates si hay un webhook registrado.
  await deleteWebhook().catch(() => {
    /* si no había webhook, da igual */
  });

  running = true;
  let offset = getPollingOffset();
  let backoff = 1000;
  let degraded = false;

  console.log("Escuchando por long polling. Ctrl+C para salir.");

  while (running) {
    try {
      const updates = await getUpdates(offset, config.telegram.pollTimeout);
      backoff = 1000;
      status.lastPollAt = new Date().toISOString();
      status.failures = 0;
      status.lastError = null;

      if (degraded) {
        degraded = false;
        void tellAdmins(
          "✅ <b>Ya me estoy entendiendo con Telegram otra vez</b>\n\n" +
            "Los mensajes en cola se contestan ahora.",
        );
      }

      const batch = [];
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = parseUpdate(update);
        if (message) batch.push(message);
      }

      for (const { message, reply } of collapseBatch(batch)) {
        // En serie a propósito: el orden importa y un /start a media tanda
        // tiene que aplicarse antes de lo que venga después.
        await withTimeout(handleMessage(message, { reply }), MESSAGE_TIMEOUT_MS).catch(
          (error: unknown) => {
            console.error(`[telegram] ${message.userId} quedó sin atender:`, error);
          },
        );
        status.lastMessageAt = new Date().toISOString();
      }

      if (updates.length > 0) setPollingOffset(offset);
    } catch (error) {
      status.failures += 1;
      status.lastError = error instanceof Error ? error.message : String(error);

      if (error instanceof TelegramError && error.status === 409) {
        // Telegram entrega los updates a un solo consumidor. Dos procesos con
        // el mismo token se pisan y ninguno de los dos atiende de forma
        // confiable, así que hay que decirlo con todas sus letras.
        console.error(
          "[telegram] 409: otro proceso está consumiendo los updates de este bot. " +
            "Sólo puede haber una instancia corriendo con este token.",
        );
      } else if (error instanceof TelegramError && error.status === 401) {
        console.error(
          "[telegram] 401: el token no es válido. Revisa TELEGRAM_BOT_TOKEN.",
        );
      } else {
        console.error("[telegram] fallo en el polling:", error);
      }

      // Sólo al cruzar el umbral: un aviso por intento fallido sería una
      // ráfaga, y el bot ya está ocupado sin poder contestarle a nadie.
      if (status.failures === ALERT_AFTER_FAILURES) {
        degraded = true;
        void tellAdmins(
          [
            "🔴 <b>No puedo hablar con Telegram</b>",
            "",
            `Llevo ${status.failures} intentos fallando: ${status.lastError}`,
            "",
            error instanceof TelegramError && error.status === 409
              ? "Hay otro proceso corriendo con el mismo token —¿quedó un 'npm run dev' abierto?—. Mientras estén los dos, ninguno atiende bien."
              : "Nadie está recibiendo respuesta mientras esto siga así.",
          ].join("\n"),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, backoff));
      // Backoff hasta 30 s para no golpear la API si Telegram está caído.
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
