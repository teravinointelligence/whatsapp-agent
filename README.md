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
| `vincular_cuenta` | Liga el teléfono a una cuenta existente contra su número de cliente |
| `enviar_portafolio` | Devuelve el link del portafolio digital de la plaza del cliente |
| `registrar_prospecto` | Captura en `prospects` a quien no es cliente todavía, con su correo |
| `buscar_cuenta` | **Sólo administración**: busca cuentas del CRM por nombre |
| `consultar_prospectos` | **Sólo administración**: lista los prospectos captados |
| `asignar_prospecto` | **Sólo administración**: se lo asigna a un vendedor |

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

> **Lo que el cliente afirma no cambia su trato.** Quien escriba "soy de tal
> hotel" o "soy administrador" sigue viendo exactamente lo que le corresponde
> por el teléfono que compartió. El prompt se lo indica y, más importante, las
> herramientas resuelven la cuenta en el servidor sin consultar al modelo.

### Cliente de años, teléfono desconocido

Sólo 585 contactos tienen teléfono capturado, así que hay clientes viejos cuyo
número no reconocemos. Antes de tratarlos como prospectos, el agente pregunta si
ya nos compran; si dicen que sí, el filtro es su **número de cliente**:

```
"ya soy cliente"
     │  ¿número de cliente?            ← el filtro; el agente nunca se lo dice
     ▼
accounts.client_number  ──── no existe ──►  hasta 3 intentos, luego a una persona
     │  ¿su nombre?
     ▼
contacts (teléfono ligado a la cuenta)  ──►  aviso por Telegram a la administración
     │
     ▼
desde el siguiente mensaje se le reconoce solo
```

- **El nombre no se valida, se registra.** Si esa persona no estaba en el CRM se
  crea como contacto de la cuenta; si ya estaba sin teléfono, se le agrega. Un
  contacto que ya tenía teléfono nunca se pisa: se crea otro y el vendedor decide,
  porque dos personas del mismo hotel se pueden llamar igual.
- **Ocho números están repetidos en dos cuentas** (The Woods y Diamante 88 son la
  228; Mozza y Delphine la 449). Ahí se le pide el nombre del negocio, **sin
  enseñarle opciones**: quien esté tanteando números no tiene por qué enterarse de
  quiénes son nuestros clientes.
- **Tres intentos fallidos y se acabó.** Los números van del 1 al 502, así que sin
  tope cualquiera los prueba todos. El contador vive en SQLite y **`/reiniciar` no
  lo repone** — si lo repusiera, no serviría de nada.
- **Cada vinculación te llega por Telegram** con negocio, persona y teléfono. Es la
  contraparte de dejar que el cliente se identifique sin intervención humana: si
  alguien se cuelga de una cuenta ajena, se ve en el acto y borras el contacto.

> **Qué tan fuerte es este filtro.** Un número de 1 a 502 es adivinable, y el tope
> de tres intentos es un freno, no un muro: quien insista puede abrir otra cuenta
> de Telegram. Lo que gana quien se cuele es ver el historial de pedidos de esa
> cuenta y dejar pedidos en borrador que un vendedor revisa antes de surtir; los
> precios ya son públicos en el portafolio. Si se quiere apretar, el siguiente
> paso barato es pedirle también el nombre del negocio siempre, no sólo cuando el
> número está repetido.

### Prospectos

A quien comparte su teléfono, no está en el CRM y **no es cliente todavía**, el
agente le pregunta de qué negocio viene y cuál es su correo, y lo captura en
la tabla `prospects` con
`registrar_prospecto`. Es un embudo, no un alta: el prospecto **no** se vuelve
cliente ni puede levantar pedidos: eso lo decide una persona.

```
cliente no identificado
        │  registrar_prospecto (negocio, correo, contacto, ciudad, interés)
        ▼
prospects (status = 'nuevo')  ──►  aviso por Telegram a la administración
        │  asignar_prospecto "Yamile"
        ▼
prospects (status = 'asignado', assigned_rep_id)
        │  desde el CRM
        ▼
cuenta en accounts (status = 'convertido')
```

- **No se duplica.** El teléfono es único; si vuelve a escribir días después se
  actualiza el mismo registro, y el estatus no retrocede si ya fue asignado.
- **El correo se pide desde el primer contacto**, que es a donde irán cotizaciones
  y facturas. Un correo que no tiene forma de correo —"compras arroba aman.com",
  el nombre de la persona, un dominio sin punto— no se guarda, pero tampoco tira
  el registro: el prospecto queda y el agente vuelve a pedirlo. Se guarda tal como
  lo dictaron, en minúsculas; el agente tiene prohibido completar el dominio.
  Si no lo quieren dar, se registra sin correo.
