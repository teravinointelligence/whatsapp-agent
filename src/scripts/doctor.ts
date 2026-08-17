/**
 * Revisión de por qué el bot no está contestando.
 *
 *   npm run doctor
 *
 * Se corre EN LA MÁQUINA DONDE VIVE EL BOT, con el mismo `.env` y la misma base
 * de datos. Pregunta las cuatro cosas que pueden dejar mudo al canal —Telegram,
 * el proceso, el CRM y el modelo— y dice cuál de ellas está fallando.
 *
 * No cambia nada: sólo lee. Se puede correr con el bot encendido.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { crm } from "../crm/client.js";
import { db } from "../db/index.js";
import { getPollingOffset } from "../data/conversations.js";
import { getMe, getWebhookInfo } from "../telegram/client.js";
import { RUNNING_COMMIT } from "../version.js";

const OK = "✅";
const ALERTA = "🔴";
const AVISO = "⚠️";

/** Hallazgos que explican por qué nadie recibe respuesta. */
const problemas: string[] = [];

function alerta(mensaje: string): void {
  problemas.push(mensaje);
  console.log(`${ALERTA} ${mensaje}`);
}

/** Ninguna revisión puede colgarse: el diagnóstico tiene que terminar siempre. */
async function conTope<T>(etiqueta: string, promesa: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promesa,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${etiqueta} no contestó en ${ms / 1000} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hace(iso: string): string {
  const minutos = Math.round((Date.now() - new Date(`${iso.replace(" ", "T")}Z`).getTime()) / 60_000);
  if (minutos < 60) return `hace ${minutos} min`;
  if (minutos < 60 * 24) return `hace ${Math.round(minutos / 60)} h`;
  return `hace ${Math.round(minutos / (60 * 24))} día(s)`;
}

console.log(`\nCódigo en memoria: ${RUNNING_COMMIT}`);
console.log(`Modo configurado: ${config.telegram.mode}\n`);

// ── 1. Telegram ────────────────────────────────────────────────────────────
// Su lado del canal: si aquí hay updates encolados, es que nadie los recoge.
console.log("── Telegram ──");
try {
  const yo = await conTope("getMe", getMe());
  console.log(`${OK} El token sirve: @${yo.username ?? yo.id}`);

  const info = await conTope("getWebhookInfo", getWebhookInfo());

  if (config.telegram.mode === "polling" && info.url) {
    alerta(
      `Hay un webhook registrado (${info.url}) pero el bot corre en polling.\n` +
        "   Telegram NO entrega por getUpdates mientras exista: el bot no recibe nada.\n" +
        "   Se quita al arrancar, así que esto significa que el proceso no arrancó bien\n" +
        "   o que alguien más lo registró después.",
    );
  }

  if (config.telegram.mode === "webhook" && !info.url) {
    alerta("El bot corre en modo webhook pero no hay ninguno registrado: nadie le entrega nada.");
  }

  if (info.pending_update_count > 0) {
    alerta(
      `${info.pending_update_count} mensaje(s) esperando en la cola de Telegram, sin recoger.\n` +
        "   Alguien escribió y el proceso no los está recogiendo: o está caído, o el\n" +
        "   bucle de polling se quedó congelado.",
    );
  } else {
    console.log(`${OK} No hay mensajes encolados sin recoger.`);
  }

  if (info.last_error_message) {
    const cuando = info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : "sin fecha";
    console.log(`${AVISO} Último error que reportó Telegram (${cuando}): ${info.last_error_message}`);
  }
} catch (error) {
  alerta(`No se pudo hablar con la API de Telegram: ${String(error)}`);
}

// ── 2. El proceso ──────────────────────────────────────────────────────────
// Lo que el bot alcanzó a registrar. Si lleva horas sin ver un mensaje y los
// clientes están escribiendo, el problema está antes del modelo.
console.log("\n── El proceso ──");
console.log(`Offset del polling guardado: ${getPollingOffset()}`);

const ultimo = db
  .prepare(`SELECT role, created_at FROM messages ORDER BY created_at DESC, id DESC LIMIT 1`)
  .get() as { role: string; created_at: string } | undefined;

if (!ultimo) {
  console.log(`${AVISO} No hay ni un mensaje registrado. ¿Base de datos nueva o ruta equivocada?`);
  console.log(`   DATABASE_PATH = ${config.databasePath}`);
} else {
  console.log(`Último mensaje registrado: ${hace(ultimo.created_at)} (${ultimo.role}).`);
}

const sinContestar = db
  .prepare(
    `SELECT m.user_id, m.created_at, c.display_name
       FROM messages m
       JOIN (SELECT user_id, MAX(id) AS id FROM messages GROUP BY user_id) ult
         ON ult.id = m.id
       LEFT JOIN conversations c ON c.user_id = m.user_id
      WHERE m.role = 'user'
        -- Cinco minutos de gracia: un turno que se está contestando ahora
        -- mismo también termina en un mensaje del cliente.
        AND m.created_at < datetime('now', '-5 minutes')
      ORDER BY m.created_at DESC
      LIMIT 10`,
  )
  .all() as Array<{ user_id: string; created_at: string; display_name: string | null }>;

if (sinContestar.length > 0) {
  alerta(`${sinContestar.length} conversación(es) donde el último mensaje es del cliente:`);
  for (const fila of sinContestar) {
    console.log(`   · ${fila.display_name ?? fila.user_id} — ${hace(fila.created_at)}`);
  }
  console.log("   El bot sí recibió esos mensajes pero no dejó respuesta: el corte está");
  console.log("   en el modelo, en el CRM o al mandar la respuesta, no en Telegram.");
} else {
  console.log(`${OK} Toda conversación registrada termina con una respuesta del bot.`);
}

// ── 3. El CRM ──────────────────────────────────────────────────────────────
console.log("\n── El CRM ──");
try {
  const { error } = await conTope(
    "Supabase",
    // El builder de Supabase es "thenable" pero no una Promise: se resuelve con
    // then() para poder pasarlo por el tope de tiempo.
    Promise.resolve(
      crm.from("products").select("sku", { count: "exact", head: true }).limit(1),
    ),
  );
  if (error) alerta(`El CRM contestó con error: ${error.message}`);
  else console.log(`${OK} El CRM responde.`);
} catch (error) {
  alerta(`El CRM no respondió: ${String(error)}`);
}

// ── 4. El modelo ───────────────────────────────────────────────────────────
console.log("\n── El modelo ──");
try {
  const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 0 });
  await conTope(
    "Anthropic",
    anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4,
      messages: [{ role: "user", content: "di ok" }],
    }),
    30_000,
  );
  console.log(`${OK} El modelo ${config.anthropic.model} responde.`);
} catch (error) {
  alerta(`El modelo no respondió: ${String(error)}`);
}

// ── Veredicto ──────────────────────────────────────────────────────────────
console.log("\n── Veredicto ──");
if (problemas.length === 0) {
  console.log(`${OK} Todas las piezas responden desde aquí.`);
  console.log("Si aun así el cliente no recibe nada, lo más probable es que el proceso");
  console.log("que está corriendo no sea éste: revisa que no haya dos instancias contra");
  console.log("el mismo token —se roban los mensajes entre ellas— y que la que atiende");
  console.log("sea la del código que reporta /version.");
} else {
  console.log(`${problemas.length} problema(s) encontrado(s), arriba con ${ALERTA}.`);
}

console.log();
process.exit(0);
