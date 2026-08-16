import { crm, normalizePhone } from "./crm/client.js";
import { getTelegramIdsForPhones } from "./data/conversations.js";
import { sendText } from "./telegram/client.js";
import type { Prospect } from "./crm/prospects.js";

/**
 * Telegram no tiene ventana de 24 horas ni plantillas, así que podemos avisarle
 * a la administración en cuanto entra un prospecto, sin trámite.
 *
 * El aviso sólo llega a quien ya haya conversado con el bot y compartido su
 * número: sin eso no tenemos su chat_id y no hay a dónde escribirle.
 */
export async function notifyAdminsOfProspect(prospect: Prospect): Promise<void> {
  const { data, error } = await crm
    .from("sales_reps")
    .select("whatsapp")
    .eq("active", true)
    .eq("role", "admin")
    .not("whatsapp", "is", null);

  if (error) {
    console.error("[notify] no se pudo consultar a la administración:", error.message);
    return;
  }

  const phones = (data ?? [])
    .map((row) => normalizePhone(String(row.whatsapp)))
    .filter((phone) => phone.length === 10);

  if (phones.length === 0) return;

  const chatIds = getTelegramIdsForPhones(phones);
  if (chatIds.length === 0) return;

  const lines = [
    "🆕 <b>Prospecto nuevo</b>",
    "",
    `<b>${prospect.negocio}</b>`,
  ];

  if (prospect.contacto) lines.push(`Contacto: ${prospect.contacto}`);
  lines.push(`Teléfono: ${prospect.telefono}`);
  lines.push(`Correo: ${prospect.correo ?? "no lo dio"}`);
  if (prospect.ciudad) lines.push(`Ciudad: ${prospect.ciudad}`);
  if (prospect.interes) lines.push(`Interés: ${prospect.interes}`);
  lines.push("", "Para asignarlo dime a qué vendedor va.");

  const text = lines.join("\n");

  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await sendText(Number(chatId), text);
      } catch (error) {
        // Un aviso fallido no debe tumbar el registro del prospecto.
        console.error(`[notify] no se pudo avisar a ${chatId}:`, error);
      }
    }),
  );
}
