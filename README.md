# Agente de ventas por Telegram

Bot de Telegram con **Claude**, conectado al CRM de Teravino en Supabase.
Responde preguntas, cotiza con precios y existencias reales, y levanta pedidos
que aparecen en el CRM que el equipo ya usa.

- **Node.js 20+ y TypeScript**
- **Telegram Bot API** — sin verificación de negocio, sin ventana de 24 h, sin plantillas
- **Claude (Opus 5)** con herramientas: no inventa precios ni existencias
- **Supabase `teravino-crm`** como única fuente de verdad del negocio

> **Por qué Telegram y no WhatsApp.** La Política de Comercio de WhatsApp
> prohíbe la compra, venta y promoción de alcohol; la cuenta de Teravino quedó
> restringida por ese motivo. Telegram no tiene esa restricción. El historial
> del repositorio conserva la implementación de WhatsApp por si algún día se
> resuelve la apelación.

---

## Cómo funciona

```
Telegram → long polling o webhook
                │  deduplica por update_id
                ▼
      identifica al cliente
      (telegram_id → teléfono → cuenta del CRM)
                ▼
         bucle del agente (Claude)
                │
   ┌────────────┼────────────┐
buscar_productos  crear_pedido  consultar_pedidos
   │              │              │
   ▼              ▼              ▼
   Supabase teravino-crm (products, orders, accounts)
                │
                ▼
        respuesta → Bot API → Telegram
```

### Herramientas del agente

| Herramienta | Qué hace |
|---|---|
| `buscar_productos` | Busca en los 978 productos activos por nombre, bodega, varietal, región o SKU |
| `listar_categorias` | Categorías del catálogo |
| `consultar_producto` | Ficha y existencias por SKU |
| `crear_pedido` | Crea el pedido en `orders`/`order_items` como borrador |
| `consultar_pedidos` | Pedidos recientes de las cuentas de ese cliente |
| `buscar_cuenta` | **Sólo equipo**: busca cuentas del CRM por nombre |

**La cuenta no es un parámetro de ninguna herramienta.** El servidor la resuelve
antes de invocar al agente, así que no puede leer ni escribir sobre otro cliente
aunque el usuario se lo pida.

---

## Identificación del cliente

Aquí está la diferencia grande contra WhatsApp: **Telegram no expone el teléfono**.
Sólo da un `user_id` numérico. Como el CRM identifica por teléfono, el flujo es:

1. El cliente escribe por primera vez → el agente le responde y le muestra el
   botón **"📱 Compartir mi número"**.
2. Al tocarlo, Telegram manda el teléfono verificado de esa cuenta.
3. Se guarda la equivalencia `user_id → teléfono` en la tabla `identities` y ya
   no se le vuelve a pedir.
4. Ese teléfono se resuelve contra `contacts.whatsapp` / `contacts.phone` por sus
   últimos 10 dígitos, igual que antes.

> **Sólo se acepta el contacto propio.** Telegram permite mandar la tarjeta de
> cualquier persona de tu agenda. El servidor exige que `contact.user_id`
> coincida con quien envía el mensaje; si no, lo descarta. Sin esa validación,
> cualquiera podría suplantar a un cliente mandando su tarjeta de contacto.

**El teléfono lo comparte la persona, no lo obtenemos nosotros.** Si se niega,
el bot lo atiende con precios de lista pero no puede levantarle pedidos.

---

## Modo interno para el equipo

Si el número que comparten está en `sales_reps` **y está activo**, el agente lo
trata como personal de Teravino y no como cliente: no le pide darse de alta y le
habla como colega.

El equipo puede además:

- **`buscar_cuenta`** — consultar cualquier cuenta del padrón por nombre, con su
  región, nivel de precio, estatus y días de crédito.
- **`consultar_pedidos` con `cuenta_id`** — ver los pedidos de cualquier cuenta.

**Estas dos capacidades se validan en el servidor, no en el prompt.** Si un
cliente pide "muéstrame los pedidos de tal negocio", la herramienta lo rechaza
aunque el modelo intentara complacerlo.

El equipo **no puede levantar pedidos a nombre de clientes** por este canal; eso
sigue haciéndose desde el CRM.

Para dar de alta a alguien basta con capturar su número en `sales_reps.whatsapp`.
Para retirarle el acceso, se le pone `active = false` — sin tocar código.

---

## Cómo se conecta al CRM

### Precios

`products.base_price` multiplicado por el nivel de la cuenta:

| `accounts.price_tier` | Factor |
|---|---|
| `base` | × 1.00 |
| `+10` | × 1.10 |

Regla **deducida de los pedidos históricos** (92 de 94 renglones en `base`, 120
de 125 en `+10`), no documentada en la base. Si no es correcta, se cambia en
`PRICE_TIER_FACTOR` dentro de `src/config.ts`.

