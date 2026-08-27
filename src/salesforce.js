// ============================================================
// salesforce.js — extracción, normalización y match Lead ↔ Admitido
// ============================================================

import {
  transformar,
  agregarPorCohorte,
  estadoPri,
  normalizeStatus,
  extractProg,
  extractNota,
  esProgramaValido,
  contarEmbudo,
  tasas,
  canonSemestre,
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

// Se mantiene como respaldo para no romper instalaciones actuales.
// La extracción de leads ya NO depende de esta lista para encontrar admitidos.
const SEMESTRES = [
  "2026SEM 1",
  "2026SEM1",
  "2026 SEM 1",
  "2026SEM 2",
  "2026SEM2",
  "2026 SEM 2",

  "2027SEM 1",
  "2027SEM1",
  "2027 SEM 1",
  "2027SEM 2",
  "2027SEM2",
  "2027 SEM 2",

  "2028SEM 1",
  "2028SEM1",
  "2028 SEM 1",
  "2028SEM 2",
  "2028SEM2",
  "2028 SEM 2",
];

// ------------------------------------------------------------
// Cohortes
// ------------------------------------------------------------
// Convierte variantes como:
//
// 2027S1
// 2027 S1
// 2027SEM1
// 2027 SEM 1
// 2027-SEM-1
//
// en:
//
// 2027S1
//
// "2027" queda como "2027": NO inventamos un semestre.
// Luego terminosCompatibles() decide si ese año genérico puede
// matchear contra S1/S2 según el contexto.
// ------------------------------------------------------------

export function normalizarTermino(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  const raw = String(valor)
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!raw) {
    return "";
  }

  const compact = raw.replace(/[^A-Z0-9]/g, "");

  let m = compact.match(
    /^(\d{4})(?:SEM|SEMESTRE|S)([12])$/
  );

  if (m) {
    return `${m[1]}S${m[2]}`;
  }

  m = compact.match(/^(\d{4})([12])$/);

  if (m && !compact.includes("SEM")) {
    // No interpretar "20271" como semestre:
    // es demasiado ambiguo.
    return raw.replace(/[^0-9]/g, "");
  }

  m = compact.match(/^(\d{4})$/);

  if (m) {
    return m[1];
  }

  // Último intento usando la función existente del proyecto.
  try {
    const c = canonSemestre(valor);

    if (c) {
      const cc = String(c)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

      const mm = cc.match(
        /^(\d{4})(?:SEM|S)([12])$/
      );

      if (mm) {
        return `${mm[1]}S${mm[2]}`;
      }

      if (/^\d{4}$/.test(cc)) {
        return cc;
      }
    }
  } catch (_) {}

  return raw.replace(/\s+/g, " ").trim();
}

export function terminoInfo(valor) {
  const normalizado = normalizarTermino(valor);

  if (/^\d{4}S[12]$/.test(normalizado)) {
    return {
      original: valor ?? null,
      normalizado,
      ano: normalizado.slice(0, 4),
      semestre: normalizado.slice(5),
      esAnoGenerico: false,
    };
  }

  if (/^\d{4}$/.test(normalizado)) {
    return {
      original: valor ?? null,
      normalizado,
      ano: normalizado,
      semestre: null,
      esAnoGenerico: true,
    };
  }

  return {
    original: valor ?? null,
    normalizado,
    ano: null,
    semestre: null,
    esAnoGenerico: false,
  };
}

export function terminosCompatibles(a, b) {
  const A = terminoInfo(a);
  const B = terminoInfo(b);

  if (!A.normalizado || !B.normalizado) {
    return false;
  }

  if (A.normalizado === B.normalizado) {
    return true;
  }

  // Un registro "2027" puede representar el año y,
  // por contexto, ser compatible con 2027S1/2027S2.
  if (
    A.esAnoGenerico &&
    A.ano === B.ano
  ) {
    return true;
  }

  if (
    B.esAnoGenerico &&
    A.ano === B.ano
  ) {
    return true;
  }

  return false;
}

export function tipoMatchTermino(a, b) {
  const A = terminoInfo(a);
  const B = terminoInfo(b);

  if (!terminosCompatibles(a, b)) {
    return "sin_match";
  }

  if (A.normalizado === B.normalizado) {
    return "termino_normalizado";
  }

  return "anio_generico";
}

const limpiarDni = (d) =>
  (d ?? "")
    .toString()
    .replace(/[.\s-]/g, "")
    .replace(/\D/g, "");

const esDniValido = (d) =>
  /^\d{6,9}$/.test(d);

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------

