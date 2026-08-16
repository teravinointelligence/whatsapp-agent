import { config } from "../config.js";

const BASE = `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

/**
 * WhatsApp corta los mensajes de texto en 4096 caracteres. Partimos por
 * párrafos para no cortar a mitad de una palabra.
 */
const MAX_BODY = 4000;

function splitBody(text: string): string[] {
  if (text.length <= MAX_BODY) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split("\n")) {
    if (current.length + paragraph.length + 1 > MAX_BODY) {
      if (current) chunks.push(current);
      // Un solo párrafo más largo que el límite: se parte a lo bruto.
      if (paragraph.length > MAX_BODY) {
        for (let i = 0; i < paragraph.length; i += MAX_BODY) {
          chunks.push(paragraph.slice(i, i + MAX_BODY));
        }
        current = "";
        continue;
      }
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `WhatsApp API ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

/** Envía uno o varios mensajes de texto al usuario. */
export async function sendText(to: string, text: string): Promise<void> {
  for (const body of splitBody(text)) {
    await post(`${config.whatsapp.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    });
  }
}

/**
 * Marca el mensaje como leído (las palomitas azules) y muestra el indicador
 * de "escribiendo…" mientras el agente piensa.
 */
export async function markAsRead(messageId: string): Promise<void> {
  await post(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  });
}
