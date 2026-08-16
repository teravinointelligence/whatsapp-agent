import type { IncomingMessage, TelegramUpdate } from "./types.js";

function displayNameOf(
  first?: string,
  last?: string,
  username?: string,
): string | null {
  const name = [first, last].filter(Boolean).join(" ").trim();
  if (name) return name;
  return username ? `@${username}` : null;
}

/**
 * Normaliza un update de Telegram al mensaje que consume el agente.
 * Devuelve null para lo que no sabemos atender (fotos, audios, updates de
 * edición, mensajes de otros bots, chats grupales).
 */
export function parseUpdate(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message?.from) return null;

  // Un bot no es un cliente.
  if (message.from.is_bot) return null;

  // Sólo atendemos conversaciones privadas: en un grupo el bot vería mensajes
  // de terceros y no podría saber a nombre de quién actúa.
  if (message.chat.type !== "private") return null;

  const text = message.text?.trim() ?? "";
  const contact = message.contact;

  /**
   * Telegram sólo pone `user_id` cuando la tarjeta corresponde a un usuario
   * real, y con el botón de "compartir mi número" ese id es el de quien la
   * comparte. Si no coincide con el remitente, es la tarjeta de otra persona:
   * aceptarla dejaría que cualquiera se hiciera pasar por un cliente.
   */
  const sharedPhone =
    contact && contact.user_id === message.from.id ? contact.phone_number : null;

  if (!text && !sharedPhone) return null;

  return {
    userId: String(message.from.id),
    chatId: message.chat.id,
    updateId: update.update_id,
    displayName: displayNameOf(
      message.from.first_name,
      message.from.last_name,
      message.from.username,
    ),
    text,
    sharedPhone,
  };
}
