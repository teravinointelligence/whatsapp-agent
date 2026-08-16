import express, { type Request, type Response } from "express";
import { config } from "./config.js";
import { respondTo } from "./agent/agent.js";
import { markAsRead, sendText } from "./whatsapp/client.js";
import {
  parseMessages,
  router as webhookRouter,
  verifySignature,
} from "./whatsapp/webhook.js";
import { claimMessage, touchConversation } from "./data/conversations.js";
import type { IncomingMessage, WhatsAppWebhookBody } from "./whatsapp/types.js";

const app = express();

// Guardamos el cuerpo crudo: la firma de Meta se calcula sobre esos bytes.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use(webhookRouter);

app.post("/webhook", (req: Request, res: Response) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!raw || !verifySignature(raw, req.get("x-hub-signature-256"))) {
    res.sendStatus(401);
    return;
  }

  // Meta reintenta el webhook si tardamos en contestar, así que confirmamos
  // de inmediato y procesamos en segundo plano.
  res.sendStatus(200);

  const messages = parseMessages(req.body as WhatsAppWebhookBody);
  for (const message of messages) {
    void handleMessage(message);
  }
});

async function handleMessage(message: IncomingMessage): Promise<void> {
  // Si el webhook llega duplicado, sólo la primera copia se procesa.
  if (!claimMessage(message.messageId)) return;

  touchConversation(message.from, message.profileName);

  try {
    await markAsRead(message.messageId).catch((error: unknown) => {
      // No es crítico: si falla, seguimos con la respuesta.
      console.warn("[whatsapp] no se pudo marcar como leído:", error);
    });

    const reply = await respondTo(message.from, message.text);
    await sendText(message.from, reply);
  } catch (error) {
    console.error(`[agent] fallo atendiendo a ${message.from}:`, error);
    await sendText(
      message.from,
      "Tuvimos un problema técnico atendiendo tu mensaje. ¿Nos lo repites en un momento?",
    ).catch((sendError: unknown) => {
      console.error("[whatsapp] tampoco se pudo avisar del error:", sendError);
    });
  }
}

app.listen(config.port, () => {
  console.log(`Agente de WhatsApp escuchando en el puerto ${config.port}`);
  console.log(`Webhook: POST /webhook  ·  Verificación: GET /webhook`);
});
