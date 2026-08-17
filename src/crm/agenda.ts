import { config } from "../config.js";
import { crm } from "./client.js";
import { normalizeName } from "./link.js";

export class AgendaError extends Error {}

/**
 * La agenda de un vendedor no está en una sola tabla del CRM: son tres cosas
 * distintas que él ve juntas en su día.
 *
 * - `activities` con estatus 'agendada' son las citas con hora: la visita al
 *   hotel, la degustación, la llamada.
 * - `rep_tasks` pendientes son los pendientes con fecha, los que genera el CRM
 *   (cobranza, cuenta inactiva) y los que le deja este canal.
 * - El `next_step` de una actividad ya realizada es lo que él mismo se
 *   comprometió a hacer después —"mandarle la cotización el jueves"—, y es lo
 *   que más fácil se cae porque no aparece en ningún lado.
 */

/** Cuántos renglones de cada cosa se devuelven por vendedor. */
const MAX_POR_BLOQUE = 10;

export interface AgendaCita {
  cuando: string;
  tipo: string;
  negocio: string;
  ciudad: string | null;
  notas: string | null;
}

export interface AgendaTarea {
  titulo: string;
  vence: string;
  /** true cuando la fecha ya pasó: es lo primero que hay que ver. */
  vencida: boolean;
  cuenta: string | null;
}

export interface AgendaSeguimiento {
  compromiso: string;
  para: string;
  vencido: boolean;
  negocio: string;
}

export interface AgendaVendedor {
  vendedor: string;
  citas: AgendaCita[];
  tareas: AgendaTarea[];
  seguimientos: AgendaSeguimiento[];
  /** Lo que no cupo en cada bloque, para no dar una lista truncada en silencio. */
  masCitas: number;
  masTareas: number;
  masSeguimientos: number;
}

export interface AgendaOptions {
  /** Nombre o parte del nombre del vendedor. Vacío: todo el equipo. */
  vendedor?: string;
  /** Días hacia adelante además de hoy. 0 = sólo hoy. */
  dias?: number;
}

/**
 * Minutos que la zona del negocio lleva respecto a UTC en ese instante.
 *
 * Se calcula, no se escribe a mano: el día de un vendedor en Los Cabos empieza
 * a su hora, no a la del servidor, y hardcodear −7 rompería el día que alguien
 * cambie TIMEZONE.
 */
function offsetMinutes(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return (asUtc - date.getTime()) / 60_000;
}

/** Fecha local del negocio en formato YYYY-MM-DD. */
function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Instante UTC en que empieza ese día local. */
function startOfLocalDay(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const naive = Date.UTC(year!, month! - 1, date!, 0, 0, 0);
  // El offset se toma sobre ese mismo instante: basta para una zona sin
  // horario de verano, que es el caso de Mazatlán desde 2022.
  return new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60_000);
}

function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const moved = new Date(Date.UTC(year!, month! - 1, date! + days));
  return moved.toISOString().slice(0, 10);
}

/** "lun 18 ago · 13:30", en la hora del negocio. */
function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);

  // Una fecha que no se puede leer no debe tumbar la agenda completa: se
  // devuelve tal como vino y el resto de las citas se contestan igual.
  if (Number.isNaN(date.getTime())) return iso;

  const dia = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
  const hora = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);

  return `${dia} · ${hora}`;
}

interface RepRow {
  id: string;
  full_name: string | null;
}

/**
 * Vendedores del equipo, opcionalmente filtrados por nombre.
 *
 * El filtro es por coincidencia parcial sin acentos ni mayúsculas, porque en
 * el chat se escribe "yamile" y en el CRM está "Yamile Rodríguez".
 */
async function resolveReps(nombre?: string): Promise<RepRow[]> {
  const { data, error } = await crm
    .from("sales_reps")
    .select("id, full_name")
    .eq("active", true);

  if (error) throw new AgendaError(`No pude leer el equipo: ${error.message}`);

  const reps = (data ?? []) as RepRow[];
  const buscado = normalizeName(nombre ?? "");
  if (!buscado) return reps;

  const encontrados = reps.filter((rep) =>
    normalizeName(rep.full_name ?? "").includes(buscado),
  );

  if (encontrados.length === 0) {
    const nombres = reps
      .map((rep) => rep.full_name)
      .filter(Boolean)
      .join(", ");
    throw new AgendaError(
      `No encontré a "${nombre}" en el equipo. Están: ${nombres}.`,
    );
  }

  return encontrados;
}

/**
 * Devuelve la agenda por vendedor: citas con hora, pendientes con fecha y
 * compromisos de seguimiento.
 *
 * Las tareas y los seguimientos vencidos entran aunque su fecha ya haya
 * pasado: para eso se pregunta por la agenda de alguien, para ver lo que trae
 * encima, y lo atrasado es justo lo que importa.
 */
