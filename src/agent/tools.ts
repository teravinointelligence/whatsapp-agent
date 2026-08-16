import type Anthropic from "@anthropic-ai/sdk";
import { resolveAccount, type AccountContext } from "../crm/accounts.js";
import {
  findAccountsByClientNumber,
  linkPhoneToAccount,
  LinkError,
  normalizeName,
  type LinkableAccount,
} from "../crm/link.js";
import {
  clearLinkFailures,
  getLinkFailures,
  recordLinkFailure,
} from "../data/conversations.js";
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
  accountEmails,
  emailIsRegistered,
  FinanceError,
  getStatement,
  listStatementEmails,
} from "../crm/finance.js";
import { listSampleRequests, SampleError } from "../crm/samples.js";
import {
  assignProspect,
  listProspects,
  ProspectError,
  registerProspect,
} from "../crm/prospects.js";
import {
  notifyAdminsOfAccountLink,
  notifyAdminsOfOrder,
  notifyAdminsOfProspect,
  notifyAdminsOfStatementRequest,
} from "../notify.js";
import { findPortfolios, plazaNames, portfolioForPlaza } from "../portfolio.js";

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

/**
 * Intentos con número de cliente equivocado antes de cortar.
 *
 * Los números van del 1 al 502, así que sin tope cualquiera los prueba hasta
 * pegarle a una cuenta ajena. Tres es suficiente para el cliente que se
 * equivoca de dígito y poco para quien anda tanteando.
 */
