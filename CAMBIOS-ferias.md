# LeadFunnel: atribución de ferias y eventos

## Para qué
Medir ferias y eventos por persona: si la persona entró solo por feria, si la feria fue comprada, si fue admitida en el término y con cuánta beca. Todo sale de `agregados`, sin traer leads uno por uno.

## Archivos
- `src/atribucion.js` (nuevo): detecta ferias compradas, arma el recorrido de cada persona y define la admisión en el término.
- `src/salesforce.js`: cada lead guarda `becaAplicada`, `feriaComprada` y `comentarioFeria`. Al terminar la carga agrupa por persona (DNI, o Candidato si no hay DNI).
- `src/agregados.js`: dimensiones y métricas nuevas, detalladas abajo.
- `src/server.js`: `/agregados` y `/leads` aceptan los filtros nuevos; `/leads` además filtra por `origen`.
- `src/mcp.js`: `agregados` y `buscar_leads` exponen los parámetros nuevos.

## Campos nuevos por lead
| Campo | Valores |
|---|---|
| `tipoFormularios` | `solo_evento`, `primero_evento`, `evento_posterior`, `sin_evento` (mira TODOS los formularios de la persona) |
| `feriaComprada` | `si`, `no`, `no_aplica` (este último si el formulario no es de feria/evento) |
| `soloFeriaComprada` | `si` si todos sus formularios son de ferias compradas |
| `primerOrigen` | origen de su primer formulario |
| `personaKey`, `formulariosPersona`, `ordenFormulario` | agrupación por persona |
| `becaAplicada` | beca de la Application compatible |

## `agregados`
- Dimensiones nuevas: `admitido`, `feriaComprada`, `tipoFormularios`, `soloFeriaComprada`, `primerOrigen`, `colegioNorm`, `campana`, `comentarioFeria`.
- Filtros nuevos (también en `buscar_leads`): `colegio`, `admitido` (`si` = en el término, `cualquiera`, `no`), `feriaComprada`, `tipoFormularios`, `soloFeriaComprada`, `primerOrigen`, `porPersona`.
- `metricas=true`: cada fila trae `personas`, `admitidos`, `tasaAdmision`, `capitas`, `admitidosConBeca`, `becaPromedioPct` y `capitasBecadas`. Cuenta personas, no formularios.

## Ojo: "admitido" ahora tiene dos lecturas
El `admitido` viejo del lead es true si la persona tiene una Application admitida de **cualquier** término. Por eso el embudo de 2027S1 marcaba 397 y Salesforce dice 324. La dimensión y el filtro nuevos separan `admitido_termino` de `admitido_otro_termino`. El embudo no se tocó.

## Calibrar la detección de feria comprada
El patrón por defecto busca frases como "no fuimos", "no asistimos", "no estuvo", "comprada" o "sin presencia" en el comentario, en "cómo llegaste", en "por qué querés estudiar" y en los nombres de campaña. **Hay que confirmarlo con los textos reales:**
1. Después de desplegar y cargar, pedí `agregados` con `por='comentarioFeria'`, `origen='Ferias'` y `topN=50`.
2. Si el texto es otro, cargá en Render la variable `FERIA_COMPRADA_REGEX`, por ejemplo `no fuimos|feria comprada|sin stand`, y volvé a cargar la sesión.

Si el dato está en otro campo del `Formulario_web__c`, sumalo al SELECT de `salesforce.js` (junto a `Comentario__c`) y a la lista `textos` de `datosFeria` en `atribucion.js`.

## Qué cuenta como feria o evento
Por defecto, los orígenes que contienen "feria" o "evento": Ferias, Feria y Evento. Para sumar Actividades de Vinculación cargá `ORIGENES_EVENTO=feria|evento|vinculacion`.

## Cómo subirlo
1. Reemplazá los 5 archivos (`atribucion.js` es nuevo) y hacé el commit. Con git: `git apply leadfunnel-atribucion-ferias.patch`.
2. Render vuelve a desplegar solo.
3. Cargá de nuevo la sesión (`/cargar`).
4. En Tech&Grow → MCP en vivo → "Probar y ver herramientas", `agregados` tiene que mostrar `tipoFormularios` y `metricas`.
