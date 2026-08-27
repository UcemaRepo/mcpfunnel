// ============================================================
// salesforce.js — extracción y merge desde Salesforce
// ============================================================

import {
  transformar, agregarPorCohorte, estadoPri, normalizeStatus,
  extractProg, extractNota, esProgramaValido, contarEmbudo, tasas,
} from "./transform.js";

const API = "v59.0";

const ASESOR_IDS = [
  "005VJ000002riJVYAY",
  "005VJ0000031rVBYAY",
  "005VJ000003eZbdYAE",
  "005VJ000000tba1YAA",
  "005VJ0000027bmTYAQ",
  "005VJ000000taFmYAI",
];

const SEMESTRES = [
  "2026SEM 1", "2026SEM1", "2026 SEM 1",
  "2026SEM 2", "2026SEM2", "2026 SEM 2",
  "2027SEM 1", "2027SEM1", "2027 SEM 1",
  "2028SEM 1", "2028SEM1", "2028 SEM 1",
];

// ── Auth ────────────────────────────────────────────────────
async function autenticar() {
  const domain = process.env.SF_DOMAIN;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });

  const res = await fetch(`https://${domain}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Auth Salesforce ${res.status}: ${JSON.stringify(data)}`);
  }
  return { token: data.access_token, inst: data.instance_url };
}

// ── Cliente ─────────────────────────────────────────────────
function crearCliente({ token, inst }) {
  const get = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.errorCode || data[0]?.errorCode) {
      throw new Error(`SOQL Error: ${JSON.stringify(data)}`);
    }
    return data;
  };

  const query = (soql) =>
    get(`${inst}/services/data/${API}/query?q=${encodeURIComponent(soql)}`);

  const queryAll = async (soql) => {
    let out = [];
    let data = await query(soql);
    out = out.concat(data.records || []);
    while (data.nextRecordsUrl) {
      data = await get(`${inst}${data.nextRecordsUrl}`);
      out = out.concat(data.records || []);
    }
    return out;
  };

  const queryBatched = async (ids, soqlFn, opts = {}) => {
    const { concurrencia = 5, quote = true } = opts;
    const lotes = [];
    for (let i = 0; i < ids.length; i += 200) lotes.push(ids.slice(i, i + 200));

    const out = [];
    for (let i = 0; i < lotes.length; i += concurrencia) {
      const grupo = lotes.slice(i, i + concurrencia);
      const resultados = await Promise.all(
        grupo.map(lote => query(soqlFn(
          lote.map(x => quote ? `'${x}'` : x).join(",")
        )))
      );
      resultados.forEach(r => out.push(...(r.records || [])));
    }
    return out;
  };

  return { query, queryAll, queryBatched };
}

