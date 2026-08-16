import { config } from "../config.js";
import { crm } from "./client.js";
import { getProductBySku } from "./catalog.js";
import { findCandidate, type AccountCandidate, type AccountContext } from "./accounts.js";
import { createOrderTasks } from "./tasks.js";

export class OrderError extends Error {}

/** IVA mexicano. Los precios del catálogo se manejan sin IVA. */
const IVA_RATE = 0.16;

export interface OrderItemInput {
  sku: string;
  cantidad: number;
}

export interface CreatedOrder {
  folio: string;
  estado: string;
  almacen: string;
  subtotal: number;
  iva: number;
  total: number;
  /** Cuenta a la que quedó, para el aviso a la administración. */
  cuentaId: string;
  negocio: string;
  /** true si le quedó la tarea al vendedor asignado en el CRM. */
  avisoAlVendedor: boolean;
  /** Vendedor asignado a la cuenta, si lo hay. */
  vendedor: string | null;
  /** Cuántas tareas de vigilancia le quedaron a la administración. */
  avisosAdmin: number;
  partidas: Array<{
    sku: string | null;
    nombre: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }>;
}

/**
 * Genera el siguiente folio con el formato que ya usa el CRM: PED-2026-0050.
 *
 * Hay una carrera teórica si dos pedidos se crean en el mismo instante; con el
 * volumen actual (84 pedidos históricos) no compensa un contador transaccional.
 * Si algún día importa, conviene una secuencia en Postgres.
 */
async function nextOrderNumber(): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `${config.crm.orderPrefix}-${year}-`;

  const { data, error } = await crm
    .from("orders")
    .select("order_number")
    .like("order_number", `${prefix}%`)
    .order("order_number", { ascending: false })
    .limit(1);

  if (error) {
    throw new OrderError(`No se pudo generar el folio: ${error.message}`);
  }

  const last = data?.[0]?.order_number as string | undefined;
  const lastSeq = last ? Number(last.slice(prefix.length)) : 0;
  const next = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;

  return `${prefix}${String(next).padStart(4, "0")}`;
}

export interface CreateOrderInput {
  account: AccountContext;
  items: OrderItemInput[];
  notes?: string;
  /** Requerido sólo cuando el número apunta a varias cuentas. */
  accountId?: string;
}

/**
 * Decide a qué cuenta se factura.
 *
 * Si el número apunta a una sola cuenta, se usa ésa y el id que mande el
 * agente es irrelevante. Si apunta a varias, el agente debe elegir, pero sólo
 * puede elegir entre las candidatas de ese número: un id ajeno se rechaza.
 */
function resolveTargetAccount(
  account: AccountContext,
  accountId: string | undefined,
): AccountCandidate {
  if (!account.isKnown || account.candidates.length === 0) {
    throw new OrderError(
      "Este número no está vinculado a una cuenta del CRM, así que no se puede levantar el pedido.",
    );
  }

  if (!account.isAmbiguous) {
    return account.candidates[0]!;
  }

  if (!accountId) {
    const nombres = account.candidates.map((c) => c.businessName).join(", ");
    throw new OrderError(
      `Este número está vinculado a varias cuentas (${nombres}). Pregúntale al cliente a cuál va el pedido y vuelve a llamar la herramienta con cuenta_id.`,
    );
  }

  const target = findCandidate(account, accountId);
  if (!target) {
    throw new OrderError(
      "Esa cuenta no está vinculada a este número de WhatsApp. Elige una de las cuentas que aparecen en el contexto.",
    );
  }

  return target;
}

