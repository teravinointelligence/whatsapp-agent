import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { accountContextBlock, SYSTEM_PROMPT } from "./prompt.js";
import { runTool, tools, type ToolContext } from "./tools.js";
import { resolveAccount } from "../crm/accounts.js";
import {
  appendMessage,
  getHistory,
  getProfileName,
} from "../data/conversations.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/** Tope de vueltas del bucle para que un modelo atorado no gire sin fin. */
const MAX_TURNS = 8;

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Corre el bucle agéntico para un mensaje entrante y devuelve el texto a enviar
 * por WhatsApp. El historial se persiste antes y después, de modo que un fallo
 * a media conversación no pierde lo que el cliente ya escribió.
 */
export async function respondTo(phone: string, userText: string): Promise<string> {
  appendMessage(phone, "user", userText);

  const profileName = getProfileName(phone);
  const history = getHistory(phone);

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
  // al modelo: así el agente no puede operar sobre otra cuenta.
  const account = await resolveAccount(phone);

  // El contexto de la cuenta es variable por cliente: va pegado al último turno
  // del usuario y no al system prompt, para no invalidar el prefijo cacheado.
  const last = messages[messages.length - 1];
  if (last && last.role === "user" && typeof last.content === "string") {
    const notes = [accountContextBlock(account)];
    if (profileName && !account.candidates[0]?.contactName) {
      notes.push(`<contexto>Perfil de WhatsApp: "${profileName}".</contexto>`);
    }
    last.content = `${last.content}\n\n${notes.join("\n")}`;
  }

  const context: ToolContext = { phone, account };
  let reply = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
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

    // Las herramientas son consultas locales, así que corren en paralelo y
    // todos los resultados vuelven en un solo turno de usuario.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const result = await runTool(block.name, block.input, context);
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

  appendMessage(phone, "assistant", reply);
  return reply;
}
