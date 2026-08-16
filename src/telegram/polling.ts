import { config } from "../config.js";
import { getPollingOffset, setPollingOffset } from "../data/conversations.js";
import { deleteWebhook, getUpdates } from "./client.js";
import { handleMessage } from "./handler.js";
import { parseUpdate } from "./updates.js";
import type { IncomingMessage } from "./types.js";

let running = false;

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
  // Telegram no entrega por getUpdates si hay un webhook registrado.
  await deleteWebhook().catch(() => {
    /* si no había webhook, da igual */
  });

  running = true;
  let offset = getPollingOffset();
  let backoff = 1000;

  console.log("Escuchando por long polling. Ctrl+C para salir.");

  while (running) {
    try {
      const updates = await getUpdates(offset, config.telegram.pollTimeout);
      backoff = 1000;

      const batch = [];
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = parseUpdate(update);
        if (message) batch.push(message);
      }

      for (const { message, reply } of collapseBatch(batch)) {
        // En serie a propósito: el orden importa y un /start a media tanda
        // tiene que aplicarse antes de lo que venga después.
        await handleMessage(message, { reply });
      }

      if (updates.length > 0) setPollingOffset(offset);
    } catch (error) {
      console.error("[telegram] fallo en el polling:", error);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      // Backoff hasta 30 s para no golpear la API si Telegram está caído.
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
