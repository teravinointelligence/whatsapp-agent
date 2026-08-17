import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { getMe, setWebhook } from "./telegram/client.js";
import { startPolling } from "./telegram/polling.js";
import { router as telegramRouter } from "./telegram/webhook.js";
import { startScheduler } from "./scheduler.js";

/**
 * Un error suelto no puede matar al bot.
 *
 * Node tumba el proceso ante una promesa rechazada sin dueño, y aquí eso
 * significa que el bot deja de contestarle a todo el mundo por un fallo de una
 * sola conversación. Como suele correr sin nadie que lo levante otra vez, es
 * preferible dejar constancia en la bitácora y seguir atendiendo.
 */
function keepAlive(): void {
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[proceso] promesa rechazada sin atender:", reason);
  });

  process.on("uncaughtException", (error: unknown) => {
    console.error("[proceso] excepción sin atrapar:", error);
  });
}

async function main(): Promise<void> {
  keepAlive();

  const me = await getMe();
  console.log(`Bot conectado: @${me.username ?? me.id}`);

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
      res.json({ ok: true, mode: "webhook" });
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
    res.json({ ok: true, mode: "polling" });
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
