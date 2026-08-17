import Anthropic from "@anthropic-ai/sdk";
import { config, DEFAULT_PRICE_TIER, DEFAULT_WAREHOUSE } from "../config.js";
import { accountContextBlock, staffContextBlock, SYSTEM_PROMPT } from "./prompt.js";
import { runTool, tools, type ToolContext } from "./tools.js";
import { resolveAccount, type AccountContext } from "../crm/accounts.js";
import { resolveStaff } from "../crm/staff.js";
import {
  appendMessage,
  getDisplayName,
  getHistory,
  getPhoneFor,
} from "../data/conversations.js";

/**
 * El SDK espera 10 minutos por defecto y reintenta dos veces. En un chat eso no
 * es "lento": es un cliente que nunca recibe respuesta y un turno que bloquea
 * al resto. Preferimos cortar pronto y disculparnos.
 */
const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  timeout: 60_000,
  maxRetries: 1,
});

/** Tope de vueltas del bucle para que un modelo atorado no gire sin fin. */
const MAX_TURNS = 8;

/**
 * Tope de la respuesta completa, herramientas incluidas.
 *
 * El tope por llamada no alcanza: ocho vueltas lentas suman minutos igual. Al
 * vencerse se contesta con lo que haya en vez de dejar al cliente esperando.
 */
const TOTAL_BUDGET_MS = 120_000;

/**
 * Tope de cada consulta al CRM. Supabase tampoco trae timeout propio, así que
 * una consulta colgada dejaría el turno esperando para siempre.
 */
const TOOL_TIMEOUT_MS = 30_000;

async function runToolWithTimeout(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      runTool(name, input, context),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`la herramienta ${name} no contestó a tiempo`)),
          TOOL_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    console.error(`[tool] ${name} falló:`, error);
    return {
      content:
        "La consulta al CRM no respondió. Dile al cliente que hubo un problema " +
        "con el sistema y ofrécele pasarlo con alguien del equipo. No inventes el dato.",
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Contexto vacío para quien todavía no comparte su teléfono. */
const NO_ACCOUNT: AccountContext = {
  candidates: [],
  accountId: null,
  warehouse: DEFAULT_WAREHOUSE,
  priceTier: DEFAULT_PRICE_TIER,
  isKnown: false,
  isAmbiguous: false,
  conflictingTerms: false,
};

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export interface AgentReply {
  text: string;
  /** true cuando conviene mostrar el botón para compartir el teléfono. */
  needsPhone: boolean;
}

/**
 * Corre el bucle agéntico para un mensaje entrante y devuelve el texto a
 * enviar. El historial se persiste antes y después, de modo que un fallo a
 * media conversación no pierde lo que el cliente ya escribió.
 */
export async function respondTo(
  userId: string,
  userText: string,
): Promise<AgentReply> {
  appendMessage(userId, "user", userText);

  const displayName = getDisplayName(userId);
  const history = getHistory(userId);

  // Al recortar el historial puede quedar un mensaje del asistente al inicio;
  // la API exige que el primer turno sea del usuario.
  while (history.length > 0 && history[0]!.role !== "user") {
    history.shift();
  }

  const messages: Anthropic.MessageParam[] = history.map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));

  // Quién es el cliente se resuelve aquí, contra el CRM, y no se le pregunta
  // al modelo: así el agente no puede operar sobre otra cuenta. En Telegram
  // el teléfono sólo existe si la persona lo compartió antes.
  const phone = getPhoneFor(userId);

  // El personal de Teravino se resuelve primero: si el número está en
  // sales_reps, no se le trata como cliente aunque además fuera un contacto.
  const staff = phone ? await resolveStaff(phone) : null;
  const account = phone && !staff ? await resolveAccount(phone) : NO_ACCOUNT;

  // El contexto de la cuenta es variable por cliente: va pegado al último turno
  // del usuario y no al system prompt, para no invalidar el prefijo cacheado.
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && typeof last.content === "string") {
    const notes = [
      staff ? staffContextBlock(staff) : accountContextBlock(account, phone !== null),
    ];
    if (displayName && !account.candidates[0]?.contactName) {
      notes.push(`<contexto>Nombre en Telegram: "${displayName}".</contexto>`);
    }
    last.content = `${last.content}\n\n${notes.join("\n")}`;
  }

  const context: ToolContext = { account, staff, phone, userId };
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let reply = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      console.warn(`[agent] se agotó el tiempo atendiendo a ${userId}`);
      break;
    }

    // `output_config.effort` es GA en la API pero el SDK publicado todavía no lo
    // tipa, así que lo declaramos aparte en vez de esperar al tipado.
    const params: Anthropic.MessageCreateParamsNonStreaming & {
      output_config?: { effort: string };
    } = {
      model: config.anthropic.model,
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: { effort: config.anthropic.effort },
      tools,
      messages,
    };

    const response = await client.messages.create(params);

    if (response.stop_reason === "refusal") {
      reply =
        "No puedo ayudarte con eso por aquí. ¿Te paso con alguien del equipo comercial?";
      break;
    }

    const text = extractText(response.content);

    if (response.stop_reason !== "tool_use") {
      reply = text;
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    // Las herramientas son consultas al CRM, así que corren en paralelo y
    // todos los resultados vuelven en un solo turno de usuario.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const result = await runToolWithTimeout(block.name, block.input, context);
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        };
      }),
    );

    messages.push({ role: "user", content: results });
  }

  if (!reply) {
    reply =
      "Perdón, se me complicó procesar eso. ¿Me lo repites o prefieres que te contacte alguien del equipo?";
  }

  appendMessage(userId, "assistant", reply);

  return { text: reply, needsPhone: phone === null };
}