const MAX_LINK_FAILURES = 3;

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
    name: "vincular_cuenta",
    description:
      "Identifica a quien dice ya ser cliente de Teravino pero cuyo número no " +
      "reconocemos. Pídele PRIMERO su número de cliente —ese es el filtro— y " +
      "después su nombre; con los dos llama esta herramienta. Si el número es " +
      "correcto, su teléfono queda ligado a la cuenta y desde ese momento se le " +
      "atiende con sus precios. Si no lo tiene a la mano, no lo adivines ni lo " +
      "supongas: sin número no hay vinculación.",
    input_schema: {
      type: "object",
      properties: {
        numero_cliente: {
          type: "string",
          description: "Número de cliente tal como lo dio. Ej. '270', '439'.",
        },
        nombre: {
          type: "string",
          description: "Nombre completo de la persona con la que hablas.",
        },
        negocio: {
          type: "string",
          description:
            "Nombre del negocio. Sólo hace falta cuando la herramienta te avise " +
            "que ese número corresponde a más de una cuenta.",
        },
      },
      required: ["numero_cliente", "nombre"],
    },
  },
  {
    name: "enviar_portafolio",
    description:
      "Devuelve el link del portafolio digital que le toca al cliente. Úsala " +
      "siempre que pidan el catálogo, la lista de precios o el portafolio: cada " +
      "plaza tiene el suyo y NUNCA debes escribir un link de memoria. Con un " +
      "cliente ya identificado no necesitas argumentos. Con quien no lo está, " +
      "pregúntale primero de qué ciudad es y pasa lo que te haya dicho en 'plaza'.",
    input_schema: {
      type: "object",
      properties: {
        plaza: {
          type: "string",
          description:
            "Ciudad o zona que dijo el cliente, en sus palabras. Ej. 'Cabo San Lucas', " +
            "'La Paz', 'Sayulita', 'Ensenada'. Omítelo si el cliente ya está identificado.",
        },
      },
      required: [],
    },
  },
  {
    name: "mi_estado_de_cuenta",
    description:
      "Para el CLIENTE que pide su propio saldo o estado de cuenta. Antes de " +
      "dárselo hay que comprobar quién es: pídele su número de cliente Y un " +
      "correo que tengamos registrado, y llama a esta herramienta con los dos. " +
      "Los dos tienen que cuadrar; si no, no se le enseña nada. Nunca le digas " +
      "cuál es el correo registrado ni le des pistas: es él quien tiene que " +
      "decirlo. Si se equivoca varias veces, pásalo con el equipo.",
    input_schema: {
      type: "object",
      properties: {
        numero_cliente: {
          type: "string",
          description: "Número de cliente que dio. Ej. '120'.",
        },
        correo: {
          type: "string",
          description:
            "Correo que dictó, tal cual. No lo completes ni le corrijas el dominio.",
        },
        negocio: {
          type: "string",
          description:
            "Nombre del negocio. Sólo cuando la herramienta te avise que ese " +
            "número corresponde a más de una cuenta.",
        },
      },
      required: ["numero_cliente", "correo"],
    },
  },
  {
    name: "estado_de_cuenta",
    description:
      "SÓLO para la administradora. Saldo de una cuenta: total, cuánto está " +
      "vencido y desde cuándo, las facturas abiertas, el último pago recibido y " +
      "cuándo se le mandó por última vez su estado de cuenta por correo. Acepta " +
      "el número de cliente directo, sin buscar la cuenta antes.",
    input_schema: {
      type: "object",
      properties: {
        numero_cliente: {
          type: "string",
          description: "Número de cliente. Ej. '120'. Es la forma más directa.",
        },
        cuenta_id: {
          type: "string",
          description: "Id de la cuenta, si ya lo tienes de buscar_cuenta.",
        },
        historial_envios: {
          type: "boolean",
          description:
            "true para ver todos los envíos de estado de cuenta, no sólo el último.",
        },
      },
      required: [],
    },
  },
  {
    name: "consultar_muestras",
    description:
      "SÓLO para la administradora. Solicitudes de muestra del equipo. Sin " +
      "argumentos devuelve las que faltan por revisar, con folio, cuenta, " +
      "vendedor, productos y botellas.",
    input_schema: {
      type: "object",
      properties: {
        estatus: {
          type: "string",
          description:
            "'borrador' (pendientes por revisar, es lo que da por defecto), " +
            "'aprobada', 'rechazada', 'entregada', 'cancelada' o 'todas'.",
        },
      },
      required: [],
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

interface ToolOutcome {
  content: string;
  isError: boolean;
}

function remainingAttemptsNote(fallos: number): string {
  const restantes = MAX_LINK_FAILURES - fallos;
  return restantes > 0
    ? `Le quedan ${restantes} intento(s).`
    : "Ya no le quedan intentos: de aquí en adelante esto lo tiene que ver una persona del equipo.";
}

/**
 * Resuelve la cuenta a partir del número de cliente que dio la persona.
 *
 * La comparten vincular_cuenta y mi_estado_de_cuenta porque el filtro es el
 * mismo, incluido el tope de intentos: si cada una llevara su propia cuenta de
 * fallos, se podrían probar números al doble alternando entre las dos.
 */
async function accountFromClientNumber(
  numero: string,
  negocio: string,
  userId: string,
): Promise<{ account: LinkableAccount } | { error: ToolOutcome }> {
  const matches = await findAccountsByClientNumber(numero);

  if (matches.length === 0) {
    const fallos = recordLinkFailure(userId);
    return {
      error: {
        content:
          `No hay ninguna cuenta con el número de cliente ${numero}. Díselo y pídele que lo verifique en alguna factura o con su asesor. ` +
          remainingAttemptsNote(fallos),
        isError: true,
      },
    };
  }

  if (matches.length === 1) return { account: matches[0]! };

  // Ocho números están repetidos en dos cuentas. Se resuelve con el nombre del
  // negocio que diga la persona, no enseñándole la lista: quien esté probando
  // números no tiene por qué enterarse de quiénes son nuestros clientes.
  if (!negocio) {
    return {
      error: {
        content: `El número ${numero} corresponde a más de una cuenta. Pregúntale el nombre del negocio y vuelve a llamarme con él en 'negocio'. No le enseñes opciones.`,
        isError: true,
      },
    };
  }

  const needle = normalizeName(negocio);
  const filtered = matches.filter((candidate) => {
    const name = normalizeName(candidate.businessName);
    return name.includes(needle) || needle.includes(name);
  });

  if (filtered.length !== 1) {
    const fallos = recordLinkFailure(userId);
    return {
      error: {
        content:
          `El negocio que dio no corresponde al número ${numero}. Díselo sin darle pistas y pídele que lo verifique. ` +
          remainingAttemptsNote(fallos),
        isError: true,
      },
    };
  }

  return { account: filtered[0]! };
}

export async function runTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolOutcome> {
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

        void notifyAdminsOfOrder({
          folio: order.folio,
          businessName: order.negocio,
          total: order.total,
          botellas: order.partidas.reduce((sum, line) => sum + line.cantidad, 0),
          warehouse: order.almacen,
          repNotified: order.avisoAlVendedor,
        });

        return {
          content: JSON.stringify(
            {
              ...order,
              nota: order.avisoAlVendedor
                ? "Su vendedor ya tiene la tarea de revisarlo en el CRM."
                : "Esta cuenta no tiene vendedor asignado; se avisó a la administración.",
            },
            null,
            2,
          ),
          isError: false,
        };
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

      case "mi_estado_de_cuenta": {
        if (staff) {
          return {
            content:
              "Eres del equipo: para ver el saldo de una cuenta usa estado_de_cuenta.",
            isError: true,
          };
        }
        if (!phone) {
          return {
            content:
              "Primero necesita compartir su teléfono con el botón; sin eso no atiendo cobranza.",
            isError: true,
          };
        }

        if (getLinkFailures(context.userId) >= MAX_LINK_FAILURES) {
          return {
            content:
              "Ya falló demasiadas veces identificándose. No lo intentes otra vez: dile que por seguridad su estado de cuenta se lo tiene que dar una persona del equipo y ofrécele el contacto.",
            isError: true,
          };
        }

        const numero =
          typeof args.numero_cliente === "string" ? args.numero_cliente.trim() : "";
        const correo = typeof args.correo === "string" ? args.correo.trim() : "";

        if (!numero || !correo) {
          return {
            content:
              "Necesito su número de cliente y un correo registrado. Pídele lo que falte antes de volver a llamarme.",
            isError: true,
          };
        }

        const resolved = await accountFromClientNumber(
          numero,
          typeof args.negocio === "string" ? args.negocio.trim() : "",
          context.userId,
        );
        if ("error" in resolved) return resolved.error;

        const registrados = await accountEmails(resolved.account.id);

        if (registrados.length === 0) {
          // No es culpa suya y no cuenta como intento: esa cuenta simplemente
          // no tiene correos capturados y no hay contra qué comprobar.
          return {
            content:
              "Esa cuenta no tiene ningún correo registrado en el CRM, así que no hay forma de comprobar quién es. Dile que su asesor o la administración se lo hace llegar, y ofrécele el contacto.",
            isError: true,
          };
        }

        if (!emailIsRegistered(correo, registrados)) {
          const fallos = recordLinkFailure(context.userId);
          return {
            content:
              "Ese correo no está registrado en esa cuenta. Díselo así, sin decirle cuál sí está ni darle pistas, y pídele que use el correo con el que recibe las facturas. " +
              remainingAttemptsNote(fallos),
            isError: true,
          };
        }

        clearLinkFailures(context.userId);

        const statement = await getStatement(resolved.account.id);

        void notifyAdminsOfStatementRequest({
          businessName: statement.negocio,
          clientNumber: statement.numeroCliente,
          email: correo.toLowerCase(),
          phone,
          balance: statement.saldoTotal,
        });

        return {
          content: JSON.stringify(
            {
              verificado: true,
              negocio: statement.negocio,
              dias_credito: statement.diasCredito,
              saldo_total: statement.saldoTotal,
              vencido: statement.vencido,
              por_vencer: statement.porVencer,
              facturas_abiertas: statement.facturasAbiertas,
              facturas: statement.facturas.slice(0, 5),
              ultimo_pago: statement.ultimoPago,
              nota: "Cifras en pesos, con IVA incluido, tal como se facturaron. Si pide el desglose completo o el PDF, dile que se lo manda la administración por correo.",
            },
            null,
            2,
          ),
          isError: false,
        };
      }

      case "estado_de_cuenta": {
        if (!staff?.isAdmin) {
          return {
            content:
              "Sólo la administración de Teravino puede consultar saldos y cobranza.",
            isError: true,
          };
        }

        const numero =
          typeof args.numero_cliente === "string" ? args.numero_cliente.trim() : "";
        let accountId = typeof args.cuenta_id === "string" ? args.cuenta_id.trim() : "";

        if (!accountId && numero) {
          const matches = await findAccountsByClientNumber(numero);
          if (matches.length === 0) {
            return {
              content: `No hay ninguna cuenta con el número de cliente ${numero}.`,
              isError: true,
            };
          }
          if (matches.length > 1) {
            const nombres = matches.map((m) => `${m.businessName} (${m.id})`).join(", ");
            return {
              content: `El número ${numero} lo tienen dos cuentas: ${nombres}. Pregúntale cuál y vuelve a llamarme con cuenta_id.`,
              isError: true,
            };
          }
          accountId = matches[0]!.id;
        }

        if (!accountId) {
          return {
            content:
              "Necesito el número de cliente o el cuenta_id. Si sólo tienes el nombre, búscalo antes con buscar_cuenta.",
            isError: true,
          };
        }

        const statement = await getStatement(accountId);

        if (args.historial_envios === true) {
          const envios = await listStatementEmails(accountId);
          return {
            content: JSON.stringify({ ...statement, envios }, null, 2),
            isError: false,
          };
        }

        return { content: JSON.stringify(statement, null, 2), isError: false };
      }

      case "consultar_muestras": {
        if (!staff?.isAdmin) {
          return {
            content: "Sólo la administración de Teravino puede ver las muestras.",
            isError: true,
          };
        }

        const estatus = typeof args.estatus === "string" ? args.estatus.trim() : "";
        const muestras = await listSampleRequests(estatus || undefined);

        if (muestras.length === 0) {
          return {
            content: estatus
              ? `No hay solicitudes de muestra con estatus "${estatus}".`
              : "No hay solicitudes de muestra pendientes por revisar.",
            isError: false,
          };
        }
        return { content: JSON.stringify(muestras, null, 2), isError: false };
      }

      case "vincular_cuenta": {
        if (staff) {
          return {
            content: "Eres del equipo de Teravino; esto es para clientes.",
            isError: true,
          };
        }
        if (!phone) {
          return {
            content:
              "Todavía no comparte su teléfono, y es lo que vamos a ligar a la cuenta. Pídeselo primero con el botón.",
            isError: true,
          };
        }
        if (account.isKnown) {
          const nombres = account.candidates.map((c) => c.businessName).join(", ");
          return {
            content: `Ya está identificado como ${nombres}; no hace falta el número de cliente.`,
            isError: true,
          };
        }

        const previas = getLinkFailures(context.userId);
        if (previas >= MAX_LINK_FAILURES) {
          return {
            content:
              "Ya falló demasiadas veces con el número de cliente. No lo intentes otra vez: dile que por seguridad esto lo tiene que ver una persona del equipo y ofrécele el contacto.",
            isError: true,
          };
        }

        const numero = String(args.numero_cliente ?? "").trim();
        const nombre = String(args.nombre ?? "").trim();

        if (!numero || !nombre) {
          return {
            content:
              "Necesito su número de cliente y su nombre. Pídele lo que falte antes de volver a llamarme.",
            isError: true,
          };
        }

        const resolved = await accountFromClientNumber(
          numero,
          typeof args.negocio === "string" ? args.negocio.trim() : "",
          context.userId,
        );
        if ("error" in resolved) return resolved.error;
        const target = resolved.account;

        const { contactCreated } = await linkPhoneToAccount({
          account: target,
          phone,
          fullName: nombre,
        });

        clearLinkFailures(context.userId);

        // El contexto de este turno se resolvió cuando el cliente todavía era
        // un desconocido. Se refresca en el mismo objeto para que lo que
        // cotice de aquí en adelante ya salga con sus precios y su almacén.
        Object.assign(context.account, await resolveAccount(phone));

        void notifyAdminsOfAccountLink({
          businessName: target.businessName,
          clientNumber: target.clientNumber,
          personName: nombre,
          phone,
          contactCreated,
        });

        return {
          content: JSON.stringify(
            {
              identificado: true,
              negocio: target.businessName,
              estatus: target.status,
              almacen: target.warehouse,
              contacto_nuevo: contactCreated,
              nota: contactCreated
                ? "Quedó ligado a la cuenta y registrado como contacto nuevo. Ya puedes cotizarle a su precio."
                : "Ya estaba en el CRM; sólo se le agregó este teléfono. Ya puedes cotizarle a su precio.",
            },
            null,
            2,
          ),
          isError: false,
        };
      }

      case "enviar_portafolio": {
        const pedida = typeof args.plaza === "string" ? args.plaza.trim() : "";

        // La plaza de un cliente identificado la manda su cuenta, no lo que
        // diga en el chat: su portafolio es el de la plaza que lo surte.
        if (account.isKnown && !account.isAmbiguous) {
          const portfolio = portfolioForPlaza(account.warehouse);
          if (portfolio) {
            return {
              content: JSON.stringify(
                { plaza: portfolio.plaza, link: portfolio.url },
                null,
                2,
              ),
              isError: false,
            };
          }
        }

        if (!pedida) {
          return {
            content:
              `Falta saber de qué plaza es. Pregúntale de qué ciudad es y vuelve a llamarme con eso. Las plazas son: ${plazaNames().join(", ")}.`,
            isError: true,
          };
        }

        const matches = findPortfolios(pedida);

        if (matches.length === 0) {
          return {
            content:
              `No reconozco "${pedida}" como una de nuestras plazas (${plazaNames().join(", ")}). Pregúntale a cuál le queda más cerca; no le mandes un link al tanteo.`,
            isError: true,
          };
        }
        if (matches.length > 1) {
          const plazas = matches.map((p) => p.plaza).join(" o ");
          return {
            content: `"${pedida}" puede ser ${plazas}. Pregúntale cuál antes de mandarle nada.`,
            isError: true,
          };
        }

        const portfolio = matches[0]!;
        return {
          content: JSON.stringify(
            { plaza: portfolio.plaza, link: portfolio.url },
            null,
            2,
          ),
          isError: false,
        };
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
    if (
      error instanceof OrderError ||
      error instanceof ProspectError ||
      error instanceof LinkError ||
      error instanceof FinanceError ||
      error instanceof SampleError
    ) {
      return { content: error.message, isError: true };
    }
    console.error(`[tool:${name}] error inesperado`, error);
    return {
      content: "La herramienta falló por un error interno. No reintentes; avisa al cliente.",
      isError: true,
    };
  }
}
