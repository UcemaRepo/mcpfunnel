// ============================================================
// server.js — LeadFunnel MCP sobre Render
// ============================================================
// v3: sin score de completitud. El foco es el embudo de admisión
// (leads → contactados → qualified → admitidos) y la comparación
// entre cohortes.
//
// La sesión vive en RAM. Cuando Render apaga el servicio por
// inactividad, el proceso muere y los datos se van con él.
// ============================================================

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { cargarLeads, buscarAdmitidos } from "./salesforce.js";
import {
  contarEmbudo, tasas, agregarPor, coincideEstado, normalizar, canonSemestre,
} from "./transform.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Estado en RAM ───────────────────────────────────────────
let sesion = null;

// ── Auth ────────────────────────────────────────────────────
// La UI de conectores de Claude no permite headers arbitrarios,
// así que el token también viaja por query (?k=...).
function auth(req, res, next) {
  const esperado = process.env.MCP_TOKEN;
  const recibido =
    req.query.k ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!esperado || recibido !== esperado) return res.status(404).end();
  next();
}

// ============================================================
// CONTROL
// ============================================================

app.post("/cargar", auth, async (req, res) => {
  try {
    sesion = await cargarLeads({
      desde: req.body?.desde,
      todosLosAsesores: req.body?.todosLosAsesores === true,
    });
    res.json({
      ok: true,
      mensaje: `Sesión cargada: ${sesion.leads.length} leads.`,
      duracionMs: sesion.duracionMs,
      desde: sesion.desde,
      todosLosAsesores: sesion.todosLosAsesores,
      embudo: sesion.embudoGlobal,
      tasas: sesion.tasasGlobales,
      cohortes: Object.keys(sesion.porCohorte).sort(),
      diagnostico: sesion.diagnostico,
    });
  } catch (err) {
    console.error("Error en /cargar:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/purgar", auth, (req, res) => {
  const total = sesion?.leads.length ?? 0;
  sesion = null;
  if (global.gc) global.gc();
  res.json({ ok: true, mensaje: "Sesión purgada.", leadsDescartados: total });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sesionActiva: !!sesion,
    leads: sesion?.leads.length ?? 0,
    uptimeSeg: Math.round(process.uptime()),
  });
});

// ============================================================
// MCP
// ============================================================

const sinSesion = () => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      error: "No hay sesión cargada en memoria.",
      accion: "Ejecutar POST /cargar. Si el servicio estuvo inactivo, Render lo apagó y la sesión se perdió.",
    }, null, 2),
  }],
});

const texto = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

// Filtro común a varias herramientas
function filtrar(leads, a = {}) {
  const n = (s) => normalizar(s || "");
  let res = leads;
  if (a.cohorte)  res = res.filter(l => l.cohorte === canonSemestre(a.cohorte));
  if (a.asesor)   res = res.filter(l => n(l.asesor).includes(n(a.asesor)));
  if (a.programa) res = res.filter(l => n(l.programa).includes(n(a.programa)));
  if (a.colegio)  res = res.filter(l => n(l.colegio).includes(n(a.colegio)));
  if (a.origen)   res = res.filter(l => n(l.origen).includes(n(a.origen)));
  if (a.estado)   res = res.filter(l => coincideEstado(l.estado, a.estado));
  if (a.admitido === true)  res = res.filter(l => l.admitido);
  if (a.admitido === false) res = res.filter(l => !l.admitido);
  if (a.desde)    res = res.filter(l => l.createdDate >= a.desde);
  if (a.hasta)    res = res.filter(l => l.createdDate <= a.hasta + "T23:59:59Z");
  return res;
}

