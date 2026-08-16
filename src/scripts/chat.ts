/**
 * Prueba el agente desde la terminal, sin WhatsApp de por medio.
 *
 *   npm run chat -- 5216241234567
 *
 * Usa la misma base de datos y el mismo bucle que el webhook, así que los
 * pedidos que levantes aquí quedan registrados de verdad.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { respondTo } from "../agent/agent.js";
import { touchConversation } from "../data/conversations.js";

const phone = process.argv[2] ?? "5215555555555";

touchConversation(phone, "Prueba local");

const rl = createInterface({ input: stdin, output: stdout });

console.log(`Conversando como ${phone}. Ctrl+C para salir.\n`);

for (;;) {
  const input = (await rl.question("tú › ")).trim();
  if (!input) continue;

  const reply = await respondTo(phone, input);
  console.log(`\nbot › ${reply}\n`);
}
