/**
 * Lectura del reporte "Inventario actual del almacén por producto" de CONTPAQ.
 *
 * El archivo trae encabezados, un pie con notas al calce y las partidas en
 * medio. Las columnas son:
 *   Código | Nombre | (marca) | Inicial | Entradas | Salidas | Existencia | ...
 *
 * Se lee la columna Existencia, no Inicial: Inicial es el arranque del mes.
 */

export interface ContpaqReport {
  /** Fecha del reporte, tal como viene en el encabezado (15/AGO/2026). */
  fecha: string | null;
  /** Código de CONTPAQ → botellas. */
  existencias: Map<string, number>;
}

/** Índice de la columna Existencia en las partidas. */
const COL_CODIGO = 0;
const COL_EXISTENCIA = 6;

/** Renglones de encabezado y pie que no son partidas. */
const NO_PARTIDA = /^(Almacén|Nombre|Código|CONTPAQ|Del:|EN UNIDADES|Total|Errores|En caso|En este)/i;

/**
 * Parser de CSV suficiente para este archivo: campos entre comillas con comas
 * adentro (hay nombres como "MACA & OLIVIA CABERNET,MALBEC,MERLOT").
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Convierte la celda de existencia a número.
 *
 * CONTPAQ marca entre corchetes lo que está en levantamiento de inventario
 * físico ([1.00]); el número de adentro sigue siendo la existencia.
 */
function toNumber(value: string): number | null {
  const limpio = value.trim().replace(/^\[|\]$/g, "").replace(/,/g, "");
  if (limpio === "") return null;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

export function parseContpaq(csv: string): ContpaqReport {
  const rows = parseCsv(csv);
  const existencias = new Map<string, number>();
  let fecha: string | null = null;

  for (const row of rows.slice(0, 6)) {
    for (const cell of row) {
      const match = /\d{2}\/[A-ZÁÉÍÓÚ]{3}\/\d{4}/i.exec(cell);
      // La primera fecha del encabezado es la del reporte; la segunda es el
      // rango del mes ("Del: 01/AGO/2026 Al: 31/AGO/2026"), que no interesa.
      if (match && !cell.includes("Del:")) {
        fecha ??= match[0];
      }
    }
  }

  for (const row of rows) {
    if (row.length <= COL_EXISTENCIA) continue;

    const codigo = (row[COL_CODIGO] ?? "").trim();
    if (!codigo || NO_PARTIDA.test(codigo)) continue;

    const cantidad = toNumber(row[COL_EXISTENCIA] ?? "");
    if (cantidad === null) continue;

    existencias.set(codigo, cantidad);
  }

  return { fecha, existencias };
}
