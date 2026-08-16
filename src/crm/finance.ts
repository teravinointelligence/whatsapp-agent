import { crm } from "./client.js";

export class FinanceError extends Error {}

export interface OpenInvoice {
  folio: string | null;
  fecha: string | null;
  vence: string | null;
  total: number;
  saldo: number;
  estatus: string | null;
  /** Días vencida al día de hoy. 0 si todavía no vence. */
  diasVencida: number;
}

export interface Statement {
  cuentaId: string;
  negocio: string;
  numeroCliente: string | null;
  diasCredito: number | null;
  saldoTotal: number;
  vencido: number;
  porVencer: number;
  facturasAbiertas: number;
  /** Reparto del saldo VENCIDO por antigüedad, en días. */
  antiguedad: { d1a30: number; d31a60: number; d61a90: number; d91omas: number };
  facturas: OpenInvoice[];
  ultimoPago: { fecha: string | null; monto: number } | null;
  ultimoEnvio: { fecha: string; destinatarios: number } | null;
}

interface InvoiceRow {
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total: number | null;
  balance: number | null;
  status: string | null;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

/** Días transcurridos desde `date` hasta hoy. Negativo si aún no llega. */
function daysSince(date: string | null): number {
  if (!date) return 0;
  const diff = Date.now() - new Date(`${date}T00:00:00Z`).getTime();
  return Math.floor(diff / 86_400_000);
}

/**
 * Estado de cuenta de una cuenta: saldo, antigüedad y facturas abiertas.
 *
 * La antigüedad se calcula contra la fecha de vencimiento y el día de hoy, no
 * contra client_balance_snapshots: ese corte es de la última vez que se generó
 * y aquí lo que se quiere saber es cómo está la cuenta ahorita.
 */
export async function getStatement(accountId: string): Promise<Statement> {
  const { data: account, error: accountError } = await crm
    .from("accounts")
    .select("id, business_name, client_number, credit_days")
    .eq("id", accountId)
    .maybeSingle();

  if (accountError) {
    throw new FinanceError(`No se pudo leer la cuenta: ${accountError.message}`);
  }
  if (!account) {
    throw new FinanceError("No existe una cuenta con ese id.");
  }

  const { data: invoiceRows, error: invoiceError } = await crm
    .from("invoices")
    .select("invoice_number, invoice_date, due_date, total, balance, status")
    .eq("account_id", accountId)
    .gt("balance", 0)
    .order("due_date");

  if (invoiceError) {
    throw new FinanceError(`No se pudieron leer las facturas: ${invoiceError.message}`);
  }

  const facturas: OpenInvoice[] = ((invoiceRows ?? []) as InvoiceRow[]).map((row) => {
    const vencida = Math.max(0, daysSince(row.due_date));
    return {
      folio: row.invoice_number,
      fecha: row.invoice_date,
      vence: row.due_date,
      total: round(Number(row.total ?? 0)),
      saldo: round(Number(row.balance ?? 0)),
      estatus: row.status,
      diasVencida: vencida,
    };
  });

  const antiguedad = { d1a30: 0, d31a60: 0, d61a90: 0, d91omas: 0 };
  let vencido = 0;
  let porVencer = 0;

  for (const factura of facturas) {
    if (factura.diasVencida <= 0) {
      porVencer += factura.saldo;
      continue;
    }
    vencido += factura.saldo;
    if (factura.diasVencida <= 30) antiguedad.d1a30 += factura.saldo;
    else if (factura.diasVencida <= 60) antiguedad.d31a60 += factura.saldo;
    else if (factura.diasVencida <= 90) antiguedad.d61a90 += factura.saldo;
    else antiguedad.d91omas += factura.saldo;
  }

  const { data: pago } = await crm
    .from("payments")
    .select("payment_date, amount")
    .eq("account_id", accountId)
    .order("payment_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: envio } = await crm
    .from("client_email_log")
    .select("created_at, recipient_count")
    .eq("account_id", accountId)
    .eq("kind", "estado_cuenta")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    cuentaId: account.id as string,
    negocio: (account.business_name as string | null) ?? "(sin nombre)",
    numeroCliente: account.client_number as string | null,
    diasCredito: account.credit_days as number | null,
    saldoTotal: round(vencido + porVencer),
    vencido: round(vencido),
    porVencer: round(porVencer),
    facturasAbiertas: facturas.length,
    antiguedad: {
      d1a30: round(antiguedad.d1a30),
      d31a60: round(antiguedad.d31a60),
      d61a90: round(antiguedad.d61a90),
      d91omas: round(antiguedad.d91omas),
    },
    // Las más vencidas primero: es lo que se cobra.
    facturas: [...facturas]
      .sort((a, b) => b.diasVencida - a.diasVencida)
      .slice(0, 10),
    ultimoPago: pago
      ? {
          fecha: (pago.payment_date as string | null) ?? null,
          monto: round(Number(pago.amount ?? 0)),
        }
      : null,
    ultimoEnvio: envio
      ? {
          fecha: String(envio.created_at),
          destinatarios: Number(envio.recipient_count ?? 0),
        }
      : null,
  };
}

export interface StatementEmail {
  fecha: string;
  asunto: string | null;
  destinatarios: number;
}

/** Historial de envíos de estado de cuenta de una cuenta. */
export async function listStatementEmails(
  accountId: string,
  limit = 10,
): Promise<StatementEmail[]> {
  const { data, error } = await crm
    .from("client_email_log")
    .select("created_at, subject, recipient_count")
    .eq("account_id", accountId)
    .eq("kind", "estado_cuenta")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new FinanceError(`No se pudo leer el historial de envíos: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    fecha: String(row.created_at),
    asunto: row.subject as string | null,
    destinatarios: Number(row.recipient_count ?? 0),
  }));
}
