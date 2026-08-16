import { respondTo } from "../agent/agent.js";
import {
  claimUpdate,
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

export async function handleMessage(message: IncomingMessage): Promise<void> {
  // Si el update llega duplicado, sólo la primera copia se procesa.
  if (!claimUpdate(message.updateId)) return;

  touchConversation(message.userId, message.displayName);

  // Guardar el teléfono antes de invocar al agente hace que el mismo turno en
  // que lo comparte ya se resuelva con su cuenta y sus precios.
  if (message.sharedPhone && !getPhoneFor(message.userId)) {
    rememberPhone(message.userId, message.sharedPhone);
  }

  const text = message.text || (message.sharedPhone ? SHARED_PHONE_NOTE : "");
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
