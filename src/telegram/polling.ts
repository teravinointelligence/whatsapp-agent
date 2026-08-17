import { config } from "../config.js";
import {
  getPollingOffset,
  releaseUnconfirmedUpdates,
  setPollingOffset,
} from "../data/conversations.js";
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

/**
 * Agrupa la tanda por persona, conservando el orden de cada conversación.
 *
 * Entre personas distintas no hay orden que respetar, y atenderlas en fila hace
 * que un turno lento —una consulta pesada al CRM, un modelo tardado— deje sin
 * respuesta a todos los que venían detrás.
 */
export function groupByUser<T extends { message: IncomingMessage }>(
  batch: T[],
): T[][] {
  const groups = new Map<string, T[]>();

  for (const item of batch) {
    const group = groups.get(item.message.userId);
    if (group) group.push(item);
    else groups.set(item.message.userId, [item]);
  }

  return [...groups.values()];
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

  // Lo que quedó a medio contestar cuando murió el proceso anterior vuelve a
  // entrar, en vez de descartarse por duplicado sin haberse atendido nunca.
  const soltados = releaseUnconfirmedUpdates();
  if (soltados > 0) {
    console.log(`Se reabrieron ${soltados} mensaje(s) que quedaron sin contestar.`);
  }

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

      // Cada conversación se atiende en serie —el orden importa y un /start a
      // media tanda tiene que aplicarse antes de lo que venga después— pero las
      // de personas distintas corren a la par.
      await Promise.all(
        groupByUser(collapseBatch(batch)).map(async (conversation) => {
          for (const { message, reply } of conversation) {
            try {
              await handleMessage(message, { reply });
            } catch (error) {
              // Un fallo con una persona no puede dejar sin atender al resto de
              // la tanda ni frenar el polling.
              console.error(`[telegram] fallo atendiendo a ${message.userId}:`, error);
            }
          }
        }),
      );

      if (updates.length > 0) setPollingOffset(offset);
    } catch (error) {
      console.error("[telegram] fallo en el polling:", error);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      // Backoff hasta 30 s para no golpear la API si Telegram está caído.
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
