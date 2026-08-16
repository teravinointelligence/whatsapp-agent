import { PORTFOLIOS, type Portfolio } from "./config.js";

/**
 * Alias con los que un cliente puede nombrar su plaza sin usar el nombre
 * oficial. Se suman a la plaza y a sus zonas, que ya vienen en la config.
 */
const ALIASES: Record<string, string[]> = {
  "Los Cabos": ["cabo", "cabos", "csl", "sjd", "san jose", "pescadero", "todos santos"],
  "La Paz": ["lapaz", "paz"],
  Vallarta: ["nayarit", "bahia de banderas", "riviera nayarit", "pvr", "vallarta"],
  Tijuana: ["tj", "baja norte", "valle de guadalupe", "playas de rosarito"],
};

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function keywordsFor(portfolio: Portfolio): string[] {
  return [
    portfolio.plaza,
    ...portfolio.zonas,
    ...(ALIASES[portfolio.plaza] ?? []),
  ].map(normalize);
}

/** El portafolio de una plaza exacta, tal como la nombra el almacén. */
export function portfolioForPlaza(plaza: string): Portfolio | null {
  const needle = normalize(plaza);
  return PORTFOLIOS.find((p) => normalize(p.plaza) === needle) ?? null;
}

/**
 * Busca el portafolio a partir de lo que el cliente dijo de su ubicación.
 *
 * Devuelve todas las coincidencias en vez de elegir: si lo que dijo apunta a
 * dos plazas, el agente tiene que preguntar. Mandar el link equivocado le
 * enseña al cliente precios que no son los suyos.
 */
export function findPortfolios(location: string): Portfolio[] {
  const text = normalize(location);
  if (!text) return [];

  return PORTFOLIOS.filter((portfolio) =>
    keywordsFor(portfolio).some(
      (keyword) => text.includes(keyword) || keyword.includes(text),
    ),
  );
}

/** Las plazas que existen, para poder preguntarle al cliente. */
export function plazaNames(): string[] {
  return PORTFOLIOS.map((p) => p.plaza);
}
