# LeadFunnel: admitidos por mes

## Qué cambia
- `src/admitidos-por-mes.js`: reescrito en formato ES Modules. El proyecto usa `"type": "module"`; la versión anterior usaba `module.exports` y, si se importaba, hacía caer el servidor al arrancar. Agrupa los admitidos de la sesión por mes y devuelve sólo conteos.
- `src/server.js`: nueva ruta `GET /admitidos/por-mes?termino=2027S1` (pide token, igual que las demás).
- `src/mcp.js`: nueva herramienta MCP `admitidos_por_mes`. Tech&Grow la detecta sola.
- `src/salesforce.js`: cada admitido guarda también `fechaCreacion` (el `CreatedDate`, que ya se consultaba) y `fechaDecision` (vacío hasta hacer el paso opcional de abajo).
- `package.json`: `cors` pasa a ser una dependencia explícita. Ya se importaba, y funcionaba porque lo trae el SDK de MCP.
- `render.yaml`: el health check apunta a `/`, que existe. `/health` no existe y devuelve una página HTML 404.
- Borrar `src/null`: es un archivo vacío que se subió por error.

## Cómo subirlo (desde la web de GitHub)
1. Reemplazá los 6 archivos por los de este zip, respetando las carpetas.
2. Borrá `src/null`.
3. Hacé el commit. Render vuelve a desplegar solo (tarda unos minutos).
4. Cuando termine, cargá de nuevo la sesión (`/cargar`): al reiniciarse, la memoria queda vacía.
5. En Tech&Grow → MCP en vivo → "Probar y ver herramientas", tiene que aparecer `admitidos_por_mes`.

Con git: `git apply leadfunnel-admitidos-por-mes.patch` y después `git rm src/null`.

## Qué fecha usa
Usa la primera, en este orden, que esté cargada en al menos el 80% de los admitidos:
1. `fechaDecision`: la fecha de la decisión de admisión. Es la ideal, pero requiere el paso opcional.
2. `fechaSolicitud` (`hed__Application_Date__c`): cuándo aplicó la persona.
3. `fechaCreacion` (`CreatedDate` de la Application).

La respuesta dice cuál usó (`campoFecha`) y cuántos quedaron sin fecha (`sinFecha`).

## Paso opcional: fecha de decisión de admisión
Si en tu org existe y se completa el campo **Application Decision Date** (`hed__Application_Decision_Date__c`) en `hed__Application__c` (Configuración → Gestor de objetos → Application → Campos):
- en `src/salesforce.js`, función `cargarApplicationsAdmitidas`, agregá `hed__Application_Decision_Date__c,` al `SELECT` (por ejemplo, debajo de `hed__Application_Date__c,`).

**Verificalo antes:** si el campo no existe o la integración no tiene permiso para leerlo, la consulta falla y no se carga ningún admitido.
