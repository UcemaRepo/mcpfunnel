# Errores de entrega de mensajería (WhatsApp)

Sirve para ver qué mensajes de WhatsApp no llegaron sin abrir cada chat en la consola de Servicio.

## De dónde sale el dato (corregido)
Cuando un mensaje no se puede entregar, Salesforce agrega a la conversación una entrada de tipo **`MESSAGE_DELIVERY_FAILED`** con `errorCode`, `errorMessage` y el identificador del mensaje que falló. Es lo que la consola dibuja como cartel rojo dentro del chat. En la consola se ve traducido como "lo ha bloqueado", pero el texto real de Meta puede ser otro (por ejemplo, código 2002: *"this user's phone number is part of an experiment"*).

La primera versión de esta ruta usaba el objeto `MessagingDeliveryError`, y eso estaba mal: ese objeto solo registra fallos del sistema viejo de *triggered outbound*. Con mensajería mejorada queda vacío, así que devolvía 0 aunque hubiera fallos. Verificado con la conversación de Lara Bianchini (MS-00018896 y MS-00168850).

Ese dato no se puede consultar por SOQL, así que la ruta ahora:
1. busca las sesiones de mensajería activas ese día, con el identificador de su conversación;
2. pide las entradas de cada conversación a la API Connect (`/connect/conversation/{id}/entries`), filtradas por el día;
3. se queda con las `MESSAGE_DELIVERY_FAILED`.

Hace una llamada a la API por conversación, de a 5 en paralelo. Un día con cientos de envíos tarda más que antes.

## Qué cambia
- `src/errores-mensajeria.js`: reescrito con la lógica de arriba. La respuesta mantiene la misma forma, así que la extensión de Chrome sigue funcionando sin cambios.
- Nueva ruta `GET /mensajeria/diagnostico?sesion=MS-00168850`: muestra, sin datos personales, si la API Connect responde y qué entradas trae una sesión conocida. Sirve para verificar después del deploy.
- `src/persona.js`: `clienteSoql({ conInstancia: true })` devuelve también `getJson`, un GET autenticado a cualquier ruta de la API.
- `src/mcp.js`: se actualizan la descripción y los parámetros de `errores_mensajeria`.

## Parámetros de /mensajeria/errores
| Parámetro | Qué hace |
|---|---|
| `fecha` | Un día completo `AAAA-MM-DD` en hora de Buenos Aires (tiene prioridad) |
| `dias` | Últimos N días (default 1, máximo 31) |
| `desde` / `hasta` | Rango `AAAA-MM-DD` (máximo 31 días) |
| `motivo` | Texto o código del fallo, por ejemplo `experiment` o `2002`. El motivo viene en inglés, como lo manda Meta |
| `asesor` | Nombre (o parte) de quien envió el mensaje o del propietario del usuario de mensajería |
| `detalle=true` | Una fila por fallo: fecha, código, motivo, mensaje que falló, quién lo envió, asesor asignado, sesión y link a la sesión |
| `nombres=true` | Agrega nombre y apellido del contacto. Solo funciona con `ERRORES_CON_NOMBRE=true` en Render |
| `limite` | Máximo de filas de detalle (default 200, tope 2000) |

La respuesta también trae `sesionesRevisadas`, `conversacionesRevisadas`, `conversacionesConError` y `ejemploError`, para saber si alguna conversación no se pudo leer.

## Verificar después del deploy
Abrí en el navegador (cambiando la URL y el token):
```
https://TU-APP.onrender.com/mensajeria/diagnostico?sesion=MS-00168850&k=TU_MCP_TOKEN
```
Tiene que decir `"apiConnect": "ok"` y listar 2 fallos con código 2002.

Si dice algo como `403 FUNCTIONALITY_NOT_ENABLED` o `INSUFFICIENT_ACCESS`, el código está bien y falta un permiso en Salesforce (lo hace el administrador de la org):
- **Configuración → Conversation Service APIs**: activarlo, si existe en la org.
- El usuario de la Connected App necesita acceso a las sesiones y conversaciones de mensajería (permiso de lectura sobre `MessagingSession` y `Conversation`, y los permisos de mensajería de Digital Engagement).

## Nombre y apellido
Hay dos formas de habilitarlos:
- `ERRORES_CON_NOMBRE=true` (recomendada): habilita nombres solo en esta ruta, y solo cuando el pedido trae `nombres=true`.
- `ENMASCARAR_PII=false`: desenmascara todo el servidor.

## Si falta algún permiso de campos
La consulta de sesiones prueba tres niveles y la respuesta dice cuál usó en `nivelRelacion`:
- `0`: con contacto (nombre y apellido), asesor asignado, teléfono y canal.
- `1`: sin contacto ni propietario del usuario de mensajería.
- `2`: solo campos base.
