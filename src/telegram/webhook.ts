import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { handleMessage } from "./handler.js";
import { parseUpdate } from "./updates.js";
import type { TelegramUpdate } from "./types.js";

export const router = Router();

/**
 * Telegram reenvía el secreto en X-Telegram-Bot-Api-Secret-Token. Es lo único
 * que distingue un POST legítimo de cualquiera que adivine la URL.
 * Comparación en tiempo constante para no filtrar el secreto por temporización.
 */
export function verifySecret(received: string | undefined): boolean {
  const expected = config.telegram.webhookSecret;
  if (!expected || !received) return false;

  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

router.post("/telegram", (req: Request, res: Response) => {
  if (!verifySecret(req.get("x-telegram-bot-api-secret-token"))) {
    res.sendStatus(401);
    return;
  }

  // Telegram reintenta si tardamos en contestar, así que confirmamos de
  // inmediato y procesamos en segundo plano.
  res.sendStatus(200);

  const message = parseUpdate(req.body as TelegramUpdate);
  if (message) {
    // Ya contestamos 200, así que el fallo sólo puede quedar en el log. El
    // update se suelta solo al fallar: si Telegram lo reentrega, se atiende.
    void handleMessage(message).catch((error: unknown) => {
      console.error(`[telegram] ${message.userId} quedó sin atender:`, error);
    });
  }
});
