import type Anthropic from "@anthropic-ai/sdk";
import {
  getProductBySku,
  listCategories,
  searchProducts,
} from "../data/catalog.js";
import {
  createOrder,
  getOrdersByPhone,
  OrderError,
  type OrderItemInput,
} from "../data/orders.js";

/**
 * Contexto que el servidor inyecta en cada ejecución: el agente nunca recibe
 * el número de teléfono como parámetro, para que no pueda leer ni crear
 * pedidos de otro cliente aunque el usuario se lo pida.
 */
export interface ToolContext {
  phone: string;
}

export const tools: Anthropic.Tool[] = [
  {
    name: "buscar_productos",
    description:
      "Busca vinos y destilados en el catálogo por nombre, productor, origen o categoría. " +
      "Devuelve SKU, precio unitario sin IVA en MXN y existencias. " +
      "Úsala siempre antes de mencionar un precio o afirmar que hay disponibilidad: " +
      "nunca respondas precios ni stock de memoria.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Texto libre: nombre del vino, bodega, región o uva. Ej. 'Sancerre', 'Bruma', 'tinto de Valle de Guadalupe'.",
        },
        categoria: {
          type: "string",
          description:
            "Filtra por categoría exacta del catálogo. Usa listar_categorias si no la conoces.",
        },
        precio_max: {
          type: "number",
          description: "Precio unitario máximo sin IVA, en MXN.",
        },
        solo_disponibles: {
          type: "boolean",
          description: "Si es true, omite los productos agotados. Por defecto false.",
        },
      },
      required: [],
    },
  },
  {
    name: "listar_categorias",
    description:
      "Devuelve las categorías disponibles en el catálogo. Útil cuando el cliente " +
      "pregunta de forma abierta qué manejamos.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "consultar_producto",
    description:
      "Devuelve la ficha completa de un producto por su SKU exacto, incluyendo " +
      "existencias actuales. Úsala para confirmar disponibilidad antes de levantar un pedido.",
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
      "Registra un pedido a nombre del cliente con el que estás conversando. " +
      "Llámala sólo cuando el cliente ya confirmó explícitamente los productos, las " +
      "cantidades y a nombre de quién va. La herramienta valida existencias y " +
      "devuelve el folio y el total; si falla, explica el motivo al cliente.",
    input_schema: {
      type: "object",
      properties: {
        cliente: {
          type: "string",
          description: "Nombre de la persona o razón social a la que se factura el pedido.",
        },
        entrega: {
          type: "string",
          description: "Dirección o punto de entrega acordado, si el cliente lo dio.",
        },
        notas: {
          type: "string",
          description: "Cualquier indicación adicional del cliente (horario, referencias).",
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
      required: ["cliente", "partidas"],
    },
  },
  {
    name: "consultar_pedidos",
    description:
      "Devuelve los pedidos más recientes de este cliente, con folio, estado y total. " +
      "Úsala cuando pregunte por el estatus de algo que ya ordenó.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

/** Ejecuta una herramienta y devuelve el texto que verá el modelo. */
export async function runTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "buscar_productos": {
        const results = searchProducts({
          query: typeof args.query === "string" ? args.query : undefined,
          categoria: typeof args.categoria === "string" ? args.categoria : undefined,
          precioMax: typeof args.precio_max === "number" ? args.precio_max : undefined,
          soloDisponibles: args.solo_disponibles === true,
        });

        if (results.length === 0) {
          return {
            content: "Sin coincidencias en el catálogo para esos criterios.",
            isError: false,
          };
        }
        return { content: JSON.stringify(results, null, 2), isError: false };
      }

      case "listar_categorias":
        return { content: JSON.stringify(listCategories()), isError: false };

      case "consultar_producto": {
        const sku = String(args.sku ?? "");
        const product = getProductBySku(sku);
        if (!product) {
          return { content: `No existe el SKU ${sku}.`, isError: true };
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

        const order = createOrder({
          phone: context.phone,
          customer: String(args.cliente ?? "").trim() || "Cliente WhatsApp",
          delivery: typeof args.entrega === "string" ? args.entrega : undefined,
          notes: typeof args.notas === "string" ? args.notas : undefined,
          items,
        });

        return {
          content: JSON.stringify(
            {
              folio: order.id,
              estado: order.status,
              total_sin_iva: order.total,
              partidas: order.items,
            },
            null,
            2,
          ),
          isError: false,
        };
      }

      case "consultar_pedidos": {
        const orders = getOrdersByPhone(context.phone);
        if (orders.length === 0) {
          return { content: "Este cliente no tiene pedidos registrados.", isError: false };
        }
        return { content: JSON.stringify(orders, null, 2), isError: false };
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
