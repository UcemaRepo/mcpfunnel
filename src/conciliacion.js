// ============================================================
// conciliacion.js — leads de Salesforce vs. leads en sesión
// ============================================================
//
// Compara los leads (Formulario_web__c) que hay AHORA en
// Salesforce contra los que están cargados en la sesión, y
// REGISTRA los que no aparecen.
//
//   falta_en_sesion  está en Salesforce y NO en la sesión
//   sobra_en_sesion  está en la sesión y ya NO en Salesforce
//
// Para cada faltante se indica el motivo:
//
//   creado_despues_de_la_carga     es nuevo: se creó cuando ya
//                                  había arrancado la carga
//   modificado_despues_de_la_carga existía, pero lo tocaron después
//                                  (probable cambio de asesor)
//   creado_antes_y_no_esta         existía, nadie lo tocó y no
//                                  entró: ESTO es lo anormal
//
// Los dos primeros son esperables (la sesión es una foto) y se
// resuelven con /cargar. Sólo el tercero indica un problema.
//
// El cruce es por ID (sfId = Formulario_web__c.Id), no por DNI.
//
// El registro vive dentro de la sesión: se borra con /reset y se
// reemplaza en cada /cargar. No toca disco ni base. Sólo guarda
// ID, nombre y fechas: nunca DNI, teléfono ni email.
// ============================================================

const MAX_MOSTRADOS = 500;

// Desde cuándo se compara por defecto: 01/01/2026, hora de Argentina.
// Se puede cambiar por llamada: /conciliacion?desde=2026-03-01
export const DESDE_POR_DEFECTO = "2026-01-01";

// "2026-01-01" -> "2026-01-01T00:00:00-03:00" (literal válido en SOQL).
//
// Sólo acepta AAAA-MM-DD y verifica que el día exista: el valor
// termina pegado dentro de una consulta SOQL, así que no se deja
// pasar texto libre.
export function fechaDesde(texto) {
  const m = String(texto).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const [, a, mes, d] = m.map(Number);
  const f = new Date(Date.UTC(a, mes - 1, d));
  const existe =
    f.getUTCFullYear() === a &&
    f.getUTCMonth() === mes - 1 &&
    f.getUTCDate() === d;

  return existe ? `${texto}T00:00:00-03:00` : null;
}

const nombreDe = (r) =>
  `${r.Nombres__c || ""} ${r.Apellidos__c || ""}`.trim() || null;

// Anota en el registro acumulado sin duplicar: si ya estaba,
// actualiza cuántas veces se vio.
function anotar(registro, entrada, ahora) {
  const previo = registro[entrada.idSalesforce];

  if (previo) {
    previo.ultimaVez = ahora;
    previo.veces += 1;
    previo.motivo = entrada.motivo;
    return;
  }

  registro[entrada.idSalesforce] = {
    ...entrada,
    primeraVez: ahora,
    ultimaVez: ahora,
    veces: 1,
  };
}

// ------------------------------------------------------------
// Comparación (función pura: no toca Salesforce ni la sesión)
// ------------------------------------------------------------

export function conciliarLeads({
  salesforce = [], // [{ Id, Nombres__c, Apellidos__c, CreatedDate }]
  leadsSesion = [], // sesion.leads (tienen sfId)
  cargadoEn = null, // sesion.cargadoEn (se fija al TERMINAR la carga)
  duracionMs = 0, // sesion.duracionMs
  alcance = {},
  registroPrevio = {},
}) {
  const ahora = new Date().toISOString();

  // cargadoEn es el momento en que TERMINÓ la carga. Los leads que
  // se crearon mientras corría (duracionMs) ya no entraron en la
  // consulta, así que el corte correcto es el INICIO de la carga.
  const tFin = cargadoEn ? Date.parse(cargadoEn) : NaN;
  const tInicio = Number.isFinite(tFin) ? tFin - (Number(duracionMs) || 0) : NaN;

  const idsSesion = new Set(leadsSesion.map((l) => l.sfId));
  const idsSalesforce = new Set(salesforce.map((r) => r.Id));

  const registro = { ...registroPrevio };
  const faltantes = [];
  const sobrantes = [];

  // Están en Salesforce y no en la sesión
  for (const r of salesforce) {
    if (idsSesion.has(r.Id)) continue;

    const creado = Date.parse(r.CreatedDate);
    const modificado = Date.parse(r.LastModifiedDate);

    let motivo = "creado_antes_y_no_esta";

    if (Number.isFinite(tInicio)) {
      if (Number.isFinite(creado) && creado > tInicio) {
        motivo = "creado_despues_de_la_carga";
      } else if (Number.isFinite(modificado) && modificado > tInicio) {
        motivo = "modificado_despues_de_la_carga";
      }
    }

    const entrada = {
      tipo: "falta_en_sesion",
      idSalesforce: r.Id,
      nombre: nombreDe(r),
      creadoEn: r.CreatedDate || null,
      modificadoEn: r.LastModifiedDate || null,
      motivo,
    };

    faltantes.push(entrada);
    anotar(registro, entrada, ahora);
  }

  // Están en la sesión y ya no en Salesforce (borrados, o
  // cambiaron de asesor / quedaron fuera del filtro)
  for (const l of leadsSesion) {
    if (idsSalesforce.has(l.sfId)) continue;

    const entrada = {
      tipo: "sobra_en_sesion",
      idSalesforce: l.sfId,
      nombre: `${l.nombre || ""} ${l.apellido || ""}`.trim() || null,
      creadoEn: l.createdDate || null,
      motivo: "ya_no_esta_en_salesforce",
    };

    sobrantes.push(entrada);
    anotar(registro, entrada, ahora);
  }

  const nuevos = faltantes.filter(
    (f) => f.motivo === "creado_despues_de_la_carga"
  ).length;
  const modificados = faltantes.filter(
    (f) => f.motivo === "modificado_despues_de_la_carga"
  ).length;
  const anomalias = faltantes.length - nuevos - modificados;

  const coinciden = salesforce.length - faltantes.length;

  // Un sobrante nunca es un error de carga: estuvo en Salesforce
  // cuando se cargó. Si ya no está, Salesforce cambió después.
  const estado =
    anomalias > 0
      ? "CON_DIFERENCIAS"
      : nuevos + modificados + sobrantes.length > 0
        ? "SESION_DESACTUALIZADA"
        : "SIN_DIFERENCIAS";

  const informe = {
    generadoEn: ahora,
    cargadoEn,
    alcance,

    totalSalesforce: salesforce.length,
    totalSesion: leadsSesion.length,
    coinciden,
    porcentajeCobertura: salesforce.length
      ? +((100 * coinciden) / salesforce.length).toFixed(2)
      : 100,

    faltantesEnSesion: faltantes.length,
    creadosDespuesDeLaCarga: nuevos,
    modificadosDespuesDeLaCarga: modificados,
    anomalias,
    sobrantesEnSesion: sobrantes.length,

    estado,
    registradosAcumulados: Object.keys(registro).length,

    faltantes,
    sobrantes,
  };

  return { informe, registro };
}

