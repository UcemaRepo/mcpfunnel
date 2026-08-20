// ============================================================
// scoring.js — depuración, validación y calificación
// ============================================================
// El score mide COMPLETITUD y VALIDEZ DE FORMATO, nunca contenido.
// Un lead con 100 tiene la ficha bien cargada; no significa que
// sea un lead prometedor.
// ============================================================

// ── Pesos del score (suman 100) ─────────────────────────────
// beca, motivación y origen quedaron FUERA: los completaba <6%
// de los leads, así que no discriminaban y bajaban el techo real
// del score a 85. Se siguen midiendo, pero aparte.
export const PESOS = {
  telefono: 25,
  email:    25,
  programa: 20,
  semestre: 15,
  colegio:  15,
};

export const OPCIONALES = ["motivacion", "beca", "origen"];

// ── Teléfono argentino ──────────────────────────────────────
// Normaliza antes de validar. Acepta: +54 9 11 5566-7788,
// 011 15 5566-7788, 1155667788, 3543 15 445566, +5493543445566
export function normalizarTelAR(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("54")) d = d.slice(2);   // país
  if (d.startsWith("9"))  d = d.slice(1);   // móvil
  if (d.startsWith("0"))  d = d.slice(1);   // trunk nacional
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");  // 15 intermedio
  return d;
}

export function validarTelAR(raw) {
  const d = normalizarTelAR(raw);
  if (!d) return false;
  if (d.length !== 10) return false;
  if (/^(\d)\1{9}$/.test(d)) return false;   // 1111111111, 0000000000
  return true;
}

// ── Email ───────────────────────────────────────────────────
// Soporta dominios multinivel: .edu.ar, .com.ar, .org.uk
export const RX_MAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-zA-Z]{2,}$/;

// ── Programas ───────────────────────────────────────────────
// Los nombres de campaña traen eventos y estados que no son
// carreras. Se filtran para no ensuciar el campo `programa`.
const RUIDO_CAMPANA = new RegExp(
  [
    "feria", "open", "evento", "jornada", "charla", "expo",
    "visita\\s+de\\s+colegio", "visita", "workshop", "webinar",
    "taller", "interior", "d[ií]a\\s+de", "entrevista",
    "sin\\s+inter[eé]s", "consulta[s]?\\s+", "puertas\\s+abiertas",
    "clase\\s+abierta", "info\\s*day",
  ].join("|"),
  "i"
);

export function esProgramaValido(p) {
  if (!p) return false;
  const t = p.trim();
  if (t.length < 3) return false;
  if (RUIDO_CAMPANA.test(t)) return false;
  return true;
}

// ── Normalización de texto ──────────────────────────────────
const quitarTildes = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export const normalizar = (t) =>
  quitarTildes((t || "").toLowerCase().trim()).replace(/\s+/g, " ");

// ── Enmascarado de PII ──────────────────────────────────────
// Activable por env var. Ver README para la decisión de riesgo.
export function maskMail(m, activo = true) {
  if (!m || !m.includes("@")) return "";
  if (!activo) return m;
  const [u, d] = m.split("@");
  return `${u.slice(0, 2)}***@${d}`;
}

export function maskTel(raw, activo = true) {
  const d = normalizarTelAR(raw);
  if (!d) return "";
  return activo ? `***${d.slice(-4)}` : d;
}

// ── Prioridad de estados ────────────────────────────────────
export function estadoPri(s) {
  if (!s) return 0;
  const t = s.toLowerCase();
  if (t === "qualified") return 7;
  if (t === "negociando") return 6;
  if (t.includes("sin respuesta")) return 5;
  if (t === "contactado" || t === "contacted") return 4;
  if (t === "desiste") return 3;
  if (t === "unqualified") return 2;
  if (t === "nuevo" || t === "new") return 1;
  return 0;
}

export const normalizeStatus = (s) =>
  !s ? "" :
  /^New$/i.test(s) ? "Nuevo" :
  /^Contacted$/i.test(s) ? "Contactado" : s;

export const extractProg = (c) =>
  !c ? "" : c.replace(/^I\s*-\s*/i, "").replace(/\s*\d{4}\s*SEM\s*\d.*$/i, "").trim();

export const extractNota = (txt) => {
  if (!txt) return null;
  const m = txt.match(/nota final ponderada:\s*([\d.,]+)\s*\/\s*10/i);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
};

