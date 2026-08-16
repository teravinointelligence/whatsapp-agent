import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";

/**
 * Cliente del CRM (Supabase `teravino-crm`).
 *
 * Usa la service role key, así que evita RLS: toda la autorización la hace el
 * servidor resolviendo la cuenta a partir del número de WhatsApp. El agente
 * nunca elige de qué cuenta lee o escribe.
 */
export const crm = createClient(config.crm.url, config.crm.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Deja sólo dígitos y se queda con los últimos 10.
 *
 * El campo contacts.whatsapp está capturado en cuatro formatos distintos
 * ("+52 1 612 ...", "52612...", "612 212 5216", "6122125216") y Meta manda
 * "521612...". Los últimos 10 dígitos son el denominador común.
 */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.slice(-10);
}