async function autenticar() {
  const domain = process.env.SF_DOMAIN;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.SF_CLIENT_ID,
    client_secret: process.env.SF_CLIENT_SECRET,
  });

  const res = await fetch(
    `https://${domain}/services/oauth2/token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Auth Salesforce ${res.status}: ${JSON.stringify(data)}`
    );
  }

  return {
    token: data.access_token,
    inst: data.instance_url,
  };
}

// ------------------------------------------------------------
// Cliente
// ------------------------------------------------------------

function crearCliente({ token, inst }) {
  const get = async (url) => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json();

    if (
      data.errorCode ||
      data[0]?.errorCode
    ) {
      throw new Error(
        `SOQL Error: ${JSON.stringify(data)}`
      );
    }

    return data;
  };

  const query = (soql) =>
    get(
      `${inst}/services/data/${API}/query?q=${encodeURIComponent(
        soql
      )}`
    );

  const queryAll = async (soql) => {
    let out = [];

    let data = await query(soql);

    out = out.concat(
      data.records || []
    );

    while (data.nextRecordsUrl) {
      data = await get(
        `${inst}${data.nextRecordsUrl}`
      );

      out = out.concat(
        data.records || []
      );
    }

    return out;
  };

  const queryBatched = async (
    ids,
    soqlFn,
    opts = {}
  ) => {
    const {
      concurrencia = 5,
      quote = true,
    } = opts;

    const lotes = [];

    for (
      let i = 0;
      i < ids.length;
      i += 200
    ) {
      lotes.push(
        ids.slice(i, i + 200)
      );
    }

    const out = [];

    for (
      let i = 0;
      i < lotes.length;
      i += concurrencia
    ) {
      const grupo =
        lotes.slice(
          i,
          i + concurrencia
        );

      const resultados =
        await Promise.all(
          grupo.map(
            (lote) =>
              query(
                soqlFn(
                  lote
                    .map((x) =>
                      quote
                        ? `'${x}'`
                        : x
                    )
                    .join(",")
                )
              )
          )
        );

      resultados.forEach(
        (r) =>
          out.push(
            ...(r.records || [])
          )
      );
    }

    return out;
  };

  return {
    query,
    queryAll,
    queryBatched,
  };
}

// ------------------------------------------------------------
// Applications admitidas
// ------------------------------------------------------------
//
// IMPORTANTE:
//
// Esta consulta es independiente de Formulario_web__c.
//
// Por eso un admitido que no tenga formulario web
// NO desaparece.
//
// ------------------------------------------------------------

async function cargarApplicationsAdmitidas(sf) {
  const apps =
    await sf.queryAll(`
      SELECT
        Id,
        Name,
        hed__Applicant__c,
        hed__Applicant__r.Name,
        hed__Applicant__r.Numero_de_documento__c,
        hed__Application_Status__c,
        hed__Application_Date__c,
        AnoLectivo__c,
        Capita__c,
        hed__Term__r.Name,
        OwnerId,
        CreatedDate

      FROM hed__Application__c

      WHERE
        (
          hed__Application_Status__c LIKE '%Admi%'
          OR
          hed__Application_Status__c LIKE '%Admit%'
        )

        AND
        (
          NOT hed__Term__r.Name LIKE '%Posgrado%'
        )

        AND
        (
          NOT hed__Term__r.Name LIKE '%Maestría%'
        )

        AND
        (
          NOT hed__Term__r.Name LIKE '%Executive%'
        )

        AND
        (
          NOT hed__Term__r.Name LIKE '%Septiembre%'
        )

      ORDER BY CreatedDate DESC
    `);

  // Una persona puede tener más de una Application.
  //
  // Para el conteo de admitidos usamos una persona
  // por término.

  const unique = new Map();

  for (const app of apps) {
    const dni =
      limpiarDni(
        app
          .hed__Applicant__r
          ?.Numero_de_documento__c
      );

    const contactId =
      app.hed__Applicant__c ||
      "";

    const termino =
      normalizarTermino(
        app.hed__Term__r?.Name ||
        app.AnoLectivo__c
      );

    const personaKey =
      contactId ||
      (
        esDniValido(dni)
          ? `DNI:${dni}`
          : `APP:${app.Id}`
      );

    const key =
      `${personaKey}|${
        termino || "SIN_TERMINO"
      }`;

    const capita =
      Number(
        app.Capita__c ?? 1
      ) || 0;

    const actual =
      unique.get(key);

    // Si hay duplicados,
    // conservamos el registro con mayor cápita.

    if (
      !actual ||
      capita > actual.capita
    ) {
      unique.set(key, {
        idApplication: app.Id,

        numeroSolicitud:
          app.Name,

        idContacto:
          contactId || null,

        dni:
          esDniValido(dni)
            ? dni
            : null,

        nombreAlumno:
          app
            .hed__Applicant__r
            ?.Name ||
          "Sin Nombre",

        estado:
          app.hed__Application_Status__c ||
          "",

        fechaSolicitud:
          app.hed__Application_Date__c ||
          null,

        anoLectivo:
          app.AnoLectivo__c ??
          null,

        capita,

        terminoOriginal:
          app.hed__Term__r?.Name ||
          null,

        termino,

        ownerId:
          app.OwnerId ||
          null,
      });
    }
  }

  return Array.from(
    unique.values()
  );
}

