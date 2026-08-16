# Agente de WhatsApp

Bot de WhatsApp construido sobre la **API oficial de Meta (WhatsApp Cloud API)** y
**Claude**. Responde preguntas en lenguaje natural, consulta el catálogo con
precios y existencias reales, y levanta pedidos.

- **Node.js 20+ y TypeScript**
- **Meta Cloud API** — el canal oficial, sin riesgo de baneo del número
- **Claude (Opus 5)** con herramientas: el modelo no inventa precios ni stock,
  los consulta
- **SQLite** para historial de conversación y pedidos

---

## Cómo funciona

```
WhatsApp → webhook (Meta) → POST /webhook
                                 │  valida la firma HMAC
                                 │  responde 200 de inmediato
                                 ▼
                          bucle del agente (Claude)
                                 │
                    ┌────────────┼────────────┐
             buscar_productos  crear_pedido  consultar_pedidos
                    │            │            │
                catalog.json   SQLite      SQLite
                                 │
                                 ▼
                     respuesta → Graph API → WhatsApp
```

El agente tiene cinco herramientas:

| Herramienta | Qué hace |
|---|---|
| `buscar_productos` | Busca por nombre, productor, origen, categoría o precio máximo |
| `listar_categorias` | Lista las categorías del catálogo |
| `consultar_producto` | Ficha completa y existencias por SKU |
| `crear_pedido` | Registra un pedido validando SKUs y stock |
| `consultar_pedidos` | Pedidos recientes de ese cliente |

El número de teléfono **no** es un parámetro de las herramientas: lo inyecta el
servidor. El agente no puede leer ni crear pedidos de otro cliente aunque el
usuario se lo pida.

---

## Puesta en marcha

### 1. Instalar

```bash
npm install
cp .env.example .env
```

### 2. Configurar Meta

En [developers.facebook.com](https://developers.facebook.com):

1. Crea una app de tipo **Business** y añádele el producto **WhatsApp**.
2. En **WhatsApp → API Setup** copia el **Phone number ID** →
   `WHATSAPP_PHONE_NUMBER_ID`.
3. En **App Settings → Basic** copia el **App Secret** → `WHATSAPP_APP_SECRET`.
4. Crea un **System User** en Meta Business Suite con el permiso
   `whatsapp_business_messaging` y genera un token permanente →
   `WHATSAPP_TOKEN`. (El token de prueba de la consola caduca en 24 h; sirve
   para probar, no para producción.)
5. Inventa cualquier cadena para `WHATSAPP_VERIFY_TOKEN`; la vas a capturar en
   el paso 4 de abajo.

### 3. Poner tu `ANTHROPIC_API_KEY`

Desde [console.anthropic.com](https://console.anthropic.com).

### 4. Exponer el webhook y registrarlo

El webhook necesita una URL pública con HTTPS. En desarrollo:

```bash
npm run dev          # arranca en el puerto 3000
npx ngrok http 3000  # en otra terminal
```

En **WhatsApp → Configuration → Webhook** captura:

- **Callback URL**: `https://tu-dominio/webhook`
- **Verify token**: el mismo valor de `WHATSAPP_VERIFY_TOKEN`

Da clic en **Verify and save** y suscríbete al campo **`messages`**. Sin esa
suscripción Meta no te manda nada.

### 5. Probar

Manda un mensaje al número de prueba desde tu WhatsApp. En la consola de Meta
tienes que agregar tu número como destinatario de prueba antes de que la
plataforma esté aprobada.

---

## Probar sin WhatsApp

Para iterar en el prompt o en las herramientas sin pasar por Meta:

```bash
npm run chat -- 5216241234567
```

Abre una conversación en la terminal usando el mismo bucle y la misma base de
datos que el webhook, así que los pedidos que levantes ahí quedan registrados
de verdad.

---

## El catálogo

Vive en `data/catalog.json` y se relee cada 60 segundos, así que puedes
editarlo sin reiniciar el servidor. Cada producto:

```json
{
  "sku": "TV-BLA-001",
  "nombre": "Bruma Ocho Blanco",
  "categoria": "Vino blanco",
  "productor": "Bruma Vinícola",
  "origen": "Valle de Guadalupe, Baja California",
  "anada": "2023",
  "presentacion": "750 ml",
  "precio": 645,
  "stock": 48,
  "notas": "Chardonnay y Sauvignon Blanc. Cítrico, fresco, final salino."
}
```

`precio` es unitario por botella, en MXN y **sin IVA** — el prompt le indica al
agente que lo aclare cada vez que menciona un precio.

Cuando quieras conectarlo a tu sistema real (CONTPAQ, un ERP, una hoja de
Google), sustituye el cuerpo de `src/data/catalog.ts` por las llamadas
correspondientes; las herramientas del agente no cambian.

---

## Ajustar el comportamiento

| Qué | Dónde |
|---|---|
| Tono, reglas de venta, límites | `src/agent/prompt.ts` |
| Herramientas disponibles | `src/agent/tools.ts` |
| Origen del catálogo | `src/data/catalog.ts` |
| Validación de pedidos | `src/data/orders.ts` |
| Latencia vs. criterio | `ANTHROPIC_EFFORT` (`low` por defecto) |
| Memoria de la conversación | `HISTORY_TURNS` (20 turnos) |

---

## Notas de operación

- **Firma del webhook**: cada POST se valida con HMAC-SHA256 contra el App
  Secret sobre el cuerpo crudo. Los que no cuadran se rechazan con 401.
- **Reintentos**: Meta reenvía el webhook si tardas en contestar. El servidor
  responde 200 antes de procesar y deduplica por `message_id`, así que un
  reintento no genera una respuesta doble ni un pedido doble.
- **Ventana de 24 horas**: fuera de las 24 h desde el último mensaje del
  cliente, Meta sólo permite enviar plantillas aprobadas, no texto libre. Este
  agente responde a mensajes entrantes, así que siempre está dentro de la
  ventana; si más adelante quieres mandar notificaciones salientes, hay que dar
  de alta plantillas.
- **Tipos de mensaje**: se atienden texto y respuestas de botón/lista. Audio,
  imagen y documento se ignoran por ahora.
- **Base de datos**: SQLite en `data/agent.db`. Para desplegar necesitas disco
  persistente (Railway, Fly.io, un VPS). En plataformas serverless de sistema de
  archivos efímero hay que cambiar a Postgres.

## Despliegue

```bash
npm run build
npm start
```

Necesita un proceso persistente y disco. Railway o Fly.io funcionan sin ajustes;
recuerda cambiar la Callback URL en Meta a la del dominio de producción.
