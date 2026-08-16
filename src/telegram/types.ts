/**
 * Subconjunto de la Bot API de Telegram que usamos.
 * La API manda muchos más campos; sólo tipamos los que leemos.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramContact {
  phone_number: string;
  first_name: string;
  last_name?: string;
  /**
   * Sólo viene cuando el contacto corresponde a un usuario de Telegram.
   * Si no coincide con quien manda el mensaje, es la tarjeta de OTRA persona
   * y no se debe usar para identificar a nadie.
   */
  user_id?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  contact?: TelegramContact;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

/** Mensaje ya normalizado que consume el agente. */
export interface IncomingMessage {
  /** Id numérico del usuario en Telegram, como texto. Es nuestra llave. */
  userId: string;
  /** Chat al que hay que contestar (en privado coincide con userId). */
  chatId: number;
  /** Id del update, para deduplicar reintentos. */
  updateId: number;
  /** Nombre visible del usuario en Telegram. */
  displayName: string | null;
  /** Texto del mensaje. Vacío si sólo compartió su contacto. */
  text: string;
  /** Teléfono que el usuario acaba de compartir, ya validado como suyo. */
  sharedPhone: string | null;
}