Los precios son por botella y sin IVA; el pedido calcula el 16% al guardar.

### Almacenes

`accounts.region` decide de qué almacén se leen las existencias:

| Región | Almacén |
|---|---|
| Los Cabos, Todos Santos | Los Cabos |
| La Paz | La Paz |
| Tijuana | Tijuana |
| Puerto Vallarta, Nayarit | Vallarta |

Las 93 cuentas sin región usan `DEFAULT_WAREHOUSE`. `V612` queda fuera del mapeo
por ser bodega central y no plaza de venta.

### Compradores con varias cuentas

Hay 13 números vinculados a más de una cuenta (`LA JUSTINA` / `LA JUSTINA VALLE`
/ `OJA`, `EMMA` / `TOWER BAR`). Comparten nivel de precio y almacén, así que
cotizar siempre es seguro; lo ambiguo es a quién se factura. El agente ve la
lista y **tiene que preguntar** a cuál va el pedido. Sólo puede elegir entre las
cuentas de ese número: un id ajeno se rechaza en el servidor.

### Pedidos

Entran a `orders` con `status = 'borrador'`, `order_type = 'whatsapp'` y el
`sales_rep_id` de la cuenta, con folio `COT-2026-NNNN`. El vendedor los revisa en
TERAVINO Flow antes de aceptarlos. Si fallan las partidas, el encabezado se borra.

---

## Puesta en marcha

### 1. Crear el bot

En Telegram, escríbele a **[@BotFather](https://t.me/BotFather)**:

```
/newbot
```

Te pide un nombre visible (`Teravino`) y un usuario que termine en `bot`
(`teravino_ventas_bot`). Te devuelve el **token** — ese va en
`TELEGRAM_BOT_TOKEN`.

Opcional pero recomendable, con BotFather:

| Comando | Para qué |
|---|---|
| `/setdescription` | Texto que ven al abrir el chat por primera vez |
| `/setabouttext` | Descripción corta del perfil |
| `/setuserpic` | Logo de Teravino |
| `/setprivacy` | Déjalo en **enabled**: el bot sólo verá mensajes dirigidos a él |

### 2. Configurar

```bash
npm install
cp .env.example .env
```

Completa `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY` y
`SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API).

> La `service_role key` se salta RLS. Nunca la expongas ni la subas al repositorio.

### 3. Arrancar

```bash
npm run dev
```

En modo `polling` no necesitas dominio, HTTPS ni ngrok. Búscalo por su usuario
en Telegram y escríbele.

### Probar sin Telegram

```bash
npm run chat -- 6122009974      # simula a un cliente del CRM
npm run chat                    # simula a alguien no identificado
```

Usa el mismo bucle y el mismo CRM. **Los pedidos que levantes se crean de verdad**
— bórralos después o usa un teléfono que no esté en el CRM.

---

## Producción

```bash
npm run build
npm start
```

`polling` funciona en producción y es más simple. Si prefieres webhook:

```
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://tu-dominio.com/telegram
TELEGRAM_WEBHOOK_SECRET=una-cadena-larga-que-tu-inventes
```

El servidor registra el webhook solo al arrancar. Cada POST se valida contra el
encabezado `X-Telegram-Bot-Api-Secret-Token`; los que no cuadran se rechazan con 401.

SQLite necesita disco persistente — Railway o Fly.io funcionan sin ajustes.

---

## Ajustar el comportamiento

| Qué | Dónde |
|---|---|
| Tono, reglas de venta, límites | `src/agent/prompt.ts` |
| Herramientas disponibles | `src/agent/tools.ts` |
| Regla de precios y mapeo de almacenes | `src/config.ts` |
| Consultas al CRM | `src/crm/` |
| Capa de Telegram | `src/telegram/` |
| Estatus del pedido | `ORDER_STATUS` (`borrador` por defecto) |
| Latencia vs. criterio | `ANTHROPIC_EFFORT` (`low` por defecto) |
| Memoria de la conversación | `HISTORY_TURNS` (20 turnos) |

---

## Notas de operación

- **Formato**: las respuestas se mandan con `parse_mode: HTML`. El texto se
  escapa completo y sólo se reponen `<b>` e `<i>`; cualquier otra etiqueta llega
  como texto plano. El prompt le indica al modelo que no use asteriscos, que en
  Telegram se verían literales.
- **Deduplicación**: por `update_id`, tanto en polling como en webhook.
- **Offset del polling**: se persiste, así que un reinicio no reprocesa la cola.
- **Sólo chats privados**: en grupos el bot vería mensajes de terceros y no
  podría saber a nombre de quién actúa, así que los ignora.
- **Folio**: se calcula leyendo el último `COT-<año>-NNNN`. Con dos pedidos
  simultáneos hay una carrera teórica; al volumen actual no compensa un contador
  transaccional.
