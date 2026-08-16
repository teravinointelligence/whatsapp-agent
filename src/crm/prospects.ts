import { crm, normalizePhone } from "./client.js";

export class ProspectError extends Error {}

export interface Prospect {
  id: string;
  negocio: string;
  contacto: string | null;
  telefono: string;
  correo: string | null;
  ciudad: string | null;
  region: string | null;
  interes: string | null;
  estatus: string;
  vendedor: string | null;
  creado: string;
}

interface ProspectRow {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string;
  email: string | null;
  city: string | null;
  region: string | null;
  interest: string | null;
  status: string;
  created_at: string;
  sales_reps: { full_name: string | null } | null;
}

const SELECT_COLUMNS =
  "id, business_name, contact_name, phone, email, city, region, interest, status, created_at, sales_reps(full_name)";

function hydrate(row: ProspectRow): Prospect {
  return {
    id: row.id,
    negocio: row.business_name,
    contacto: row.contact_name,
    telefono: row.phone,
    correo: row.email,
    ciudad: row.city,
    region: row.region,
    interes: row.interest,
    estatus: row.status,
    vendedor: row.sales_reps?.full_name ?? null,
    creado: row.created_at,
  };
}

export interface RegisterProspectInput {
  /** Teléfono verificado que compartió por Telegram. Lo pone el servidor. */
  phone: string;
  telegramUserId: string;
  businessName: string;
  contactName?: string;
  /** Correo para cotizaciones y facturas. */
  email?: string;
  city?: string;
  interest?: string;
}

export interface RegisteredProspect {
  prospect: Prospect;
  /** false cuando ya existía y sólo se actualizó. */
  isNew: boolean;
  /** true si venía un correo con forma inválida y no se guardó. */
  emailRejected: boolean;
}

/**
 * Comprobación deliberadamente laxa: sólo descarta lo que no puede ser un
 * correo. Dictar un correo por chat sale mal seguido —"arroba", espacios de
 * más, el nombre en vez de la dirección— y guardar eso significa mandar la
 * factura al vacío. Pero tampoco queremos rechazar un dominio raro que sí
 * existe, así que no validamos más allá de la forma.
 */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(value);
}

/**
 * Registra —o actualiza— el prospecto de este teléfono.
 *
 * Si la persona vuelve a escribir días después no se duplica el registro: se
 * completa con lo nuevo que haya dicho. Una vez asignado o convertido, el
 * estatus no se toca para no deshacer el trabajo de la administración.
 */
export async function registerProspect(
  input: RegisterProspectInput,
): Promise<RegisteredProspect> {
  const businessName = input.businessName.trim();
  if (!businessName) {
    throw new ProspectError("Falta el nombre del negocio.");
  }

  const { data: existingRow, error: findError } = await crm
    .from("prospects")
    .select("id, status")
    .eq("phone", input.phone)
    .maybeSingle();

  if (findError) {
    throw new ProspectError(`No se pudo consultar prospectos: ${findError.message}`);
  }

  const patch: Record<string, unknown> = {
    business_name: businessName,
    phone: input.phone,
    telegram_user_id: input.telegramUserId,
    updated_at: new Date().toISOString(),
  };

  if (input.contactName?.trim()) patch.contact_name = input.contactName.trim();
  if (input.city?.trim()) patch.city = input.city.trim();
  if (input.interest?.trim()) patch.interest = input.interest.trim();

  // El correo que no pasa la comprobación no se guarda, pero tampoco tira el
  // registro: perder al prospecto por una arroba mal dictada sería peor.
  const email = input.email?.trim().toLowerCase() ?? "";
  const emailRejected = email !== "" && !looksLikeEmail(email);
  if (email && !emailRejected) patch.email = email;

  if (existingRow) {
    const { data, error } = await crm
      .from("prospects")
      .update(patch)
      .eq("id", existingRow.id)
      .select(SELECT_COLUMNS)
      .single();

    if (error) {
      throw new ProspectError(`No se pudo actualizar el prospecto: ${error.message}`);
    }
    return {
      prospect: hydrate(data as unknown as ProspectRow),
      isNew: false,
      emailRejected,
    };
  }

  const { data, error } = await crm
    .from("prospects")
    .insert({ ...patch, source: "telegram" })
    .select(SELECT_COLUMNS)
    .single();

  if (error) {
    throw new ProspectError(`No se pudo registrar el prospecto: ${error.message}`);
  }

  return {
    prospect: hydrate(data as unknown as ProspectRow),
    isNew: true,
    emailRejected,
  };
}

/** Lista prospectos, opcionalmente filtrando por estatus. */
export async function listProspects(
  status?: string,
  limit = 15,
): Promise<Prospect[]> {
  let builder = crm.from("prospects").select(SELECT_COLUMNS);

  if (status) builder = builder.eq("status", status);

  const { data, error } = await builder
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[crm] no se pudieron leer prospectos:", error.message);
    return [];
  }

  return (data as unknown as ProspectRow[]).map(hydrate);
}

export interface RepOption {
  id: string;
  name: string;
  region: string | null;
}

/** Vendedores activos, para poder asignarles un prospecto. */
export async function listReps(): Promise<RepOption[]> {
  const { data, error } = await crm
    .from("sales_reps")
    .select("id, full_name, primary_region")
    .eq("active", true)
    .eq("role", "rep")
    .order("full_name");

  if (error) return [];

  return (data ?? []).map((row) => ({
    id: row.id as string,
    name: (row.full_name as string | null) ?? "(sin nombre)",
    region: row.primary_region as string | null,
  }));
}

/**
 * Asigna el prospecto a un vendedor, buscándolo por nombre.
 *
 * Si el nombre coincide con varios se rechaza en vez de elegir: asignar al
 * vendedor equivocado le quita la cuenta a quien le tocaba.
 */
export async function assignProspect(
  prospectId: string,
  repName: string,
): Promise<Prospect> {
  const reps = await listReps();
  const needle = normalizeName(repName);

  if (!needle) {
    throw new ProspectError("Falta el nombre del vendedor.");
  }

  const matches = reps.filter((rep) => normalizeName(rep.name).includes(needle));

  if (matches.length === 0) {
    const nombres = reps.map((r) => r.name).join(", ");
    throw new ProspectError(
      `No hay vendedor activo que coincida con "${repName}". Los vendedores son: ${nombres}.`,
    );
  }
  if (matches.length > 1) {
    const nombres = matches.map((r) => r.name).join(", ");
    throw new ProspectError(
      `"${repName}" coincide con varios vendedores (${nombres}). Sé más específica.`,
    );
  }

  const rep = matches[0]!;

  const { data, error } = await crm
    .from("prospects")
    .update({
      assigned_rep_id: rep.id,
      assigned_at: new Date().toISOString(),
      status: "asignado",
      updated_at: new Date().toISOString(),
    })
    .eq("id", prospectId)
    .select(SELECT_COLUMNS)
    .maybeSingle();

  if (error) {
    throw new ProspectError(`No se pudo asignar: ${error.message}`);
  }
  if (!data) {
    throw new ProspectError("No existe un prospecto con ese id.");
  }

  return hydrate(data as unknown as ProspectRow);
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