// ------------------------------------------------------------
// Extracción completa
// ------------------------------------------------------------

export async function cargarLeads(
  opts = {}
) {
  const t0 = Date.now();

  const creds =
    await autenticar();

  const sf =
    crearCliente(creds);

  const ownerIn =
    ASESOR_IDS
      .map((i) => `'${i}'`)
      .join(",");

  const desde =
    opts.desde ||
    "2025-01-01T00:00:00Z";

  const filtroOwner =
    opts.todosLosAsesores
      ? ""
      : `AND OwnerId IN (${ownerIn})`;

  // ----------------------------------------------------------
  // IMPORTANTE:
  //
  // Ya NO filtramos aquí por SEMESTRES.
  //
  // Traemos los formularios y normalizamos su cohorte
  // después.
  //
  // ----------------------------------------------------------

  const records =
    await sf.queryAll(`
      SELECT
        Id,
        Nombres__c,
        Apellidos__c,
        N_mero_de_documento__c,
        Telefono__c,
        Correo_electronico__c,
        Colegio_Universidad__c,
        Origen_del_candidato__c,
        Beca_de_inter_s__c,
        Programas_de_interes__c,
        Cuando_Ingresarias__c,
        Comentario__c,
        Por_qu_quer_s_estudiar_en_la_UCEMA__c,
        Gestionado__c,
        Estado_del_Candidato2__c,
        Propietario_del_Candidato__c,
        C_mo_llegaste_a_nuestra_propuesta_educa__c,
        Area__c,
        Candidato__c,
        OwnerId,
        Owner.Name,
        CreatedDate,
        LastModifiedDate

      FROM Formulario_web__c

      WHERE CreatedDate >= ${desde}

      ${filtroOwner}

      ORDER BY CreatedDate DESC
    `);

  // ----------------------------------------------------------
  // Applications reales de admitidos.
  // ----------------------------------------------------------

  const appsAdmitidas =
    await cargarApplicationsAdmitidas(
      sf
    );

  // ----------------------------------------------------------
  // IDs de candidatos
  // ----------------------------------------------------------

  const candidatoIds = [
    ...new Set(
      records
        .map(
          (r) =>
            r.Candidato__c
        )
        .filter(Boolean)
    ),
  ];

  const [
    leadRecs,
    cmRecs,
  ] = await Promise.all([
    sf.queryBatched(
      candidatoIds,
      (ids) =>
        `
          SELECT
            Id,
            Status

          FROM Lead

          WHERE Id IN (${ids})
        `
    ),

    sf.queryBatched(
      candidatoIds,
      (ids) =>
        `
          SELECT
            LeadId,
            Status,
            Campaign.Name

          FROM CampaignMember

          WHERE
            LeadId IN (${ids})

          AND CampaignId NOT IN (
            SELECT Id
            FROM Campaign
            WHERE
              Name LIKE 'I - Posgrado%'
              OR Name LIKE 'I - Maestría%'
          )

          ORDER BY CreatedDate DESC
        `
    ),
  ]);

  const leadStatus = {};

  leadRecs.forEach(
    (r) => {
      leadStatus[r.Id] =
        r.Status || "";
    }
  );

  const cmMap = {};

  cmRecs.forEach(
    (r) => {
      const lid =
        r.LeadId;

      if (!cmMap[lid]) {
        cmMap[lid] = {
          best: "",
          camps: new Set(),
        };
      }

      const camp =
        r.Campaign?.Name ||
        "";

      if (camp) {
        cmMap[lid].camps.add(
          camp
        );
      }

      if (
        estadoPri(
          r.Status || ""
        ) >
        estadoPri(
          cmMap[lid].best
        )
      ) {
        cmMap[lid].best =
          r.Status || "";
      }
    }
  );

  // ----------------------------------------------------------
  // Contactos asociados a los leads
  // ----------------------------------------------------------

  const dnis = [
    ...new Set(
      records
        .map(
          (r) =>
            limpiarDni(
              r.N_mero_de_documento__c
            )
        )
        .filter(
          esDniValido
        )
    ),
  ];

  const contactRecs =
    dnis.length
      ? await sf.queryBatched(
          dnis,

          (ids) =>
            `
              SELECT
                Id,
                Numero_de_documento__c,
                Admitido__c

              FROM Contact

              WHERE
                Numero_de_documento__c
                IN (${ids})
            `,

          {
            quote: false,
          }
        )
      : [];

  const contactByDni = {};
  const dniByContact = {};

  contactRecs.forEach(
    (c) => {
      const dni =
        limpiarDni(
          c.Numero_de_documento__c
        );

      if (!dni) {
        return;
      }

      contactByDni[dni] = {
        id: c.Id,
        admitido:
          c.Admitido__c === true,
      };

      dniByContact[c.Id] =
        dni;
    }
  );

  // ----------------------------------------------------------
  // Índices de Applications admitidas
  // ----------------------------------------------------------

  const appsByContactId =
    new Map();

  const appsByDni =
    new Map();

  for (
    const app
    of appsAdmitidas
  ) {
    if (app.idContacto) {
      if (
        !appsByContactId.has(
          app.idContacto
        )
      ) {
        appsByContactId.set(
          app.idContacto,
          []
        );
      }

      appsByContactId
        .get(app.idContacto)
        .push(app);
    }

    if (app.dni) {
      if (
        !appsByDni.has(
          app.dni
        )
      ) {
        appsByDni.set(
          app.dni,
          []
        );
      }

      appsByDni
        .get(app.dni)
        .push(app);
    }
  }

  // ----------------------------------------------------------
  // Feedback
  // ----------------------------------------------------------

  const contactIdsSet =
    new Set();

  for (
    const r
    of records
  ) {
    const dni =
      limpiarDni(
        r.N_mero_de_documento__c
      );

    const c =
      contactByDni[dni];

    if (!c) {
      continue;
    }

    const conv =
      estadoPri(
        cmMap[
          r.Candidato__c
        ]?.best || ""
      ) === 7 ||

      (
        r.Estado_del_Candidato2__c ||
        ""
      ).toLowerCase() ===
        "qualified";

    const esAdmitidoReal =
      c.admitido ||
      appsByDni.has(dni) ||
      appsByContactId.has(c.id);

    if (
      esAdmitidoReal ||
      conv
    ) {
      contactIdsSet.add(
        c.id
      );
    }
  }

  const contactIds =
    [...contactIdsSet];

  const notaByDni = {};

  if (
    contactIds.length
  ) {
    const fbRecs =
      await sf.queryBatched(
        contactIds,

        (ids) =>
          `
            SELECT
              Contacto__c,
              Feedback__c,
              CreatedDate

            FROM Feedback__c

            WHERE
              Contacto__c
              IN (${ids})

            ORDER BY CreatedDate DESC
          `
      );

    fbRecs.forEach(
      (f) => {
        const dni =
          dniByContact[
            f.Contacto__c
          ];

        if (
          !dni ||
          notaByDni[dni] != null
        ) {
          return;
        }

        const n =
          extractNota(
            f.Feedback__c
          );

        if (
          n != null
        ) {
          notaByDni[dni] =
            n;
        }
      }
    );
  }

  // ----------------------------------------------------------
  // Transformación de leads
  // ----------------------------------------------------------

  const enmascarar =
    process.env.ENMASCARAR_PII !==
    "false";

  const campanasDescartadas =
    new Set();

  const leads =
    records.map(
      (r) => {
        const cm =
          cmMap[
            r.Candidato__c
          ] || {
            best: "",
            camps: new Set(),
          };

        const camps =
          Array.from(
            cm.camps
          );

        let estado =
          r.Estado_del_Candidato2__c ||
          "";

        const ls =
          normalizeStatus(
            leadStatus[
              r.Candidato__c
            ] || ""
          );

        if (
          estadoPri(ls) >
          estadoPri(estado)
        ) {
          estado = ls;
        }

        if (
          estadoPri(cm.best) >
          estadoPri(estado)
        ) {
          estado =
            cm.best;
        }

        const progs =
          new Set();

        (
          r.Programas_de_interes__c ||
          ""
        )
          .split(/[,;]/)
          .map(
            (p) => p.trim()
          )
          .filter(
            esProgramaValido
          )
          .forEach(
            (p) =>
              progs.add(p)
          );

        camps
          .map(extractProg)
          .forEach(
            (p) => {
              if (!p) {
                return;
              }

              if (
                esProgramaValido(p)
              ) {
                progs.add(p);
              } else {
                campanasDescartadas.add(
                  p
                );
              }
            }
          );

        const dni =
          limpiarDni(
            r.N_mero_de_documento__c
          );

        const contactInfo =
          contactByDni[dni];

        const aplicaciones =
          appsByDni.get(dni) ||
          (
            contactInfo?.id
              ? appsByContactId.get(
                  contactInfo.id
                )
              : []
          ) ||
          [];

        const esAdmitido =
          contactInfo?.admitido === true ||
          aplicaciones.length > 0;

        // Para el registro del lead
        // tomamos la application compatible
        // con su cohorte, si existe.
        //
        // Si no, la primera disponible.

        const cohorteLead =
          normalizarTermino(
            r.Cuando_Ingresarias__c
          );

        const appCompatible =
          aplicaciones.find(
            (app) =>
              terminosCompatibles(
                cohorteLead,
                app.termino
              )
          ) ||
          aplicaciones[0];

        const capita =
          esAdmitido
            ? Number(
                appCompatible?.capita ??
                1
              ) || 0
            : 0;

        const item =
          transformar(
            r,
            {
              programa:
                Array.from(
                  progs
                ).join(", "),

              estado,

              campanas:
                camps,

              nota:
                notaByDni[dni] ??
                null,

              admitido:
                esAdmitido,
            },

            {
              enmascarar,
            }
          );

        item.dni =
          dni || null;

        item.idCandidato =
          r.Candidato__c ||
          null;

        item.cohorteOriginal =
          r.Cuando_Ingresarias__c ||
          null;

        item.cohorte =
          cohorteLead ||
          item.cohorte ||
          null;

        item.idContacto =
          contactInfo?.id ||
          null;

        item.capita =
          capita;

        if (
          appCompatible
        ) {
          item.idApplication =
            appCompatible.idApplication;

          item.terminoAdmitido =
            appCompatible.termino;

          item.terminoAdmitidoOriginal =
            appCompatible.terminoOriginal;

          item.matchTermino =
            tipoMatchTermino(
              cohorteLead,
              appCompatible.termino
            );
        } else {
          item.idApplication =
            null;

          item.terminoAdmitido =
            null;

          item.terminoAdmitidoOriginal =
            null;

          item.matchTermino =
            "sin_application";
        }

        return item;
      }
    );

  const embudoGlobal =
    contarEmbudo(
      leads
    );

  // ----------------------------------------------------------
  // Diagnóstico del match
  // ----------------------------------------------------------

  const leadDniSet =
    new Set(
      records
        .map(
          (r) =>
            limpiarDni(
              r.N_mero_de_documento__c
            )
        )
        .filter(
          esDniValido
        )
    );

  const admitidosConLead =
    appsAdmitidas.filter(
      (app) =>
        (
          app.dni &&
          leadDniSet.has(
            app.dni
          )
        ) ||

        (
          app.idContacto &&
          contactRecs.some(
            (c) =>
              c.Id ===
              app.idContacto
          )
        )
    );

  const admitidosSinLead =
    appsAdmitidas.filter(
      (app) =>
        !admitidosConLead.some(
          (x) =>
            x.idApplication ===
            app.idApplication
        )
    );

  const capitasAdmitidos =
    appsAdmitidas.reduce(
      (sum, a) =>
        sum +
        (
          Number(
            a.capita
          ) || 0
        ),
      0
    );

  const capitasConLead =
    admitidosConLead.reduce(
      (sum, a) =>
        sum +
        (
          Number(
            a.capita
          ) || 0
        ),
      0
    );

  return {
    cargadoEn:
      new Date().toISOString(),

    duracionMs:
      Date.now() - t0,

    desde,

    todosLosAsesores:
      !!opts.todosLosAsesores,

    piiEnmascarada:
      enmascarar,

    leads,

    // NUEVO:
    // universo independiente de
    // Applications admitidas.

    admitidosSalesforce:
      appsAdmitidas,

    embudoGlobal,

    tasasGlobales:
      tasas(
        embudoGlobal
      ),

    porCohorte:
      agregarPorCohorte(
        leads
      ),

    diagnostico: {
      totalRegistros:
        records.length,

      conDniValido:
        dnis.length,

      sinDniValido:
        records.length -
        dnis.length,

      contactosEncontrados:
        contactRecs.length,

      admitidosSalesforce:
        appsAdmitidas.length,

      capitasAdmitidosSalesforce:
        +capitasAdmitidos.toFixed(2),

      admitidosConLead:
        admitidosConLead.length,

      capitasAdmitidosConLead:
        +capitasConLead.toFixed(2),

      admitidosSinLead:
        admitidosSinLead.length,

      capitasAdmitidosSinLead:
        +(
          capitasAdmitidos -
          capitasConLead
        ).toFixed(2),

      admitidosDetectadosEnLeads:
        leads.filter(
          (l) =>
            l.admitido
        ).length,

      feedbacksConNota:
        Object.keys(
          notaByDni
        ).length,
    },

    campanasDescartadas:
      Array.from(
        campanasDescartadas
      ).sort(),
  };
}

