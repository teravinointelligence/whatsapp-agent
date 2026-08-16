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
import {
  assignProspect,
  listProspects,
  ProspectError,
  registerProspect,
} from "../crm/prospects.js";
import { notifyAdminsOfProspect } from "../notify.js";

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
  /** Teléfono verificado que compartió, o null si aún no lo comparte. */
  phone: string | null;
  /** Id de Telegram, para poder volver a contactar al prospecto. */
  userId: string;
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
  {
    name: "registrar_prospecto",
    description:
      "Registra en el CRM a un negocio que todavía no es cliente, para que la " +
      "administración le asigne un vendedor. Úsala cuando alguien no identificado " +
      "te diga de qué negocio viene y quiera trabajar con nosotros. Pide el nombre " +
      "del negocio y su correo, que es a donde se le mandarán cotizaciones y " +
      "facturas; lo demás es opcional. Si vuelve a escribir no se duplica, se " +
      "actualiza. Sólo funciona con quien ya compartió su teléfono.",
    input_schema: {
      type: "object",
      properties: {
        negocio: {
          type: "string",
          description: "Nombre del hotel, restaurante o bar. Obligatorio.",
        },
        contacto: {
          type: "string",
          description: "Nombre de la persona con la que hablas.",
        },
        correo: {
          type: "string",
          description:
            "Correo para cotizaciones y facturas. Escríbelo tal como lo dictó, sin " +
            "completarlo ni corregirle el dominio.",
        },
        ciudad: {
          type: "string",
          description: "Ciudad o zona donde opera. Ej. 'Los Cabos', 'La Paz'.",
        },
        interes: {
          type: "string",
          description:
            "Qué busca, en sus propias palabras. Ej. 'vinos blancos por copeo para su carta'.",
        },
      },
      required: ["negocio"],
    },
  },
  {
    name: "consultar_prospectos",
    description:
      "SÓLO para la administradora. Lista los prospectos captados, del más " +
      "reciente al más viejo, con su estatus y el vendedor asignado.",
    input_schema: {
      type: "object",
      properties: {
        estatus: {
          type: "string",
          description:
            "Filtra por estatus: 'nuevo', 'asignado', 'convertido' o 'descartado'. " +
            "Omítelo para verlos todos.",
        },
      },
      required: [],
    },
  },
  {
    name: "asignar_prospecto",
    description:
      "SÓLO para la administradora. Asigna un prospecto a un vendedor por su " +
      "nombre y lo deja en estatus 'asignado'. Obtén el id con consultar_prospectos.",
    input_schema: {
      type: "object",
      properties: {
        prospecto_id: {
          type: "string",
          description: "Id del prospecto, tal como lo devolvió consultar_prospectos.",
        },
        vendedor: {
          type: "string",
          description: "Nombre del vendedor. Ej. 'Yamile', 'Citlali'.",
        },
      },
      required: ["prospecto_id", "vendedor"],
    },
  },
];

export async function runTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<{ content: string; isError: boolean }> {
  const args = (input ?? {}) as Record<string, unknown>;
  const { account, staff, phone } = context;

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

      case "registrar_prospecto": {
        if (!phone) {
          return {
            content:
              "Todavía no compartió su teléfono, así que no hay a quién registrar. Pídeselo con el botón.",
            isError: true,
          };
        }
        if (staff) {
          return {
            content: "Eres del equipo de Teravino, no un prospecto.",
            isError: true,
          };
        }
        if (account.isKnown) {
          const nombres = account.candidates.map((c) => c.businessName).join(", ");
          return {
            content: `Este cliente ya está dado de alta como ${nombres}; no hay que registrarlo como prospecto.`,
            isError: true,
          };
        }

        const { prospect, isNew, emailRejected } = await registerProspect({
          phone,
          telegramUserId: context.userId,
          businessName: String(args.negocio ?? ""),
          contactName: typeof args.contacto === "string" ? args.contacto : undefined,
          email: typeof args.correo === "string" ? args.correo : undefined,
          city: typeof args.ciudad === "string" ? args.ciudad : undefined,
          interest: typeof args.interes === "string" ? args.interes : undefined,
        });

        // El aviso a la administración no debe bloquear la respuesta al cliente.
        void notifyAdminsOfProspect(prospect);

        const notas = [
          isNew
            ? "Quedó registrado y la administración ya fue avisada."
            : "Ya estaba registrado; se actualizaron sus datos.",
        ];
        if (emailRejected) {
          notas.push(
            "El correo que pasaste no tiene forma de correo y NO se guardó: pídeselo otra vez y vuelve a llamar la herramienta.",
          );
        } else if (!prospect.correo) {
          notas.push(
            "Todavía no tiene correo registrado. Pídeselo para poder mandarle cotizaciones y facturas, y vuelve a llamar la herramienta con él.",
          );
        }

        return {
          content: JSON.stringify(
            {
              registrado: true,
              nuevo: isNew,
              negocio: prospect.negocio,
              correo: prospect.correo,
              estatus: prospect.estatus,
              nota: notas.join(" "),
            },
            null,
            2,
          ),
          isError: false,
        };
      }

      case "consultar_prospectos": {
        if (!staff?.isAdmin) {
          return {
            content: "Sólo la administración de Teravino puede ver los prospectos.",
            isError: true,
          };
        }
        const estatus = typeof args.estatus === "string" ? args.estatus.trim() : "";
        const prospects = await listProspects(estatus || undefined);
        if (prospects.length === 0) {
          return { content: "No hay prospectos con ese criterio.", isError: false };
        }
        return { content: JSON.stringify(prospects, null, 2), isError: false };
      }

      case "asignar_prospecto": {
        if (!staff?.isAdmin) {
          return {
            content: "Sólo la administración de Teravino puede asignar prospectos.",
            isError: true,
          };
        }
        const prospect = await assignProspect(
          String(args.prospecto_id ?? ""),
          String(args.vendedor ?? ""),
        );
        return { content: JSON.stringify(prospect, null, 2), isError: false };
      }

      default:
        return { content: `Herramienta desconocida: ${name}`, isError: true };
    }
  } catch (error) {
    if (error instanceof OrderError || error instanceof ProspectError) {
      return { content: error.message, isError: true };
    }
    console.error(`[tool:${name}] error inesperado`, error);
    return {
      content: "La herramienta falló por un error interno. No reintentes; avisa al cliente.",
      isError: true,
    };
  }
}
