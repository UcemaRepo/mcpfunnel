// ============================================================
// sin-match.js — por que un admitido no tiene formulario
// ============================================================
//
// GET /admitidos/sin-match?termino=2027S1[&detalle=true]
//
// Toma los admitidos que el cruce de la sesion no pudo unir con
// ningun formulario y los busca EN VIVO en Salesforce, primero
// por DNI y despues por nombre. Cada uno queda con un motivo:
//
//   formulario_fuera_de_la_carga  hay formulario con su DNI,
//                                 pero /cargar no lo trajo
//                                 (propietario fuera de los
//                                 asesores o anterior a la fecha
//                                 de carga)
//   formulario_sin_dni            hay formulario con su nombre,
//                                 cargado sin DNI, y no se pudo
//                                 recuperar (nombre ambiguo o
//                                 formulario fuera de la carga)
//   sin_formulario                no hay ningun formulario: hizo
//                                 la solicitud directa
//
// Devuelve conteos y, con detalle=true, una fila por admitido
// SIN nombre ni DNI: numero de solicitud, motivo y datos del
// formulario encontrado.
// ============================================================

import { clienteSoql, soqlSeguro } from "./persona.js";
import { tokensNombre } from "./match.js";

const DIA = 24 * 60 * 60 * 1000;
const lotes = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n)
  );

const CAMPOS = `Id, N_mero_de_documento__c, Nombres__c, Apellidos__c,
  Origen_del_candidato__c, Cuando_Ingresarias__c, Owner.Name,
  CreatedDate`;

const limpiarDni = (d) => String(d ?? "").replace(/\D/g, "");

function contar(lista, clave) {
  const m = {};
  for (const x of lista) {
    const k = clave(x) ?? "sin_dato";
    m[k] = (m[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

export async function diagnosticarSinMatch(sinLead, idsEnSesion) {
  const q = await clienteSoql();

  // ── 1. Por DNI ─────────────────────────────────────────────
  const dnis = [...new Set(sinLead.map((a) => a.dni).filter(Boolean))];
  const porDni = new Map();

  for (const lote of lotes(dnis, 100)) {
    const recs = await q(
      `SELECT ${CAMPOS} FROM Formulario_web__c
       WHERE N_mero_de_documento__c IN (${lote.join(",")})`
    );
    for (const r of recs) {
      const d = limpiarDni(r.N_mero_de_documento__c);
      if (!porDni.has(d)) porDni.set(d, []);
      porDni.get(d).push(r);
    }
  }

  // ── 2. Por nombre, para los que no aparecen por DNI ────────
  const sinDni = sinLead.filter((a) => !porDni.has(a.dni));
  const porApp = new Map();

  const condiciones = sinDni
    .map((a) => {
      const t = tokensNombre(a.nombreAlumno);
      if (t.length < 2) return null;
      return {
        app: a,
        tokens: new Set(t),
        cond: `(Nombres__c LIKE '%${soqlSeguro(t[0])}%' AND Apellidos__c LIKE '%${soqlSeguro(t[t.length - 1])}%')`,
      };
    })
    .filter(Boolean);

  for (const lote of lotes(condiciones, 20)) {
    const recs = await q(
      `SELECT ${CAMPOS} FROM Formulario_web__c
       WHERE ${lote.map((c) => c.cond).join(" OR ")}`
    );
    for (const c of lote) {
      const propios = recs.filter((r) => {
        const toks = tokensNombre(`${r.Nombres__c || ""} ${r.Apellidos__c || ""}`);
        return toks.length >= 2 && toks.every((t) => c.tokens.has(t));
      });
      if (propios.length) porApp.set(c.app.idApplication, propios);
    }
  }

  // ── 3. Clasificacion ───────────────────────────────────────
  const filas = sinLead.map((a) => {
    const formsDni = porDni.get(a.dni) || [];
    const formsNombre = porApp.get(a.idApplication) || [];
    const forms = formsDni.length ? formsDni : formsNombre;

    const motivo = formsDni.length
      ? "formulario_fuera_de_la_carga"
      : formsNombre.length
        ? "formulario_sin_dni"
        : "sin_formulario";

    const ordenados = [...forms].sort((x, y) =>
      String(x.CreatedDate).localeCompare(String(y.CreatedDate))
    );
    const primero = ordenados[0] || null;
    const fApp = Date.parse(a.fechaCreacion || a.fechaSolicitud || "");
    const esInscripcion = (r) =>
      !isNaN(fApp) && Math.abs(Date.parse(r.CreatedDate) - fApp) <= DIA;

    return {
      numeroSolicitud: a.numeroSolicitud,
      idApplication: a.idApplication,
      capita: a.capita,
      motivo,
      formularios: forms.length,
      formulariosEnSesion: idsEnSesion
        ? forms.filter((r) => idsEnSesion.has(r.Id)).length
        : null,
      soloFormularioDeInscripcion: forms.length > 0 && forms.every(esInscripcion),
      origenPrimerFormulario: primero?.Origen_del_candidato__c || null,
      semestrePrimerFormulario: primero?.Cuando_Ingresarias__c || null,
      propietarioPrimerFormulario: primero?.Owner?.Name || null,
      fechaPrimerFormulario: primero?.CreatedDate || null,
    };
  });

  const resumenPorMotivo = {};
  for (const f of filas) {
    const r = (resumenPorMotivo[f.motivo] ||= { admitidos: 0, capitas: 0 });
    r.admitidos++;
    r.capitas = +(r.capitas + (Number(f.capita) || 0)).toFixed(2);
  }

  const conForm = filas.filter((f) => f.formularios > 0);

  return {
    total: filas.length,
    porMotivo: resumenPorMotivo,
    soloFormularioDeInscripcion: conForm.filter((f) => f.soloFormularioDeInscripcion).length,
    porOrigenDelPrimerFormulario: contar(conForm, (f) => f.origenPrimerFormulario),
    porPropietarioDelFormulario: contar(conForm, (f) => f.propietarioPrimerFormulario),
    filas,
  };
}

export function montarSinMatch(app, auth, getSesion, resumirAdmitidosCapitas) {
  app.get("/admitidos/sin-match", auth, async (req, res) => {
    try {
      const data = getSesion();
      const { termino, term, ano, year, detalle } = req.query;

      const r = resumirAdmitidosCapitas(
        { termino: termino || term, ano: ano || year },
        data
      );
      const sinLead = (r.admitidos || []).filter((a) => !a.tieneLead);
      const ids = new Set((data.leads || []).map((l) => l.sfId));

      const d = await diagnosticarSinMatch(sinLead, ids);
      const conDetalle = detalle === "true" || detalle === "si";

      res.json({
        ok: true,
        filtroAplicado: r.filtroAplicado,
        totalAdmitidos: r.totalAdmitidos,
        conFormulario: r.totalAdmitidos - sinLead.length,
        matching: r.matching,
        sinFormulario: {
          total: d.total,
          porMotivo: d.porMotivo,
          soloFormularioDeInscripcion: d.soloFormularioDeInscripcion,
          porOrigenDelPrimerFormulario: d.porOrigenDelPrimerFormulario,
          porPropietarioDelFormulario: d.porPropietarioDelFormulario,
        },
        ...(conDetalle && { detalle: d.filas }),
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
}
