# Mensajería (WhatsApp): conversaciones del día

## Qué cambia
- `src/errores-mensajeria.js`: nueva ruta **`GET /mensajeria/conversaciones?fecha=AAAA-MM-DD[&nombres=true]`**. Devuelve una fila por conversación de WhatsApp con actividad ese día (la sesión más reciente de cada una), con el link para abrirla en la consola, el asesor asignado (propietario del usuario de mensajería), si la persona respondió y, si está habilitado, nombre y apellido. La usa la extensión de Chrome «Errores de WhatsApp» versión 2.
- `GET /mensajeria/errores` ahora responde **501 con una explicación**, en lugar de devolver 0 errores.
- `src/mcp.js`: se quita la herramienta `errores_mensajeria`, porque contestaba "0 errores" y eso no era real.
- Se quita la ruta `/mensajeria/diagnostico`.

## Por qué los fallos no se calculan en el servidor
Cuando un mensaje no se entrega, Salesforce agrega a la conversación una entrada `MESSAGE_DELIVERY_FAILED`, que la consola muestra como cartel rojo. Ese dato no es accesible desde el servidor:
- `MessagingSession`: un envío fallido y uno entregado sin respuesta son idénticos (`Ended`, 0 segundos, 0 mensajes). Se verificó con 200 envíos automáticos del 18/11/2026.
- `MessagingDeliveryError`: solo registra fallos del sistema viejo de *triggered outbound*. Para estos queda vacío.
- API Connect (`/connect/conversation/{id}/entries`): devuelve los mensajes, pero no las entradas de fallo. Verificado con la conversación de Lara Bianchini: devuelve 2 entradas de 4.
- Conversation Data API (`api.salesforce.com/platform/engagement`): debería traer todos los tipos de entrada, pero necesita una External Client App con el permiso `sfap_api`, que tiene que crear un administrador de la org.

Por eso la detección la hace la extensión: abre cada conversación en la consola con la sesión del asesor y busca el cartel.

## Datos personales
El teléfono sale enmascarado. Nombre y apellido solo aparecen con `ERRORES_CON_NOMBRE=true` y el parámetro `nombres=true`, o con `ENMASCARAR_PII=false`, que desenmascara todo el servidor.

## Si falta algún permiso de campos
La consulta prueba tres niveles y la respuesta dice cuál usó en `nivelRelacion`:
- `0`: con contacto, asesor asignado, teléfono y canal.
- `1`: sin contacto ni propietario del usuario de mensajería. La extensión revisa entonces todas las conversaciones del día.
- `2`: solo campos base.
