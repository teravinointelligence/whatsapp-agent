import { config } from "../config.js";
import type { TelegramUpdate } from "./types.js";

const BASE = `https://api.telegram.org/bot${config.telegram.token}`;

/** Telegram corta los mensajes en 4096 caracteres. */
const MAX_BODY = 3800;

/**
 * Telegram interpreta HTML en el texto, así que hay que escapar lo que el
 * modelo escriba. Escapamos todo y después reponemos sólo <b> e <i>, que son
 * las dos etiquetas que el prompt le autoriza a usar. Cualquier otra cosa que
 * parezca HTML llega al cliente como texto plano, que es lo que queremos.
 */
export function toTelegramHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/&lt;(\/?)(b|i)&gt;/g, "<$1$2>");
}

function splitBody(text: string): string[] {
  if (text.length <= MAX_BODY) return [text];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of text.split("\n")) {
    if (current.length + paragraph.length + 1 > MAX_BODY) {
      if (current) chunks.push(current);
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

async function call<T = unknown>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };

  if (!response.ok || !payload.ok) {
    throw new Error(
      `Telegram ${method} ${response.status}: ${payload.description ?? "sin detalle"}`,
    );
  }

  return payload.result as T;
}

export interface SendOptions {
  /**
   * Muestra el botón que le pide al usuario compartir su teléfono. Telegram
   * sólo permite pedirlo con un botón: no se puede leer el número sin que la
   * persona lo autorice explícitamente.
   */
  requestContact?: boolean;
}

export async function sendText(
  chatId: number,
  text: string,
  options: SendOptions = {},
): Promise<void> {
  const chunks = splitBody(text);

  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;

    await call("sendMessage", {
      chat_id: chatId,
      text: toTelegramHtml(chunk),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      // El teclado se manda sólo con el último fragmento para que no se
      // repita el botón en cada pedazo de una respuesta larga.
      ...(options.requestContact && isLast
        ? {
            reply_markup: {
              keyboard: [
                [{ text: "📱 Compartir mi número", request_contact: true }],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        : {}),
    });
  }
}

/** Muestra "escribiendo…" mientras el agente piensa. Dura unos 5 segundos. */
export async function sendTyping(chatId: number): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action: "typing" });
}

/**
 * Long polling. Devuelve cuando hay updates o cuando vence el timeout.
 * `offset` confirma los updates anteriores: Telegram los borra de su cola.
 */
export async function getUpdates(
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  });
}

export async function setWebhook(url: string, secretToken: string): Promise<void> {
  await call("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
}

export async function deleteWebhook(): Promise<void> {
  await call("deleteWebhook", { drop_pending_updates: false });
}

export async function getMe(): Promise<{ id: number; username?: string }> {
  return call<{ id: number; username?: string }>("getMe", {});
}
