// ============================================================
// server.js — LeadFunnel MCP sobre Render
// ============================================================
// La sesión vive en RAM del proceso. No hay base, no hay disco,
// no hay cache. Cuando Render apaga el servicio por inactividad
// (~15 min en free tier), el proceso muere y los datos se van
// con él. Esa es la garantía de efimeridad.
// ============================================================

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { cargarLeads } from "./salesforce.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ============================================================
// ESTADO EN RAM — la única "base de datos" que hay
// ============================================================
let sesion = null;

// ── Auth ────────────────────────────────────────────────────
// La UI de conectores de Claude no permite headers arbitrarios,
// así que el token también se acepta por query param (?k=...).
// Ver README: es más débil que un header. OAuth es el paso siguiente.
function auth(req, res, next) {
  const esperado = process.env.MCP_TOKEN;
  const recibido =
    req.query.k ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (!esperado || recibido !== esperado) {
    // 404 y no 401: un 401 hace que Claude intente OAuth discovery
    return res.status(404).end();
  }
  next();
}

// ============================================================
// ENDPOINTS DE CONTROL
// ============================================================

// Abrir sesión: trae todo de Salesforce y lo deja en RAM
app.post("/cargar", auth, async (req, res) => {
  try {
    sesion = await cargarLeads({ desde: req.body?.desde });
    const a = sesion.agregados;
    res.json({
      ok: true,
      mensaje: `Sesión cargada: ${a.total} leads.`,
      duracionMs: sesion.duracionMs,
      scorePromedio: a.scorePromedio,
      piiEnmascarada: sesion.piiEnmascarada,
      telefonosInvalidos: a.faltantesPorCampo.telefono || 0,
      telefonosMalFormateados: a.malFormateadosPorCampo.telefono || 0,
      emailsMalFormateados: a.malFormateadosPorCampo.email || 0,
      campanasDescartadas: sesion.campanasDescartadas.slice(0, 30),
    });
  } catch (err) {
    console.error("Error en /cargar:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Cerrar sesión: la RAM se libera
app.post("/purgar", auth, (req, res) => {
  const total = sesion?.leads.length ?? 0;
  sesion = null;
  if (global.gc) global.gc();
  res.json({ ok: true, mensaje: "Sesión purgada.", leadsDescartados: total });
});

// Health check — Render lo usa para saber si el servicio vive
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    sesionActiva: !!sesion,
    leads: sesion?.leads.length ?? 0,
    uptimeSeg: Math.round(process.uptime()),
  });
});

// Diagnóstico de formatos de teléfono, sin exponer números
app.post("/diagnostico", auth, (req, res) => {
  if (!sesion) return res.json({ error: "No hay sesión cargada." });
  const formas = {};
  for (const l of sesion.leads) {
    const clave = l.malFormateados.includes("telefono") ? "invalido"
      : l.faltantes.includes("telefono") ? "vacio" : "valido";
    formas[clave] = (formas[clave] || 0) + 1;
  }
  res.json({ telefonos: formas, total: sesion.leads.length });
});

// ============================================================
// SERVIDOR MCP
// ============================================================

const sinSesion = () => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      error: "No hay sesión cargada en memoria.",
      accion: "Ejecutar POST /cargar antes de consultar. Si el servicio estuvo inactivo, Render lo apagó y la sesión se perdió.",
    }, null, 2),
  }],
});

const texto = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

