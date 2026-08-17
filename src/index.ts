import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { getMe, setWebhook } from "./telegram/client.js";
import { pollingStatus, startPolling } from "./telegram/polling.js";
import { router as telegramRouter } from "./telegram/webhook.js";
import { startScheduler } from "./scheduler.js";
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

async function main(): Promise<void> {
  installCrashHandlers();

  const me = await getMe();
  console.log(`Bot conectado: @${me.username ?? me.id}`);
  console.log(`Código en memoria: ${RUNNING_COMMIT}`);

  startScheduler();

  if (config.telegram.mode === "webhook") {
    if (!config.telegram.webhookUrl || !config.telegram.webhookSecret) {
      throw new Error(
        "En modo webhook necesitas TELEGRAM_WEBHOOK_URL y TELEGRAM_WEBHOOK_SECRET.",
      );
    }

    const app = express();
    app.use(express.json());

    app.get("/health", (_req: Request, res: Response) => {
      res.json({ ok: true, mode: "webhook", commit: RUNNING_COMMIT });
    });

    app.use(telegramRouter);

    app.listen(config.port, () => {
      console.log(`Escuchando en el puerto ${config.port}`);
    });

    await setWebhook(config.telegram.webhookUrl, config.telegram.webhookSecret);
    console.log(`Webhook registrado en ${config.telegram.webhookUrl}`);
    return;
  }

  // Modo polling: no necesita servidor, pero levantamos /health para que las
  // plataformas de despliegue puedan comprobar que el proceso sigue vivo.
  const app = express();
  app.get("/health", (_req: Request, res: Response) => {
    // Con el estado del bucle a la vista, "el bot no contesta" se diagnostica
    // con un curl: si lastPollAt es de hace un minuto, el problema no es que
    // el proceso esté caído.
    const polling = pollingStatus();
    res.json({
      ok: polling.failures === 0,
      mode: "polling",
      commit: RUNNING_COMMIT,
      ...polling,
    });
  });
  app.listen(config.port, () => {
    console.log(`Health check en el puerto ${config.port}`);
  });

  await startPolling();
}

main().catch((error: unknown) => {
  console.error("No se pudo arrancar:", error);
  process.exit(1);
});
