import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Qué versión del código está corriendo.
 *
 * Existe porque el bot corre en la máquina de alguien más: cuando algo "no
 * funciona", lo primero que hay que descartar es que el proceso siga con el
 * código de antes del último git pull, y preguntárselo al propio bot es más
 * rápido que pedir capturas de la terminal.
 *
 * Se lee una sola vez al arrancar: si alguien hace pull sin reiniciar, este
 * dato sigue diciendo la verdad sobre lo que está en memoria.
 */
function readCommit(): string {
  try {
    const cwd = dirname(fileURLToPath(import.meta.url));
    return execFileSync("git", ["log", "-1", "--format=%h · %cd · %s", "--date=short"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "sin repositorio git a la vista";
  }
}

export const RUNNING_COMMIT = readCommit();
