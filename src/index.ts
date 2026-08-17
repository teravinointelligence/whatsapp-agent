import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { getMe, setWebhook, TelegramError } from "./telegram/client.js";
import { pollingStatus, startPolling } from "./telegram/polling.js";
import { router as telegramRouter } from "./telegram/webhook.js";
import { startScheduler } from "./scheduler.js";
import { reportDowntime, startHeartbeat } from "./heartbeat.js";
import { RUNNING_COMMIT } from "./version.js";

/**
 * Un proceso que muere sin decir nada es exactamente lo que se ve desde el
 * chat como "el bot ya no contesta". Cualquier fallo que se escape queda
 * escrito antes de irse.
 */
function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    // No se mata el proceso: una promesa suelta —un aviso, un envío— no es
    // razón para dejar sin atender a quien está escribiendo.
    console.error("[proceso] promesa rechazada sin atender:", reason);
  });

  process.on("uncaughtException", (error: unknown) => {
    // Aquí sí: el estado ya no es confiable. Se sale con código 1 para que
    // quien supervise el proceso lo levante otra vez.
    console.error("[proceso] excepción no atrapada, saliendo:", error);
    process.exit(1);
  });
}

/** Estado del arranque, para que /health lo cuente mientras tanto. */
let telegramState = "conectando";

/**
 * Espera a que haya red y se presenta con Telegram.
 *
 * Antes, un arranque sin conexión mataba el proceso: si la laptop despertaba
 * antes que el wifi, o el internet parpadeaba, el bot no volvía y nadie se
 * enteraba hasta que un cliente escribía. Reintentar es lo que haría cualquiera
 * en su lugar —esperar un momento y volver a intentar—, y el bucle del polling
 * ya trabaja así una vez arrancado.
 *
 * Un token inválido es la excepción: eso no se arregla esperando.
 */
async function connectToTelegram(): Promise<{ id: number; username?: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const me = await getMe();
      telegramState = "conectado";
      return me;
    } catch (error) {
      if (error instanceof TelegramError && error.status === 401) {
        throw new Error(
          "El token de Telegram no es válido. Revisa TELEGRAM_BOT_TOKEN en el .env.",
        );
      }

      // Hasta un minuto entre intentos: si la red tarda en volver, no tiene
      // caso golpearla cada segundo, y el proceso no se pierde nada esperando.
      const waitMs = Math.min(5000 * 2 ** (attempt - 1), 60_000);
      telegramState = `sin conexión (intento ${attempt})`;

      console.error(
        `[arranque] intento ${attempt}: no se pudo contactar a Telegram ` +
          `(${error instanceof Error ? error.message : String(error)}). ` +
          `Reintento en ${waitMs / 1000} s.`,
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * El servidor se levanta antes de hablar con Telegram, a propósito: mientras el
 * bot espera a que vuelva la red, /health es lo único que puede explicar qué
 * está pasando.
 */
function startServer(): void {
  const app = express();

  if (config.telegram.mode === "webhook") {
    app.use(express.json());
    app.use(telegramRouter);
  }

  app.get("/health", (_req: Request, res: Response) => {
    // Con el estado a la vista, "el bot no contesta" se diagnostica con un
    // curl: si lastPollAt es de hace un minuto, el problema no es el proceso.
    const polling = config.telegram.mode === "polling" ? pollingStatus() : null;

    res.json({
      ok: telegramState === "conectado" && (polling?.failures ?? 0) === 0,
      mode: config.telegram.mode,
      telegram: telegramState,
      commit: RUNNING_COMMIT,
      ...(polling ?? {}),
    });
  });

  app.listen(config.port, () => {
    console.log(`Health check en el puerto ${config.port}`);
  });
}

async function main(): Promise<void> {
  installCrashHandlers();

  if (config.telegram.mode === "webhook") {
    if (!config.telegram.webhookUrl || !config.telegram.webhookSecret) {
      throw new Error(
        "En modo webhook necesitas TELEGRAM_WEBHOOK_URL y TELEGRAM_WEBHOOK_SECRET.",
      );
    }
  }

  startServer();

  const me = await connectToTelegram();
  console.log(`Bot conectado: @${me.username ?? me.id}`);
  console.log(`Código en memoria: ${RUNNING_COMMIT}`);

  // Antes de empezar a atender: si hay un hueco desde la última señal de vida,
  // el bot estuvo caído y la administración se entera ahora, no cuando un
  // cliente reclame. No bloquea el arranque si el aviso falla.
  await reportDowntime().catch((error: unknown) => {
    console.error("[latido] no se pudo avisar de la caída:", error);
  });
  startHeartbeat();

  startScheduler();

  if (config.telegram.mode === "webhook") {
    await setWebhook(config.telegram.webhookUrl, config.telegram.webhookSecret);
    console.log(`Webhook registrado en ${config.telegram.webhookUrl}`);
    return;
  }

  await startPolling();
}

main().catch((error: unknown) => {
  console.error("No se pudo arrancar:", error);
  process.exit(1);
});
