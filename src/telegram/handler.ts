import { respondTo } from "../agent/agent.js";
import { tools } from "../agent/tools.js";
import { RUNNING_COMMIT } from "../version.js";
import {
  appendMessage,
  claimUpdate,
  clearHistory,
  finishUpdate,
  forgetIdentity,
  getPhoneFor,
  releaseUpdate,
  rememberPhone,
  touchConversation,
} from "../data/conversations.js";
import { sendText, sendTyping } from "./client.js";
import type { IncomingMessage, MediaKind } from "./types.js";

/**
 * Texto que se le pasa al agente cuando el usuario acaba de compartir su
 * teléfono sin escribir nada. Sin esto el turno llegaría vacío.
 */
const SHARED_PHONE_NOTE = "(el cliente acaba de compartir su número de teléfono)";

/**
 * Qué se le contesta a quien manda algo que no sabemos leer.
 *
 * Callarse es lo peor que se puede hacer aquí: quien manda una nota de voz y
 * no recibe nada no piensa "no entiende audios", piensa que el bot está caído
 * —y así es como llega el reporte de que "no contesta"—. Contestar en el acto
 * cuesta un mensaje y deja claro qué sí funciona.
 */
const MEDIA_REPLIES: Record<MediaKind, string> = {
  audio:
    "Por aquí todavía no puedo escuchar audios. ¿Me lo escribes? Con eso te atiendo al momento.",
  foto:
    "No alcanzo a ver las imágenes. Si me escribes qué necesitas —o qué dice la foto— te ayudo de inmediato.",
  video: "No puedo ver videos por aquí. Cuéntame por escrito y lo vemos.",
  documento:
    "No puedo abrir archivos por este canal. Si me escribes lo que traes, te ayudo; y si es algo que tiene que ver tu vendedor, lo canalizo.",
  sticker: "😄 Dime en qué te ayudo y lo vemos.",
  ubicación:
    "Gracias. Escríbeme la ciudad o zona y con eso te digo qué portafolio te toca.",
  contacto:
    "Esa tarjeta es de otra persona, así que no puedo usarla para identificarte. Usa el botón de aquí abajo para compartir tu propio número.",
  adjunto: "No puedo abrir eso por aquí. ¿Me escribes qué necesitas?",
};

/** Cómo se nombra cada adjunto cuando hay que contárselo al agente. */
const MEDIA_NAMES: Record<MediaKind, string> = {
  audio: "un audio",
  foto: "una foto",
  video: "un video",
  documento: "un documento",
  sticker: "un sticker",
  ubicación: "una ubicación",
  contacto: "una tarjeta de contacto",
  adjunto: "un archivo",
};

/**
 * Nota que acompaña al texto cuando el mensaje además traía un adjunto.
 *
 * Sin esto el modelo ve sólo el pie de foto —"¿me lo cotizas?"— y contesta
 * como si hubiera visto la imagen.
 */
function mediaNote(kind: MediaKind): string {
  return `(el cliente adjuntó ${MEDIA_NAMES[kind]}; no puedo abrirlo, sólo leo el texto que escribió)`;
}

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

    case "/version":
    case "/versión":
      // No pasa por el modelo: la pregunta es qué código está corriendo, y el
      // modelo no tiene forma de saberlo.
      return (
        `Código en memoria: ${RUNNING_COMMIT}\n` +
        `Herramientas cargadas: ${tools.length}.\n` +
        "Si esto no coincide con lo último que jalaste, falta reiniciar el proceso."
      );

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

/**
 * Atiende el mensaje una sola vez, aunque Telegram lo reentregue.
 *
 * El update se aparta antes de atenderlo y se marca como contestado hasta el
 * final. Si algo se rompe en medio se suelta, porque un mensaje que quedó a
 * medias tiene que poder atenderse en la reentrega: darlo por "ya procesado"
 * es dejar a esa persona sin respuesta para siempre.
 */
export async function handleMessage(
  message: IncomingMessage,
  options: HandleOptions = {},
): Promise<void> {
  // Si el update llega duplicado, sólo la primera copia se procesa.
  if (!claimUpdate(message.updateId)) return;

  try {
    await attend(message, options);
    finishUpdate(message.updateId);
  } catch (error) {
    releaseUpdate(message.updateId);
    throw error;
  }
}

async function attend(
  message: IncomingMessage,
  options: HandleOptions,
): Promise<void> {
  const { reply = true } = options;

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
    // darle de comer su propia respuesta como si fuera del cliente: el modelo
    // la parafrasearía y /version dejaría de servir justo para lo que existe,
    // que es saber qué código está corriendo sin preguntarle a nadie.
    if (reply) {
      // Un fallo al enviar se propaga a propósito: suelta el update y la
      // reentrega vuelve a intentarlo.
      await sendText(message.chatId, command, {
        requestContact: getPhoneFor(message.userId) === null,
      });
    }
    return;
  }

  // Un adjunto sin texto se contesta aquí mismo, sin pasar por el modelo: no
  // hay nada que razonar y lo que importa es que la persona sepa en el acto
  // que se le leyó.
  if (!message.text && message.media) {
    if (!reply) {
      // Quedó atrás en la tanda: al menos que el agente sepa que mandó algo,
      // para que no conteste el último mensaje como si nada más hubiera pasado.
      appendMessage(
        message.userId,
        "user",
        `(el cliente mandó ${MEDIA_NAMES[message.media]}; no se puede abrir)`,
      );
      return;
    }

    await sendText(message.chatId, MEDIA_REPLIES[message.media], {
      requestContact: getPhoneFor(message.userId) === null,
    });
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

    // El adjunto va como nota para que el agente no conteste como si lo
    // hubiera visto.
    const answer = await respondTo(
      message.userId,
      message.media ? `${text}\n\n${mediaNote(message.media)}` : text,
    );

    await sendText(message.chatId, answer.text, {
      requestContact: answer.needsPhone,
    });
  } catch (error) {
    console.error(`[agent] fallo atendiendo a ${message.userId}:`, error);

    // Si ni el aviso de la falla se pudo mandar, esa persona no recibió nada:
    // se propaga para que el update se suelte y la reentrega lo reintente, en
    // vez de quedar contado como atendido.
    await sendText(
      message.chatId,
      "Tuvimos un problema técnico atendiendo tu mensaje. ¿Nos lo repites en un momento?",
    );
  }
}
