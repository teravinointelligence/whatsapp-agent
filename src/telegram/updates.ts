import type {
  IncomingMessage,
  MediaKind,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

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
 * Qué adjunto trae el mensaje, si trae alguno.
 *
 * No es para procesarlo —no sabemos leer un audio ni ver una foto— sino para
 * poder decirlo. El cliente que manda una nota de voz y no recibe nada no
 * concluye "no entiende audios": concluye que el bot está muerto.
 */
function mediaKindOf(message: TelegramMessage): MediaKind | null {
  if (message.voice || message.audio || message.video_note) return "audio";
  if (message.photo) return "foto";
  if (message.video) return "video";
  if (message.document) return "documento";
  if (message.sticker) return "sticker";
  if (message.location) return "ubicación";
  return null;
}

/**
 * Normaliza un update de Telegram al mensaje que consume el agente.
 * Devuelve null para lo que no viene de una persona en un chat privado
 * (updates de edición, mensajes de otros bots, chats grupales).
 */
export function parseUpdate(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message?.from) return null;

  // Un bot no es un cliente.
  if (message.from.is_bot) return null;

  // Sólo atendemos conversaciones privadas: en un grupo el bot vería mensajes
  // de terceros y no podría saber a nombre de quién actúa.
  if (message.chat.type !== "private") return null;

  // El pie de foto es texto del cliente igual que cualquier otro: si manda una
  // foto preguntando algo, la pregunta viene ahí.
  const text = (message.text ?? message.caption)?.trim() ?? "";
  const contact = message.contact;

  /**
   * Telegram sólo pone `user_id` cuando la tarjeta corresponde a un usuario
   * real, y con el botón de "compartir mi número" ese id es el de quien la
   * comparte. Si no coincide con el remitente, es la tarjeta de otra persona:
   * aceptarla dejaría que cualquiera se hiciera pasar por un cliente.
   */
  const sharedPhone =
    contact && contact.user_id === message.from.id ? contact.phone_number : null;

  // Una tarjeta de contacto que no es la suya no sirve para identificarlo, pero
  // tampoco se puede ignorar: la persona cree que ya compartió su número.
  const media = contact && !sharedPhone ? "contacto" : mediaKindOf(message);

  // Sin texto, sin teléfono y sin adjunto no hay nada que atender: un mensaje
  // de servicio de Telegram, alguien que entró al chat, cosas así.
  if (!text && !sharedPhone && !media) return null;

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
    media,
  };
}
