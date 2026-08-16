import { crm } from "./client.js";

export interface OrderTaskInput {
  /** Vendedor asignado a la cuenta. Puede no haberlo. */
  repId: string | null;
  accountId: string;
  businessName: string;
  orderId: string;
  folio: string;
  total: number;
  botellas: number;
}

export interface OrderTaskResult {
  /** true si le quedó la tarea al vendedor asignado. */
  repNotified: boolean;
  /** Cuántas tareas de vigilancia quedaron para la administración. */
  adminsNotified: number;
  /** Nombre del vendedor asignado, para el aviso. */
  repName: string | null;
}

/**
 * Prioridad alta: es un cliente esperando respuesta, no una tarea generada.
 * En rep_tasks los valores van de 18 a 100.
 */
const PRIORITY = 100;

/**
 * rep_tasks.source tiene un CHECK que sólo acepta 'prospecto', 'cobranza',
 * 'inactivo' y 'manual'. Se usa 'manual' —que es lo que más se le parece: la
 * pidió una persona, no la generó el CRM— en vez de agregar un valor nuevo al
 * CHECK, porque el CRM tiene su propio mapa de etiquetas por source y un valor
 * desconocido se le vería en blanco. El canal real queda en meta.
 */
const SOURCE = "manual";

async function repName(repId: string | null): Promise<string | null> {
  if (!repId) return null;

  const { data } = await crm
    .from("sales_reps")
    .select("full_name")
    .eq("id", repId)
    .maybeSingle();

  return (data?.full_name as string | null) ?? null;
}

async function activeAdminIds(): Promise<string[]> {
  const { data, error } = await crm
    .from("sales_reps")
    .select("id")
    .eq("active", true)
    .eq("role", "admin");

  if (error) {
    console.error("[crm] no se pudo consultar a la administración:", error.message);
    return [];
  }

  return (data ?? []).map((row) => row.id as string);
}

/**
 * Deja en el CRM las tareas de revisar un pedido que entró por Telegram.
 *
 * Es el punto del canal: el cliente puede pedir aunque su vendedora esté de
 * vacaciones o no conteste, pero el pedido entra en borrador y alguien tiene
 * que aceptarlo. Sin estas tareas, ese pedido se queda esperando a que alguien
 * se asome al CRM por casualidad.
 *
 * Se crean dos: la del vendedor asignado y una de vigilancia para la
 * administración, porque el vendedor de vacaciones tampoco va a ver el CRM.
 * Si la cuenta ya está asignada a la propia administradora no se duplica.
 *
 * Nunca tira el pedido: si falla el aviso, el pedido ya está creado y perderlo
 * por no haber podido crear una tarea sería peor.
 */
export async function createOrderTasks(
  input: OrderTaskInput,
): Promise<OrderTaskResult> {
  const total = input.total.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN",
  });

  const resumen = `${input.botellas} botellas, ${total} con IVA`;
  const hoy = new Date().toISOString().slice(0, 10);
  const nombre = await repName(input.repId);

  const base = {
    account_id: input.accountId,
    source: SOURCE,
    due_date: hoy,
    priority: PRIORITY,
    // Un pedido, una tarea por persona: si el pedido se reprocesa no se
    // duplica el aviso, porque el índice único es (sales_rep_id, dedupe_key).
    dedupe_key: `telegram:${input.orderId}`,
    meta: { order_id: input.orderId, folio: input.folio, canal: "telegram" },
  };

  const rows: Array<Record<string, unknown>> = [];

  if (input.repId) {
    rows.push({
      ...base,
      sales_rep_id: input.repId,
      title: `Revisar pedido ${input.folio} de ${input.businessName} (Telegram)`,
      detail:
        `El cliente lo levantó por Telegram: ${resumen}. ` +
        "Está en borrador y no se surte hasta que lo revises y lo aceptes.",
    });
  }

  const admins = (await activeAdminIds()).filter((id) => id !== input.repId);

  for (const adminId of admins) {
    rows.push({
      ...base,
      sales_rep_id: adminId,
      title: `Vigilar pedido ${input.folio} de ${input.businessName} (Telegram)`,
      detail: input.repId
        ? `El cliente lo levantó por Telegram: ${resumen}. Está en borrador, asignado a ${nombre ?? "su vendedor"}. ` +
          "Esta copia es por si esa persona no está viendo el CRM."
        : `El cliente lo levantó por Telegram: ${resumen}. La cuenta NO tiene vendedor asignado, ` +
          "así que nadie más tiene esta tarea.",
    });
  }

  if (rows.length === 0) return { repNotified: false, adminsNotified: 0, repName: nombre };

  const { error } = await crm.from("rep_tasks").insert(rows);

  if (error) {
    console.error("[crm] no se pudieron crear las tareas del pedido:", error.message);
    return { repNotified: false, adminsNotified: 0, repName: nombre };
  }

  return {
    repNotified: input.repId !== null,
    adminsNotified: admins.length,
    repName: nombre,
  };
}