// Campos de filtro compartidos por varias herramientas
const filtrosBase = {
  cohorte:  z.string().optional().describe("Cohorte/semestre: 2026S1, 2027S1, 2026S2. También acepta '2027SEM 1'."),
  asesor:   z.string().optional().describe("Nombre o parte del nombre del asesor"),
  programa: z.string().optional().describe("Sigla o nombre del programa, ej. INIA, LIEM"),
  colegio:  z.string().optional().describe("Nombre o parte del nombre del colegio"),
  origen:   z.string().optional().describe("Origen: Unbounce, Consulta Web, Visitas de Colegios, Referido"),
  estado:   z.string().optional().describe("Estado exacto: Nuevo, Contactado, Qualified, Unqualified, Desiste, Negociando"),
  admitido: z.boolean().optional().describe("true = solo admitidos, false = solo no admitidos"),
  desde:    z.string().optional().describe("Fecha de creación mínima, YYYY-MM-DD"),
  hasta:    z.string().optional().describe("Fecha de creación máxima, YYYY-MM-DD"),
};

function crearServidorMcp() {
  const server = new McpServer({ name: "ucema-leadfunnel", version: "3.0.0" });

  // ── estado_sesion ─────────────────────────────────────────
  server.registerTool("estado_sesion", {
    title: "Estado de la sesión",
    description: "Indica si hay datos cargados en memoria, cuántos leads, qué cohortes están disponibles y el embudo global. Usar SIEMPRE primero si no se sabe si hay datos.",
    inputSchema: {},
  }, async () => {
    if (!sesion) return sinSesion();
    return texto({
      sesionActiva: true,
      cargadoEn: sesion.cargadoEn,
      desdeFecha: sesion.desde,
      totalLeads: sesion.leads.length,
      cohortesDisponibles: Object.keys(sesion.porCohorte).sort(),
      embudoGlobal: sesion.embudoGlobal,
      tasasGlobales: sesion.tasasGlobales,
      diagnostico: sesion.diagnostico,
      advertencias: [
        sesion.todosLosAsesores
          ? "Incluye todos los asesores."
          : "Filtrado por los 6 asesores ACTUALES: las cohortes viejas quedan subcontadas si hubo cambios de equipo. Recargar con todosLosAsesores:true para comparaciones históricas.",
        "El campo 'admitido' no tiene fecha de admisión: se agrupa por el mes en que entró el lead, no por cuándo fue admitido.",
      ],
    });
  });

  // ── embudo ────────────────────────────────────────────────
  server.registerTool("embudo", {
    title: "Embudo de admisión",
    description: "Conteos del embudo (leads, contactados, negociando, qualified, admitidos, desiste) y tasas de conversión. Se puede filtrar y desglosar por dimensión. Usar para preguntas sobre volumen y conversión.",
    inputSchema: {
      ...filtrosBase,
      agrupar_por: z.enum(["cohorte", "asesor", "programa", "origen", "estado", "colegio"])
        .optional().describe("Dimensión del desglose. Sin esto, devuelve solo el total del filtro."),
      top: z.number().min(1).max(40).optional().describe("Máximo de grupos a devolver, ordenados por admitidos. Default 20."),
    },
  }, async (args) => {
    if (!sesion) return sinSesion();
    const res = filtrar(sesion.leads, args);
    const total = contarEmbudo(res);
    const out = { filtroAplicado: args, total, tasas: tasas(total) };

    if (args.agrupar_por) {
      const grupos = agregarPor(res, args.agrupar_por);
      const top = args.top || 20;
      const ordenados = Object.entries(grupos)
        .sort((a, b) => b[1].admitidos - a[1].admitidos || b[1].leads - a[1].leads)
        .slice(0, top);
      out.desglose = Object.fromEntries(ordenados);
      if (Object.keys(grupos).length > top) {
        out.aviso = `Mostrando ${top} de ${Object.keys(grupos).length} grupos.`;
      }
    }
    return texto(out);
  });

  // ── curva_temporal ────────────────────────────────────────
  server.registerTool("curva_temporal", {
    title: "Curva mes a mes",
    description: "Evolución mensual de una o más cohortes: altas nuevas, acumulado, y admitidos. Permite alinear las cohortes por mes de campaña (mes 1 = primer mes con leads de esa cohorte) para compararlas al mismo punto del ciclo.",
    inputSchema: {
      cohortes: z.array(z.string()).optional()
        .describe("Cohortes a incluir, ej. ['2026S1','2027S1']. Sin esto, todas."),
      alinear: z.boolean().optional()
        .describe("true = alinea por mes de campaña en vez de mes calendario. Recomendado para comparar ciclos."),
      asesor: z.string().optional(),
      origen: z.string().optional(),
    },
  }, async (args) => {
    if (!sesion) return sinSesion();

    const cohortes = args.cohortes?.length
      ? args.cohortes.map(canonSemestre)
      : Object.keys(sesion.porCohorte);

    const out = {};
    for (const c of cohortes) {
      const ls = filtrar(sesion.leads, {
        cohorte: c, asesor: args.asesor, origen: args.origen,
      });
      if (!ls.length) { out[c] = { error: "Sin datos para este filtro." }; continue; }

      const porMes = {};
      for (const l of ls) {
        if (!l.mes) continue;
        if (!porMes[l.mes]) porMes[l.mes] = { nuevos: 0, admitidos: 0 };
        porMes[l.mes].nuevos++;
        if (l.admitido) porMes[l.mes].admitidos++;
      }

      const meses = Object.keys(porMes).sort();
      let acum = 0, acumAdm = 0;
      const curva = meses.map((m, i) => {
        acum += porMes[m].nuevos;
        acumAdm += porMes[m].admitidos;
        return {
          ...(args.alinear ? { mesCampana: i + 1, mesCalendario: m } : { mes: m }),
          nuevos: porMes[m].nuevos,
          acumulado: acum,
          admitidos: porMes[m].admitidos,
          admitidosAcum: acumAdm,
        };
      });

      out[c] = { totalLeads: ls.length, mesesConActividad: meses.length, curva };
    }

    return texto({
      alineado: !!args.alinear,
      nota: args.alinear
        ? "mesCampana 1 = primer mes con leads de esa cohorte. Comparar filas del mismo mesCampana."
        : "Meses calendario. Cohortes distintas arrancan en meses distintos: para comparar ciclos, usar alinear:true.",
      advertencia: "Los admitidos se ubican en el mes en que ENTRÓ el lead, no en el mes en que fue admitido. Una cohorte reciente tiene menos tiempo transcurrido para admitir.",
      cohortes: out,
    });
  });

// server.js — Agregás este bloque dentro de crearServidorMcp()

  server.registerTool(
    "buscar_admitidos",
    {
      title: "Buscar admitidos y cápitas de Grado",
      description: "Consulta directamente en hed__Application__c los postulantes admitidos con su valor de cápita. No depende de la sesión de leads en RAM.",
      inputSchema: {
        ano: z.number().optional().describe("Año lectivo a consultar, ej: 2026"),
        limite: z.number().min(1).max(200).optional().describe("Default: 200"),
      },
    },
    async (args) => {
      try {
        const res = await buscarAdmitidos({
          ano: args.ano,
          limite: args.limite,
        });

        if (res.totalAdmitidos === 0) {
          return texto({
            alerta: "POSIBLE_DESFASAJE_DE_DATOS",
            mensaje: `La consulta devolvió 0 admitidos en hed__Application__c para el año ${args.ano || 'seleccionado'}. Verifique filtros o tagging.`,
            totalAdmitidos: 0,
            totalCapitas: 0,
          });
        }

        return texto({
          totalAdmitidos: res.totalAdmitidos,
          totalCapitas: res.totalCapitas,
          admitidos: res.registros,
        });
      } catch (err) {
        console.error("Error al consultar admitidos:", err.message);
        return texto({
          error: "ERROR_CONSULTA_SALESFORCE",
          detalle: err.message,
        });
      }
    }
  );
  
  // ── comparar_cohortes ─────────────────────────────────────
  server.registerTool("comparar_cohortes", {
    title: "Comparar dos cohortes",
    description: "Compara dos cohortes lado a lado, opcionalmente recortando ambas al mismo mes de campaña para que la comparación sea justa. Devuelve variaciones porcentuales.",
    inputSchema: {
      cohorte_a: z.string().describe("Cohorte base, ej. 2026S1"),
      cohorte_b: z.string().describe("Cohorte a comparar, ej. 2027S1"),
      hasta_mes_campana: z.number().min(1).max(36).optional()
        .describe("Recorta ambas cohortes a sus primeros N meses de campaña. Muy recomendado: sin esto se compara un ciclo terminado contra uno en curso."),
      asesor: z.string().optional(),
      origen: z.string().optional(),
    },
  }, async (args) => {
    if (!sesion) return sinSesion();

    const recortar = (cohorte) => {
      let ls = filtrar(sesion.leads, {
        cohorte, asesor: args.asesor, origen: args.origen,
      });
      if (!ls.length) return { ls: [], meses: [] };

      const meses = [...new Set(ls.map(l => l.mes).filter(Boolean))].sort();
      if (args.hasta_mes_campana) {
        const permitidos = new Set(meses.slice(0, args.hasta_mes_campana));
        ls = ls.filter(l => permitidos.has(l.mes));
      }
      return { ls, meses };
    };

    const A = recortar(canonSemestre(args.cohorte_a));
    const B = recortar(canonSemestre(args.cohorte_b));

    if (!A.ls.length || !B.ls.length) {
      return texto({
        error: "Una de las cohortes no tiene datos.",
        cohortesDisponibles: Object.keys(sesion.porCohorte).sort(),
      });
    }

    const eA = contarEmbudo(A.ls);
    const eB = contarEmbudo(B.ls);

    const variacion = {};
    for (const k of Object.keys(eA)) {
      variacion[k] = eA[k]
        ? { a: eA[k], b: eB[k], deltaAbs: eB[k] - eA[k], deltaPct: +(100 * (eB[k] - eA[k]) / eA[k]).toFixed(1) }
        : { a: eA[k], b: eB[k], deltaAbs: eB[k], deltaPct: null };
    }

    return texto({
      cohorteA: canonSemestre(args.cohorte_a),
      cohorteB: canonSemestre(args.cohorte_b),
      recorte: args.hasta_mes_campana
        ? `Ambas cohortes recortadas a sus primeros ${args.hasta_mes_campana} meses de campaña.`
        : "SIN RECORTE — se compara un ciclo posiblemente completo contra uno en curso. Los números no son comparables directamente.",
      mesesDisponibles: { a: A.meses.length, b: B.meses.length },
      embudoA: { ...eA, tasas: tasas(eA) },
      embudoB: { ...eB, tasas: tasas(eB) },
      variacion,
      advertencias: [
        "Si el equipo de asesores cambió entre ciclos y la sesión se cargó con el filtro de owners actual, la cohorte vieja está subcontada.",
        "Los admitidos de la cohorte en curso van a seguir subiendo: no es un total final.",
      ],
    });
  });

  // ── buscar_leads ──────────────────────────────────────────
  server.registerTool("buscar_leads", {
    title: "Buscar leads",
    description: "Devuelve hasta 50 leads individuales filtrados. Usar para casos concretos, no para panoramas — para volúmenes usar 'embudo'.",
    inputSchema: {
      ...filtrosBase,
      orden: z.enum(["reciente", "antiguo"]).optional().describe("Default: reciente"),
      limite: z.number().min(1).max(50).optional().describe("Tope 50. Default 20."),
    },
  }, async (args) => {
    if (!sesion) return sinSesion();
    let res = filtrar(sesion.leads, args);

    res = [...res].sort((a, b) =>
      args.orden === "antiguo"
        ? a.createdDate.localeCompare(b.createdDate)
        : b.createdDate.localeCompare(a.createdDate));

    const limite = args.limite || 20;
    const total = res.length;

    return texto({
      coincidencias: total,
      mostrando: Math.min(total, limite),
      embudoDelFiltro: contarEmbudo(res),
      leads: res.slice(0, limite),
      ...(total > limite && { aviso: `Hay ${total} coincidencias. Afiná los filtros.` }),
    });
  });

  return server;
}

// ── Transporte MCP stateless ────────────────────────────────
app.post("/mcp", auth, async (req, res) => {
  try {
    const server = crearServidorMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error MCP:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Error interno" },
        id: null,
      });
    }
  }
});

app.get("/mcp", auth, (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Servidor stateless: solo POST" },
    id: null,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LeadFunnel MCP v3 escuchando en :${PORT}`);
  if (!process.env.MCP_TOKEN) {
    console.warn("⚠️  MCP_TOKEN no definido — todo va a devolver 404.");
  }
});