// ------------------------------------------------------------
// Ruta
// ------------------------------------------------------------
//
// GET /conciliacion
// GET /conciliacion?incluirDetalle=false
//
// Cada llamada consulta Salesforce (sólo IDs, nombre y fecha),
// compara contra la sesión y actualiza el registro.
//
// traerFormularios viene de salesforce.js.
// ------------------------------------------------------------

export function montarConciliacion(app, auth, getSesion, traerFormularios) {
  app.get("/conciliacion", auth, async (req, res) => {
    let data;

    try {
      data = getSesion();
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    // ---- Desde cuándo se compara -------------------------------
    const pedido = req.query.desde || DESDE_POR_DEFECTO;
    const desdePedido = fechaDesde(pedido);

    if (!desdePedido) {
      return res.status(400).json({
        ok: false,
        error: `'desde' no es valida: "${pedido}". Formato AAAA-MM-DD, por ejemplo 2026-01-01.`,
      });
    }

    // La sesión sólo tiene leads desde su propia fecha de carga. Si
    // se pidiera comparar desde antes, los leads anteriores figurarían
    // como faltantes sin serlo. Por eso nunca se compara antes de eso.
    const tPedido = Date.parse(desdePedido);
    const tSesion = Date.parse(data.desde);
    const ajustado = Number.isFinite(tSesion) && tSesion > tPedido;
    const desdeEfectivo = ajustado ? data.desde : desdePedido;
    const tEfectivo = ajustado ? tSesion : tPedido;

    try {
      const salesforce = await traerFormularios({
        desde: desdeEfectivo,
        todosLosAsesores: data.todosLosAsesores,
      });

      // Mismo recorte del lado de la sesión: si no, los leads de
      // antes de la fecha figurarían como "sobrantes".
      const todos = Array.isArray(data.leads) ? data.leads : [];
      const leadsSesion = todos.filter((l) => {
        const t = Date.parse(l.createdDate);
        return !Number.isFinite(t) || t >= tEfectivo;
      });

      const { informe, registro } = conciliarLeads({
        salesforce,
        leadsSesion,
        cargadoEn: data.cargadoEn,
        duracionMs: data.duracionMs,
        alcance: {
          desde: desdeEfectivo,
          desdePedido,
          desdeAjustadoALaSesion: ajustado,
          todosLosAsesores: !!data.todosLosAsesores,
          leadsEnSesionTotal: todos.length,
          leadsEnSesionFueraDeRango: todos.length - leadsSesion.length,
        },
        registroPrevio: data.registroConciliacion || {},
      });

      // Se guarda dentro de la sesión: /reset lo borra.
      data.conciliacion = informe;
      data.registroConciliacion = registro;

      const { faltantes, sobrantes, ...resumen } = informe;
      const conDetalle =
        String(req.query.incluirDetalle ?? "true").toLowerCase() !== "false";

      return res.json({
        ok: true,
        ...resumen,
        ...(conDetalle && {
          faltantes: faltantes.slice(0, MAX_MOSTRADOS),
          sobrantes: sobrantes.slice(0, MAX_MOSTRADOS),
          hayMasFaltantes: faltantes.length > MAX_MOSTRADOS,
          hayMasSobrantes: sobrantes.length > MAX_MOSTRADOS,
        }),
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });
}