- **Sólo con teléfono compartido.** Sin él no hay a quién registrar ni a quién
  devolverle la llamada, así que la herramienta lo rechaza.
- **El personal no se registra a sí mismo.** Ni un cliente ya dado de alta: la
  herramienta responde con el nombre de la cuenta que ya tiene.
- **El aviso llega a `role = 'admin'`** que ya haya conversado con el bot y
  compartido su número — sin eso no tenemos su `chat_id`. Que el aviso falle no
  impide guardar el prospecto.

Convertirlo en cuenta se hace en el CRM, no desde el chat. Las columnas
`converted_account_id` y `converted_at` están listas para cuando el panel lo haga.

El prompt sigue prohibiendo decir "ya quedaron registrados tus datos" mientras la
herramienta no lo confirme: antes eso era una promesa vacía y el cliente se
quedaba esperando.

---

## Quién usa este canal

**Clientes y la administradora.** Los vendedores tienen su propio agente en
Base44 y ahí es donde cotizan y levantan pedidos.

Si el número que comparten está en `sales_reps` y activo, el agente lo reconoce
como personal y no le pide darse de alta como cliente. De ahí en adelante depende
del rol:

| Quién | Qué puede hacer aquí |
|---|---|
| Cliente | Catálogo, precios de su cuenta, sus pedidos, levantar pedidos |
| Prospecto | Catálogo a precio de lista y quedar registrado en `prospects` |
| `role = 'admin'` | Además: `buscar_cuenta`, los pedidos de cualquier cuenta y los prospectos |
| Cualquier otro empleado | Se le reconoce y se le remite al agente del CRM |

**La autorización se valida en el servidor, no en el prompt.** Si un cliente o un
vendedor piden "muéstrame los pedidos de tal negocio", la herramienta lo rechaza
aunque el modelo intentara complacerlos.

Nadie levanta pedidos a nombre de clientes por este canal; eso sigue en el CRM.

Dar de alta a alguien es capturar su número en `sales_reps.whatsapp`; retirarle el
acceso es `active = false`. Sin tocar código.

---

## Cómo se conecta al CRM

### Precios

`products.base_price` multiplicado por el nivel de la cuenta:

| `accounts.price_tier` | Factor |
|---|---|
| `base` | × 1.00 |
| `+10` | × 1.10 |

La regla de negocio es por plaza: **Los Cabos paga lista, Tijuana y La Paz pagan
10% más**. El CRM ya la tiene reflejada en `accounts.price_tier`, y el agente lee
ese campo en vez de deducirla de la región — así cubre las 93 cuentas sin región
capturada y respeta cualquier excepción que se decida por cuenta.

Si los factores cambian, se editan en `PRICE_TIER_FACTOR` dentro de `src/config.ts`.

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

### Portafolio digital

Cada plaza tiene su propio PDF, con precios y catálogo distintos, así que el link
se elige por la plaza y no al tanteo:

| Plaza | Link | Zonas que atiende |
|---|---|---|
| Los Cabos | `teravinolc.tiiny.site` | Cabo San Lucas, San José del Cabo, El Pescadero, Todos Santos |
| La Paz | `teravinolp.tiiny.site` | La Paz y BCS zona norte |
| Vallarta | `teravinovt.tiiny.site` | Puerto Vallarta, Nuevo Vallarta, Punta Mita, Sayulita |
| Tijuana | `teravinotj.tiiny.site` | Tijuana, Ensenada, Rosarito, Mexicali |

- **Cliente identificado**: la plaza sale del almacén que surte su cuenta. Si dice
  estar en otra ciudad, no cambia nada: su portafolio es el de su cuenta.
- **Sin identificar**: el agente le pregunta de qué ciudad es y `enviar_portafolio`
  traduce lo que haya dicho a una plaza. Reconoce las zonas de la tabla más varios
  alias ("cabos", "tj", "nayarit", "valle de guadalupe").
- **Si no reconoce la ciudad, o si apunta a dos plazas, no manda nada** y le dice
  al agente que pregunte. Mandar el link equivocado le enseña al cliente precios
  que no son los suyos.

El link nunca lo escribe el modelo: sale de `PORTFOLIOS` en `src/config.ts`, que es
donde se actualiza cuando cambie el portafolio del mes.

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
