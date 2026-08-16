import { config } from "../config.js";
import { crm } from "../crm/client.js";
import { claimInventoryFile } from "../data/jobs.js";
import { parseContpaq } from "./contpaq.js";
import { downloadCsv, listFolder, newestDated } from "./drive.js";

export interface WarehouseResult {
  almacen: string;
  /** null cuando no había nada nuevo que cargar. */
  archivo: string | null;
  corte: string | null;
  partidas: number;
  escritas: number;
  /** Códigos del reporte que no existen en el catálogo del CRM. */
  sinProducto: Array<{ codigo: string; cantidad: number }>;
  botellas: number;
  error?: string;
}

/** Carga el inventario más reciente de un almacén. */
export async function syncWarehouse(
  almacen: string,
  folderId: string,
): Promise<WarehouseResult> {
  const vacio: WarehouseResult = {
    almacen,
    archivo: null,
    corte: null,
    partidas: 0,
    escritas: 0,
    sinProducto: [],
    botellas: 0,
  };

  const archivo = newestDated(await listFolder(folderId));
  if (!archivo) return vacio;

  // Un archivo se carga una sola vez: mientras nadie suba uno nuevo, la
  // revisión diaria no vuelve a escribir ni a avisar.
  if (!claimInventoryFile(archivo.id)) return { ...vacio, archivo: archivo.title };

  const { fecha, existencias } = parseContpaq(await downloadCsv(archivo.id));

  if (existencias.size === 0) {
    throw new Error(`el archivo ${archivo.title} no trae partidas`);
  }

  const codigos = [...existencias.keys()];
  const { data: productos, error } = await crm
    .from("products")
    .select("id, codigo_contpaqi")
    .in("codigo_contpaqi", codigos);

  if (error) {
    throw new Error(`no se pudo leer el catálogo: ${error.message}`);
  }

  const porCodigo = new Map(
    (productos ?? []).map((row) => [row.codigo_contpaqi as string, row.id as string]),
  );

  const fuente = `CONTPAQ ${fecha ?? archivo.fecha ?? "s/f"} (Drive)`;
  const filas = [];
  const sinProducto: Array<{ codigo: string; cantidad: number }> = [];
  let botellas = 0;

  for (const [codigo, cantidad] of existencias) {
    const productId = porCodigo.get(codigo);
    if (!productId) {
      // Se reporta en vez de callarse: son productos que alguien tiene que
      // mapear en el CRM, y mientras tanto sus existencias no entran.
      if (cantidad > 0) sinProducto.push({ codigo, cantidad });
      continue;
    }

    filas.push({
      product_id: productId,
      warehouse: almacen,
      stock_quantity: cantidad,
      last_update: new Date().toISOString(),
      last_source: fuente,
    });
    botellas += cantidad;
  }

  const { error: upsertError } = await crm
    .from("product_warehouse_stock")
    .upsert(filas, { onConflict: "product_id,warehouse" });

  if (upsertError) {
    throw new Error(`no se pudieron escribir las existencias: ${upsertError.message}`);
  }

  await crm.from("inventory_imports").insert({
    import_type: "inventario_almacen",
    source_file_name: `${archivo.title} (Drive, automático)`,
    rows_total: existencias.size,
    rows_ok: filas.length,
    rows_error: existencias.size - filas.length,
    error_log: sinProducto.map((item) => ({
      row: 0,
      message: `SKU/código ${item.codigo} sin producto en el CRM`,
      raw: { sku: item.codigo, stock_quantity: item.cantidad },
    })),
  });

  return {
    almacen,
    archivo: archivo.title,
    corte: fecha ?? archivo.fecha,
    partidas: existencias.size,
    escritas: filas.length,
    sinProducto,
    botellas,
  };
}

export interface SyncSummary {
  resultados: WarehouseResult[];
  /** Productos cuyo total cambió al recalcular. */
  rollup: number;
  /** true si algún almacén trajo archivo nuevo. */
  huboCambios: boolean;
}

/**
 * Revisa los cinco almacenes y actualiza lo que tenga archivo nuevo.
 *
 * Un almacén que falle no detiene a los demás: se anota el error y se sigue,
 * porque perder Vallarta por una caída de Drive no es razón para quedarse sin
 * Los Cabos.
 */
export async function syncInventories(): Promise<SyncSummary> {
  const resultados: WarehouseResult[] = [];

  for (const [almacen, folderId] of Object.entries(config.inventarios.carpetas)) {
    try {
      resultados.push(await syncWarehouse(almacen, folderId));
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);
      console.error(`[inventarios] falló ${almacen}:`, detalle);
      resultados.push({
        almacen,
        archivo: null,
        corte: null,
        partidas: 0,
        escritas: 0,
        sinProducto: [],
        botellas: 0,
        error: detalle,
      });
    }
  }

  const huboCambios = resultados.some((r) => r.escritas > 0);
  let rollup = 0;

  if (huboCambios) {
    const { data, error } = await crm.rpc("recalcular_stock_rollup", {
      fuente: "Rollup inventario por almacén (Drive, automático)",
    });
    if (error) console.error("[inventarios] falló el rollup:", error.message);
    else rollup = Number(data ?? 0);
  }

  return { resultados, rollup, huboCambios };
}
