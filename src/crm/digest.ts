import { crm } from "./client.js";

/** Cuántos días pasaron desde una fecha ISO, contra hoy. */
function daysSince(value: string | null): number {
  if (!value) return 0;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

export interface PendingOrder {
  id: string;
  folio: string;
  negocio: string;
  vendedor: string | null;
  total: number;
  dias: number;
}

/**
 * Pedidos que siguen en borrador, del más viejo al más nuevo.
 *
 * Un borrador es un cliente esperando: mientras nadie lo acepte, no se surte.
 */
export async function pendingOrders(minDays = 0): Promise<PendingOrder[]> {
  const { data, error } = await crm
    .from("orders")
    .select(
      "id, order_number, order_date, created_at, total, accounts(business_name), sales_reps!orders_sales_rep_id_fkey(full_name)",
    )
    .eq("status", "borrador")
    .order("created_at");

  if (error) {
    console.error("[crm] no se pudieron leer los borradores:", error.message);
    return [];
  }

  return (data ?? [])
    .map((row) => {
      const account = row.accounts as unknown as { business_name: string | null } | null;
      const rep = row.sales_reps as unknown as { full_name: string | null } | null;
      return {
        id: row.id as string,
        folio: (row.order_number as string | null) ?? "(sin folio)",
        negocio: account?.business_name ?? "(cuenta sin nombre)",
        vendedor: rep?.full_name ?? null,
        total: Number(row.total ?? 0),
        dias: daysSince((row.created_at as string | null) ?? (row.order_date as string | null)),
      };
    })
    .filter((order) => order.dias >= minDays);
}

export interface Cobranza {
  clientesVencidos: number;
  saldoVencido: number;
  venceEstaSemana: number;
  montoEstaSemana: number;
  peores: Array<{ negocio: string; saldo: number; dias: number }>;
}

/** Foto de la cobranza: lo vencido y lo que está por vencerse. */
export async function cobranza(): Promise<Cobranza> {
  const { data, error } = await crm
    .from("invoices")
    .select("due_date, balance, account_id, accounts(business_name)")
    .gt("balance", 0);

  if (error) {
    console.error("[crm] no se pudo leer la cobranza:", error.message);
    return {
      clientesVencidos: 0,
      saldoVencido: 0,
      venceEstaSemana: 0,
      montoEstaSemana: 0,
      peores: [],
    };
  }

  const hoy = Date.now();
  const semana = hoy + 7 * 86_400_000;
  const porCuenta = new Map<string, { negocio: string; saldo: number; dias: number }>();

  let saldoVencido = 0;
  let venceEstaSemana = 0;
  let montoEstaSemana = 0;

  for (const row of data ?? []) {
    const saldo = Number(row.balance ?? 0);
    const due = row.due_date ? new Date(`${row.due_date}T00:00:00Z`).getTime() : null;
    if (due === null) continue;

    if (due < hoy) {
      saldoVencido += saldo;
      const account = row.accounts as unknown as { business_name: string | null } | null;
      const key = row.account_id as string;
      const dias = Math.floor((hoy - due) / 86_400_000);
      const previo = porCuenta.get(key);
      porCuenta.set(key, {
        negocio: account?.business_name ?? "(cuenta sin nombre)",
        saldo: (previo?.saldo ?? 0) + saldo,
        dias: Math.max(previo?.dias ?? 0, dias),
      });
    } else if (due <= semana) {
      venceEstaSemana += 1;
      montoEstaSemana += saldo;
    }
  }

  const peores = [...porCuenta.values()]
    .sort((a, b) => b.saldo - a.saldo)
    .slice(0, 3)
    .map((item) => ({ ...item, saldo: Number(item.saldo.toFixed(2)) }));

  return {
    clientesVencidos: porCuenta.size,
    saldoVencido: Number(saldoVencido.toFixed(2)),
    venceEstaSemana,
    montoEstaSemana: Number(montoEstaSemana.toFixed(2)),
    peores,
  };
}

export interface DormantAccount {
  negocio: string;
  vendedor: string;
  dias: number | null;
}

/**
 * Cuentas activas que llevan mucho sin pedir, agrupadas por vendedor.
 *
 * Se leen todos los pedidos una vez y se cruzan en memoria: son 85 pedidos y
 * 464 cuentas, así que sale más barato que una consulta por cuenta.
 */
export async function dormantAccounts(days = 60): Promise<Map<string, DormantAccount[]>> {
  const [accounts, orders] = await Promise.all([
    crm
      .from("accounts")
      .select("id, business_name, status, sales_reps!accounts_assigned_rep_id_fkey(full_name)")
      .eq("status", "activo"),
    crm.from("orders").select("account_id, order_date").neq("status", "cancelada"),
  ]);

  if (accounts.error) {
    console.error("[crm] no se pudieron leer las cuentas:", accounts.error.message);
    return new Map();
  }

  const ultimo = new Map<string, number>();
  for (const row of orders.data ?? []) {
    const fecha = row.order_date ? new Date(`${row.order_date}T00:00:00Z`).getTime() : 0;
    const key = row.account_id as string;
    ultimo.set(key, Math.max(ultimo.get(key) ?? 0, fecha));
  }

  const corte = Date.now() - days * 86_400_000;
  const porVendedor = new Map<string, DormantAccount[]>();

  for (const row of accounts.data ?? []) {
    const last = ultimo.get(row.id as string) ?? 0;
    if (last >= corte) continue;

    const rep = row.sales_reps as unknown as { full_name: string | null } | null;
    const vendedor = rep?.full_name ?? "Sin vendedor asignado";
    const lista = porVendedor.get(vendedor) ?? [];

    lista.push({
      negocio: (row.business_name as string | null) ?? "(cuenta sin nombre)",
      vendedor,
      dias: last === 0 ? null : Math.floor((Date.now() - last) / 86_400_000),
    });
    porVendedor.set(vendedor, lista);
  }

  for (const lista of porVendedor.values()) {
    // Primero quien lleva más tiempo callado; null (nunca pidió) hasta arriba.
    lista.sort((a, b) => (b.dias ?? Infinity) - (a.dias ?? Infinity));
  }

  return porVendedor;
}

export interface DigestCounts {
  prospectosNuevos: number;
  muestrasPorRevisar: number;
  tareasVencidas: number;
}

/** Los conteos sueltos del resumen diario. */
export async function digestCounts(): Promise<DigestCounts> {
  const hoy = new Date().toISOString().slice(0, 10);

  const [prospectos, muestras, tareas] = await Promise.all([
    crm.from("prospects").select("id", { count: "exact", head: true }).eq("status", "nuevo"),
    crm
      .from("sample_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "borrador"),
    crm
      .from("rep_tasks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendiente")
      .lt("due_date", hoy),
  ]);

  return {
    prospectosNuevos: prospectos.count ?? 0,
    muestrasPorRevisar: muestras.count ?? 0,
    tareasVencidas: tareas.count ?? 0,
  };
}
