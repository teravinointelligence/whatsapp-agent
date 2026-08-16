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
/** Manda el mismo texto a la administración, sin tumbar nada si falla. */
async function tellAdmins(text: string): Promise<void> {
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

  await Promise.all(
    chatIds.map(async (chatId) => {
      try {
        await sendText(Number(chatId), text);
      } catch (error) {
        // Un aviso fallido no debe tumbar la operación que lo disparó.
        console.error(`[notify] no se pudo avisar a ${chatId}:`, error);
      }
    }),
  );
}

export async function notifyAdminsOfProspect(prospect: Prospect): Promise<void> {
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

  await tellAdmins(lines.join("\n"));
}

/**
 * Aviso de que entró un pedido por el canal.
 *
 * El pedido ya le dejó tarea a su vendedor en el CRM, pero justamente el caso
 * que este canal atiende es que el vendedor no esté disponible —vacaciones, día
 * de descanso, ruta—, así que la administración se entera también y puede
 * cubrirlo. Cuando la cuenta no tiene vendedor asignado, este aviso es el único.
 */
export async function notifyAdminsOfOrder(order: {
  folio: string;
  businessName: string;
  total: number;
  botellas: number;
  warehouse: string;
  repNotified: boolean;
  repName: string | null;
  adminTasks: number;
}): Promise<void> {
  const total = order.total.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });

  const lines = [
    "🧾 <b>Pedido nuevo por Telegram</b>",
    "",
    `<b>${order.businessName}</b>`,
    `Folio ${order.folio} · ${order.botellas} botellas · ${total} con IVA`,
    `Almacén: ${order.warehouse}`,
    "",
  ];

  if (order.repNotified) {
    lines.push(
      `Le quedó la tarea de revisarlo a ${order.repName ?? "su vendedor"} en el CRM.`,
    );
  } else {
    lines.push("⚠️ Esta cuenta no tiene vendedor asignado.");
  }

  if (order.adminTasks > 0) {
    lines.push("También te quedó a ti en tus tareas, para que no se atore.");
  }

  await tellAdmins(lines.join("\n"));
}

/**
 * Aviso de que un cliente consultó su propio estado de cuenta.
 *
 * Se avisa siempre, aunque haya pasado el filtro: el saldo es información
 * sensible y conviene que quede a la vista de quién lo pidió y desde qué
 * número, no sólo en los logs del servidor.
 */
export async function notifyAdminsOfStatementRequest(request: {
  businessName: string;
  clientNumber: string | null;
  email: string;
  phone: string;
  balance: number;
}): Promise<void> {
  const saldo = request.balance.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });

  await tellAdmins(
    [
      "📄 <b>Un cliente consultó su estado de cuenta</b>",
      "",
      `<b>${request.businessName}</b>${request.clientNumber ? ` (cliente ${request.clientNumber})` : ""}`,
      `Se identificó con: ${request.email}`,
      `Teléfono: ${request.phone}`,
      `Saldo que se le informó: ${saldo}`,
    ].join("\n"),
  );
}

/**
 * Aviso de que un teléfono se ligó solo a una cuenta dando su número de
 * cliente.
 *
 * Es la contraparte de dejar que el cliente se identifique sin intervención
 * humana: si alguien se cuelga de una cuenta que no es suya, se ve en el acto
 * y el contacto se puede borrar del CRM.
 */
export async function notifyAdminsOfAccountLink(link: {
  businessName: string;
  clientNumber: string | null;
  personName: string;
  phone: string;
  contactCreated: boolean;
}): Promise<void> {
  const lines = [
    "🔗 <b>Cliente se identificó por Telegram</b>",
    "",
    `<b>${link.businessName}</b>${link.clientNumber ? ` (cliente ${link.clientNumber})` : ""}`,
    `Persona: ${link.personName}`,
    `Teléfono: ${link.phone}`,
    link.contactCreated
      ? "Se registró como contacto nuevo de la cuenta."
      : "Ya estaba en el CRM; se le agregó este teléfono.",
    "",
    "Si no lo reconoces, borra el contacto en el CRM y avísame.",
  ];

  await tellAdmins(lines.join("\n"));
}
