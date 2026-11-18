# Errores de entrega de mensajería (WhatsApp)

Sirve para ver qué mensajes no llegaron sin abrir cada chat en la consola de Servicio.

## Por qué
El cartel rojo dentro del chat ("No se pueden enviar mensajes a este destinatario porque lo ha bloqueado", plantilla rechazada, número inválido) solo se ve con la conversación abierta. Lo arma el componente `scrt-message-error-info` con los mensajes de la conversación, que se cargan al abrirla.

El registro `MessagingSession` no lo refleja: en una sesión con el mensaje rebotado, `ErrorReason` estaba vacío y `AgentMessageCount` en 0. Lo que sí queda guardado es un registro del objeto estándar **`MessagingDeliveryError`** por cada envío fallido. Esta función consulta ese objeto.

## Qué cambia
- `src/errores-mensajeria.js` (nuevo): ruta `GET /mensajeria/errores`. Consulta Salesforce en vivo, así que no hace falta `/cargar` antes.
- `src/server.js`: monta la ruta (2 líneas). Pide token, igual que las demás.
- `src/mcp.js`: nueva herramienta MCP `errores_mensajeria`. Tech&Grow la detecta sola.
- `src/persona.js`: `clienteSoql({ conInstancia: true })` devuelve también la URL de la instancia, para armar los links. Si se llama sin argumentos funciona igual que antes, así que `sin-match.js` no cambia.

## Parámetros
| Parámetro | Qué hace |
|---|---|
| `dias` | Últimos N días (default 7, máximo 90) |
| `desde` / `hasta` | Rango `AAAA-MM-DD`, con `hasta` incluido (máximo 90 días) |
| `tipo` | Valor exacto del campo `Type` |
| `motivo` | Texto dentro del motivo del fallo; `bloqueado` también encuentra "bloqueó" |
| `asesor` | Quién envió el mensaje (nombre o parte) |
| `detalle=true` | Una fila por error, con link a la ficha del usuario de mensajería |
| `limite` | Máximo de filas de detalle (default 200, tope 2000) |

## Qué devuelve
`total`, `personasAfectadas`, conteos `porMotivo`, `porTipo`, `porCanal`, `porEnviadoPor`, `porPlantilla` y `porDia`, y `reincidentes` (personas con más de un error). En el detalle, el teléfono va enmascarado (`***0283`) y el nombre solo aparece si `ENMASCARAR_PII=false`.

Si la integración no puede leer alguna relación (nombre del canal, del usuario o de quien envió), la consulta se repite solo con los campos base y la respuesta trae `camposDeRelacion: false`. Si no puede leer el objeto, responde 403 con un mensaje claro.

## Prueba
```bash
curl "https://TU-APP.onrender.com/mensajeria/errores?dias=7&detalle=true" \
  -H "Authorization: Bearer $MCP_TOKEN"
```

## Antes de usarlo, verificá
1. Que el usuario de la Connected App pueda leer `MessagingDeliveryError` (el permiso es de ese usuario, no del tuyo).
2. Qué textos trae `FailureReason` en tu org. Pueden venir en inglés: si `motivo=bloqueado` no encuentra nada, probá con `motivo=block`.
3. Que el caso conocido (MS-00018896, Lara Bianchini) aparezca en el resultado.

## Cómo subirlo
Con git: `git apply leadfunnel-errores-mensajeria.patch`. Desde la web de GitHub: subí los 4 archivos del zip respetando las carpetas. Render redespliega solo.