// ── Extracción completa ─────────────────────────────────────
export async function cargarLeads(opts = {}) {
  const t0 = Date.now();
  const creds = await autenticar();
  const sf = crearCliente(creds);

  const ownerIn    = ASESOR_IDS.map(i => `'${i}'`).join(",");
  const semestreIn = SEMESTRES.map(s => `'${s}'`).join(",");
  const desde      = opts.desde || "2025-01-01T00:00:00Z";

  const filtroOwner = opts.todosLosAsesores ? "" : `AND OwnerId IN (${ownerIn})`;

  const records = await sf.queryAll(`SELECT Id, Nombres__c, Apellidos__c,
    N_mero_de_documento__c, Telefono__c, Correo_electronico__c,
    Colegio_Universidad__c, Origen_del_candidato__c, Beca_de_inter_s__c,
    Programas_de_interes__c, Cuando_Ingresarias__c, Comentario__c,
    Por_qu_quer_s_estudiar_en_la_UCEMA__c, Gestionado__c,
    Estado_del_Candidato2__c, Propietario_del_Candidato__c,
    C_mo_llegaste_a_nuestra_propuesta_educa__c, Area__c, Candidato__c,
    OwnerId, Owner.Name, CreatedDate, LastModifiedDate
    FROM Formulario_web__c
    WHERE CreatedDate >= ${desde}
    ${filtroOwner}
    AND Cuando_Ingresarias__c IN (${semestreIn})
    ORDER BY CreatedDate DESC`);

  const candidatoIds = [...new Set(records.map(r => r.Candidato__c).filter(Boolean))];

  const [leadRecs, cmRecs] = await Promise.all([
    sf.queryBatched(candidatoIds, ids =>
      `SELECT Id, Status FROM Lead WHERE Id IN (${ids})`),
    sf.queryBatched(candidatoIds, ids =>
      `SELECT LeadId, Status, Campaign.Name FROM CampaignMember
       WHERE LeadId IN (${ids})
       AND CampaignId NOT IN (SELECT Id FROM Campaign
         WHERE Name LIKE 'I - Posgrado%' OR Name LIKE 'I - Maestría%')
       ORDER BY CreatedDate DESC`),
  ]);

  const leadStatus = {};
  leadRecs.forEach(r => { leadStatus[r.Id] = r.Status || ""; });

  const cmMap = {};
  cmRecs.forEach(r => {
    const lid = r.LeadId;
    if (!cmMap[lid]) cmMap[lid] = { best: "", camps: new Set() };
    const camp = r.Campaign?.Name || "";
    if (camp) cmMap[lid].camps.add(camp);
    if (estadoPri(r.Status || "") > estadoPri(cmMap[lid].best)) {
      cmMap[lid].best = r.Status || "";
    }
  });

  const limpiarDni = (d) => (d || "").toString().replace(/[.\s-]/g, "");
  const dnis = [...new Set(
    records.map(r => limpiarDni(r.N_mero_de_documento__c))
      .filter(d => /^\d{6,9}$/.test(d))
  )];

  const contactRecs = dnis.length
    ? await sf.queryBatched(dnis, ids =>
        `SELECT Id, Numero_de_documento__c, Admitido__c FROM Contact
         WHERE Numero_de_documento__c IN (${ids})`,
        { quote: false })
    : [];

  const contactByDni = {}, dniByContact = {};
  contactRecs.forEach(c => {
    const dni = limpiarDni(c.Numero_de_documento__c);
    if (!dni) return;
    contactByDni[dni] = { id: c.Id, admitido: c.Admitido__c === true };
    dniByContact[c.Id] = dni;
  });

  const admitidosSetByDni = new Set();
  const admitidosSetByContactId = new Set();

  const appsAdmitidas = await sf.queryAll(`SELECT Id, hed__Applicant__c, hed__Applicant__r.Numero_de_documento__c 
    FROM hed__Application__c 
    WHERE (hed__Application_Status__c LIKE '%Admi%' OR hed__Application_Status__c LIKE '%Admit%')
    AND (NOT hed__Term__r.Name LIKE '%Posgrado%')
    AND (NOT hed__Term__r.Name LIKE '%Maestría%')
    AND (NOT hed__Term__r.Name LIKE '%Executive%')
    AND (NOT hed__Term__r.Name LIKE '%Septiembre%')`);

  appsAdmitidas.forEach(app => {
    if (app.hed__Applicant__c) {
      admitidosSetByContactId.add(app.hed__Applicant__c);
    }
    if (app.hed__Applicant__r?.Numero_de_documento__c) {
      const dniApp = limpiarDni(app.hed__Applicant__r.Numero_de_documento__c);
      if (dniApp) admitidosSetByDni.add(dniApp);
    }
  });

  const contactIdsSet = new Set();
  for (const r of records) {
    const dni = limpiarDni(r.N_mero_de_documento__c);
    const c = contactByDni[dni];
    if (!c) continue;
    const conv = estadoPri(cmMap[r.Candidato__c]?.best || "") === 7
      || (r.Estado_del_Candidato2__c || "").toLowerCase() === "qualified";
    
    const esAdmitidoReal = c.admitido || admitidosSetByDni.has(dni) || admitidosSetByContactId.has(c.id);
    if (esAdmitidoReal || conv) contactIdsSet.add(c.id);
  }
  const contactIds = [...contactIdsSet];

  const notaByDni = {};
  if (contactIds.length) {
    const fbRecs = await sf.queryBatched(contactIds, ids =>
      `SELECT Contacto__c, Feedback__c, CreatedDate FROM Feedback__c
       WHERE Contacto__c IN (${ids}) ORDER BY CreatedDate DESC`);
    fbRecs.forEach(f => {
      const dni = dniByContact[f.Contacto__c];
      if (!dni || notaByDni[dni] != null) return;
      const n = extractNota(f.Feedback__c);
      if (n != null) notaByDni[dni] = n;
    });
  }

  // ── Transformación ────────────────────────────────────────
  const enmascarar = process.env.ENMASCARAR_PII !== "false";
  const campanasDescartadas = new Set();

  const leads = records.map(r => {
    const cm = cmMap[r.Candidato__c] || { best: "", camps: new Set() };
    const camps = Array.from(cm.camps);

    let estado = r.Estado_del_Candidato2__c || "";
    const ls = normalizeStatus(leadStatus[r.Candidato__c] || "");
    if (estadoPri(ls) > estadoPri(estado)) estado = ls;
    if (estadoPri(cm.best) > estadoPri(estado)) estado = cm.best;

    const progs = new Set();
    (r.Programas_de_interes__c || "")
      .split(/[,;]/).map(p => p.trim())
      .filter(esProgramaValido)
      .forEach(p => progs.add(p));

    camps.map(extractProg).forEach(p => {
      if (!p) return;
      if (esProgramaValido(p)) progs.add(p);
      else campanasDescartadas.add(p);
    });

    const dni = limpiarDni(r.N_mero_de_documento__c);
    const contactInfo = contactByDni[dni];

    const esAdmitido = (contactInfo?.admitido === true) 
      || admitidosSetByDni.has(dni) 
      || (contactInfo?.id && admitidosSetByContactId.has(contactInfo.id));

    return transformar(r, {
      programa: Array.from(progs).join(", "),
      estado,
      campanas: camps,
      nota: notaByDni[dni] ?? null,
      admitido: esAdmitido,
    }, { enmascarar });
  });

  const embudoGlobal = contarEmbudo(leads);

  return {
    cargadoEn: new Date().toISOString(),
    duracionMs: Date.now() - t0,
    desde,
    todosLosAsesores: !!opts.todosLosAsesores,
    piiEnmascarada: enmascarar,
    leads,
    embudoGlobal,
    tasasGlobales: tasas(embudoGlobal),
    porCohorte: agregarPorCohorte(leads),

    diagnostico: {
      totalRegistros: records.length,
      conDniValido: dnis.length,
      sinDniValido: records.length - dnis.length,
      contactosEncontrados: contactRecs.length,
      admitidosDetectados: leads.filter(l => l.admitido).length,
      feedbacksConNota: Object.keys(notaByDni).length,
    },
    campanasDescartadas: Array.from(campanasDescartadas).sort(),
  };
}

