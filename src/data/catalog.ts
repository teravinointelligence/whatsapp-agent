import { readFileSync } from "node:fs";
import { config } from "../config.js";

export interface Product {
  sku: string;
  nombre: string;
  categoria: string;
  productor?: string;
  origen?: string;
  anada?: string;
  presentacion?: string;
  /** Precio unitario sin IVA, en MXN. */
  precio: number;
  /** Existencias disponibles en botellas. */
  stock: number;
  notas?: string;
}

let cache: { products: Product[]; loadedAt: number } | null = null;

/** El catálogo se relee cada 60s para poder actualizarlo sin reiniciar. */
function load(): Product[] {
  if (cache && Date.now() - cache.loadedAt < 60_000) {
    return cache.products;
  }

  const raw = readFileSync(config.catalogPath, "utf8");
  const products = JSON.parse(raw) as Product[];
  cache = { products, loadedAt: Date.now() };
  return products;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export interface SearchOptions {
  query?: string;
  categoria?: string;
  precioMax?: number;
  soloDisponibles?: boolean;
  limite?: number;
}

/**
 * Busca por coincidencia de texto en nombre, productor, origen y categoría.
 * Deliberadamente simple: para un catálogo de cientos de SKUs es suficiente y
 * evita depender de un motor de búsqueda.
 */
export function searchProducts(options: SearchOptions): Product[] {
  const { query, categoria, precioMax, soloDisponibles = false, limite = 8 } = options;
  const terms = query ? normalize(query).split(/\s+/).filter(Boolean) : [];

  const scored = load()
    .filter((p) => {
      if (categoria && normalize(p.categoria) !== normalize(categoria)) return false;
      if (precioMax !== undefined && p.precio > precioMax) return false;
      if (soloDisponibles && p.stock <= 0) return false;
      return true;
    })
    .map((product) => {
      const haystack = normalize(
        [product.nombre, product.productor, product.origen, product.categoria, product.notas]
          .filter(Boolean)
          .join(" "),
      );
      const score = terms.filter((term) => haystack.includes(term)).length;
      return { product, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.product.precio - b.product.precio);

  return scored.slice(0, limite).map(({ product }) => product);
}

export function getProductBySku(sku: string): Product | undefined {
  const target = sku.trim().toUpperCase();
  return load().find((p) => p.sku.toUpperCase() === target);
}

export function listCategories(): string[] {
  return [...new Set(load().map((p) => p.categoria))].sort();
}
