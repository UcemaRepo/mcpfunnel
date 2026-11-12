// ============================================================
// agregados.js — conteos calculados del lado del servidor
// ============================================================
//
// Por que existe:
//
// Para armar un panel casi nunca hacen falta los leads
// individuales, hacen falta los conteos. Traerse 25.000 leads
// con 30 campos cada uno para despues contarlos son decenas de
// MB que agotan la memoria del free tier de Render. Los mismos
// numeros, agregados aca, son unos pocos KB.
//
// La regla: agregar donde estan los datos, no donde se
// consumen.
// ============================================================

import { estadoAdmision, becaPct } from "./atribucion.js";
import { normalizar } from "./transform.js";

// Dimensiones por las que se puede agrupar.
// El valor es una funcion, no un nombre de campo, porque
// algunas necesitan derivarse (el mes sale de la fecha).
const DIMENSIONES = {
  mes: (l) => l.mes || (l.createdDate || "").slice(0, 7) || "sin_fecha",
  cohorte: (l) => l.cohorte || "sin_cohorte",
  estado: (l) => l.estado || "sin_estado",
  canal: (l) => l.canal || "sin_canal",
  origen: (l) => l.origen || "sin_origen",
  asesor: (l) => l.asesor || "sin_asesor",
  colegio: (l) => l.colegio || "sin_colegio",
  semestre: (l) => l.semestre || "sin_semestre",
  beca: (l) => l.beca || "sin_dato",

  // Solo tiene sentido sobre leads que desistieron. En el resto
  // devuelve "sin_motivo", que en un agregado sin filtrar es la
  // categoria dominante y no dice nada: conviene combinarlo con
  // estado='Desiste'.
  motivoDesiste: (l) => l.motivoDesiste || "sin_motivo",

  // Agrupa los motivos en dos familias. "Sin respuesta", "No
  // quiso informacion" y "Datos incorrectos" no explican por que
  // alguien no eligio UCEMA: explican que la conversacion nunca
  // paso. Mezclarlos con Precio o Modalidad distorsiona
  // cualquier lectura.
  tipoDesiste: (l) => {
    if (!l.motivoDesiste) return "sin_motivo";

    const m = String(l.motivoDesiste).toLowerCase();

    return /sin respuesta|no quiso|datos incorrectos|no hubo respuesta/.test(m)
      ? "no_contactabilidad"
      : "motivo_real";
  },
  gestionado: (l) => l.gestionado || "sin_dato",

  // Multivaluado: un lead con "INIA, LIEM" cuenta en ambos.
  // Por eso la suma de programas puede superar el total.
  programa: (l) =>
    String(l.programa || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),


  // ── Atribucion (ver atribucion.js) ──
  // admitido_termino / admitido_otro_termino / no_admitido.
  // Solo 'admitido_termino' es comparable con los admitidos
  // directos de Salesforce de ese termino.
  admitido: (l) => estadoAdmision(l),

  // si / no / no_aplica (no es formulario de feria o evento)
  feriaComprada: (l) => l.feriaComprada || "no_aplica",

  // solo_evento / primero_evento / evento_posterior / sin_evento
  tipoFormularios: (l) => l.tipoFormularios || "sin_dato",

  soloFeriaComprada: (l) => l.soloFeriaComprada || "no",

  primerOrigen: (l) => l.primerOrigen || "sin_origen",

  // Colegio sin tildes ni mayusculas: junta "Santa Maria" y
  // "Santa María". No une variantes como "ORT" y "ORT Belgrano".
  colegioNorm: (l) => normalizar(l.colegio) || "sin_colegio",

  // Multivaluado, como programa: un lead en dos campanas cuenta
  // en ambas.
  campana: (l) => (Array.isArray(l.campanas) ? l.campanas : []),

  // Para calibrar FERIA_COMPRADA_REGEX. Usar con origen=Ferias.
  comentarioFeria: (l) => l.comentarioFeria || "no_aplica",

  // si = cargado en las 24 h de la Application (no es el primer
  // contacto). soloInscripcion = la persona no tiene otro.
  formularioInscripcion: (l) => (l.formularioInscripcion ? "si" : "no"),
  soloInscripcion: (l) => l.soloInscripcion || "no",

  // Como se encontro la persona del formulario.
  dniOrigen: (l) =>
    l.dniInferido ? "inferido_por_nombre" : /^\d{6,9}$/.test(String(l.dni || "")) ? "formulario" : "sin_dni",

};

export const DIMENSIONES_VALIDAS = Object.keys(DIMENSIONES);

function valoresDe(lead, dim) {
  const v = DIMENSIONES[dim](lead);
  return Array.isArray(v) ? (v.length ? v : [`sin_${dim}`]) : [v];
}

// ------------------------------------------------------------
// Agregacion
// ------------------------------------------------------------
//
// Soporta una o dos dimensiones. Con dos devuelve una matriz
// anidada, que es justo lo que come un grafico de barras
// apiladas o de lineas multiples (ej. mes x canal).
// ------------------------------------------------------------

// Metricas opcionales por fila (metricas=true).
// Cuentan PERSONAS, no formularios: si alguien tiene dos
// formularios en la misma fila, suma una sola vez.
function nuevaMetrica() {
  return { personas: new Set(), adm: new Map() };
}

