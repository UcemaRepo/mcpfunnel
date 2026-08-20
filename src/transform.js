// ============================================================
// transform.js — normalización y estructura de cohortes
// ============================================================
// Reemplaza al viejo scoring.js. Ya no hay score de completitud:
// el foco pasó a ser el embudo (leads → contactados → qualified
// → admitidos) y la comparación entre cohortes.
// ============================================================

// ── Normalización de texto ──────────────────────────────────
const quitarTildes = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export const normalizar = (t) =>
  quitarTildes((t || "").toLowerCase().trim()).replace(/\s+/g, " ");

// ── Teléfono argentino ──────────────────────────────────────
// Se conserva solo para enmascarar de forma consistente.
export function normalizarTelAR(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("54")) d = d.slice(2);
  if (d.startsWith("9"))  d = d.slice(1);
  if (d.startsWith("0"))  d = d.slice(1);
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, "$1$2");
  return d;
}

// ── Enmascarado de PII ──────────────────────────────────────
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

// ============================================================
// COHORTES — canonicalización del semestre
// ============================================================
// En Salesforce el campo viene escrito de muchas formas:
// "2026SEM 1", "2026SEM1", "2026 SEM 1". Todas se colapsan
// a una forma única: "2026S1".
export function canonSemestre(raw) {
  if (!raw) return "sin_semestre";
  const s = String(raw).trim();
  // Ya canónico: "2026S1"
  const ya = s.match(/^(\d{4})\s*S\s*(\d)$/i);
  if (ya) return `${ya[1]}S${ya[2]}`;
  // Forma de Salesforce: "2026SEM 1", "2026SEM1", "2026 SEM 1"
  const m = s.match(/(\d{4})\s*SEM\s*(\d)/i);
  if (!m) return "otro:" + s;
  return `${m[1]}S${m[2]}`;
}

// Mes de creación como "2026-08", para agrupar la curva
export const mesDe = (iso) => (iso || "").slice(0, 7);

// ============================================================
// ESTADOS
// ============================================================
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

// Comparación de estado SIN el bug de substring.
// "unqualified".includes("qualified") daba true y mezclaba
// dos estados opuestos. Ahora se compara por igualdad o por
// prefijo de palabra completa.
export function coincideEstado(estadoLead, buscado) {
  const a = normalizar(estadoLead);
  const b = normalizar(buscado);
  if (!b) return true;
  if (a === b) return true;
  return a.startsWith(b + " ");   // "Contactado Sin respuesta" ~ "Contactado"
}

