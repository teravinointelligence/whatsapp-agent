import { crm, normalizePhone } from "./client.js";

/** Alguien del equipo de Teravino, identificado por su número. */
export interface StaffContext {
  id: string;
  name: string;
  /** admin, rep, chofer, contador, jefe_logistica… */
  role: string;
  region: string | null;
  /** true sólo para 'admin': ve todo sin restricción de región. */
  isAdmin: boolean;
}

interface StaffRow {
  id: string;
  full_name: string | null;
  role: string | null;
  primary_region: string | null;
  whatsapp: string | null;
  active: boolean | null;
}

/**
 * Busca a la persona en sales_reps por su número.
 *
 * Igual que con los contactos, la comparación se hace sobre los últimos 10
 * dígitos porque el campo está capturado en formatos heterogéneos. Son 14
 * registros, así que traerlos todos no cuesta nada.
 *
 * Sólo cuenta el personal activo: a quien se da de baja se le retira el acceso
 * al quitarle `active`, sin tocar código.
 */
export async function resolveStaff(phone: string): Promise<StaffContext | null> {
  const target = normalizePhone(phone);
  if (target.length < 10) return null;

  const { data, error } = await crm
    .from("sales_reps")
    .select("id, full_name, role, primary_region, whatsapp, active")
    .eq("active", true)
    .not("whatsapp", "is", null);

  if (error) {
    console.error("[crm] no se pudo consultar al equipo:", error.message);
    return null;
  }

  const match = (data as StaffRow[] | null)?.find(
    (row) => row.whatsapp && normalizePhone(row.whatsapp) === target,
  );

  if (!match) return null;

  return {
    id: match.id,
    name: match.full_name ?? "(sin nombre)",
    role: match.role ?? "rep",
    region: match.primary_region,
    isAdmin: match.role === "admin",
  };
}

export interface AccountSummary {
  id: string;
  nombre: string;
  region: string | null;
  nivelPrecio: string | null;
  estatus: string | null;
  numeroCliente: string | null;
  diasCredito: number | null;
}

/**
 * Busca cuentas por nombre. Sólo la usa el personal: un cliente no puede
 * consultar los datos de otro.
 */
export async function searchAccounts(query: string): Promise<AccountSummary[]> {
  const safe = query.trim().replace(/[,()*%]/g, " ").trim();
  if (!safe) return [];

  const { data, error } = await crm
    .from("accounts")
    .select("id, business_name, region, price_tier, status, client_number, credit_days")
    .ilike("business_name", `%${safe}%`)
    .order("business_name")
    .limit(10);

  if (error) {
    console.error("[crm] no se pudieron buscar cuentas:", error.message);
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    nombre: (row.business_name as string | null) ?? "(sin nombre)",
    region: row.region as string | null,
    nivelPrecio: row.price_tier as string | null,
    estatus: row.status as string | null,
    numeroCliente: row.client_number as string | null,
    diasCredito: row.credit_days as number | null,
  }));
}
