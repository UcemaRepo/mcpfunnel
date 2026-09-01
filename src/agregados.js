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
  gestionado: (l) => l.gestionado || "sin_dato",

  // Multivaluado: un lead con "INIA, LIEM" cuenta en ambos.
  // Por eso la suma de programas puede superar el total.
  programa: (l) =>
    String(l.programa || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
};

export const DIMENSIONES_VALIDAS = Object.keys(DIMENSIONES);

function valoresDe(lead, dim) {
  const v = DIMENSIONES[dim](lead);
  return Array.isArray(v) ? (v.length ? v : ["sin_programa"]) : [v];
}

// ------------------------------------------------------------
// Agregacion
// ------------------------------------------------------------
//
// Soporta una o dos dimensiones. Con dos devuelve una matriz
// anidada, que es justo lo que come un grafico de barras
// apiladas o de lineas multiples (ej. mes x canal).
// ------------------------------------------------------------

export function agregar(leads, dim1, dim2 = null, opciones = {}) {
  const { topN = 0 } = opciones;

  const conteo = new Map();
  let total = 0;

  for (const l of leads) {
    for (const v1 of valoresDe(l, dim1)) {
      if (!conteo.has(v1)) {
        conteo.set(v1, { total: 0, sub: dim2 ? new Map() : null });
      }

      const entrada = conteo.get(v1);
      entrada.total++;
      total++;

      if (dim2) {
        for (const v2 of valoresDe(l, dim2)) {
          entrada.sub.set(v2, (entrada.sub.get(v2) || 0) + 1);
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
    ...(dim2 && {
      desglose: Object.fromEntries(
        [...e.sub.entries()].sort((a, b) => b[1] - a[1])
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
    };
  }

  return {
    dimension: dim1,
    subdimension: dim2 || undefined,
    totalLeads: total,
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
