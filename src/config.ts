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

  business: {
    name: optional("BUSINESS_NAME", "Teravino Wine & Spirits"),
    /** Se inyecta en el prompt para que el agente sepa en qué horario opera. */
    hours: optional("BUSINESS_HOURS", "Lunes a viernes de 9:00 a 18:00 (hora de Los Cabos)"),
    handoffNumber: process.env.HANDOFF_CONTACT ?? "",
  },

  /** Cuántos turnos de conversación se recuerdan por número de teléfono. */
  historyTurns: Number(optional("HISTORY_TURNS", "20")),

  databasePath: optional("DATABASE_PATH", "./data/agent.db"),
  catalogPath: optional("CATALOG_PATH", "./data/catalog.json"),
} as const;
