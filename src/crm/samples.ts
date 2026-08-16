import { crm } from "./client.js";

export class SampleError extends Error {}

export interface SampleRequest {
  folio: string | null;
  cuenta: string | null;
  vendedor: string | null;
  estatus: string;
  motivo: string | null;
  /** Botellas pedidas, sumando las partidas. */
  botellas: number;
  productos: string[];
  solicitada: string;
  enviarEl: string | null;
}

interface SampleRow {
  request_number: string | null;
  status: string | null;
  reason: string | null;
  created_at: string;
  ship_date: string | null;
  accounts: { business_name: string | null } | null;
  sales_reps: { full_name: string | null } | null;
  sample_request_items: Array<{ product_name: string | null; quantity: number | null }>;
}

/**
 * sample_requests tiene tres llaves a sales_reps (quien la pide, quien la
 * revisa y quien la cancela), así que hay que decirle a PostgREST cuál embeber.
 */
const SELECT_COLUMNS =
  "request_number, status, reason, created_at, ship_date, " +
  "accounts(business_name), " +
  "sales_reps!sample_requests_sales_rep_id_fkey(full_name), " +
  "sample_request_items(product_name, quantity)";

/**
 * Estatus de las solicitudes que todavía nadie revisó.
 *
 * En el CRM son las que están en 'borrador': todas las demás
 * —aprobada, rechazada, entregada, cancelada— ya pasaron por revisión.
 */
export const PENDING_STATUS = "borrador";

function hydrate(row: SampleRow): SampleRequest {
  const items = row.sample_request_items ?? [];
  return {
    folio: row.request_number,
    cuenta: row.accounts?.business_name ?? null,
    vendedor: row.sales_reps?.full_name ?? null,
    estatus: row.status ?? "(sin estatus)",
    motivo: row.reason,
    botellas: items.reduce((sum, item) => sum + Number(item.quantity ?? 0), 0),
    productos: items
      .map((item) => item.product_name)
      .filter((name): name is string => Boolean(name)),
    solicitada: row.created_at,
    enviarEl: row.ship_date,
  };
}

/**
 * Solicitudes de muestra. Sin argumentos devuelve las que faltan por revisar.
 */
export async function listSampleRequests(
  status: string = PENDING_STATUS,
  limit = 15,
): Promise<SampleRequest[]> {
  let builder = crm.from("sample_requests").select(SELECT_COLUMNS);

  if (status !== "todas") builder = builder.eq("status", status);

  const { data, error } = await builder
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new SampleError(`No se pudieron leer las muestras: ${error.message}`);
  }

  return (data as unknown as SampleRow[]).map(hydrate);
}
