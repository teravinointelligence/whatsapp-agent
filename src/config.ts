import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Falta la variable de entorno ${name}. Copia .env.example a .env y complétala.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),

  whatsapp: {
    /** Token de acceso permanente del System User de Meta. */
    token: required("WHATSAPP_TOKEN"),
    /** ID del número de teléfono emisor (no el número en sí). */
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    /** Cadena que tú inventas y registras en Meta al configurar el webhook. */
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    /** App Secret de la app de Meta, para validar la firma X-Hub-Signature-256. */
    appSecret: required("WHATSAPP_APP_SECRET"),
    graphVersion: optional("WHATSAPP_GRAPH_VERSION", "v21.0"),
  },

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-opus-5"),
    /** low mantiene la latencia baja, que es lo que importa en un chat. */
    effort: optional("ANTHROPIC_EFFORT", "low") as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max",
  },

  crm: {
    /** URL del proyecto Supabase teravino-crm. */
    url: required("SUPABASE_URL"),
    /**
     * Service role key: el agente escribe pedidos y lee cuentas, así que
     * necesita saltarse RLS. Esta clave NUNCA debe salir del servidor.
     */
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    /** Estatus con el que entran los pedidos levantados por el bot. */
    orderStatus: optional("ORDER_STATUS", "borrador"),
    /** Prefijo del folio, para distinguirlos en el CRM. */
    orderPrefix: optional("ORDER_PREFIX", "COT"),
  },

  business: {
    name: optional("BUSINESS_NAME", "Teravino Wine & Spirits"),
    hours: optional("BUSINESS_HOURS", "Lunes a viernes de 9:00 a 18:00 (hora de Los Cabos)"),
    handoffNumber: process.env.HANDOFF_CONTACT ?? "",
  },

  /** Cuántos turnos de conversación se recuerdan por número de teléfono. */
  historyTurns: Number(optional("HISTORY_TURNS", "20")),

  /** SQLite guarda sólo el historial del chat; el negocio vive en el CRM. */
  databasePath: optional("DATABASE_PATH", "./data/agent.db"),
} as const;

/**
 * Región de la cuenta → almacén del que se surte.
 * V612 queda fuera a propósito: es bodega central, no plaza de venta.
 */
export const WAREHOUSE_BY_REGION: Record<string, string> = {
  "Los Cabos": "Los Cabos",
  "Todos Santos": "Los Cabos",
  "La Paz": "La Paz",
  Tijuana: "Tijuana",
  "Puerto Vallarta": "Vallarta",
  Nayarit: "Vallarta",
};

/** Almacén que se usa cuando la cuenta no tiene región capturada. */
export const DEFAULT_WAREHOUSE = optional("DEFAULT_WAREHOUSE", "Los Cabos");

/**
 * Multiplicador sobre products.base_price según accounts.price_tier.
 * Deducido de los pedidos existentes: 'base' factura a precio base
 * (92 de 94 renglones) y '+10' a base + 10% (120 de 125 renglones).
 */
export const PRICE_TIER_FACTOR: Record<string, number> = {
  base: 1.0,
  "+10": 1.1,
};

/** Nivel que se aplica a quien no está identificado en el CRM. */
export const DEFAULT_PRICE_TIER = optional("DEFAULT_PRICE_TIER", "+10");