// ── Depuración + scoring de un registro ─────────────────────
export function depurar(r, extras, opts = {}) {
  const enmascarar = opts.enmascarar !== false;

  const telRaw = r.Telefono__c || "";
  const mail   = (r.Correo_electronico__c || "").trim();
  const motivacion = (r.Comentario__c || r.Por_qu_quer_s_estudiar_en_la_UCEMA__c || "").trim();

  // Campos que puntúan
  const validez = {
    telefono: validarTelAR(telRaw),
    email:    RX_MAIL.test(mail),
    programa: !!extras.programa,
    semestre: !!r.Cuando_Ingresarias__c,
    colegio:  !!r.Colegio_Universidad__c,
  };

  let score = 0;
  const faltantes = [];
  for (const [campo, ok] of Object.entries(validez)) {
    if (ok) score += PESOS[campo];
    else faltantes.push(campo);
  }

  // Campos que se miden pero NO puntúan
  const opcionalesFaltantes = [];
  if (motivacion.length <= 10)       opcionalesFaltantes.push("motivacion");
  if (!r.Beca_de_inter_s__c)         opcionalesFaltantes.push("beca");
  if (!r.Origen_del_candidato__c)    opcionalesFaltantes.push("origen");

  // Cargado pero inválido → se corrige, no se pide de nuevo
  const malFormateados = [];
  if (telRaw.replace(/\D/g, "") && !validez.telefono) malFormateados.push("telefono");
  if (mail && !validez.email) malFormateados.push("email");

  return {
    sfId:       r.Id,
    nombre:     (r.Nombres__c || "").trim(),
    apellido:   (r.Apellidos__c || "").trim(),
    nombreNorm: normalizar(`${r.Nombres__c || ""} ${r.Apellidos__c || ""}`),

    telefono: maskTel(telRaw, enmascarar),
    email:    maskMail(mail, enmascarar),
    // DNI: nunca se expone

    programa:   extras.programa,
    semestre:   r.Cuando_Ingresarias__c || "",
    colegio:    r.Colegio_Universidad__c || "",
    origen:     r.Origen_del_candidato__c || "",
    canal:      r.C_mo_llegaste_a_nuestra_propuesta_educa__c || "",
    area:       r.Area__c || "",
    beca:       (r.Beca_de_inter_s__c || "").toLowerCase().includes("beca") ? "si" : "no",
    motivacionLargo: motivacion.length,
    gestionado: r.Gestionado__c === true ? "si" : r.Gestionado__c === false ? "no" : "desconocido",
    estado:     extras.estado,
    asesor:     (r.Owner && r.Owner.Name) || r.Propietario_del_Candidato__c || "",
    campanas:   extras.campanas,
    notaFinalPonderada: extras.nota,
    createdDate: r.CreatedDate || "",

    score,
    faltantes,
    opcionalesFaltantes,
    malFormateados,
  };
}

// ── Agregados precalculados ─────────────────────────────────
export function agregar(leads) {
  const agg = {
    total: leads.length,
    scorePromedio: +(leads.reduce((a, l) => a + l.score, 0) / (leads.length || 1)).toFixed(1),
    distribucionScore: { "0-25": 0, "26-50": 0, "51-75": 0, "76-100": 0 },
    faltantesPorCampo: {},
    opcionalesFaltantesPorCampo: {},
    malFormateadosPorCampo: {},
    porAsesor: {},
    porPrograma: {},
    porEstado: {},
  };

  const bump = (obj, key, l) => {
    if (!key) return;
    if (!obj[key]) obj[key] = { n: 0, _suma: 0, incompletos: 0 };
    obj[key].n++;
    obj[key]._suma += l.score;
    if (l.score < 75) obj[key].incompletos++;
  };

  for (const l of leads) {
    const b = l.score <= 25 ? "0-25" : l.score <= 50 ? "26-50" : l.score <= 75 ? "51-75" : "76-100";
    agg.distribucionScore[b]++;

    l.faltantes.forEach(f => { agg.faltantesPorCampo[f] = (agg.faltantesPorCampo[f] || 0) + 1; });
    l.opcionalesFaltantes.forEach(f => { agg.opcionalesFaltantesPorCampo[f] = (agg.opcionalesFaltantesPorCampo[f] || 0) + 1; });
    l.malFormateados.forEach(f => { agg.malFormateadosPorCampo[f] = (agg.malFormateadosPorCampo[f] || 0) + 1; });

    bump(agg.porAsesor, l.asesor, l);
    bump(agg.porEstado, l.estado, l);
    l.programa.split(",").map(p => p.trim()).filter(Boolean)
      .forEach(p => bump(agg.porPrograma, p, l));
  }

  for (const grupo of [agg.porAsesor, agg.porPrograma, agg.porEstado]) {
    for (const k of Object.keys(grupo)) {
      grupo[k].scoreProm = +(grupo[k]._suma / grupo[k].n).toFixed(1);
      delete grupo[k]._suma;
    }
  }

  return agg;
}
