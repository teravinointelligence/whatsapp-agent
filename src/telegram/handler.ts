import { respondTo } from "../agent/agent.js";
import { tools } from "../agent/tools.js";
import { RUNNING_COMMIT } from "../version.js";
import {
  appendMessage,
  claimUpdate,
  clearHistory,
  forgetIdentity,
  getPhoneFor,
  rememberPhone,
  touchConversation,
} from "../data/conversations.js";
import { sendText, sendTyping } from "./client.js";
import type { IncomingMessage } from "./types.js";

/**
 * Texto que se le pasa al agente cuando el usuario acaba de compartir su
 * teléfono sin escribir nada. Sin esto el turno llegaría vacío.
 */
const SHARED_PHONE_NOTE = "(el cliente acaba de compartir su número de teléfono)";

/**
 * Comandos que resuelve el servidor, sin pasar por el modelo.
 *
 * El modelo no puede olvidar por su cuenta: el historial se le vuelve a mandar
 * completo en cada turno, así que "olvida lo que te dije" no funciona. Borrarlo
 * tiene que ser una operación del servidor.
 */
interface CommandReply {
  text: string;
  /** Vuelve a mostrar el botón de compartir teléfono. */
  requestContact?: boolean;
}

function handleCommand(message: IncomingMessage): CommandReply | null {
  const command = message.text.split(/\s+/)[0]?.toLowerCase() ?? "";

  switch (command) {
    case "/start":
      // Arranca de cero la conversación pero conserva el teléfono ya
      // verificado: volver a pedirlo sería molesto y no aporta nada.
      clearHistory(message.userId);
      return { text: "Empecemos de nuevo." };

    case "/version":
    case "/versión":
      // No pasa por el modelo: la pregunta es qué código está corriendo, y el
      // modelo no tiene forma de saberlo.
      return {
        text:
          `Código en memoria: ${RUNNING_COMMIT}\n` +
          `Herramientas cargadas: ${tools.length}.\n` +
          "Si esto no coincide con lo último que jalaste, falta reiniciar el proceso.",
      };

    case "/reiniciar":
    case "/reset":
      // Además desvincula el número, para cuando se compartió el equivocado.
      clearHistory(message.userId);
      forgetIdentity(message.userId);
      return {
        text: "Listo, borré la conversación y tu número. Empecemos de cero.",
        // Acabamos de olvidar su teléfono, así que el botón tiene que volver:
        // sin él no hay forma de que lo comparta otra vez.
        requestContact: true,
      };

    default:
      return null;
  }
}

export interface HandleOptions {
  /**
   * false para los mensajes que quedaron atrás en la misma tanda: se guardan en
   * el historial pero no se contestan uno por uno.
   *
   * Cuando el bot vuelve de estar caído, Telegram le entrega de golpe todo lo
   * que quedó encolado. Contestar cada mensaje por separado le llena la
   * conversación al cliente de respuestas sueltas y desordenadas; contestar
   * sólo el último, ya con todo lo anterior en el historial, es lo que haría
   * una persona que se pone al corriente.
   */
  reply?: boolean;
}

export async function handleMessage(
  message: IncomingMessage,
  options: HandleOptions = {},
): Promise<void> {
  const { reply = true } = options;

  // Si el update llega duplicado, sólo la primera copia se procesa.
  if (!claimUpdate(message.updateId)) return;

  touchConversation(message.userId, message.displayName);

  // Guardar el teléfono antes de invocar al agente hace que el mismo turno en
  // que lo comparte ya se resuelva con su cuenta y sus precios.
  if (message.sharedPhone && !getPhoneFor(message.userId)) {
    rememberPhone(message.userId, message.sharedPhone);
  }

  // Los comandos se aplican aunque el mensaje no se conteste: un /start a
  // media tanda tiene que borrar la conversación igual.
  const command = handleCommand(message);

  if (command !== null) {
    // La respuesta del comando se manda tal cual. Pasarla por el modelo sería
    // pedirle que parafrasee un dato que él no puede verificar: /version
    // contestaría cualquier cosa menos el commit que está corriendo.
    if (reply) {
      await sendText(message.chatId, command.text, {
        requestContact: command.requestContact,
      }).catch((error: unknown) => {
        console.error("[telegram] no se pudo contestar el comando:", error);
      });
    }
    return;
  }

  const text = message.text || (message.sharedPhone ? SHARED_PHONE_NOTE : "");
  if (!text) return;

  if (!reply) {
    // Sin llamar al modelo: el mensaje queda en el historial y el agente lo lee
    // cuando conteste el último de la tanda.
    appendMessage(message.userId, "user", text);
    return;
  }

  try {
    await sendTyping(message.chatId).catch((error: unknown) => {
      // No es crítico: si falla, seguimos con la respuesta.
      console.warn("[telegram] no se pudo marcar 'escribiendo':", error);
    });

    const answer = await respondTo(message.userId, text);

    await sendText(message.chatId, answer.text, {
      requestContact: answer.needsPhone,
    });
  } catch (error) {
    console.error(`[agent] fallo atendiendo a ${message.userId}:`, error);
    await sendText(
      message.chatId,
      "Tuvimos un problema técnico atendiendo tu mensaje. ¿Nos lo repites en un momento?",
    ).catch((sendError: unknown) => {
      console.error("[telegram] tampoco se pudo avisar del error:", sendError);
    });
  }
}
