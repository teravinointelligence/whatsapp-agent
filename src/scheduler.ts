import { config } from "./config.js";
import {
  cobranza,
  digestCounts,
  dormantAccounts,
  pendingOrders,
  type PendingOrder,
} from "./crm/digest.js";
import { claimDailyJob, claimOrderStuckAlert } from "./data/jobs.js";
import { syncInventories } from "./inventory/sync.js";
import { tellAdmins } from "./notify.js";

/** Cada cuánto se revisa si a algún aviso le toca. */
const TICK_MS = 60_000;

function money(value: number): string {
  return value.toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

/**
 * Hora local del negocio, no la del servidor.
 *
 * Si esto corre en una nube en otro huso, "las 7 de la mañana" tiene que
 * seguir siendo las 7 en Los Cabos.
 */
function localNow(): { day: string; hour: number; minute: number; weekday: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.avisos.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );

  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: String(parts.weekday),
  };
}

/**
 * Carga los inventarios nuevos de Drive y avisa qué entró.
 *
 * Si no hay archivo nuevo no manda nada: un aviso diario de "sin novedad" se
 * deja de leer a la semana.
 */
export async function syncAndReportInventories(): Promise<void> {
  const { resultados, rollup, huboCambios } = await syncInventories();
  const fallidos = resultados.filter((r) => r.error);

  if (!huboCambios && fallidos.length === 0) return;

  const lines = ["📦 <b>Inventarios actualizados</b>", ""];

  for (const r of resultados) {
    if (r.error) {
      lines.push(`⚠️ ${r.almacen}: no se pudo cargar (${r.error})`);
      continue;
    }
    if (r.escritas === 0) continue;

    lines.push(
      `<b>${r.almacen}</b> · corte ${r.corte ?? "s/f"} · ${r.escritas} productos · ${r.botellas.toLocaleString("es-MX")} botellas`,
    );

    if (r.sinProducto.length > 0) {
      const detalle = r.sinProducto
        .slice(0, 3)
        .map((item) => `${item.codigo} (${item.cantidad})`)
        .join(", ");
      lines.push(
        `   ⚠️ ${r.sinProducto.length} código(s) sin producto en el CRM: ${detalle}` +
          (r.sinProducto.length > 3 ? "…" : ""),
      );
    }
  }

  if (rollup > 0) {
    lines.push("", `Se recalculó el total de ${rollup} producto(s).`);
  }

  await tellAdmins(lines.join("\n"));
}

/** Resumen de la mañana: lo que necesita atención hoy. */
export async function sendDailyBriefing(): Promise<void> {
  const [borradores, cartera, conteos] = await Promise.all([
    pendingOrders(),
    cobranza(),
    digestCounts(),
  ]);

  const lines = ["☀️ <b>Resumen del día</b>", ""];

  if (borradores.length > 0) {
    lines.push(`<b>Pedidos por revisar:</b> ${borradores.length}`);
    for (const order of borradores.slice(0, 5)) {
      lines.push(
        `· ${order.folio} — ${order.negocio} — ${money(order.total)} — ${order.dias} día(s)` +
          (order.vendedor ? ` — ${order.vendedor}` : " — sin vendedor"),
      );
    }
    if (borradores.length > 5) lines.push(`· y ${borradores.length - 5} más`);
    lines.push("");
  }

  if (conteos.prospectosNuevos > 0) {
    lines.push(`<b>Prospectos sin asignar:</b> ${conteos.prospectosNuevos}`);
  }
  if (conteos.muestrasPorRevisar > 0) {
    lines.push(`<b>Muestras por revisar:</b> ${conteos.muestrasPorRevisar}`);
  }
  if (conteos.tareasVencidas > 0) {
    lines.push(`<b>Tareas del equipo con fecha pasada:</b> ${conteos.tareasVencidas}`);
  }
  if (conteos.prospectosNuevos + conteos.muestrasPorRevisar + conteos.tareasVencidas > 0) {
    lines.push("");
  }

  lines.push("<b>Cobranza</b>");
  lines.push(
    `Vencido: ${money(cartera.saldoVencido)} en ${cartera.clientesVencidos} cliente(s)`,
  );
  if (cartera.venceEstaSemana > 0) {
    lines.push(
      `Vence esta semana: ${cartera.venceEstaSemana} factura(s), ${money(cartera.montoEstaSemana)}`,
    );
  }
  for (const peor of cartera.peores) {
    lines.push(`· ${peor.negocio} — ${money(peor.saldo)} — hasta ${peor.dias} días`);
  }

  if (
    borradores.length === 0 &&
    conteos.prospectosNuevos === 0 &&
    conteos.muestrasPorRevisar === 0 &&
    cartera.saldoVencido === 0
  ) {
    lines.push("", "Todo tranquilo por hoy.");
  }

  await tellAdmins(lines.join("\n"));
}

