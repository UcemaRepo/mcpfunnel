// ============================================================
// mcp.js — capa MCP sobre la API REST existente
// ============================================================
//
// Las herramientas NO reimplementan logica: llaman a los mismos
// endpoints que ya usas. Si manana cambias /admitidos, la
// herramienta sigue el cambio sola.
//
// Se monta desde server.js con montarMcp(app, auth).
// ============================================================

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ------------------------------------------------------------
// Cliente interno
// ------------------------------------------------------------
// Llama al propio servidor por loopback. El token va en el
// header porque auth() lo acepta de las dos formas.
// ------------------------------------------------------------

async function llamar(ruta, params = {}) {
  const puerto = process.env.PORT || 3000;

  const url = new URL(
    ruta,
    `http://127.0.0.1:${puerto}`
  );

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.MCP_TOKEN}`,
    },
  });

  const texto = await res.text();

  try {
    return JSON.parse(texto);
  } catch {
    return {
      error: `Respuesta no-JSON de ${ruta}`,
      status: res.status,
      cuerpo: texto.slice(0, 500),
    };
  }
}

const salida = (obj) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(obj, null, 2),
    },
  ],
});

// Filtros de cohorte compartidos
const filtroCohorte = {
  termino: z
    .string()
    .optional()
    .describe(
      "Cohorte: '2027S1', '2027SEM1' o '2026S2'. Es el filtro preferido."
    ),

  ano: z
    .string()
    .optional()
    .describe(
      "Año de ingreso, ej. '2027'. Menos preciso que termino: incluye ambos semestres."
    ),
};

// ------------------------------------------------------------
// Servidor MCP
// ------------------------------------------------------------

function crearServidor() {
  const server = new McpServer({
    name: "ucema-funnel",
    version: "4.0.0",
  });

  // ── estado_sesion ─────────────────────────────────────────
  server.registerTool(
    "estado_sesion",
    {
      title: "Estado de la sesión",
      description:
        "Indica si hay datos de Salesforce cargados en memoria, cuántos leads y admitidos hay, y cuándo se cargaron. Usar SIEMPRE primero si no se sabe si hay datos disponibles.",
      inputSchema: {},
    },
    async () => salida(await llamar("/estado"))
  );

  // ── cohortes ──────────────────────────────────────────────
  server.registerTool(
    "cohortes",
    {
      title: "Cohortes disponibles",
      description:
        "Lista las cohortes (año + semestre) presentes en los datos cargados, con sus volúmenes. Usar para saber qué períodos se pueden consultar antes de filtrar por uno.",
      inputSchema: {},
    },
    async () => salida(await llamar("/cohortes"))
  );

  // ── admitidos ─────────────────────────────────────────────
  server.registerTool(
    "admitidos",
    {
      title: "Admitidos y cápitas",
      description:
        "Cantidad de admitidos y suma de cápitas, filtrable por cohorte. La cápita es fraccionaria: refleja el arancel neto tras la beca (0,70 = beca del 30%). Usar para preguntas de volumen de admisiones.",
      inputSchema: {
        ...filtroCohorte,

        capita_min: z
          .string()
          .optional()
          .describe("Cápita mínima, ej. '0.5'"),

        capita_max: z
          .string()
          .optional()
          .describe("Cápita máxima, ej. '1'"),

        nombre: z
          .string()
          .optional()
          .describe("Filtra por nombre o parte del nombre del alumno"),

        incluirDetalle: z
          .boolean()
          .optional()
          .describe(
            "true devuelve también los registros individuales. Default false."
          ),
      },
    },
    async (a) =>
      salida(
        await llamar("/admitidos", {
          ...a,
          incluirDetalle: a.incluirDetalle ? "true" : "false",
        })
      )
  );

  // ── admitidos_lista ───────────────────────────────────────
  server.registerTool(
    "admitidos_lista",
    {
      title: "Listado de admitidos",
      description:
        "Devuelve los admitidos individuales de una cohorte, con nombre, estado, cápita y beca. Usar para casos concretos, no para totales — para eso está 'admitidos'.",
      inputSchema: filtroCohorte,
    },
    async (a) => salida(await llamar("/admitidos/lista", a))
  );

  // ── admitidos_salesforce ──────────────────────────────────
  server.registerTool(
    "admitidos_salesforce",
    {
      title: "Admitidos en vivo desde Salesforce",
      description:
        "Consulta admitidos directamente contra Salesforce, sin usar la sesión en memoria. Más lento, pero refleja el estado actual. Usar cuando importa que el dato esté al minuto o cuando no hay sesión cargada.",
      inputSchema: {
        ...filtroCohorte,

        nombre: z.string().optional(),
        capita_min: z.string().optional(),
        capita_max: z.string().optional(),

        limite: z
          .number()
          .min(1)
          .max(500)
          .optional()
          .describe("Máximo de registros. Default 200."),

        offset: z.number().min(0).optional(),
      },
    },
    async (a) => salida(await llamar("/admitidos/salesforce", a))
  );

  // ── embudo ────────────────────────────────────────────────
  server.registerTool(
    "embudo",
    {
      title: "Embudo de conversión",
      description:
        "Embudo completo de una cohorte: leads, contactados, convertidos y admitidos, con tasas de conversión entre etapas. Usar para preguntas sobre rendimiento del proceso, no sobre volúmenes sueltos.",
      inputSchema: filtroCohorte,
    },
    async (a) => salida(await llamar("/funnel", a))
  );

  // ── resumen ───────────────────────────────────────────────
  server.registerTool(
    "resumen",
    {
      title: "Resumen general",
      description:
        "Panorama agregado de los datos cargados. Usar como punto de partida cuando la pregunta es amplia y todavía no se sabe qué cortar.",
      inputSchema: {},
    },
    async () => salida(await llamar("/resumen"))
  );

  // ── buscar_leads ──────────────────────────────────────────
  server.registerTool(
    "buscar_leads",
    {
      title: "Buscar leads",
      description:
        "Leads filtrados por cohorte, programa o estado. Usar para casos concretos; para volúmenes usar 'embudo'.",
      inputSchema: {
        ...filtroCohorte,

        programa: z
          .string()
          .optional()
          .describe("Sigla o nombre del programa, ej. INIA, LIEM"),

        estado: z
          .string()
          .optional()
          .describe(
            "Estado del candidato: Nuevo, Contactado, Qualified, Desiste"
          ),
      },
    },
    async (a) => salida(await llamar("/leads", a))
  );

  return server;
}

// ------------------------------------------------------------
// Montaje
// ------------------------------------------------------------
// Modo stateless: un servidor y un transporte por request.
// Evita estado de sesión MCP, que en un servicio que Render
// apaga solo sería una fuente de errores.
// ------------------------------------------------------------

export function montarMcp(app, auth) {
  app.post("/mcp", auth, async (req, res) => {
    try {
      const server = crearServidor();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
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
      error: {
        code: -32000,
        message: "Servidor stateless: solo POST",
      },
      id: null,
    });
  });
}
