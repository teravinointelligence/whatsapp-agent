import { PRICE_TIER_FACTOR } from "../config.js";
import { crm } from "./client.js";

/**
 * Lo mínimo que se necesita para cotizar: a qué precio y de qué almacén.
 * Tanto AccountContext como AccountCandidate lo satisfacen estructuralmente,
 * así que sirve igual para una consulta general que para una cuenta concreta.
 */
export interface PricingContext {
  priceTier: string;
  warehouse: string;
}

export interface CatalogProduct {
  id: string;
  sku: string | null;
  nombre: string;
  categoria: string | null;
  productor: string | null;
  varietal: string | null;
  origen: string | null;
  anada: string | null;
  presentacion: string | null;
  /** Precio unitario por botella, sin IVA, ya ajustado al nivel del cliente. */
  precio: number;
  /** Existencias en el almacén que le corresponde a la cuenta. */
  stock: number;
  almacen: string;
}

interface ProductRow {
  id: string;
  sku: string | null;
  name: string;
  supplier: string | null;
  category: string | null;
  varietal: string | null;
  country: string | null;
  region_origin: string | null;
  vintage: string | null;
  volume_ml: number | null;
  base_price: number | null;
}

/** Aplica el multiplicador del nivel de precio de la cuenta. */
export function priceFor(basePrice: number | null, priceTier: string): number {
  const factor = PRICE_TIER_FACTOR[priceTier] ?? 1;
  return Number(((basePrice ?? 0) * factor).toFixed(2));
}

/** Existencias de varios productos en un almacén, en una sola consulta. */
async function stockFor(
  productIds: string[],
  warehouse: string,
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();

  const { data, error } = await crm
    .from("product_warehouse_stock")
    .select("product_id, stock_quantity")
    .eq("warehouse", warehouse)
    .in("product_id", productIds);

  if (error) {
    console.error("[crm] no se pudieron leer existencias:", error.message);
    return new Map();
  }

  return new Map(
    (data ?? []).map((row) => [
      row.product_id as string,
      Number(row.stock_quantity ?? 0),
    ]),
  );
}

function hydrate(
  row: ProductRow,
  stock: Map<string, number>,
  account: PricingContext,
): CatalogProduct {
  return {
    id: row.id,
    sku: row.sku,
    nombre: row.name,
    categoria: row.category,
    productor: row.supplier,
    varietal: row.varietal,
    origen: [row.region_origin, row.country].filter(Boolean).join(", ") || null,
    anada: row.vintage,
    presentacion: row.volume_ml ? `${row.volume_ml} ml` : null,
    precio: priceFor(row.base_price, account.priceTier),
    stock: stock.get(row.id) ?? 0,
    almacen: account.warehouse,
  };
}

const SELECT_COLUMNS =
  "id, sku, name, supplier, category, varietal, country, region_origin, vintage, volume_ml, base_price";

export interface SearchOptions {
  query?: string;
  categoria?: string;
  precioMax?: number;
  soloDisponibles?: boolean;
  limite?: number;
}

/**
 * Busca en el catálogo activo del CRM (978 productos).
 *
 * El filtro de precio se aplica después de convertir a precio de cliente, no
 * sobre base_price, para que un cliente '+10' no vea productos por encima del
 * tope que pidió.
 */
export async function searchProducts(
  options: SearchOptions,
  account: PricingContext,
): Promise<CatalogProduct[]> {
  const { query, categoria, precioMax, soloDisponibles = false, limite = 8 } = options;

  let builder = crm.from("products").select(SELECT_COLUMNS).eq("active", true);

  if (categoria) {
    builder = builder.ilike("category", `%${categoria}%`);
  }

  if (query?.trim()) {
    // Postgrest no permite comodines sin escapar dentro de or(); las comas y
    // los paréntesis romperían la expresión.
    const safe = query.trim().replace(/[,()*]/g, " ").trim();
    if (safe) {
      builder = builder.or(
        [
          `name.ilike.%${safe}%`,
          `supplier.ilike.%${safe}%`,
          `varietal.ilike.%${safe}%`,
          `region_origin.ilike.%${safe}%`,
          `country.ilike.%${safe}%`,
          `sku.ilike.%${safe}%`,
        ].join(","),
      );
    }
  }

  // Se pide de más porque el filtro de existencias se aplica después.
  const { data, error } = await builder.order("name").limit(limite * 4);

  if (error) {
    console.error("[crm] falló la búsqueda de productos:", error.message);
    return [];
  }

  const rows = (data ?? []) as ProductRow[];
  const stock = await stockFor(
    rows.map((row) => row.id),
    account.warehouse,
  );

  return rows
    .map((row) => hydrate(row, stock, account))
    .filter((p) => (precioMax === undefined ? true : p.precio <= precioMax))
    .filter((p) => (soloDisponibles ? p.stock > 0 : true))
    .slice(0, limite);
}

/** Ficha de un producto por SKU exacto. */
export async function getProductBySku(
  sku: string,
  account: PricingContext,
): Promise<CatalogProduct | null> {
  const { data, error } = await crm
    .from("products")
    .select(SELECT_COLUMNS)
    .eq("active", true)
    .ilike("sku", sku.trim())
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as ProductRow;
  const stock = await stockFor([row.id], account.warehouse);
  return hydrate(row, stock, account);
}

export async function listCategories(): Promise<string[]> {
  const { data, error } = await crm
    .from("products")
    .select("category")
    .eq("active", true)
    .not("category", "is", null);

  if (error) return [];

  const categories = new Set(
    (data ?? []).map((row) => row.category as string).filter(Boolean),
  );
  return [...categories].sort();
}
