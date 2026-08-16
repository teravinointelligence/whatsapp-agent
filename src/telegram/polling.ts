import { config } from "../config.js";
import { getPollingOffset, setPollingOffset } from "../data/conversations.js";
import { deleteWebhook, getUpdates } from "./client.js";
import { handleMessage } from "./handler.js";
import { parseUpdate } from "./updates.js";

let running = false;

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

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);

        const message = parseUpdate(update);
        if (!message) continue;

        // Se procesan en serie a propósito: un cliente que manda tres mensajes
        // seguidos debe verlos atendidos en orden.
        await handleMessage(message);
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