export async function getAgenda(
  options: AgendaOptions = {},
): Promise<AgendaVendedor[]> {
  const timeZone = config.avisos.timezone;
  const dias = Math.max(0, Math.min(options.dias ?? 0, 60));

  const hoy = localDay(new Date(), timeZone);
  const hasta = addDays(hoy, dias);

  const desdeUtc = startOfLocalDay(hoy, timeZone).toISOString();
  const hastaUtc = startOfLocalDay(addDays(hasta, 1), timeZone).toISOString();

  const reps = await resolveReps(options.vendedor);
  const ids = reps.map((rep) => rep.id);
  if (ids.length === 0) return [];

  const [citas, tareas, seguimientos] = await Promise.all([
    crm
      .from("activities")
      .select(
        "sales_rep_id, activity_type, activity_date, notes, accounts(business_name, city)",
      )
      .eq("status", "agendada")
      .in("sales_rep_id", ids)
      .gte("activity_date", desdeUtc)
      .lt("activity_date", hastaUtc)
      .order("activity_date"),

    crm
      .from("rep_tasks")
      .select("sales_rep_id, title, due_date, accounts(business_name)")
      .eq("status", "pendiente")
      .in("sales_rep_id", ids)
      .lte("due_date", hasta)
      .order("due_date"),

    crm
      .from("activities")
      .select("sales_rep_id, next_step, next_step_date, accounts(business_name)")
      .eq("next_step_done", false)
      .in("sales_rep_id", ids)
      .not("next_step_date", "is", null)
      .lte("next_step_date", hasta)
      .order("next_step_date"),
  ]);

  for (const { error } of [citas, tareas, seguimientos]) {
    if (error) throw new AgendaError(`No pude leer la agenda: ${error.message}`);
  }

  const porVendedor = new Map<string, AgendaVendedor>();
  for (const rep of reps) {
    porVendedor.set(rep.id, {
      vendedor: rep.full_name ?? "(sin nombre)",
      citas: [],
      tareas: [],
      seguimientos: [],
      masCitas: 0,
      masTareas: 0,
      masSeguimientos: 0,
    });
  }

  for (const row of citas.data ?? []) {
    const agenda = porVendedor.get(row.sales_rep_id as string);
    if (!agenda) continue;

    if (agenda.citas.length >= MAX_POR_BLOQUE) {
      agenda.masCitas += 1;
      continue;
    }

    const cuenta = row.accounts as unknown as {
      business_name: string | null;
      city: string | null;
    } | null;

    agenda.citas.push({
      cuando: formatWhen(row.activity_date as string, timeZone),
      tipo: (row.activity_type as string | null) ?? "actividad",
      negocio: cuenta?.business_name ?? "(sin cuenta)",
      ciudad: cuenta?.city ?? null,
      notas: (row.notes as string | null) ?? null,
    });
  }

  for (const row of tareas.data ?? []) {
    const agenda = porVendedor.get(row.sales_rep_id as string);
    if (!agenda) continue;

    if (agenda.tareas.length >= MAX_POR_BLOQUE) {
      agenda.masTareas += 1;
      continue;
    }

    const vence = (row.due_date as string | null) ?? hoy;
    const cuenta = row.accounts as unknown as { business_name: string | null } | null;

    agenda.tareas.push({
      titulo: (row.title as string | null) ?? "(sin título)",
      vence,
      vencida: vence < hoy,
      cuenta: cuenta?.business_name ?? null,
    });
  }

  for (const row of seguimientos.data ?? []) {
    const agenda = porVendedor.get(row.sales_rep_id as string);
    if (!agenda) continue;

    if (agenda.seguimientos.length >= MAX_POR_BLOQUE) {
      agenda.masSeguimientos += 1;
      continue;
    }

    const para = row.next_step_date as string;
    const cuenta = row.accounts as unknown as { business_name: string | null } | null;

    agenda.seguimientos.push({
      compromiso: (row.next_step as string | null) ?? "(sin detalle)",
      para,
      vencido: para < hoy,
      negocio: cuenta?.business_name ?? "(sin cuenta)",
    });
  }

  // Al preguntar por el equipo entero, quien no trae nada ese día sólo hace
  // ruido. Al preguntar por una persona sí se contesta, aunque venga vacía:
  // "no trae nada" es una respuesta.
  const resultado = [...porVendedor.values()];
  if (options.vendedor) return resultado;

  return resultado.filter(
    (agenda) =>
      agenda.citas.length + agenda.tareas.length + agenda.seguimientos.length > 0,
  );
}
