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

  telegram: {
    /** Token que te da @BotFather al crear el bot. */
    token: required("TELEGRAM_BOT_TOKEN"),
    /** 'polling' no necesita dominio público; 'webhook' sí. */
    mode: optional("TELEGRAM_MODE", "polling") as "polling" | "webhook",
    /** Sólo en modo webhook: URL pública HTTPS donde escucha este servidor. */
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL ?? "",
    /**
     * Sólo en modo webhook: cadena que tú inventas. Telegram la reenvía en el
     * encabezado X-Telegram-Bot-Api-Secret-Token y así verificamos que el POST
     * viene de Telegram y no de cualquiera que adivine la URL.
     */
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
    /** Segundos que el long polling deja la conexión abierta esperando. */
    pollTimeout: Number(optional("TELEGRAM_POLL_TIMEOUT", "30")),
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
    /**
     * El CRM distingue dos documentos y no son lo mismo: 'cotizacion' con folio
     * COT-2026-NNNN es lo que arma un vendedor para que el cliente lo piense, y
     * 'pedido' con folio PED-2026-NNNN es mercancía que alguien ya pidió.
     *
     * Lo que levanta el bot es un pedido —el cliente ya confirmó productos y
     * cantidades— que entra en borrador para que su vendedor lo acepte.
     */
    orderType: optional("ORDER_TYPE", "pedido"),
    orderPrefix: optional("ORDER_PREFIX", "PED"),
  },

  business: {
    name: optional("BUSINESS_NAME", "Teravino Wine & Spirits"),
    hours: optional("BUSINESS_HOURS", "Lunes a viernes de 9:00 a 18:00 (hora de Los Cabos)"),
    handoffNumber: process.env.HANDOFF_CONTACT ?? "",
  },

  /** Cuántos turnos de conversación se recuerdan por número de teléfono. */
  historyTurns: Number(optional("HISTORY_TURNS", "20")),

  /**
   * Carpetas de Google Drive donde se suben los inventarios de CONTPAQ, una
   * por almacén. El nombre de la llave es el nombre del almacén en el CRM.
   */
  inventarios: {
    carpetas: {
      "Los Cabos": optional("DRIVE_LOS_CABOS", "1H0a86XugYyCOg6DoXA8b1B-pK93Fwq6i"),
      "La Paz": optional("DRIVE_LA_PAZ", "1ixUUcZtlnXWQhGVCw0jdcH5OvHITR71r"),
      Tijuana: optional("DRIVE_TIJUANA", "1CZFYLzyhTaVejrGY5vVmxaqEUEVqUIbp"),
      Vallarta: optional("DRIVE_VALLARTA", "19so7Csnzsk3oQtp28ffDwtpX0Ii8UnfL"),
      V612: optional("DRIVE_V612", "1N6kV0Cj6yar8pxfd1MJlqwePPO3Rj1Ae"),
    } as Record<string, string>,
    /** Hora de la revisión diaria. Antes del resumen, para que salga al día. */
    hour: Number(optional("INVENTARIO_HOUR", "6")),
    /** false apaga la carga automática. */
    enabled: optional("INVENTARIOS", "on") !== "off",
  },

  avisos: {
    /**
     * Zona horaria para los avisos programados. Los Cabos y La Paz usan
     * America/Mazatlan, que desde 2022 ya no cambia con el horario de verano.
     */
    timezone: optional("TIMEZONE", "America/Mazatlan"),
    /** Hora del resumen diario, en formato 24 h. */
    briefingHour: Number(optional("BRIEFING_HOUR", "7")),
    /** Hora del resumen de clientes dormidos, los lunes. */
    dormantHour: Number(optional("DORMANT_HOUR", "8")),
    /** Horas que puede pasar un pedido en borrador antes de avisar. */
    stuckOrderHours: Number(optional("STUCK_ORDER_HOURS", "48")),
    /** false apaga todos los avisos programados. */
    enabled: optional("AVISOS", "on") !== "off",
  },

  /** SQLite guarda sólo el historial del chat; el negocio vive en el CRM. */
  databasePath: optional("DATABASE_PATH", "./data/agent.db"),

  /**
   * URL a la que el bot le hace ping cada minuto para decir que sigue vivo
   * (healthchecks.io, Better Stack o similar).
   *
   * Es la única forma de enterarse de una caída dura: un proceso muerto no
   * puede avisar de su propia muerte, así que quien avisa tiene que estar
   * afuera y darse cuenta de que dejamos de latir. Vacío la apaga.
   */
  heartbeatUrl: process.env.HEARTBEAT_URL ?? "",
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

export interface Portfolio {
  /** Coincide con el nombre del almacén que surte la plaza. */
  plaza: string;
  url: string;
  /** Localidades que atiende, para reconocer de qué plaza es el cliente. */
  zonas: string[];
}

/**
 * Portafolios digitales por plaza (agosto 2026).
 *
 * Cada plaza tiene su propio PDF porque cambian precios y catálogo, así que el
 * link se elige por la plaza del cliente, nunca al tanteo.
 */
export const PORTFOLIOS: Portfolio[] = [
  {
    plaza: "Los Cabos",
    url: "https://teravinolc.tiiny.site",
    zonas: ["Cabo San Lucas", "San José del Cabo", "El Pescadero", "Todos Santos"],
  },
  {
    plaza: "La Paz",
    url: "https://teravinolp.tiiny.site",
    zonas: ["La Paz", "Baja California Sur (zona norte)"],
  },
  {
    plaza: "Vallarta",
    url: "https://teravinovt.tiiny.site",
    zonas: ["Puerto Vallarta", "Nuevo Vallarta", "Punta Mita", "Sayulita"],
  },
  {
    plaza: "Tijuana",
    url: "https://teravinotj.tiiny.site",
    zonas: ["Tijuana", "Ensenada", "Rosarito", "Mexicali"],
  },
];

/** Nivel que se aplica a quien no está identificado en el CRM. */
export const DEFAULT_PRICE_TIER = optional("DEFAULT_PRICE_TIER", "+10");