function sumarMetrica(m, l) {
  const k = l.personaKey || l.sfId;
  m.personas.add(k);
  if (estadoAdmision(l) === "admitido_termino") {
    const prev = m.adm.get(k);
    const capita = Number(l.capita) || 0;
    if (!prev || capita > prev.capita) {
      m.adm.set(k, { capita, beca: becaPct(l) });
    }
  }
}

function cerrarMetrica(m) {
  const adm = [...m.adm.values()];
  const capitas = adm.reduce((a, x) => a + x.capita, 0);
  const conBeca = adm.filter((x) => x.beca > 0);
  return {
    personas: m.personas.size,
    admitidos: adm.length,
    tasaAdmision: m.personas.size
      ? +((100 * adm.length) / m.personas.size).toFixed(2)
      : 0,
    capitas: +capitas.toFixed(2),
    admitidosConBeca: conBeca.length,
    becaPromedioPct: adm.length
      ? +(adm.reduce((a, x) => a + x.beca, 0) / adm.length).toFixed(1)
      : 0,
    // Arancel que se deja de cobrar, en capitas.
    capitasBecadas: +(adm.length - capitas).toFixed(2),
  };
}

export function agregar(leads, dim1, dim2 = null, opciones = {}) {
  const { topN = 0, metricas = false } = opciones;

  const conteo = new Map();
  let total = 0;
  const global = metricas ? nuevaMetrica() : null;

  for (const l of leads) {
    if (global) sumarMetrica(global, l);

    for (const v1 of valoresDe(l, dim1)) {
      if (!conteo.has(v1)) {
        conteo.set(v1, {
          total: 0,
          sub: dim2 ? new Map() : null,
          m: metricas ? nuevaMetrica() : null,
          subM: dim2 && metricas ? new Map() : null,
        });
      }

      const entrada = conteo.get(v1);
      entrada.total++;
      total++;
      if (entrada.m) sumarMetrica(entrada.m, l);

      if (dim2) {
        for (const v2 of valoresDe(l, dim2)) {
          entrada.sub.set(v2, (entrada.sub.get(v2) || 0) + 1);
          if (entrada.subM) {
            if (!entrada.subM.has(v2)) entrada.subM.set(v2, nuevaMetrica());
            sumarMetrica(entrada.subM.get(v2), l);
          }
        }
      }
    }
  }

  // Las dimensiones temporales se ordenan cronologicamente;
  // el resto, por volumen.
  const esTemporal = dim1 === "mes";

  let filas = [...conteo.entries()].map(([valor, e]) => ({
    valor,
    total: e.total,
    ...(e.m && { metricas: cerrarMetrica(e.m) }),
    ...(dim2 && {
      desglose: Object.fromEntries(
        [...e.sub.entries()].sort((a, b) => b[1] - a[1])
      ),
    }),
    ...(e.subM && {
      desgloseMetricas: Object.fromEntries(
        [...e.subM.entries()].map(([k, m]) => [k, cerrarMetrica(m)])
      ),
    }),
  }));

  filas.sort((a, b) =>
    esTemporal
      ? a.valor.localeCompare(b.valor)
      : b.total - a.total || a.valor.localeCompare(b.valor)
  );

  // topN agrupa la cola en "otros" en vez de truncarla, para
  // que los porcentajes sigan sumando 100.
  let otros = null;

  if (topN > 0 && filas.length > topN) {
    const cola = filas.slice(topN);
    filas = filas.slice(0, topN);

    otros = {
      valor: "otros",
      total: cola.reduce((a, f) => a + f.total, 0),
      categorias: cola.length,
      ...(metricas && {
        admitidos: cola.reduce((a, f) => a + f.metricas.admitidos, 0),
      }),
    };
  }

  return {
    dimension: dim1,
    subdimension: dim2 || undefined,
    totalLeads: total,
    ...(global && { metricasTotales: cerrarMetrica(global) }),
    categorias: filas.length + (otros ? 1 : 0),
    filas,
    ...(otros && { otros }),
  };
}

// ------------------------------------------------------------
// Ruta
// ------------------------------------------------------------

export function montarAgregados(app, auth, getSesion, filtrarLeads) {
  app.get("/agregados", auth, (req, res) => {
    try {
      const data = getSesion();

      const {
        por,
        sub,
        topN,
        metricas,
        ...filtros
      } = req.query;

      if (!por || !DIMENSIONES[por]) {
        return res.status(400).json({
          ok: false,
          error: `Falta 'por' o no es valida. Opciones: ${DIMENSIONES_VALIDAS.join(", ")}`,
        });
      }

      if (sub && !DIMENSIONES[sub]) {
        return res.status(400).json({
          ok: false,
          error: `'sub' no es valida. Opciones: ${DIMENSIONES_VALIDAS.join(", ")}`,
        });
      }

      const leads = filtrarLeads(
        Array.isArray(data.leads) ? data.leads : [],
        filtros
      );

      res.json({
        ok: true,
        filtros,
        ...agregar(leads, por, sub || null, {
          topN: parseInt(topN, 10) || 0,
          metricas: metricas === "true" || metricas === "si",
        }),
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  });
}
