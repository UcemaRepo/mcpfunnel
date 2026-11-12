# LeadFunnel: cruce de admitidos con formularios

Va encima del patch de ferias (atribución). Si ese ya está subido, este se aplica directo.

## Qué arregla
De los 324 admitidos 2027S1, 85 no se unían con ningún formulario. En la revisión aparecieron tres causas:

1. **Formulario sin DNI.** El asesor lo carga al inscribir, segundos antes de la Application. Ahora se recupera por nombre.
2. **Formulario de otra cohorte o sin semestre.** El cruce filtraba por cohorte *antes* de buscar el DNI. Ahora busca en todos los formularios y prefiere el del término compatible.
3. **Sin formulario.** Solicitud directa: no tiene arreglo, pero la nueva herramienta lo informa.

## Archivos
- `src/match.js` (nuevo): infiere el DNI por nombre y marca los formularios de inscripción.
- `src/sin-match.js` (nuevo): ruta `GET /admitidos/sin-match`, que busca en vivo en Salesforce a los admitidos que siguen sin formulario.
- `src/salesforce.js`:
  - Al cargar: infiere el DNI de los formularios sin DNI, marca `formularioInscripcion` y, si el formulario no tiene semestre y la persona está admitida, le asigna la cohorte de su admisión (`cohorteInferida`).
  - En `resumirAdmitidosCapitas`: ya no filtra los formularios por cohorte antes del cruce. Nuevo `metodoMatch: "nombre"` y campo `motivoSinMatch`.
  - El diagnóstico de `/estado` suma `dnisInferidos`.
- `src/atribucion.js`: los formularios de inscripción no cuentan como primer contacto si la persona tiene otros. Nuevo campo `soloInscripcion`.
- `src/agregados.js`: dimensiones nuevas `formularioInscripcion`, `soloInscripcion` y `dniOrigen`.
- `src/persona.js`: `enDataset` ahora dice si el formulario está de verdad en la sesión, en lugar de una estimación.
- `src/programas.js`: el catálogo suma LIEM, ACTU, CCP, LIAN, BA y "LIE 25".
- `src/server.js` y `src/mcp.js`: montan la ruta nueva y la herramienta `admitidos_sin_match`.

## Reglas de la inferencia por nombre
- Solo contra **admitidos** (no contra todos los leads).
- Todas las palabras del nombre del formulario (al menos 2, de 2+ letras) tienen que estar en el nombre de la Application. "Sofía Romero" encuentra "Sofía Belén Romero Romanelli"; "Tomás ." no encuentra nada.
- Tiene que coincidir con **una sola** persona; si hay dos posibles, no se infiere.
- El formulario tiene que ser anterior a la Application o, como máximo, 3 días posterior.

## Formulario de inscripción
Es el formulario creado dentro de las 24 h de la Application, antes o después. No dice cómo llegó la persona, así que para el recorrido (`tipoFormularios`, `primerOrigen`) se usa el formulario anterior. Si es el único que tiene, queda `soloInscripcion = si`.

## Cambia el conteo
- `admitidos` (con formulario) va a subir: suma los recuperados por nombre y los de otra cohorte.
- Los cruzados con un formulario de otra cohorte quedan con `matchTermino: "sin_match"` y `confianza: "baja"`, para separarlos si hace falta.

## Cómo subirlo
1. Reemplazá los archivos del zip (dos son nuevos) y hacé el commit. Con git: `git apply leadfunnel-match-admitidos.patch`.
2. Esperá el deploy de Render y cargá la sesión de nuevo (`/cargar`).
3. En Tech&Grow → MCP en vivo, tiene que aparecer `admitidos_sin_match`.