// ── Consulta estructurada a hed__Application__c con filtros rigurosos de Grado ──────
export async function buscarAdmitidos(opts = {}) {
  const creds = await autenticar();
  const sf = crearCliente(creds);

  let whereClauses = [
    "(hed__Application_Status__c LIKE '%Admi%' OR hed__Application_Status__c LIKE '%Admit%')"
  ];

  // FILTRO CORREGIDO: Pegado estricto al número de año lectivo o semestres de grado válidos
  if (opts.ano) {
    const anoNum = Number(opts.ano);
    const anoStr = String(opts.ano);
    whereClauses.push(`(AnoLectivo__c = ${anoNum} OR hed__Term__r.Name LIKE '${anoStr}SEM%' OR hed__Term__r.Name LIKE '${anoStr} SEM%')`);
  }

  if (opts.nombre) {
    const nombreLimpio = opts.nombre.replace(/'/g, "\\'");
    whereClauses.push(`hed__Applicant__r.Name LIKE '%${nombreLimpio}%'`);
  }

  // Filtros de Cápita corregidos
  if (opts.capita_min !== undefined && opts.capita_min !== null) {
    whereClauses.push(`Capita__c >= ${Number(opts.capita_min)}`);
  }
  if (opts.capita_max !== undefined && opts.capita_max !== null) {
    whereClauses.push(`Capita__c <= ${Number(opts.capita_max)}`);
  }

  // Exclusión estricta de programas que no son de Grado
  whereClauses.push("(NOT hed__Term__r.Name LIKE '%Posgrado%')");
  whereClauses.push("(NOT hed__Term__r.Name LIKE '%Maestría%')");
  whereClauses.push("(NOT hed__Term__r.Name LIKE '%Executive%')");
  whereClauses.push("(NOT hed__Term__r.Name LIKE '%Septiembre%')");

  const limite = Math.min(opts.limite || 200, 500);
  const offset = Math.max(opts.offset || 0, 0);

  const query = `SELECT 
      Id, 
      Name, 
      hed__Applicant__c, 
      hed__Applicant__r.Name, 
      hed__Application_Status__c, 
      hed__Application_Date__c, 
      AnoLectivo__c, 
      Capita__c,
      hed__Term__r.Name,
      OwnerId
    FROM hed__Application__c 
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY CreatedDate DESC
    LIMIT ${limite}
    OFFSET ${offset}`;

  const data = await sf.query(query);
  const records = data.records || [];

  const admitidos = records.map(r => ({
    idApplication: r.Id,
    numeroSolicitud: r.Name,
    idContacto: r.hed__Applicant__c,
    nombreAlumno: r.hed__Applicant__r ? r.hed__Applicant__r.Name : "Sin Nombre",
    estado: r.hed__Application_Status__c,
    fechaSolicitud: r.hed__Application_Date__c,
    anoLectivo: r.AnoLectivo__c ?? null,
    capita: r.Capita__c ?? 0,
    termino: r.hed__Term__r ? r.hed__Term__r.Name : null
  }));

  const totalCapitas = admitidos.reduce((acc, r) => acc + (Number(r.capita) || 0), 0);

  return {
    totalAdmitidos: admitidos.length,
    totalCapitas: +totalCapitas.toFixed(2),
    offset,
    limite,
    registros: admitidos
  };
}

// ── NUEVA FUNCIÓN: Agregación masiva mediante GROUP BY directa en Salesforce ──────
// ── Agregación por GROUP BY directa (Académico Completo) ────────────────────
export async function resumirAdmitidosCapitas(opts = {}) {
  const creds = await autenticar();
  const sf = crearCliente(creds);

  let whereClauses = [
    "(hed__Application_Status__c LIKE '%Admi%' OR hed__Application_Status__c LIKE '%Admit%')",
    "(NOT hed__Term__r.Name LIKE '%Posgrado%')",
    "(NOT hed__Term__r.Name LIKE '%Maestría%')",
    "(NOT hed__Term__r.Name LIKE '%Executive%')",
    "(NOT hed__Term__r.Name LIKE '%Septiembre%')"
  ];

  if (opts.ano) {
    const anoNum = Number(opts.ano);
    const anoStr = String(opts.ano);
    // Incluye AnoLectivo__c O nombres de término que contengan el año (ej: "Marzo 2027", "2027SEM1")
    whereClauses.push(`(AnoLectivo__c = ${anoNum} OR hed__Term__r.Name LIKE '%${anoStr}%')`);
  }

  if (opts.termino) {
    const termLimpio = opts.termino.replace(/'/g, "\\'");
    whereClauses.push(`hed__Term__r.Name LIKE '%${termLimpio}%'`);
  }

  const query = `SELECT 
      hed__Term__r.Name termino, 
      COUNT(Id) totalAdmitidos, 
      SUM(Capita__c) totalCapitas
    FROM hed__Application__c 
    WHERE ${whereClauses.join(" AND ")}
    GROUP BY hed__Term__r.Name`;

  const data = await sf.query(query);
  const records = data.records || [];

  const desglose = records.map(r => ({
    termino: r.termino || "Sin Término Asignado",
    totalAdmitidos: r.totalAdmitidos || 0,
    totalCapitas: +(r.totalCapitas || 0).toFixed(2)
  }));

  const granTotalAdmitidos = desglose.reduce((a, b) => a + b.totalAdmitidos, 0);
  const granTotalCapitas = desglose.reduce((a, b) => a + b.totalCapitas, 0);

  return {
    filtroAplicado: opts.ano ? `Año ${opts.ano}` : opts.termino ? `Término ${opts.termino}` : "Todos",
    totalAdmitidos: granTotalAdmitidos,
    totalCapitas: +granTotalCapitas.toFixed(2),
    desglosePorTermino: desglose
  };
}
