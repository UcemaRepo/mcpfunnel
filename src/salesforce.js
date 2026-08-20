// ============================================================
// salesforce.js — extracción y merge desde Salesforce
// ============================================================

import {
  depurar, agregar, estadoPri, normalizeStatus,
  extractProg, extractNota, esProgramaValido,
} from "./scoring.js";

const API = "v59.0";

// IDs de los 6 asesores activos
const ASESOR_IDS = [
  "005VJ000002riJVYAY",
  "005VJ0000031rVBYAY",
  "005VJ000003eZbdYAE",
  "005VJ000000tba1YAA",
  "005VJ0000027bmTYAQ",
  "005VJ000000taFmYAI",
];

// Semestres futuros activos. Los vacíos entran aparte (ver WHERE).
const SEMESTRES_ACTIVOS = [
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

// ── Helpers de query ────────────────────────────────────────
function crearCliente({ token, inst }) {
  const get = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.errorCode || data[0]?.errorCode) {
      throw new Error(`SOQL: ${JSON.stringify(data)}`);
    }
    return data;
  };

  const query = (soql) =>
    get(`${inst}/services/data/${API}/query?q=${encodeURIComponent(soql)}`);

  // Query paginada completa
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

  // Ejecuta una query por lotes de 200 ids, en paralelo de a 5
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
  const semestreIn = SEMESTRES_ACTIVOS.map(s => `'${s}'`).join(",");
  const desde      = opts.desde || "2026-02-01T00:00:00Z";

  // 1. Formulario_web__c (paginado completo)
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
    AND OwnerId IN (${ownerIn})
    AND (Cuando_Ingresarias__c IN (${semestreIn}) OR Cuando_Ingresarias__c = null)
    ORDER BY CreatedDate DESC`);

  const candidatoIds = [...new Set(records.map(r => r.Candidato__c).filter(Boolean))];

  // 2 y 3. Lead.Status y CampaignMember, en paralelo
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

  // 4. Contact por DNI
  const limpiarDni = (d) => (d || "").toString().replace(/[.\s-]/g, "");
  const dnis = [...new Set(
    records.map(r => limpiarDni(r.N_mero_de_documento__c))
      .filter(d => /^\d{6,9}$/.test(d))   // solo numéricos válidos
  )];

  const contactRecs = await sf.queryBatched(dnis, ids =>
    `SELECT Id, Numero_de_documento__c, Admitido__c FROM Contact
     WHERE Numero_de_documento__c IN (${ids})`,
    { quote: false });

  const contactByDni = {}, dniByContact = {};
  contactRecs.forEach(c => {
    const dni = limpiarDni(c.Numero_de_documento__c);
    if (!dni) return;
    contactByDni[dni] = { id: c.Id, admitido: c.Admitido__c === true };
    dniByContact[c.Id] = dni;
  });

  // 5. Feedback solo de admitidos/convertidos
  const contactIds = [];
  for (const r of records) {
    const c = contactByDni[limpiarDni(r.N_mero_de_documento__c)];
    if (!c) continue;
    const conv = estadoPri(cmMap[r.Candidato__c]?.best || "") === 7
      || (r.Estado_del_Candidato2__c || "").toLowerCase() === "qualified";
    if ((c.admitido || conv) && !contactIds.includes(c.id)) contactIds.push(c.id);
  }

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

  // ── Depuración ────────────────────────────────────────────
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

    return depurar(r, {
      programa: Array.from(progs).join(", "),
      estado,
      campanas: camps,
      nota: notaByDni[limpiarDni(r.N_mero_de_documento__c)] ?? null,
    }, { enmascarar });
  });

  return {
    cargadoEn: new Date().toISOString(),
    duracionMs: Date.now() - t0,
    piiEnmascarada: enmascarar,
    leads,
    agregados: agregar(leads),
    campanasDescartadas: Array.from(campanasDescartadas).sort(),
  };
}