/** Los lunes: quién lleva mucho sin comprar, por vendedor. */
export async function sendDormantReport(): Promise<void> {
  const porVendedor = await dormantAccounts(60);

  if (porVendedor.size === 0) {
    await tellAdmins("😴 <b>Clientes dormidos</b>\n\nNinguna cuenta activa lleva más de 60 días sin pedir.");
    return;
  }

  const total = [...porVendedor.values()].reduce((sum, list) => sum + list.length, 0);
  const lines = [
    "😴 <b>Clientes dormidos</b>",
    `${total} cuenta(s) activa(s) sin pedir en 60 días o más.`,
    "",
  ];

  const ordenado = [...porVendedor.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [vendedor, cuentas] of ordenado) {
    lines.push(`<b>${vendedor}</b> — ${cuentas.length}`);
    for (const cuenta of cuentas.slice(0, 3)) {
      lines.push(
        `· ${cuenta.negocio} — ${cuenta.dias === null ? "nunca ha pedido" : `${cuenta.dias} días`}`,
      );
    }
    if (cuentas.length > 3) lines.push(`· y ${cuentas.length - 3} más`);
    lines.push("");
  }

  await tellAdmins(lines.join("\n").trim());
}

/** Avisa de los pedidos que llevan demasiado tiempo esperando revisión. */
export async function checkStuckOrders(): Promise<void> {
  const minDays = Math.floor(config.avisos.stuckOrderHours / 24);
  const atorados = await pendingOrders(minDays);

  // Se avisa uno por uno para poder recordar de cuáles ya se avisó.
  const nuevos: PendingOrder[] = atorados.filter((order) =>
    claimOrderStuckAlert(order.id),
  );

  for (const order of nuevos) {
    await tellAdmins(
      [
        "⏳ <b>Pedido atorado</b>",
        "",
        `${order.folio} — <b>${order.negocio}</b> — ${money(order.total)}`,
        `Lleva ${order.dias} día(s) en borrador.`,
        order.vendedor
          ? `Está asignado a ${order.vendedor}.`
          : "⚠️ La cuenta no tiene vendedor asignado.",
      ].join("\n"),
    );
  }
}

/**
 * Revisa cada minuto si a algún aviso le toca correr.
 *
 * Se apoya en la fecha local: cada aviso diario se marca como corrido y no se
 * repite aunque el proceso se reinicie tres veces esa mañana. Si el bot estuvo
 * apagado a la hora exacta, el aviso sale en cuanto vuelve —tarde, pero sale—,
 * que es mejor que perderlo.
 */
export function startScheduler(): void {
  if (!config.avisos.enabled) {
    console.log("Avisos programados apagados (AVISOS=off).");
    return;
  }

  console.log(
    `Avisos programados activos: inventarios ${config.inventarios.hour}:00, ` +
      `resumen ${config.avisos.briefingHour}:00, ` +
      `dormidos los lunes ${config.avisos.dormantHour}:00 (${config.avisos.timezone}).`,
  );

  const tick = async (): Promise<void> => {
    const { day, hour, weekday } = localNow();

    try {
      // Primero los inventarios: así el resumen de la mañana ya sale con las
      // existencias del día y no con las de ayer.
      if (
        config.inventarios.enabled &&
        hour >= config.inventarios.hour &&
        claimDailyJob("inventarios", day)
      ) {
        await syncAndReportInventories();
      }

      if (hour >= config.avisos.briefingHour && claimDailyJob("briefing", day)) {
        await sendDailyBriefing();
      }

      if (
        weekday === "Mon" &&
        hour >= config.avisos.dormantHour &&
        claimDailyJob("dormidos", day)
      ) {
        await sendDormantReport();
      }

      // Los pedidos atorados se revisan una vez al día; el aviso de cada uno
      // ya está deduplicado por su id.
      if (hour >= config.avisos.briefingHour && claimDailyJob("atorados", day)) {
        await checkStuckOrders();
      }
    } catch (error) {
      console.error("[avisos] falló un aviso programado:", error);
    }
  };

  void tick();
  setInterval(() => void tick(), TICK_MS).unref();
}
