import type Anthropic from "@anthropic-ai/sdk";
import type { AccountContext } from "../crm/accounts.js";
import {
  getProductBySku,
  listCategories,
  searchProducts,
} from "../crm/catalog.js";
import {
  createOrder,
  getOrdersForAccount,
  getRecentOrders,
  OrderError,
  type OrderItemInput,
} from "../crm/orders.js";
import { searchAccounts, type StaffContext } from "../crm/staff.js";

/**
 * Contexto que el servidor resuelve antes de invocar al agente. La cuenta sale
 * del teléfono que el cliente compartió por Telegram: el agente no la elige ni
 * la recibe como parámetro, así que no puede leer ni escribir sobre otro
 * cliente aunque el usuario se lo pida.
 */
export interface ToolContext {
  account: AccountContext;
  /** Cuando quien escribe es del equipo de Teravino, no un cliente. */
  staff: StaffContext | null;
}

export const tools: Anthropic.Tool[] = [
  {
    name: "buscar_productos",
    description:
      "Busca en el catálogo por nombre, bodega, varietal, región o SKU. Devuelve " +
      "el precio que le corresponde a ESTE cliente y las existencias del almacén " +
      "que lo surte. Úsala siempre antes de mencionar un precio o afirmar que hay " +
      "disponibilidad: nunca respondas precios ni existencias de memoria.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Texto libre: nombre del vino, bodega, uva o región. Ej. 'Sancerre', 'Bruma', 'cabernet'.",
        },
        categoria: {
          type: "string",
          description: "Filtra por categoría. Usa listar_categorias si no la conoces.",
        },
        precio_max: {
          type: "number",
          description: "Precio unitario máximo sin IVA, en MXN.",
        },
        solo_disponibles: {
          type: "boolean",
          description: "Si es true, omite lo que no tenga existencias. Por defecto false.",
        },
      },
      required: [],
    },
  },
  {
    name: "listar_categorias",
    description:
      "Devuelve las categorías del catálogo. Útil cuando el cliente pregunta de " +
      "forma abierta qué manejamos.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consultar_producto",
    description:
      "Ficha completa de un producto por SKU exacto, con las existencias del " +
      "almacén de este cliente. Úsala para confirmar disponibilidad antes de " +
      "levantar un pedido.",
    input_schema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "SKU exacto tal como lo devolvió la búsqueda." },
      },
      required: ["sku"],
    },
  },
  {
    name: "crear_pedido",
    description:
      "Registra el pedido en el CRM como borrador, para que el vendedor asignado " +
      "lo revise y lo acepte. Llámala sólo cuando el cliente ya confirmó " +
      "explícitamente productos y cantidades. Valida existencias y devuelve el " +
      "folio; si falla, explícale al cliente el motivo que devuelva la herramienta. " +
      "Sólo funciona con clientes identificados.",
    input_schema: {
      type: "object",
      properties: {
        cuenta_id: {
          type: "string",
          description:
            "Obligatorio SÓLO si el contexto indica que este número está vinculado a varias cuentas: " +
            "el id de la cuenta que el cliente eligió. Nunca lo inventes; usa uno de los del contexto.",
        },
        notas: {
          type: "string",
          description:
            "Indicaciones del cliente que el vendedor deba ver: horario de recepción, referencias, urgencia.",
        },
        partidas: {
          type: "array",
          description: "Productos solicitados.",
          items: {
            type: "object",
            properties: {
              sku: { type: "string", description: "SKU exacto del catálogo." },
              cantidad: {
                type: "integer",
                description: "Número de botellas. Entero mayor a cero.",
              },
            },
            required: ["sku", "cantidad"],
          },
        },
      },
      required: ["partidas"],
    },
  },
  {
    name: "consultar_pedidos",
    description:
      "Devuelve los pedidos recientes con folio, estatus y total. Sin argumentos " +
      "consulta los del cliente con el que hablas. La administradora de Teravino " +
      "puede pasar cuenta_id para ver los de cualquier cuenta.",
    input_schema: {
      type: "object",
      properties: {
        cuenta_id: {
          type: "string",
          description:
            "Sólo para la administradora: id de la cuenta cuyos pedidos quieres ver. " +
            "Obtenlo con buscar_cuenta.",
        },
      },
      required: [],
    },
  },
  {
    name: "buscar_cuenta",
    description:
      "SÓLO para la administradora de Teravino. Busca cuentas del CRM por nombre " +
      "del negocio y devuelve su id, región, nivel de precio, estatus y días de " +
      "crédito. Con cualquier otra persona esta herramienta se rechaza.",
    input_schema: {
      type: "object",
      properties: {
        nombre: {
          type: "string",
          description: "Parte del nombre del negocio. Ej. 'Justina', 'Four Seasons'.",
        },
      },
      required: ["nombre"],
    },
  },
];

