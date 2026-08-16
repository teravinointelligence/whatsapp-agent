/**
 * Lectura de la carpeta de inventarios en Google Drive, sin credenciales.
 *
 * Las carpetas están compartidas por link, así que se pueden leer con dos
 * URLs públicas: la vista incrustada para listar y el export a CSV para bajar
 * el archivo. Eso evita montar una cuenta de servicio de Google y que alguien
 * tenga que rotar llaves.
 *
 * La contraparte es que quien tenga el link ve el inventario. Si algún día se
 * cierra la carpeta, este archivo es lo único que hay que cambiar: el resto de
 * la carga no sabe de dónde salió el CSV.
 */

export interface DriveFile {
  id: string;
  title: string;
  /** Fecha del título (2026-08-15 Los Cabos), que es la del corte. */
  fecha: string | null;
}

const LISTA_URL = "https://drive.google.com/embeddedfolderview?id=";
const EXPORT_URL = "https://docs.google.com/spreadsheets/d/";

/** Tiempo máximo por petición: si Drive no contesta, no bloqueamos el arranque. */
const TIMEOUT_MS = 30_000;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${url} respondió ${response.status}`);
  }
  return response.text();
}

/** Archivos de una carpeta compartida, en el orden en que los devuelve Drive. */
export async function listFolder(folderId: string): Promise<DriveFile[]> {
  const html = await fetchText(`${LISTA_URL}${folderId}#list`);
  const entries = [...html.matchAll(/id="entry-([A-Za-z0-9_-]+)"[\s\S]*?flip-entry-title">([^<]+)</g)];

  return entries.map(([, id, title]) => {
    const limpio = (title ?? "").trim();
    const fecha = /^(\d{4}-\d{2}-\d{2})/.exec(limpio)?.[1] ?? null;
    return { id: id!, title: limpio, fecha };
  });
}

/**
 * El archivo de corte más reciente de la carpeta.
 *
 * Se eligen sólo los que empiezan con fecha: en cada carpeta vive también un
 * "Histórico existencias" que no es un corte y que, si se cargara, borraría el
 * inventario con datos de otra cosa.
 */
export function newestDated(files: DriveFile[]): DriveFile | null {
  const conFecha = files.filter((file) => file.fecha !== null);
  if (conFecha.length === 0) return null;

  return conFecha.reduce((mejor, file) => (file.fecha! > mejor.fecha! ? file : mejor));
}

/** Baja la hoja como CSV. */
export async function downloadCsv(fileId: string): Promise<string> {
  return fetchText(`${EXPORT_URL}${fileId}/export?format=csv`);
}
