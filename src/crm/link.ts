import { DEFAULT_PRICE_TIER, DEFAULT_WAREHOUSE, WAREHOUSE_BY_REGION } from "../config.js";
import { crm, normalizePhone } from "./client.js";

export class LinkError extends Error {}

export interface LinkableAccount {
  id: string;
  businessName: string;
  clientNumber: string | null;
  region: string | null;
  warehouse: string;
  priceTier: string;
  status: string | null;
}

interface AccountRow {
  id: string;
  business_name: string | null;
  client_number: string | null;
  region: string | null;
  price_tier: string | null;
  status: string | null;
}

function hydrate(row: AccountRow): LinkableAccount {
  return {
    id: row.id,
    businessName: row.business_name ?? "(cuenta sin nombre)",
    clientNumber: row.client_number,
    region: row.region,
    warehouse:
      (row.region ? WAREHOUSE_BY_REGION[row.region] : undefined) ?? DEFAULT_WAREHOUSE,
    priceTier: row.price_tier ?? DEFAULT_PRICE_TIER,
    status: row.status,
  };
}

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Cuentas con ese número de cliente.
 *
 * Devuelve una lista porque hay 8 números repetidos en dos cuentas (The Woods
 * y Diamante 88 son la 228, Mozza y Delphine la 449). Elegir por nuestra
 * cuenta sería vincular a la persona con el negocio equivocado.
 */
export async function findAccountsByClientNumber(
  clientNumber: string,
): Promise<LinkableAccount[]> {
  // "el 0270" y "cliente 270" son el mismo 270: en el CRM están capturados
  // como enteros sin ceros a la izquierda.
  const wanted = clientNumber.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (!wanted) return [];

  const { data, error } = await crm
    .from("accounts")
    .select("id, business_name, client_number, region, price_tier, status")
    .eq("client_number", wanted);

  if (error) {
    throw new LinkError(`No se pudo consultar el padrón: ${error.message}`);
  }

  return ((data ?? []) as AccountRow[]).map(hydrate);
}

export interface LinkResult {
  account: LinkableAccount;
  /** true si se creó un contacto nuevo; false si ya existía con ese nombre. */
  contactCreated: boolean;
}

/**
 * Deja el teléfono verificado colgando de la cuenta, como contacto.
 *
 * A partir de aquí el cliente se reconoce solo por su número, sin volver a dar
 * el número de cliente. Nunca se pisa el teléfono de un contacto que ya tenía
 * uno: dos personas del mismo hotel pueden llamarse igual, y sobrescribir el
 * número de la otra la dejaría fuera.
 */
export async function linkPhoneToAccount(input: {
  account: LinkableAccount;
  phone: string;
  fullName: string;
}): Promise<LinkResult> {
  const fullName = input.fullName.trim();
  if (!fullName) {
    throw new LinkError("Falta el nombre de la persona.");
  }

  const phone = normalizePhone(input.phone);
  if (phone.length !== 10) {
    throw new LinkError("El teléfono verificado no tiene forma de número mexicano.");
  }

  const { data: existing, error: findError } = await crm
    .from("contacts")
    .select("id, full_name, whatsapp, phone")
    .eq("account_id", input.account.id);

  if (findError) {
    throw new LinkError(`No se pudieron leer los contactos: ${findError.message}`);
  }

  const needle = normalizeName(fullName);
  const sameName = (existing ?? []).find(
    (row) => normalizeName(String(row.full_name ?? "")) === needle,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const note = `Se identificó por Telegram con su número de cliente el ${stamp}.`;

  if (sameName && !sameName.whatsapp && !sameName.phone) {
    const { error } = await crm
      .from("contacts")
      .update({ whatsapp: phone, notes: note })
      .eq("id", sameName.id);

    if (error) {
      throw new LinkError(`No se pudo guardar el teléfono: ${error.message}`);
    }
    return { account: input.account, contactCreated: false };
  }

  if (sameName) {
    // Ya está en el CRM con otro teléfono. No se toca; se agrega el nuevo
    // número como contacto aparte para que el vendedor decida si es la misma
    // persona con otra línea.
    const { error } = await crm.from("contacts").insert({
      account_id: input.account.id,
      full_name: fullName,
      whatsapp: phone,
      notes: `${note} Ya existía un contacto con este nombre y otro teléfono.`,
    });

    if (error) {
      throw new LinkError(`No se pudo registrar el contacto: ${error.message}`);
    }
    return { account: input.account, contactCreated: true };
  }

  const { error } = await crm.from("contacts").insert({
    account_id: input.account.id,
    full_name: fullName,
    whatsapp: phone,
    notes: note,
  });

  if (error) {
    throw new LinkError(`No se pudo registrar el contacto: ${error.message}`);
  }

  return { account: input.account, contactCreated: true };
}