export async function runTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const { account, staff } = context;

  try {
    switch (name) {
      case "buscar_productos": {
        const results = await searchProducts(
          {
            query: typeof args.query === "string" ? args.query : undefined,
            categoria: typeof args.categoria === "string" ? args.categoria : undefined,
            precioMax: typeof args.precio_max === "number" ? args.precio_max : undefined,
            soloDisponibles: args.solo_disponibles === true,
          },
          account,
        );

        if (results.length === 0) {
          return {
            content: "Sin coincidencias en el catálogo para esos criterios.",
            isError: false,
          };
        }
        return { content: JSON.stringify(results, null, 2), isError: false };
      }

      case "listar_categorias":
        return { content: JSON.stringify(await listCategories()), isError: false };

      case "consultar_producto": {
        const sku = String(args.sku ?? "");
        const product = await getProductBySku(sku, account);
        if (!product) {
          return { content: `No existe el SKU ${sku} en el catálogo activo.`, isError: true };
        }
        return { content: JSON.stringify(product, null, 2), isError: false };
      }

      case "crear_pedido": {
        const partidas = Array.isArray(args.partidas) ? args.partidas : [];
        const items: OrderItemInput[] = partidas.map((raw) => {
          const item = (raw ?? {}) as Record<string, unknown>;
          return {
            sku: String(item.sku ?? ""),
            cantidad: Number(item.cantidad ?? 0),
          };
        });

        const order = await createOrder({
          account,
          items,
          notes: typeof args.notas === "string" ? args.notas : undefined,
          accountId: typeof args.cuenta_id === "string" ? args.cuenta_id : undefined,
        });

        return { content: JSON.stringify(order, null, 2), isError: false };
      }

      case "consultar_pedidos": {
        const requestedAccount =
          typeof args.cuenta_id === "string" ? args.cuenta_id.trim() : "";

        // Consultar una cuenta arbitraria es privilegio del equipo: un cliente
        // sólo puede ver las suyas, aunque pase el id de otra.
        if (requestedAccount) {
          if (!staff?.isAdmin) {
            return {
              content:
                "Sólo la administración de Teravino puede consultar pedidos de otras cuentas.",
              isError: true,
            };
          }
          const orders = await getOrdersForAccount(requestedAccount);
          if (orders.length === 0) {
            return { content: "Esa cuenta no tiene pedidos registrados.", isError: false };
          }
          return { content: JSON.stringify(orders, null, 2), isError: false };
        }

        if (!account.isKnown) {
          return {
            content: staff?.isAdmin
              ? "Eres la administradora, no una cuenta de cliente. Usa buscar_cuenta y pasa cuenta_id."
              : staff
                ? "Eres personal de Teravino, no una cuenta de cliente. Consulta los pedidos desde el CRM."
                : "Este número no está vinculado a ninguna cuenta del CRM.",
            isError: false,
          };
        }
        const orders = await getRecentOrders(account);
        if (orders.length === 0) {
          return { content: "Esta cuenta no tiene pedidos registrados.", isError: false };
        }
        return { content: JSON.stringify(orders, null, 2), isError: false };
      }

      case "buscar_cuenta": {
        if (!staff?.isAdmin) {
          return {
            content:
              "Sólo la administración de Teravino puede consultar el padrón de cuentas.",
            isError: true,
          };
        }
        const results = await searchAccounts(String(args.nombre ?? ""));
        if (results.length === 0) {
          return { content: "Ninguna cuenta coincide con ese nombre.", isError: false };
        }
        return { content: JSON.stringify(results, null, 2), isError: false };
      }

      default:
        return { content: `Herramienta desconocida: ${name}`, isError: true };
    }
  } catch (error) {
    if (error instanceof OrderError) {
      return { content: error.message, isError: true };
    }
    console.error(`[tool:${name}] error inesperado`, error);
    return {
      content: "La herramienta falló por un error interno. No reintentes; avisa al cliente.",
      isError: true,
    };
  }
}
