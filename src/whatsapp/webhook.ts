import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import type { IncomingMessage, WhatsAppWebhookBody } from "./types.js";

export const router = Router();

/**
 * Meta firma el cuerpo crudo con el App Secret. Hay que comparar contra los
 * bytes exactos que llegaron, no contra el JSON re-serializado.
 */
export function verifySignature(raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;

  const expected = crypto
    .createHmac("sha256", config.whatsapp.appSecret)
    .update(raw)
    .digest("hex");

  const received = header.slice("sha256=".length);

  // Longitudes distintas hacen que timingSafeEqual lance en vez de devolver false.
  if (received.length !== expected.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(received, "hex"),
    Buffer.from(expected, "hex"),
  );
}

/** Extrae los mensajes de texto utilizables del payload del webhook. */
export function parseMessages(body: WhatsAppWebhookBody): IncomingMessage[] {
  const out: IncomingMessage[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      // Los webhooks de estado (entregado/leído) no traen 'messages'.
      if (!value?.messages) continue;

      const profileByWaId = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
      );

      for (const message of value.messages) {
        let text: string | undefined;

        if (message.type === "text") {
          text = message.text?.body;
        } else if (message.type === "interactive") {
          text =
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title;
        } else if (message.type === "button") {
          text = message.button?.text;
        }

        if (!text?.trim()) continue;

        out.push({
          from: message.from,
          messageId: message.id,
          profileName: profileByWaId.get(message.from) ?? null,
          text: text.trim(),
        });
      }
    }
  }

  return out;
}

/** Handshake de verificación que Meta ejecuta al registrar el webhook. */
router.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    res.status(200).send(String(challenge ?? ""));
    return;
  }

  res.sendStatus(403);
});
