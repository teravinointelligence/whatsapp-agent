# Agente de WhatsApp

Bot de WhatsApp construido sobre la **API oficial de Meta (WhatsApp Cloud API)** y
**Claude**, conectado al CRM de Teravino en Supabase. Responde preguntas, cotiza
con precios y existencias reales, y levanta pedidos que aparecen en el CRM que el
equipo ya usa.

- **Node.js 20+ y TypeScript**
- **Meta Cloud API** — el canal oficial, sin riesgo de baneo del número
- **Claude (Opus 5)** con herramientas: no inventa precios ni existencias
- **Supabase `teravino-crm`** como única fuente de verdad del negocio

---

## Cómo funciona

```
WhatsApp → webhook (Meta) → POST /webhook
                                 │  valida la firma HMAC
                                 │  responde 200 de inmediato
                                 ▼
                       resuelve la cuenta por el número
                       (contacts.whatsapp → accounts)
                                 ▼
                          bucle del agente (Claude)
                                 │
                  ┌──────────────┼──────────────┐
           buscar_productos  crear_pedido  consultar_pedidos
                  │              │              │
                  ▼              ▼              ▼
              Supabase teravino-crm (products, orders, accounts)
                                 │
                                 ▼
                     respuesta → Graph API → WhatsApp
```

### Herramientas del agente

| Herramienta | Qué hace |
|---|---|
| `buscar_productos` | Busca en los 978 productos activos por nombre, bodega, varietal, región o SKU |
| `listar_categorias` | Categorías del catálogo |
| `consultar_producto` | Ficha y existencias por SKU |
| `crear_pedido` | Crea el pedido en `orders`/`order_items` como borrador |
| `consultar_pedidos` | Pedidos recientes de las cuentas de ese número |

**El número de teléfono no es un parámetro de ninguna herramienta.** El servidor
resuelve la cuenta antes de invocar al agente, así que no puede leer ni escribir
sobre otro cliente aunque el usuario se lo pida.

---

## Cómo se conecta al CRM

### Identificación del cliente

El número entrante se compara contra `contacts.whatsapp` y `contacts.phone` por
sus **últimos 10 dígitos**. El CRM tiene esos campos capturados en cuatro
formatos distintos (`+52 612 200 9974`, `526871590866`, `+52 1 222 904 0365`,
`6122125216`) y Meta manda un quinto (`5216122009974`); los últimos 10 dígitos
son el denominador común.

**Hoy 128 de 585 contactos tienen WhatsApp capturado.** El resto de los clientes
entra como no identificado: el agente cotiza a precio de lista pero no puede
levantarles pedidos. Cada número que capturen en el CRM amplía la cobertura sin
tocar código.

### Compradores con varias cuentas

Hay 13 números vinculados a más de una cuenta —compradores que atienden varios
negocios del mismo grupo (`LA JUSTINA` / `LA JUSTINA VALLE` / `OJA`, `EMMA` /
`TOWER BAR`)—. En todos los casos actuales comparten nivel de precio y almacén,
así que **cotizar siempre es seguro**; lo ambiguo es a quién se factura.

Cuando eso pasa, el agente ve la lista de cuentas y **tiene que preguntar a cuál
va el pedido**. Sólo puede elegir entre las cuentas de ese número: un id ajeno se
rechaza en el servidor.

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

### Pedidos

Entran a `orders` con `status = 'borrador'`, `order_type = 'whatsapp'` y el
`sales_rep_id` de la cuenta, con folio en el formato que ya usa el CRM
(`COT-2026-0085`). El vendedor los revisa en TERAVINO Flow antes de aceptarlos.

Si fallan las partidas, el encabezado se borra: no quedan pedidos vacíos que
alguien tenga que limpiar a mano.

---

## Puesta en marcha

```bash
npm install
cp .env.example .env
```

Luego completa el `.env`:

| Variable | De dónde sale |
|---|---|
| `WHATSAPP_TOKEN` | System User de Meta con `whatsapp_business_messaging` |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp → API Setup (no es el número) |
| `WHATSAPP_VERIFY_TOKEN` | Lo inventas tú |
| `WHATSAPP_APP_SECRET` | App Settings → Basic |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `SUPABASE_URL` | Ya viene puesto en `.env.example` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API |

> La `service_role key` se salta RLS. Nunca la expongas al cliente ni la subas al
> repositorio: sólo vive en el servidor.

Después registra el webhook en Meta (`https://tu-dominio/webhook`, el mismo
`WHATSAPP_VERIFY_TOKEN`) y suscríbete al campo **`messages`**. Sin esa
suscripción Meta no manda nada.

### Probar sin WhatsApp

```bash
npm run chat -- 5216241234567
```

Abre una conversación en la terminal usando el mismo bucle, el mismo CRM y la
misma resolución de cuenta. Usa el número real de un contacto del CRM para
probar el camino de cliente identificado.

**Los pedidos que levantes aquí se crean de verdad en el CRM.** Bórralos después
o usa un número que no esté vinculado a ninguna cuenta.

---

## Ajustar el comportamiento

| Qué | Dónde |
|---|---|
| Tono, reglas de venta, límites | `src/agent/prompt.ts` |
| Herramientas disponibles | `src/agent/tools.ts` |
| Regla de precios y mapeo de almacenes | `src/config.ts` |
| Consultas al CRM | `src/crm/` |
| Estatus del pedido | `ORDER_STATUS` (`borrador` por defecto) |
| Latencia vs. criterio | `ANTHROPIC_EFFORT` (`low` por defecto) |
| Memoria de la conversación | `HISTORY_TURNS` (20 turnos) |

---

## Notas de operación

- **Firma del webhook**: cada POST se valida con HMAC-SHA256 contra el App
  Secret sobre el cuerpo crudo. Los que no cuadran se rechazan con 401.
- **Reintentos**: Meta reenvía el webhook si tardas en contestar. El servidor
  responde 200 antes de procesar y deduplica por `message_id`, así que un
  reintento no genera respuesta doble ni pedido doble.
- **Ventana de 24 horas**: fuera de las 24 h desde el último mensaje del
  cliente, Meta sólo permite plantillas aprobadas. Este agente sólo responde a
  mensajes entrantes, así que siempre está dentro de la ventana.
- **SQLite** (`data/agent.db`) guarda únicamente la transcripción del chat y la
  deduplicación de webhooks. Todo lo del negocio vive en el CRM. Necesita disco
  persistente; en serverless efímero habría que moverlo también a Postgres.
- **Folio**: se calcula leyendo el último `COT-<año>-NNNN`. Con dos pedidos
  simultáneos hay una carrera teórica; al volumen actual no compensa un contador
  transaccional, pero si crece conviene una secuencia en Postgres.

## Despliegue

```bash
npm run build
npm start
```

Railway o Fly.io funcionan sin ajustes. Recuerda actualizar la Callback URL en
Meta al dominio de producción.