// ------------------------------------------------------------
// Consulta estructurada de Applications admitidas
// ------------------------------------------------------------

export async function buscarAdmitidos(
  opts = {}
) {
  const creds =
    await autenticar();

  const sf =
    crearCliente(creds);

  let whereClauses = [
    `
      (
        hed__Application_Status__c LIKE '%Admi%'
        OR
        hed__Application_Status__c LIKE '%Admit%'
      )
    `,
  ];

  if (
    opts.termino ||
    opts.term
  ) {
    const input =
      opts.termino ||
      opts.term;

    const info =
      terminoInfo(input);

    if (
      info.ano &&
      info.semestre
    ) {
      // Buscamos por las representaciones
      // conocidas:
      //
      // AnoLectivo + variantes del Term.

      whereClauses.push(
        `
          (
            AnoLectivo__c = ${Number(
              info.ano
            )}

            OR
            hed__Term__r.Name LIKE '${info.ano}SEM%'

            OR
            hed__Term__r.Name LIKE '${info.ano} SEM%'

            OR
            hed__Term__r.Name LIKE '${info.ano}S%'
          )
        `
      );
    } else if (
      info.ano
    ) {
      whereClauses.push(
        `AnoLectivo__c = ${Number(
          info.ano
        )}`
      );
    }
  } else if (
    opts.ano
  ) {
    const anoNum =
      Number(opts.ano);

    if (
      Number.isFinite(
        anoNum
      )
    ) {
      whereClauses.push(
        `AnoLectivo__c = ${anoNum}`
      );
    }
  }

  if (
    opts.nombre
  ) {
    const nombreLimpio =
      String(
        opts.nombre
      ).replace(
        /'/g,
        "\\'"
      );

    whereClauses.push(
      `
        hed__Applicant__r.Name
        LIKE '%${nombreLimpio}%'
      `
    );
  }

  if (
    opts.capita_min !==
    undefined &&
    opts.capita_min !==
    null
  ) {
    whereClauses.push(
      `Capita__c >= ${Number(
        opts.capita_min
      )}`
    );
  }

  if (
    opts.capita_max !==
    undefined &&
    opts.capita_max !==
    null
  ) {
    whereClauses.push(
      `Capita__c <= ${Number(
        opts.capita_max
      )}`
    );
  }

  whereClauses.push(
    `
      (
        NOT hed__Term__r.Name
        LIKE '%Posgrado%'
      )
    `
  );

  whereClauses.push(
    `
      (
        NOT hed__Term__r.Name
        LIKE '%Maestría%'
      )
    `
  );

  whereClauses.push(
    `
      (
        NOT hed__Term__r.Name
        LIKE '%Executive%'
      )
    `
  );

  whereClauses.push(
    `
      (
        NOT hed__Term__r.Name
        LIKE '%Septiembre%'
      )
    `
  );

  const limite =
    Math.min(
      opts.limite || 200,
      500
    );

  const offset =
    Math.max(
      opts.offset || 0,
      0
    );

  const query = `
    SELECT
      Id,
      Name,
      hed__Applicant__c,
      hed__Applicant__r.Name,
      hed__Applicant__r.Numero_de_documento__c,
      hed__Application_Status__c,
      hed__Application_Date__c,
      AnoLectivo__c,
      Capita__c,
      hed__Term__r.Name,
      OwnerId

    FROM hed__Application__c

    WHERE
      ${whereClauses.join(
        " AND "
      )}

    ORDER BY CreatedDate DESC

    LIMIT ${limite}

    OFFSET ${offset}
  `;

  const data =
    await sf.query(
      query
    );

  const records =
    data.records || [];

  const admitidos =
    records.map(
      (r) => ({
        idApplication:
          r.Id,

        numeroSolicitud:
          r.Name,

        idContacto:
          r.hed__Applicant__c,

        dni:
          limpiarDni(
            r
              .hed__Applicant__r
              ?.Numero_de_documento__c
          ) || null,

        nombreAlumno:
          r
            .hed__Applicant__r
            ?.
              Name ||
          "Sin Nombre",

        estado:
          r.hed__Application_Status__c,

        fechaSolicitud:
          r.hed__Application_Date__c,

        anoLectivo:
          r.AnoLectivo__c ??
          null,

        capita:
          Number(
            r.Capita__c ?? 0
          ) || 0,

        terminoOriginal:
          r.hed__Term__r
            ?.Name ||
          null,

        termino:
          normalizarTermino(
            r.hed__Term__r
              ?.Name ||
            r.AnoLectivo__c
          ),
      })
    );

  const totalCapitas =
    admitidos.reduce(
      (acc, r) =>
        acc +
        (
          Number(
            r.capita
          ) || 0
        ),
      0
    );

  return {
    totalAdmitidos:
      admitidos.length,

    totalCapitas:
      +totalCapitas.toFixed(2),

    offset,

    limite,

    admitidos,
  };
}

