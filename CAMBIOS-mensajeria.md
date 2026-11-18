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
| `fecha` | Un día completo `AAAA-MM-DD` en hora de Buenos Aires (tiene prioridad sobre los demás) |
| `dias` | Últimos N días (default 7, máximo 90) |
| `desde` / `hasta` | Rango `AAAA-MM-DD`, con `hasta` incluido (máximo 90 días) |
| `tipo` | Valor exacto del campo `Type` |
| `motivo` | Texto dentro del motivo del fallo; `bloqueado` también encuentra "bloqueó" |
| `asesor` | Nombre (o parte) del asesor: quien envió el mensaje o el propietario del usuario de mensajería |
| `detalle=true` | Una fila por error, con link a la ficha del usuario de mensajería |
| `nombres=true` | Agrega nombre y apellido del contacto al detalle. Solo funciona si en Render está `ERRORES_CON_NOMBRE=true` |
| `limite` | Máximo de filas de detalle (default 200, tope 2000) |

## Qué devuelve
`total`, `personasAfectadas`, conteos `porMotivo`, `porTipo`, `porCanal`, `porEnviadoPor`, `porAsesorAsignado`, `porPlantilla` y `porDia`, y `reincidentes` (personas con más de un error). En el detalle, el teléfono va enmascarado (`***0283`).

## Nombre y apellido
Por defecto no salen. Hay dos formas de habilitarlos:
- `ENMASCARAR_PII=false`: desenmascara TODO el servidor (leads incluidos).
- `ERRORES_CON_NOMBRE=true` (recomendada): habilita nombres solo en esta ruta, y solo cuando el pedido trae `nombres=true`. Es la que usa el complemento de Sheets.

Con nombres habilitados, el detalle trae `nombre` y `apellido` (del Contact vinculado al usuario de mensajería), `nombreWhatsapp` (el nombre del usuario de mensajería, a veces el perfil de WhatsApp) y el teléfono completo.

## Si falta algún permiso
La consulta prueba tres niveles y la respuesta dice cuál usó en `nivelRelacion`:
- `0`: con contacto (nombre y apellido) y asesor asignado (propietario del usuario de mensajería).
- `1`: sin contacto ni asesor asignado, con canal y quién envió.
- `2`: solo campos base. Si no puede leer el objeto, responde 403 con un mensaje claro.

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
