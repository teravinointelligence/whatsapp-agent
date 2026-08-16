import { respondTo } from "../agent/agent.js";
import {
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
function handleCommand(message: IncomingMessage): string | null {
  const command = message.text.split(/\s+/)[0]?.toLowerCase() ?? "";

  switch (command) {
    case "/start":
      // Arranca de cero la conversación pero conserva el teléfono ya
      // verificado: volver a pedirlo sería molesto y no aporta nada.
      clearHistory(message.userId);
      return "Empecemos de nuevo.";

    case "/reiniciar":
    case "/reset":
      // Además desvincula el número, para cuando se compartió el equivocado.
      clearHistory(message.userId);
      forgetIdentity(message.userId);
      return "Listo, borré la conversación y tu número. Empecemos de cero.";

    default:
      return null;
  }
}

export async function handleMessage(message: IncomingMessage): Promise<void> {
  // Si el update llega duplicado, sólo la primera copia se procesa.
  if (!claimUpdate(message.updateId)) return;

  touchConversation(message.userId, message.displayName);

  // Guardar el teléfono antes de invocar al agente hace que el mismo turno en
  // que lo comparte ya se resuelva con su cuenta y sus precios.
  if (message.sharedPhone && !getPhoneFor(message.userId)) {
    rememberPhone(message.userId, message.sharedPhone);
  }

  const command = handleCommand(message);
  const text = command ?? message.text ?? (message.sharedPhone ? SHARED_PHONE_NOTE : "");
  if (!text) return;

  try {
    await sendTyping(message.chatId).catch((error: unknown) => {
      // No es crítico: si falla, seguimos con la respuesta.
      console.warn("[telegram] no se pudo marcar 'escribiendo':", error);
    });

    const reply = await respondTo(message.userId, text);

    await sendText(message.chatId, reply.text, {
      requestContact: reply.needsPhone,
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
