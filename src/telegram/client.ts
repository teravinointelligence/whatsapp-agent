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

/**
 * Error de la API de Telegram con el código a la vista.
 *
 * El código importa para decidir: 409 es otra instancia consumiendo los
 * updates y 400 con "can't parse entities" es HTML mal formado. Sin el código,
 * quien lo atrapa sólo tiene una cadena que parsear a mano.
 */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram ${method} ${status}: ${description}`);
    this.name = "TelegramError";
  }
}

/** Tope para cualquier llamada que no sea el long polling. */
const CALL_TIMEOUT_MS = 30_000;

/**
 * Intentos ante un fallo de red, contando el primero.
 *
 * Una conexión que se corta a media llamada —ECONNRESET, un timeout al abrir
 * el socket— no dice nada sobre el mensaje: sólo que ese intento no llegó. En
 * una red inestable, rendirse al primer tropiezo le cuesta al cliente su
 * respuesta.
 */
const CALL_ATTEMPTS = 3;

interface CallOptions {
  timeoutMs?: number;
  /** 1 para no reintentar: el long polling ya trae su propio backoff. */
  attempts?: number;
}

/**
 * Un error de la API tiene código y es una respuesta: reintentarlo repetiría el
 * mismo rechazo. Uno de red no llegó a ser respuesta, y ése sí se reintenta.
 */
function isNetworkError(error: unknown): boolean {
  return !(error instanceof TelegramError);
}

/**
 * `fetch` no trae timeout: sin esto, una conexión que se queda a medias cuelga
 * la llamada para siempre. Y como el polling procesa los mensajes en serie, un
 * envío colgado deja al bot mudo para todos, no sólo para quien escribió.
 *
 * El reintento asume que un mensaje repetido es mejor que un mensaje perdido:
 * si la conexión se corta después de que Telegram recibió el envío, el cliente
 * puede ver la respuesta dos veces. Con una red inestable, perder la respuesta
 * es lo que de verdad se nota.
 */
async function call<T = unknown>(
  method: string,
  body: unknown,
  options: CallOptions = {},
): Promise<T> {
  const { timeoutMs = CALL_TIMEOUT_MS, attempts = CALL_ATTEMPTS } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${BASE}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: T;
        description?: string;
      };

      if (!response.ok || !payload.ok) {
        throw new TelegramError(
          method,
          response.status,
          payload.description ?? "sin detalle",
        );
      }

      return payload.result as T;
    } catch (error) {
      if (attempt >= attempts || !isNetworkError(error)) throw error;

      console.warn(
        `[telegram] ${method}: la red falló en el intento ${attempt} ` +
          `(${error instanceof Error ? error.message : String(error)}). Reintento.`,
      );

      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
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

    // El teclado se manda sólo con el último fragmento para que no se repita
    // el botón en cada pedazo de una respuesta larga.
    const keyboard =
      options.requestContact && isLast
        ? {
            reply_markup: {
              keyboard: [
                [{ text: "📱 Compartir mi número", request_contact: true }],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        : {};

    try {
      await call("sendMessage", {
        chat_id: chatId,
        text: toTelegramHtml(chunk),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...keyboard,
      });
    } catch (error) {
      // Telegram rechaza el mensaje entero si el HTML no cuadra —una <b> sin
      // cerrar, o un corte de fragmento que parte la etiqueta a la mitad—. El
      // cliente no tiene por qué quedarse sin respuesta por un formato: se
      // reenvía en texto plano, que siempre pasa.
      if (!isParseError(error)) throw error;

      console.warn(
        `[telegram] HTML rechazado (${(error as TelegramError).description}); reenviando en texto plano.`,
      );

      await call("sendMessage", {
        chat_id: chatId,
        text: chunk,
        link_preview_options: { is_disabled: true },
        ...keyboard,
      });
    }
  }
}

/** 400 por etiquetas mal formadas: se puede reintentar sin parse_mode. */
function isParseError(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    error.status === 400 &&
    /parse entities|tag|entity/i.test(error.description)
  );
}

/** Muestra "escribiendo…" mientras el agente piensa. Dura unos 5 segundos. */
export async function sendTyping(chatId: number): Promise<void> {
  // Sin reintento: es un adorno y su fallo ya se ignora. Insistir sólo le
  // agregaría segundos de espera al cliente antes de la respuesta de verdad.
  await call("sendChatAction", { chat_id: chatId, action: "typing" }, { attempts: 1 });
}

/**
 * Long polling. Devuelve cuando hay updates o cuando vence el timeout.
 * `offset` confirma los updates anteriores: Telegram los borra de su cola.
 */
export async function getUpdates(
  offset: number,
  timeoutSeconds: number,
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(
    "getUpdates",
    {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    },
    {
      // Margen sobre el long polling: la petición se queda abierta a propósito,
      // así que el timeout sólo tiene que cortar la que se quedó colgada.
      timeoutMs: (timeoutSeconds + 15) * 1000,
      // Sin reintento propio: el bucle ya trae backoff y lleva la cuenta de los
      // fallos para el aviso. Reintentar aquí escondería esa cuenta.
      attempts: 1,
    },
  );
}

export interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

/**
 * Qué cree Telegram que está pasando con este bot.
 *
 * Es lo primero que hay que mirar cuando el bot no contesta nada: una `url`
 * puesta significa que los mensajes se están yendo a otro servidor, y un
 * `last_error_message` dice por qué ese otro servidor no los está recibiendo.
 */
export async function getWebhookInfo(): Promise<WebhookInfo> {
  return call<WebhookInfo>("getWebhookInfo", {});
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
