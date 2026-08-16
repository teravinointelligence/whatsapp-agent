import { db } from "../db/index.js";
import { getProductBySku, type Product } from "./catalog.js";

export interface OrderItemInput {
  sku: string;
  cantidad: number;
}

export interface OrderLine {
  sku: string;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
}

export interface Order {
  id: number;
  phone: string;
  customer: string;
  delivery: string | null;
  notes: string | null;
  items: OrderLine[];
  total: number;
  status: string;
  createdAt: string;
}

export class OrderError extends Error {}

const insertOrder = db.prepare(`
  INSERT INTO orders (phone, customer, delivery, notes, items_json, total)
  VALUES (@phone, @customer, @delivery, @notes, @items, @total)
`);

const selectOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`);

const selectByPhone = db.prepare(`
  SELECT * FROM orders WHERE phone = ? ORDER BY id DESC LIMIT ?
`);

interface OrderRow {
  id: number;
  phone: string;
  customer: string;
  delivery: string | null;
  notes: string | null;
  items_json: string;
  total: number;
  status: string;
  created_at: string;
}

function hydrate(row: OrderRow): Order {
  return {
    id: row.id,
    phone: row.phone,
    customer: row.customer,
    delivery: row.delivery,
    notes: row.notes,
    items: JSON.parse(row.items_json) as OrderLine[],
    total: row.total,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toLine(product: Product, cantidad: number): OrderLine {
  return {
    sku: product.sku,
    nombre: product.nombre,
    cantidad,
    precioUnitario: product.precio,
    subtotal: Number((product.precio * cantidad).toFixed(2)),
  };
}

export interface CreateOrderInput {
  phone: string;
  customer: string;
  delivery?: string;
  notes?: string;
  items: OrderItemInput[];
}

/**
 * Valida cada SKU contra el catálogo y guarda el pedido. Se guardan los
 * precios del momento para que un cambio de lista no altere pedidos viejos.
 */
export function createOrder(input: CreateOrderInput): Order {
  if (input.items.length === 0) {
    throw new OrderError("El pedido no tiene partidas.");
  }

  const lines: OrderLine[] = [];

  for (const item of input.items) {
    const product = getProductBySku(item.sku);
    if (!product) {
      throw new OrderError(`El SKU ${item.sku} no existe en el catálogo.`);
    }
    if (!Number.isInteger(item.cantidad) || item.cantidad <= 0) {
      throw new OrderError(
        `Cantidad inválida para ${product.nombre}: debe ser un entero mayor a cero.`,
      );
    }
    if (item.cantidad > product.stock) {
      throw new OrderError(
        `Sólo hay ${product.stock} botellas de ${product.nombre}; se pidieron ${item.cantidad}.`,
      );
    }
    lines.push(toLine(product, item.cantidad));
  }

  const total = Number(lines.reduce((sum, l) => sum + l.subtotal, 0).toFixed(2));

  const result = insertOrder.run({
    phone: input.phone,
    customer: input.customer,
    delivery: input.delivery ?? null,
    notes: input.notes ?? null,
    items: JSON.stringify(lines),
    total,
  });

  return hydrate(selectOrder.get(result.lastInsertRowid) as OrderRow);
}

export function getOrdersByPhone(phone: string, limit = 5): Order[] {
  const rows = selectByPhone.all(phone, limit) as OrderRow[];
  return rows.map(hydrate);
}
