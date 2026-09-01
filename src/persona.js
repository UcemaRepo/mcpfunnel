// ============================================================
// persona.js — ficha completa de una persona
// ============================================================
//
// Por que existe:
//
// La sesion en memoria carga SOLO grado con semestre definido.
// Los leads de posgrado quedan afuera por dos motivos a la vez:
// su programa no esta en el catalogo de grado, y su campo
// Cuando_Ingresarias__c viene vacio, asi que no entra en el
// IN de semestres.
//
// Son mas de 45.000 registros: cargarlos a RAM duplicaria la
// sesion y reventaria el free tier. Pero para responder "esta
// persona de maestria, tiene tambien algo de grado?" no hacen
// falta los 45.000, hace falta UNA persona.
//
// Entonces esta busqueda va en vivo contra Salesforce, sin
// pasar por la sesion y sin ninguno de sus filtros.
// ============================================================

import { clasificarCampo } from "./programas.js";

const API = "v59.0";

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
    throw new Error(`Auth Salesforce ${res.status}`);
  }

  return { token: data.access_token, inst: data.instance_url };
}

// Escapa comillas para no romper la SOQL con apellidos tipo O'Brien
const soqlSeguro = (t) => String(t || "").replace(/['\\]/g, "\\$&");

export async function fichaPersona({ nombre, apellido, dni }) {
  if (!nombre && !apellido && !dni) {
    throw new Error("Hace falta al menos nombre, apellido o DNI.");
  }

  const { token, inst } = await autenticar();

  const query = async (soql) => {
    const res = await fetch(
      `${inst}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();

    if (data.errorCode || data[0]?.errorCode) {
      throw new Error(`SOQL: ${JSON.stringify(data)}`);
    }

    return data.records || [];
  };

  // ── Condiciones ───────────────────────────────────────────
  const condFormulario = [];
  const condApp = [];

  if (dni) {
    const d = String(dni).replace(/\D/g, "");
    condFormulario.push(`N_mero_de_documento__c = ${d}`);
    condApp.push(`N_mero_de_documento__c = ${d}`);
  }

  if (apellido) {
    const a = soqlSeguro(apellido);
    condFormulario.push(`Apellidos__c LIKE '%${a}%'`);
    condApp.push(`Apellido_del_solicitante__c LIKE '%${a}%'`);
  }

  if (nombre) {
    const n = soqlSeguro(nombre);
    condFormulario.push(`Nombres__c LIKE '%${n}%'`);
    condApp.push(`Nombre_del_solicitante__c LIKE '%${n}%'`);
  }

  // OR entre criterios: con apellido solo ya alcanza para
  // encontrar variantes de tipeo del nombre ("Analia"/"Anali").
  const whereF = condFormulario.join(" OR ");
  const whereA = condApp.join(" OR ");

  // ── Formularios y solicitudes, en paralelo ────────────────
  const [formularios, solicitudes] = await Promise.all([
    query(`SELECT Id, Nombres__c, Apellidos__c, N_mero_de_documento__c,
      Programas_de_interes__c, Cuando_Ingresarias__c,
      Estado_del_Candidato2__c, Propietario_del_Candidato__c,
      Origen_del_candidato__c, Colegio_Universidad__c,
      Gestionado__c, Candidato__c, CreatedDate
      FROM Formulario_web__c
      WHERE ${whereF}
      ORDER BY CreatedDate DESC
      LIMIT 100`),

    query(`SELECT Id, Nombre_del_solicitante__c, Apellido_del_solicitante__c,
      Tipo_de_Programa__c, hed__Application_Status__c,
      A_o_de_ingreso__c, Semestre__c, Capita__c, Beca_aplicada__c,
      CreatedDate
      FROM hed__Application__c
      WHERE ${whereA}
      ORDER BY CreatedDate DESC
      LIMIT 100`),
  ]);

  // ── Clasificacion ─────────────────────────────────────────
  const formsClasificados = formularios.map((f) => {
    const c = clasificarCampo(f.Programas_de_interes__c);

    return {
      sfId: f.Id,
      nombre: `${f.Nombres__c || ""} ${f.Apellidos__c || ""}`.trim(),
      programaRaw: f.Programas_de_interes__c || null,
      tipoPrograma: c.tipo,
      programas: c.codigos,
      semestre: f.Cuando_Ingresarias__c || null,
      estado: f.Estado_del_Candidato2__c || null,
      asesor: f.Propietario_del_Candidato__c || null,
      origen: f.Origen_del_candidato__c || null,
      colegio: f.Colegio_Universidad__c || null,
      gestionado:
        f.Gestionado__c === true
          ? "si"
          : f.Gestionado__c === false
            ? "no"
            : "desconocido",
      createdDate: f.CreatedDate,

      // Este es el motivo por el que el lead no esta en la
      // sesion en memoria, si no lo esta.
      enDataset:
        c.tipo === "grado" && !!f.Cuando_Ingresarias__c,
    };
  });

  const apps = solicitudes.map((a) => ({
    sfId: a.Id,
    nombre: `${a.Nombre_del_solicitante__c || ""} ${
      a.Apellido_del_solicitante__c || ""
    }`.trim(),
    tipoPrograma: a.Tipo_de_Programa__c || null,
    estado: a.hed__Application_Status__c || null,
    anoIngreso: a.A_o_de_ingreso__c ?? null,
    semestre: a.Semestre__c || null,
    capita: a.Capita__c ?? null,
    beca: a.Beca_aplicada__c ?? null,
    createdDate: a.CreatedDate,
  }));

  // ── Resumen ───────────────────────────────────────────────
  const tipos = new Set(
    formsClasificados.map((f) => f.tipoPrograma).filter((t) => t !== "sin_programa")
  );

  apps.forEach((a) => {
    if (a.tipoPrograma) tipos.add(a.tipoPrograma.toLowerCase());
  });

  const tieneGrado = tipos.has("grado") || tipos.has("mixto");
  const tienePosgrado = tipos.has("posgrado") || tipos.has("mixto");

  // Duplicados aparentes: mismo programa cargado mas de una vez
  const porPrograma = {};
  for (const f of formsClasificados) {
    const k = f.programaRaw || "(sin programa)";
    porPrograma[k] = (porPrograma[k] || 0) + 1;
  }

  const repetidos = Object.entries(porPrograma)
    .filter(([, n]) => n > 1)
    .map(([programa, veces]) => ({ programa, veces }));

  return {
    criterio: { nombre, apellido, dni },

    resumen: {
      formularios: formsClasificados.length,
      solicitudes: apps.length,
      tieneGrado,
      tienePosgrado,
      cruzaGradoYPosgrado: tieneGrado && tienePosgrado,

      enDatasetEnMemoria: formsClasificados.filter((f) => f.enDataset)
        .length,

      fueraDelDataset: formsClasificados.filter((f) => !f.enDataset)
        .length,

      ...(repetidos.length && { programasRepetidos: repetidos }),
    },

    formularios: formsClasificados,
    solicitudes: apps,

    nota:
      "Consulta en vivo contra Salesforce, sin los filtros de la sesion en memoria. Incluye posgrado y registros sin semestre. 'enDataset' indica si ese formulario forma parte del dataset que usan las demas herramientas.",
  };
}

// ------------------------------------------------------------
// Ruta
// ------------------------------------------------------------

export function montarPersona(app, auth) {
  app.get("/persona", auth, async (req, res) => {
    try {
      const { nombre, apellido, dni } = req.query;
      res.json({ ok: true, ...(await fichaPersona({ nombre, apellido, dni })) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
}