// ------------------------------------------------------------
// Resumen REAL de admitidos + match contra leads
// ------------------------------------------------------------

export function resumirAdmitidosCapitas(
  opts = {},
  sesionActiva = null
) {
  if (!sesionActiva) {
    throw new Error(
      "No hay una sesión activa del funnel cargada en memoria."
    );
  }

  const termInput =
    opts.termino ||
    opts.term ||
    null;

  const anoInput =
    opts.ano ||
    opts.year ||
    null;

  const terminoBuscado =
    termInput
      ? normalizarTermino(
          termInput
        )
      : null;

  const anoBuscado =
    anoInput
      ? String(
          anoInput
        ).trim()
      : null;

  const apps =
    Array.isArray(
      sesionActiva
        .admitidosSalesforce
    )
      ? sesionActiva
          .admitidosSalesforce
      : [];

  let admitidos =
    apps;

  // ----------------------------------------------------------
  // Filtrado correcto sobre Applications,
  // no sobre leads.
  // ----------------------------------------------------------

  if (
    terminoBuscado
  ) {
    admitidos =
      admitidos.filter(
        (a) =>
          terminosCompatibles(
            terminoBuscado,
            a.termino
          )
      );
  } else if (
    anoBuscado
  ) {
    admitidos =
      admitidos.filter(
        (a) =>
          terminoInfo(
            a.termino
          ).ano ===
          anoBuscado
      );
  }

  // ----------------------------------------------------------
  // Leads que se usarán para el matching
  // ----------------------------------------------------------

  let leads =
    Array.isArray(
      sesionActiva.leads
    )
      ? sesionActiva.leads
      : [];

  if (
    terminoBuscado
  ) {
    leads =
      leads.filter(
        (l) =>
          terminosCompatibles(
            terminoBuscado,
            l.cohorte ||
            l.cuandoIngresaria ||
            l.termino
          )
      );
  } else if (
    anoBuscado
  ) {
    leads =
      leads.filter(
        (l) =>
          terminoInfo(
            l.cohorte ||
            l.cuandoIngresaria ||
            l.termino
          ).ano ===
          anoBuscado
      );
  }

  // ----------------------------------------------------------
  // Índices de leads
  // ----------------------------------------------------------

  const leadsByDni =
    new Map();

  const leadsByContact =
    new Map();

  for (
    const lead
    of leads
  ) {
    const dni =
      limpiarDni(
        lead.dni
      );

    if (dni) {
      if (
        !leadsByDni.has(
          dni
        )
      ) {
        leadsByDni.set(
          dni,
          []
        );
      }

      leadsByDni
        .get(dni)
        .push(lead);
    }

    if (
      lead.idContacto
    ) {
      if (
        !leadsByContact.has(
          lead.idContacto
        )
      ) {
        leadsByContact.set(
          lead.idContacto,
          []
        );
      }

      leadsByContact
        .get(
          lead.idContacto
        )
        .push(lead);
    }
  }

  // ----------------------------------------------------------
  // Match
  // ----------------------------------------------------------

  const resultado =
    admitidos.map(
      (app) => {
        let lead = null;

        let metodoMatch =
          "sin_match";

        let matchTermino =
          "sin_match";

        let confianza =
          "sin_match";

        const candidatos = [
          ...(app.dni
            ? leadsByDni.get(
                app.dni
              ) || []
            : []),

          ...(app.idContacto
            ? leadsByContact.get(
                app.idContacto
              ) || []
            : []),
        ];

        // Evitar duplicados.
        const candidatosUnicos =
          [
            ...new Map(
              candidatos.map(
                (l) => [
                  l.idCandidato ||
                  l.id ||
                  `${l.dni}|${l.createdDate}`,
                  l,
                ]
              )
            ).values(),
          ];

        // Primero preferimos un match
        // cuyo término sea compatible.

        const compatible =
          candidatosUnicos.find(
            (l) =>
              terminosCompatibles(
                app.termino,

                l.cohorte ||
                l.cuandoIngresaria ||
                l.termino
              )
          );

        if (
          compatible
        ) {
          lead =
            compatible;
        } else if (
          candidatosUnicos.length
        ) {
          // Hay una persona coincidente,
          // pero el término no coincide.

          lead =
            candidatosUnicos[0];
        }

        if (lead) {
          const dniLead =
            limpiarDni(
              lead.dni
            );

          if (
            app.dni &&
            dniLead &&
            app.dni ===
              dniLead
          ) {
            metodoMatch =
              "dni";
          } else if (
            app.idContacto &&
            lead.idContacto &&
            app.idContacto ===
              lead.idContacto
          ) {
            metodoMatch =
              "contactId";
          } else {
            metodoMatch =
              "persona";
          }

          matchTermino =
            tipoMatchTermino(
              app.termino,

              lead.cohorte ||
              lead.cuandoIngresaria ||
              lead.termino
            );

          if (
            metodoMatch ===
              "dni" &&
            matchTermino ===
              "termino_normalizado"
          ) {
            confianza =
              "alta";
          } else if (
            matchTermino !==
            "sin_match"
          ) {
            confianza =
              "media";
          } else {
            confianza =
              "baja";
          }
        }

        return {
          ...app,

          tieneLead:
            !!lead,

          idCandidato:
            lead?.idCandidato ||
            null,

          leadNombre:
            lead?.nombre ||
            null,

          leadCohorteOriginal:
            lead?.cohorteOriginal ||
            lead?.cuandoIngresaria ||
            lead?.cohorte ||
            null,

          metodoMatch,

          matchTermino,

          confianza,
        };
      }
    );

  // ----------------------------------------------------------
  // Totales
  // ----------------------------------------------------------

  const totalAdmitidos =
    resultado.length;

  const totalCapitas =
    resultado.reduce(
      (sum, a) =>
        sum +
        (
          Number(
            a.capita
          ) || 0
        ),
      0
    );

  const conLead =
    resultado.filter(
      (a) =>
        a.tieneLead
    );

  const sinLead =
    resultado.filter(
      (a) =>
        !a.tieneLead
    );

  const capitasConLead =
    conLead.reduce(
      (sum, a) =>
        sum +
        (
          Number(
            a.capita
          ) || 0
        ),
      0
    );

  const capitasSinLead =
    sinLead.reduce(
      (sum, a) =>
        sum +
        (
          Number(
            a.capita
          ) || 0
        ),
      0
    );

  // ----------------------------------------------------------
  // Desglose por término
  // ----------------------------------------------------------

  const desgloseMap =
    {};

  for (
    const a
    of resultado
  ) {
    const coh =
      normalizarTermino(
        a.termino
      ) ||
      "SIN_TERMINO";

    if (
      !desgloseMap[coh]
    ) {
      desgloseMap[coh] = {
        totalAdmitidos:
          0,

        totalCapitas:
          0,
      };
    }

    desgloseMap[coh]
      .totalAdmitidos++;

    desgloseMap[coh]
      .totalCapitas +=
        Number(
          a.capita
        ) || 0;
  }

  const desglosePorTermino =
    Object.entries(
      desgloseMap
    )
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
      .map(
        ([
          termino,
          data,
        ]) => ({
          termino,

          totalAdmitidos:
            data.totalAdmitidos,

          totalCapitas:
            +data.totalCapitas.toFixed(
              2
            ),
        })
      );

  // ----------------------------------------------------------
  // Diagnóstico de tipos de match
  // ----------------------------------------------------------

  const tiposMatch = {
    dni:
      resultado.filter(
        (a) =>
          a.metodoMatch ===
          "dni"
      ).length,

    contactId:
      resultado.filter(
        (a) =>
          a.metodoMatch ===
          "contactId"
      ).length,

    persona:
      resultado.filter(
        (a) =>
          a.metodoMatch ===
          "persona"
      ).length,

    sinMatch:
      resultado.filter(
        (a) =>
          !a.tieneLead
      ).length,
  };

  const terminosMatch = {
    exacto:
      resultado.filter(
        (a) =>
          a.matchTermino ===
          "termino_normalizado"
      ).length,

    anoGenerico:
      resultado.filter(
        (a) =>
          a.matchTermino ===
          "anio_generico"
      ).length,

    distinto:
      resultado.filter(
        (a) =>
          a.tieneLead &&
          a.matchTermino ===
            "sin_match"
      ).length,
  };

  return {
    filtroAplicado:
      terminoBuscado
        ? `Término ${terminoBuscado}`
        : anoBuscado
          ? `Año ${anoBuscado}`
          : "Todos",

    totalAdmitidos,

    totalCapitas:
      +totalCapitas.toFixed(
        2
      ),

    matching: {
      admitidosConLead:
        conLead.length,

      admitidosSinLead:
        sinLead.length,

      capitasConLead:
        +capitasConLead.toFixed(
          2
        ),

      capitasSinLead:
        +capitasSinLead.toFixed(
          2
        ),

      porcentajeAdmitidosConLead:
        totalAdmitidos
          ? +(
              100 *
              conLead.length /
              totalAdmitidos
            ).toFixed(1)
          : 0,

      porcentajeCapitasConLead:
        totalCapitas
          ? +(
              100 *
              capitasConLead /
              totalCapitas
            ).toFixed(1)
          : 0,

      tiposMatch,

      terminosMatch,
    },

    desglosePorTermino,

    // Los devolvemos para poder auditar
    // los casos problemáticos.

    admitidos:
      resultado,
  };
}
