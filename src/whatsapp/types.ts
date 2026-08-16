/**
 * Subconjunto del payload del webhook de WhatsApp Cloud API que usamos.
 * Meta manda muchos más campos; sólo tipamos los que leemos.
 */

export interface WhatsAppTextMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { text: string; payload: string };
}

export interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WhatsAppValue {
  messaging_product: string;
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppTextMessage[];
  statuses?: unknown[];
}

export interface WhatsAppWebhookBody {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ field: string; value: WhatsAppValue }>;
  }>;
}

/** Mensaje ya normalizado que consume el agente. */
export interface IncomingMessage {
  /** Número del usuario en formato E.164 sin '+', como lo manda Meta. */
  from: string;
  /** ID del mensaje, usado para deduplicar reintentos del webhook. */
  messageId: string;
  /** Nombre del perfil de WhatsApp, si Meta lo incluye. */
  profileName: string | null;
  /** Texto del mensaje (o el título del botón/lista que tocó el usuario). */
  text: string;
}
