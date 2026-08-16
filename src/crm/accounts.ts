import {
  DEFAULT_PRICE_TIER,
  DEFAULT_WAREHOUSE,
  WAREHOUSE_BY_REGION,
} from "../config.js";
import { crm, normalizePhone } from "./client.js";

/** Una cuenta a la que este número de WhatsApp está vinculado. */
export interface AccountCandidate {
  id: string;
  businessName: string;
  contactName: string | null;
  region: string | null;
  warehouse: string;
  priceTier: string;
  assignedRepId: string | null;
  status: string | null;
}

export interface AccountContext {
  /**
   * Cuentas a las que pertenece este número. Puede haber varias: hay
   * compradores que atienden varios negocios del mismo grupo, y el CRM tiene
   * algunas cuentas duplicadas.
   */
  candidates: AccountCandidate[];
  /** La cuenta única, o null si hay ambigüedad que el cliente debe resolver. */
  accountId: string | null;
  /** Almacén que surte a este cliente. */
  warehouse: string;
  /** Nivel de precio aplicable. */
  priceTier: string;
  isKnown: boolean;
  /** true cuando el número apunta a más de una cuenta. */
  isAmbiguous: boolean;
  /**
   * true si las cuentas candidatas difieren en nivel de precio o almacén. En
   * los datos actuales nunca pasa, pero si pasara no se puede cotizar sin
   * saber primero de qué cuenta hablamos.
   */
  conflictingTerms: boolean;
}

interface ContactRow {
  full_name: string | null;
  whatsapp: string | null;
  phone: string | null;
  accounts: {
    id: string;
    business_name: string | null;
    region: string | null;
    price_tier: string | null;
    assigned_rep_id: string | null;
    status: string | null;
  } | null;
}

const UNKNOWN: AccountContext = {
  candidates: [],
  accountId: null,
  warehouse: DEFAULT_WAREHOUSE,
  priceTier: DEFAULT_PRICE_TIER,
  isKnown: false,
  isAmbiguous: false,
  conflictingTerms: false,
};

/**
 * Busca las cuentas del cliente por su número de WhatsApp.
 *
 * La comparación se hace en memoria sobre los últimos 10 dígitos: el campo
 * contacts.whatsapp está capturado en cuatro formatos distintos y ningún
 * índice de Postgres los normaliza. Son ~585 contactos, así que el costo es
 * irrelevante; si algún día crece, conviene una columna generada.
 */
export async function resolveAccount(phone: string): Promise<AccountContext> {
  const target = normalizePhone(phone);
  if (target.length < 10) return UNKNOWN;

  const { data, error } = await crm
    .from("contacts")
    .select(
      "full_name, whatsapp, phone, accounts(id, business_name, region, price_tier, assigned_rep_id, status)",
    )
    .or("whatsapp.not.is.null,phone.not.is.null");

  if (error) {
    console.error("[crm] no se pudo consultar contactos:", error.message);
    return UNKNOWN;
  }

  const rows = (data ?? []) as unknown as ContactRow[];
  const byAccountId = new Map<string, AccountCandidate>();

  for (const row of rows) {
    if (!row.accounts) continue;

    const numbers = [row.whatsapp, row.phone].filter(
      (value): value is string => Boolean(value),
    );
    if (!numbers.some((value) => normalizePhone(value) === target)) continue;

    const account = row.accounts;
    // Un mismo contacto puede aparecer repetido; nos quedamos con una entrada
    // por cuenta y conservamos el primer nombre de persona que encontremos.
    if (byAccountId.has(account.id)) continue;

    byAccountId.set(account.id, {
      id: account.id,
      businessName: account.business_name ?? "(cuenta sin nombre)",
      contactName: row.full_name,
      region: account.region,
      warehouse:
        (account.region ? WAREHOUSE_BY_REGION[account.region] : undefined) ??
        DEFAULT_WAREHOUSE,
      priceTier: account.price_tier ?? DEFAULT_PRICE_TIER,
      assignedRepId: account.assigned_rep_id,
      status: account.status,
    });
  }

  const candidates = [...byAccountId.values()].sort((a, b) =>
    a.businessName.localeCompare(b.businessName),
  );

  const first = candidates[0];
  if (!first) return UNKNOWN;

  const conflictingTerms = candidates.some(
    (c) => c.priceTier !== first.priceTier || c.warehouse !== first.warehouse,
  );

  return {
    candidates,
    accountId: candidates.length === 1 ? first.id : null,
    warehouse: first.warehouse,
    priceTier: first.priceTier,
    isKnown: true,
    isAmbiguous: candidates.length > 1,
    conflictingTerms,
  };
}

/** Busca una cuenta candidata por id. Devuelve null si no pertenece al número. */
export function findCandidate(
  account: AccountContext,
  accountId: string,
): AccountCandidate | null {
  return account.candidates.find((c) => c.id === accountId) ?? null;
}