/**
 * Crea el pedido en el CRM con estatus 'borrador' para que el vendedor lo
 * revise en TERAVINO Flow antes de aceptarlo. Valida SKU y existencias del
 * almacén de la cuenta antes de escribir nada.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const { account, items } = input;
  const target = resolveTargetAccount(account, input.accountId);

  if (items.length === 0) {
    throw new OrderError("El pedido no tiene partidas.");
  }

  const lines: Array<{
    product_id: string;
    product_name: string;
    supplier: string | null;
    vintage: string | null;
    quantity: number;
    unit: string;
    unit_price: number;
    line_total: number;
    sku: string | null;
  }> = [];

  for (const item of items) {
    const product = await getProductBySku(item.sku, target);

    if (!product) {
      throw new OrderError(`El SKU ${item.sku} no existe o está descontinuado.`);
    }
    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      throw new OrderError(
        `Cantidad inválida para ${product.nombre}: debe ser un entero mayor a cero.`,
      );
    }
    if (item.cantidad > product.stock) {
      throw new OrderError(
        `En ${product.almacen} sólo hay ${product.stock} botellas de ${product.nombre}; se pidieron ${item.cantidad}.`,
      );
    }

    lines.push({
      product_id: product.id,
      product_name: product.nombre,
      supplier: product.productor,
      vintage: product.anada,
      quantity: item.cantidad,
      unit: "botella",
      unit_price: product.precio,
      line_total: Number((product.precio * item.cantidad).toFixed(2)),
      sku: product.sku,
    });
  }

  const subtotal = Number(
    lines.reduce((sum, line) => sum + line.line_total, 0).toFixed(2),
  );
  const iva = Number((subtotal * IVA_RATE).toFixed(2));
  const total = Number((subtotal + iva).toFixed(2));
  const orderNumber = await nextOrderNumber();

  const { data: order, error: orderError } = await crm
    .from("orders")
    .insert({
      order_number: orderNumber,
      account_id: target.id,
      sales_rep_id: target.assignedRepId,
      order_type: config.crm.orderType,
      status: config.crm.orderStatus,
      order_date: new Date().toISOString().slice(0, 10),
      subtotal,
      iva,
      total,
      warehouse: target.warehouse,
      notes: [input.notes, "Levantado por el cliente desde Telegram."]
        .filter(Boolean)
        .join(" · "),
    })
    .select("id, order_number, status")
    .single();

  if (orderError || !order) {
    throw new OrderError(
      `No se pudo crear el pedido: ${orderError?.message ?? "sin detalle"}`,
    );
  }

  const { error: itemsError } = await crm.from("order_items").insert(
    lines.map(({ sku: _sku, ...line }) => ({ ...line, order_id: order.id })),
  );

  if (itemsError) {
    // Sin partidas el encabezado es basura en el CRM: lo quitamos para no
    // dejar un pedido vacío que alguien tenga que limpiar a mano.
    await crm.from("orders").delete().eq("id", order.id);
    throw new OrderError(
      `No se pudieron guardar las partidas: ${itemsError.message}`,
    );
  }

  const botellas = lines.reduce((sum, line) => sum + line.quantity, 0);

  // El pedido ya existe; los avisos son aparte y no pueden tumbarlo.
  const avisos = await createOrderTasks({
    repId: target.assignedRepId,
    accountId: target.id,
    businessName: target.businessName,
    orderId: order.id as string,
    folio: order.order_number as string,
    total,
    botellas,
  });

  return {
    folio: order.order_number as string,
    estado: order.status as string,
    almacen: target.warehouse,
    subtotal,
    iva,
    total,
    cuentaId: target.id,
    negocio: target.businessName,
    avisoAlVendedor: avisos.repNotified,
    vendedor: avisos.repName,
    avisosAdmin: avisos.adminsNotified,
    partidas: lines.map((line) => ({
      sku: line.sku,
      nombre: line.product_name,
      cantidad: line.quantity,
      precioUnitario: line.unit_price,
      subtotal: line.line_total,
    })),
  };
}

const ORDER_COLUMNS =
  "order_number, order_type, status, order_date, total, warehouse, accounts(business_name), order_items(product_name, quantity, unit_price)";

/**
 * En qué va cada estatus, dicho para el cliente.
 *
 * NO se usa orders.fulfillment_status: en el CRM dice 'por_surtir' en los 85
 * pedidos, incluidos los 41 ya entregados. Nadie lo mantiene, así que repetirlo
 * sería decirle al cliente que su pedido entregado sigue sin surtirse. El que
 * sí avanza es `status`.
 */
const ORDER_STAGE: Record<string, string> = {
  borrador: "Su vendedor lo está revisando; todavía no entra a surtirse.",
  aceptada: "Aceptado y en preparación en el almacén.",
  enviada: "Ya salió del almacén, va en camino.",
  entregada: "Entregado.",
  facturada: "Entregado y facturado.",
  cancelada: "Cancelado.",
};

export interface OrderSummary {
  folio: string | null;
  /** 'cotizacion' o 'pedido': en el CRM no son lo mismo y no hay que confundirlos. */
  tipo: string | null;
  negocio: string | null;
  fecha: string | null;
  estatus: string | null;
  /** El estatus explicado, para poder decírselo al cliente. */
  enQueVa: string;
  total: number;
  almacen: string | null;
  partidas: Array<{ nombre: string | null; cantidad: number; precioUnitario: number }>;
}

function hydrateOrder(row: Record<string, unknown>): OrderSummary {
  const account = row.accounts as { business_name: string | null } | null;
  const status = (row.status as string | null) ?? null;
  const items = (row.order_items ?? []) as Array<{
    product_name: string | null;
    quantity: number | null;
    unit_price: number | null;
  }>;

  return {
    folio: (row.order_number as string | null) ?? null,
    tipo: (row.order_type as string | null) ?? null,
    negocio: account?.business_name ?? null,
    fecha: (row.order_date as string | null) ?? null,
    estatus: status,
    enQueVa:
      (status ? ORDER_STAGE[status] : undefined) ??
      "No sabemos en qué etapa va; hay que preguntarle a su vendedor.",
    total: Number(row.total ?? 0),
    almacen: (row.warehouse as string | null) ?? null,
    partidas: items.map((item) => ({
      nombre: item.product_name,
      cantidad: Number(item.quantity ?? 0),
      precioUnitario: Number(item.unit_price ?? 0),
    })),
  };
}

/** Pedidos recientes de la cuenta, para responder "¿cómo va mi pedido?". */
export async function getRecentOrders(
  account: AccountContext,
  limit = 5,
): Promise<OrderSummary[]> {
  // Se consultan todas las cuentas del número, no sólo una: si el comprador
  // atiende varios negocios, quiere ver los pedidos de todos.
  const accountIds = account.candidates.map((c) => c.id);
  if (accountIds.length === 0) return [];

  const { data, error } = await crm
    .from("orders")
    .select(ORDER_COLUMNS)
    .in("account_id", accountIds)
    .order("order_date", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[crm] no se pudieron leer pedidos:", error.message);
    return [];
  }

  return (data ?? []).map((row) => hydrateOrder(row as Record<string, unknown>));
}

/**
 * Pedidos de una cuenta cualquiera, por id. Sólo la usa el personal: para un
 * cliente el acceso pasa siempre por getRecentOrders, que se limita a sus
 * propias cuentas.
 */
export async function getOrdersForAccount(
  accountId: string,
  limit = 5,
): Promise<OrderSummary[]> {
  const { data, error } = await crm
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("account_id", accountId)
    .order("order_date", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[crm] no se pudieron leer pedidos de la cuenta:", error.message);
    return [];
  }

  return (data ?? []).map((row) => hydrateOrder(row as Record<string, unknown>));
}