// ── Programas ───────────────────────────────────────────────
const RUIDO_CAMPANA = new RegExp(
  [
    "feria", "open", "evento", "jornada", "charla", "expo",
    "visita\\s+de\\s+colegio", "visita", "workshop", "webinar",
    "taller", "interior", "d[ií]a\\s+de", "entrevista",
    "sin\\s+inter[eé]s", "consulta[s]?\\s+", "puertas\\s+abiertas",
    "clase\\s+abierta", "info\\s*day", "carga\\s+masiva",
    "finalizada",
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

export const extractProg = (c) =>
  !c ? "" : c.replace(/^I\s*-\s*/i, "").replace(/\s*\d{4}\s*SEM\s*\d.*$/i, "").trim();

export const extractNota = (txt) => {
  if (!txt) return null;
  const m = txt.match(/nota final ponderada:\s*([\d.,]+)\s*\/\s*10/i);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
};

// ============================================================
// TRANSFORMACIÓN DE UN REGISTRO
// ============================================================
export function transformar(r, extras, opts = {}) {
  const enmascarar = opts.enmascarar !== false;
  const semestreRaw = r.Cuando_Ingresarias__c || "";

  return {
    sfId:       r.Id,
    nombre:     (r.Nombres__c || "").trim(),
    apellido:   (r.Apellidos__c || "").trim(),
    nombreNorm: normalizar(`${r.Nombres__c || ""} ${r.Apellidos__c || ""}`),

    telefono: maskTel(r.Telefono__c, enmascarar),
    email:    maskMail((r.Correo_electronico__c || "").trim(), enmascarar),
    // DNI: nunca se expone

    programa:   extras.programa,
    semestre:   semestreRaw,
    cohorte:    canonSemestre(semestreRaw),
    colegio:    r.Colegio_Universidad__c || "",
    origen:     r.Origen_del_candidato__c || "",
    canal:      r.C_mo_llegaste_a_nuestra_propuesta_educa__c || "",
    area:       r.Area__c || "",
    beca:       (r.Beca_de_inter_s__c || "").toLowerCase().includes("beca") ? "si" : "no",
    gestionado: r.Gestionado__c === true ? "si" : r.Gestionado__c === false ? "no" : "desconocido",

    estado:    extras.estado,
    estadoPri: estadoPri(extras.estado),

    // ── EL DATO QUE ANTES SE PERDÍA ──
    // Admitido__c se consultaba en Contact pero se descartaba:
    // solo servía para decidir a quién pedirle el Feedback.
    admitido:  extras.admitido === true,

    asesor:    (r.Owner && r.Owner.Name) || r.Propietario_del_Candidato__c || "",
    campanas:  extras.campanas,
    notaFinalPonderada: extras.nota,

    createdDate: r.CreatedDate || "",
    mes:         mesDe(r.CreatedDate),
  };
}

// ============================================================
// EMBUDO
// ============================================================
// Etapas acumulativas del proceso de admisión.
export function contarEmbudo(leads) {
  return {
    leads:       leads.length,
    contactados: leads.filter(l => l.estadoPri >= 4).length,
    negociando:  leads.filter(l => l.estadoPri >= 6).length,
    qualified:   leads.filter(l => normalizar(l.estado) === "qualified").length,
    admitidos:   leads.filter(l => l.admitido).length,
    desiste:     leads.filter(l => normalizar(l.estado) === "desiste").length,
  };
}

// Tasas de conversión entre etapas
export function tasas(e) {
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;
  return {
    contactoSobreLeads:   pct(e.contactados, e.leads),
    qualifiedSobreLeads:  pct(e.qualified, e.leads),
    admitidosSobreLeads:  pct(e.admitidos, e.leads),
    admitidosSobreQualified: pct(e.admitidos, e.qualified),
  };
}

// ============================================================
// AGREGADOS POR COHORTE
// ============================================================
export function agregarPorCohorte(leads) {
  const porCohorte = {};

  for (const l of leads) {
    const c = l.cohorte;
    if (!porCohorte[c]) porCohorte[c] = [];
    porCohorte[c].push(l);
  }

  const out = {};
  for (const [cohorte, ls] of Object.entries(porCohorte)) {
    const embudo = contarEmbudo(ls);

    // Curva mensual: altas nuevas y acumulado
    const porMes = {};
    for (const l of ls) {
      if (!l.mes) continue;
      if (!porMes[l.mes]) porMes[l.mes] = { nuevos: 0, admitidos: 0 };
      porMes[l.mes].nuevos++;
      if (l.admitido) porMes[l.mes].admitidos++;
    }

    const meses = Object.keys(porMes).sort();
    let acum = 0, acumAdm = 0;
    const curva = meses.map(m => {
      acum += porMes[m].nuevos;
      acumAdm += porMes[m].admitidos;
      return {
        mes: m,
        nuevos: porMes[m].nuevos,
        acumulado: acum,
        admitidos: porMes[m].admitidos,
        admitidosAcum: acumAdm,
      };
    });

    out[cohorte] = {
      embudo,
      tasas: tasas(embudo),
      primerLead: ls.reduce((a, l) => !a || l.createdDate < a ? l.createdDate : a, null),
      ultimoLead: ls.reduce((a, l) => !a || l.createdDate > a ? l.createdDate : a, null),
      curva,
    };
  }

  return out;
}

// ── Agregados por dimensión, dentro de un subconjunto ───────
export function agregarPor(leads, campo) {
  const grupos = {};
  for (const l of leads) {
    const claves = campo === "programa"
      ? (l.programa || "").split(",").map(p => p.trim()).filter(Boolean)
      : [l[campo]].filter(Boolean);

    for (const k of claves) {
      if (!grupos[k]) grupos[k] = [];
      grupos[k].push(l);
    }
  }

  const out = {};
  for (const [k, ls] of Object.entries(grupos)) {
    const e = contarEmbudo(ls);
    out[k] = { ...e, tasas: tasas(e) };
  }
  return out;
}