function crearServidorMcp() {
  const server = new McpServer({
    name: "ucema-leadfunnel",
    version: "2.0.0",
  });

  // ── estado_sesion ─────────────────────────────────────────
  server.registerTool(
    "estado_sesion",
    {
      title: "Estado de la sesión",
      description: "Indica si hay una sesión de datos cargada en memoria, cuántos leads tiene y cuándo se cargó. Usar SIEMPRE primero si no se sabe si hay datos disponibles.",
      inputSchema: {},
    },
    async () => {
      if (!sesion) return sinSesion();
      return texto({
        sesionActiva: true,
        cargadoEn: sesion.cargadoEn,
        totalLeads: sesion.leads.length,
        scorePromedio: sesion.agregados.scorePromedio,
        piiEnmascarada: sesion.piiEnmascarada,
        nota: "El score mide completitud y validez de formato de los campos, NO la calidad ni el potencial del lead. Un lead que desistió puede tener 100 si su ficha está bien cargada.",
      });
    }
  );

  // ── resumen_calidad ───────────────────────────────────────
  server.registerTool(
    "resumen_calidad",
    {
      title: "Resumen de calidad",
      description: "Estadísticas agregadas de completitud: score promedio, distribución, qué campos faltan más, y desglose por asesor, programa o estado. No devuelve leads individuales. Usar para preguntas de panorama general.",
      inputSchema: {
        agrupar_por: z.enum(["asesor", "programa", "estado", "todos"])
          .optional()
          .describe("Dimensión del desglose. Default: todos."),
      },
    },
    async ({ agrupar_por = "todos" }) => {
      if (!sesion) return sinSesion();
      const a = sesion.agregados;
      const out = {
        totalLeads: a.total,
        scorePromedio: a.scorePromedio,
        distribucionScore: a.distribucionScore,
        faltantesPorCampo: a.faltantesPorCampo,
        malFormateadosPorCampo: a.malFormateadosPorCampo,
        opcionalesNoPuntuables: a.opcionalesFaltantesPorCampo,
      };
      if (agrupar_por === "asesor"   || agrupar_por === "todos") out.porAsesor = a.porAsesor;
      if (agrupar_por === "programa" || agrupar_por === "todos") out.porPrograma = a.porPrograma;
      if (agrupar_por === "estado"   || agrupar_por === "todos") out.porEstado = a.porEstado;
      return texto(out);
    }
  );

  // ── buscar_leads ──────────────────────────────────────────
  server.registerTool(
    "buscar_leads",
    {
      title: "Buscar leads",
      description: "Devuelve hasta 50 leads individuales filtrados y ordenados. Usar para casos concretos, no para panoramas generales.",
      inputSchema: {
        asesor:   z.string().optional().describe("Nombre o parte del nombre del asesor"),
        programa: z.string().optional().describe("Sigla o nombre del programa, ej. INIA, LIEM"),
        estado:   z.string().optional().describe("Estado del candidato: Nuevo, Contactado, Qualified, Desiste"),
        colegio:  z.string().optional().describe("Nombre o parte del nombre del colegio"),
        falta_campo: z.enum(["telefono", "email", "programa", "semestre", "colegio"])
          .optional().describe("Solo leads a los que les falta este campo puntuable"),
        mal_formateado: z.enum(["telefono", "email"])
          .optional().describe("Solo leads con este campo cargado pero inválido"),
        score_min: z.number().min(0).max(100).optional(),
        score_max: z.number().min(0).max(100).optional(),
        desde: z.string().optional().describe("Fecha de creación mínima, YYYY-MM-DD"),
        orden: z.enum(["reciente", "antiguo", "score_desc", "score_asc"])
          .optional().describe("Criterio de orden. Default: reciente"),
        limite: z.number().min(1).max(50).optional().describe("Tope 50. Default 20."),
      },
    },
    async (args) => {
      if (!sesion) return sinSesion();
      const n = (s) => (s || "").toLowerCase();
      let res = sesion.leads;

      if (args.asesor)   res = res.filter(l => n(l.asesor).includes(n(args.asesor)));
      if (args.programa) res = res.filter(l => n(l.programa).includes(n(args.programa)));
      if (args.estado)   res = res.filter(l => n(l.estado).includes(n(args.estado)));
      if (args.colegio)  res = res.filter(l => n(l.colegio).includes(n(args.colegio)));
      if (args.falta_campo)    res = res.filter(l => l.faltantes.includes(args.falta_campo));
      if (args.mal_formateado) res = res.filter(l => l.malFormateados.includes(args.mal_formateado));
      if (args.score_min != null) res = res.filter(l => l.score >= args.score_min);
      if (args.score_max != null) res = res.filter(l => l.score <= args.score_max);
      if (args.desde) res = res.filter(l => l.createdDate >= args.desde);

      const orden = args.orden || "reciente";
      res = [...res].sort((a, b) => {
        if (orden === "score_desc") return b.score - a.score;
        if (orden === "score_asc")  return a.score - b.score;
        if (orden === "antiguo")    return a.createdDate.localeCompare(b.createdDate);
        return b.createdDate.localeCompare(a.createdDate);
      });

      const limite = args.limite || 20;
      const total = res.length;

      return texto({
        coincidencias: total,
        mostrando: Math.min(total, limite),
        orden,
        leads: res.slice(0, limite),
        ...(total > limite && {
          aviso: `Hay ${total} coincidencias. Afiná los filtros para ver otras.`,
        }),
      });
    }
  );

  // ── ranking_incompletos ───────────────────────────────────
  server.registerTool(
    "ranking_incompletos",
    {
      title: "Ranking de incompletos",
      description: "Los leads con peor completitud, de peor a mejor. Útil para priorizar qué fichas hay que completar primero.",
      inputSchema: {
        asesor: z.string().optional().describe("Opcional: limitar a un asesor"),
        limite: z.number().min(1).max(50).optional().describe("Tope 50. Default 20."),
      },
    },
    async ({ asesor, limite = 20 }) => {
      if (!sesion) return sinSesion();
      let res = sesion.leads;
      if (asesor) {
        const n = asesor.toLowerCase();
        res = res.filter(l => (l.asesor || "").toLowerCase().includes(n));
      }
      res = [...res].sort((a, b) => a.score - b.score);

      return texto({
        totalEvaluados: res.length,
        peores: res.slice(0, limite).map(l => ({
          nombre: `${l.nombre} ${l.apellido}`.trim(),
          sfId: l.sfId,
          asesor: l.asesor,
          programa: l.programa || "(sin programa)",
          estado: l.estado,
          score: l.score,
          faltantes: l.faltantes,
          malFormateados: l.malFormateados,
        })),
      });
    }
  );

  return server;
}

// ── Transporte MCP (modo stateless) ─────────────────────────
// Un servidor y un transporte nuevos por request. Evita el
// estado de sesión MCP, que en un servicio que se apaga solo
// sería una fuente de errores.
app.post("/mcp", auth, async (req, res) => {
  try {
    const server = crearServidorMcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,   // stateless
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

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

// GET y DELETE no aplican en modo stateless
app.get("/mcp", auth, (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Método no permitido: servidor stateless" },
    id: null,
  });
});

// ── Arranque ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LeadFunnel MCP escuchando en :${PORT}`);
  console.log(`PII enmascarada: ${process.env.ENMASCARAR_PII !== "false"}`);
  if (!process.env.MCP_TOKEN) {
    console.warn("⚠️  MCP_TOKEN no está definido — todos los requests van a dar 404.");
  }
});
