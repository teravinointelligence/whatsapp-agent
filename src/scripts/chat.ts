/**
 * Prueba el agente desde la terminal, sin Telegram de por medio.
 *
 *   npm run chat -- 6241234567
 *
 * El argumento es el TELÉFONO del cliente que quieres simular: se registra
 * como si lo hubiera compartido por Telegram, para que el agente resuelva su
 * cuenta contra el CRM. Sin argumento, simula a alguien no identificado.
 *
 * Usa la misma base de datos y el mismo bucle que el bot, así que los pedidos
 * que levantes aquí quedan registrados de verdad en el CRM.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { respondTo } from "../agent/agent.js";
import { rememberPhone, touchConversation } from "../data/conversations.js";

const phone = process.argv[2];
// Id ficticio de Telegram, distinto por teléfono para no mezclar historiales.
const userId = phone ? `local-${phone}` : "local-anonimo";

touchConversation(userId, "Prueba local");
if (phone) rememberPhone(userId, phone);

const rl = createInterface({ input: stdin, output: stdout });

console.log(
  phone
    ? `Conversando como el teléfono ${phone}. Ctrl+C para salir.\n`
    : "Conversando como cliente NO identificado. Ctrl+C para salir.\n",
);

for (;;) {
  const input = (await rl.question("tú › ")).trim();
  if (!input) continue;

  const reply = await respondTo(userId, input);
  console.log(`\nbot › ${reply.text}\n`);
  if (reply.needsPhone) {
    console.log("      [en Telegram aquí aparecería el botón de compartir número]\n");
  }
}
