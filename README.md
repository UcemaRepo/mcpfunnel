# LeadFunnel MCP — Render

Servidor MCP con la sesión en **RAM del proceso**. Sin base, sin disco, sin cache.

```
POST /cargar   →  Salesforce → depura → scorea → RAM
POST /mcp      →  Claude consulta (lee de RAM)
POST /purgar   →  RAM = null
GET  /health   →  ¿está vivo? ¿hay sesión?
```

Cuando Render apaga el servicio por inactividad, el proceso muere y los datos
se van con él. Esa es la garantía de efimeridad — no depende de un TTL.

---

## Deploy

1. Subí este repo a GitHub (privado).
2. Render → **New → Web Service** → conectá el repo.
3. Configuración:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/health`

### Variables de entorno

| Variable | Valor |
|---|---|
| `SF_DOMAIN` | `ucema2.my.salesforce.com` |
| `SF_CLIENT_ID` | consumer key de la Connected App |
| `SF_CLIENT_SECRET` | consumer secret |
| `MCP_TOKEN` | `openssl rand -hex 32` |
| `ENMASCARAR_PII` | `true` (poné `false` solo si necesitás el dato completo) |

---

## Prueba

```bash
# Salud
curl https://TU-APP.onrender.com/health

# Cargar (tarda: hace todo el pull de Salesforce)
curl -X POST https://TU-APP.onrender.com/cargar \
  -H "Authorization: Bearer $MCP_TOKEN"

# Handshake MCP
curl -X POST "https://TU-APP.onrender.com/mcp?k=$MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Purgar
curl -X POST https://TU-APP.onrender.com/purgar \
  -H "Authorization: Bearer $MCP_TOKEN"
```

El header `Accept` con `text/event-stream` es **obligatorio** en Streamable HTTP.
Sin él, el SDK rechaza el request.

Inspector oficial antes de conectar a Claude:
```bash
npx @modelcontextprotocol/inspector
```

---

## Conectar a Claude

`claude.ai → Customize → Connectors → + → Add custom connector`

URL: `https://TU-APP.onrender.com/mcp?k=TU_TOKEN`

---

## Flujo de trabajo diario

1. `POST /cargar` cuando arrancás
2. Consultás desde Claude todo lo que quieras
3. Si te fuiste un rato largo, Render apagó el servicio: volvé a `/cargar`

---

## Limitaciones conocidas

**Cold start.** En el free tier, tras ~15 min sin tráfico Render apaga el
servicio. La siguiente request lo despierta (~50 s) **y la sesión se perdió**.
Si molesta: plan pago, o un cron que le pegue a `/health` cada 10 min (aunque
eso mantiene los datos vivos en RAM indefinidamente, que es justo lo que no
querías).

**Token en la URL.** La UI de conectores de Claude no permite headers
arbitrarios. El token en query param es más débil que un header: queda en la
config del conector y potencialmente en logs. El paso siguiente es OAuth 2.0
real, que con el SDK es factible pero es otro proyecto.

**RAM.** 12k leads ≈ 25 MB en objetos JS. El free tier de Render da 512 MB.
Holgado, pero si el dataset creciera mucho habría que paginar.

---

## Qué se guarda

| Campo | Se guarda |
|---|---|
| Nombre y apellido | sí |
| `sfId` | sí (para saltar al registro) |
| DNI | **nunca** |
| Teléfono | enmascarado (`***4821`) |
| Email | enmascarado (`ni***@gmail.com`) |
| Motivación | solo el largo, no el texto |

Con `ENMASCARAR_PII=false` se guardan teléfono y mail completos. Es una decisión
de riesgo consciente: con esa variable en `false`, los datos de contacto de
candidatos reales entran al contexto del modelo en cada consulta.
