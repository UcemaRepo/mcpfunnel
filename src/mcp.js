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

async function llamar(ruta, params = {}, metodo = "GET", cuerpo = null) {
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
    method: metodo,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MCP_TOKEN}`,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
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
            "Estado exacto. Valores reales: 'Nuevo', 'Contactado', 'Contactado Sin respuesta', 'Contactado Interesado', 'Negociando', 'Qualified', 'Unqualified', 'Desiste'. Buscar 'Contactado' tambien trae sus variantes; 'Qualified' NO trae 'Unqualified'."
          ),

        limite: z
          .number()
          .min(1)
          .max(1000)
          .optional()
          .describe("Registros por pagina. Default 200, tope 1000."),

        offset: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Desde que registro arrancar. La respuesta trae 'siguienteOffset' para pedir la pagina siguiente."
          ),
      },
    },
    async (a) => salida(await llamar("/leads", a))
  );

  // ── agregados ─────────────────────────────────────────────
  server.registerTool(
    "agregados",
    {
      title: "Conteos agregados",
      description:
        "Devuelve conteos de leads agrupados por una o dos dimensiones, calculados en el servidor. USAR ESTA en lugar de 'buscar_leads' para cualquier panel, grafico o pregunta de volumen: devuelve unos pocos KB en vez de traerse decenas de miles de registros individuales. 'buscar_leads' es solo para inspeccionar casos concretos.",
      inputSchema: {
        por: z
          .enum([
            "mes",
            "cohorte",
            "estado",
            "canal",
            "origen",
            "asesor",
            "colegio",
            "semestre",
            "beca",
            "gestionado",
            "programa",
          ])
          .describe("Dimension principal de agrupacion."),

        sub: z
          .enum([
            "mes",
            "cohorte",
            "estado",
            "canal",
            "origen",
            "asesor",
            "colegio",
            "semestre",
            "beca",
            "gestionado",
            "programa",
          ])
          .optional()
          .describe(
            "Segunda dimension. Con esto sale una matriz (ej. por='mes', sub='canal') lista para barras apiladas o lineas multiples."
          ),

        topN: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Deja las N categorias mas grandes y agrupa el resto en 'otros', sin perder el total."
          ),

        ...filtroCohorte,

        estado: z.string().optional(),
        programa: z.string().optional(),
        asesor: z.string().optional(),
        canal: z.string().optional(),
        origen: z.string().optional(),
      },
    },
    async (a) => salida(await llamar("/agregados", a))
  );

  // ── buscar_persona ────────────────────────────────────────
  server.registerTool(
    "buscar_persona",
    {
      title: "Ficha completa de una persona",
      description:
        "Busca a una persona en TODOS sus registros de Salesforce en vivo, sin los filtros de la sesion en memoria: incluye posgrado (maestrias, especializaciones, doctorados) y formularios sin semestre, que no forman parte del dataset de las demas herramientas. Devuelve sus formularios y solicitudes clasificados en grado/posgrado, y marca si cruza ambos. Usar para preguntas sobre una persona concreta; NUNCA para volumenes.",
      inputSchema: {
        apellido: z
          .string()
          .optional()
          .describe(
            "Apellido o parte. Es el criterio mas confiable: los nombres suelen tener variantes de tipeo."
          ),

        nombre: z.string().optional().describe("Nombre o parte."),

        dni: z
          .string()
          .optional()
          .describe("Numero de documento, solo digitos. El criterio mas preciso."),
      },
    },
    async (a) => salida(await llamar("/persona", a))
  );

  // ══════════════════════════════════════════════════════════
  // PANELES
  // ══════════════════════════════════════════════════════════
  //
  // El HTML se renderiza en un iframe sandbox de la extension,
  // asi que puede traer estilos y JS propios (Chart.js ya esta
  // cargado ahi). Es lo que hace que los paneles sean editables
  // sin tocar la extension.
  // ══════════════════════════════════════════════════════════

  server.registerTool(
    "enviar_panel",
    {
      title: "Enviar panel al dashboard",
      description:
        "Publica un panel en el dashboard embebido en Salesforce Lightning. Si ya existe un panel con esa clave lo REEMPLAZA; si no, lo crea. ANTES de usar esta herramienta llamar a \'listar_paneles\': muestra las claves ya existentes, incluidas las que solo estan guardadas en el navegador del usuario. Si el pedido es modificar o fusionar algo que ya existe, hay que reusar esa clave. El html se renderiza en un iframe aislado que ya tiene Chart.js cargado y clases de estilo tipo Salesforce (tarjeta, tarjeta__titulo, encabezado, grilla grilla--3, metrica, metrica__valor, metrica__label, tabla). Usar SOLO cuando el usuario pide explicitamente enviar o actualizar un panel. El contenido debe ser exclusivamente metricas agregadas: el servidor rechaza cualquier panel con nombres, mails, telefonos o documentos.",
      inputSchema: {
        clave: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{1,48}$/i)
          .describe(
            "Identificador estable del panel. Para MODIFICAR, ACTUALIZAR o FUSIONAR un panel existente hay que reenviar SU MISMA CLAVE: eso lo reemplaza en el dashboard. Usar una clave nueva crea un panel adicional, que casi nunca es lo que se pide. Llamar primero a 'listar_paneles' para ver las claves que ya existen."
          ),

        titulo: z
          .string()
          .optional()
          .describe("Titulo que se ve en la solapa, ej. '2027 Semestre 1 | General'"),

        html: z
          .string()
          .describe(
            "HTML completo del panel. Puede incluir <style> y <script>. Para graficos usar <canvas> y Chart.js."
          ),

        orden: z
          .number()
          .optional()
          .describe("Posicion entre las solapas. Menor va primero."),
      },
    },
    async (a) =>
      salida(await llamar("/paneles", {}, "POST", a))
  );

  server.registerTool(
    "listar_paneles",
    {
      title: "Listar paneles publicados",
      description:
        "Devuelve las claves, titulos y fechas de TODOS los paneles conocidos, sin el HTML: los que estan en el servidor y tambien los que solo quedaron guardados en el navegador del usuario de una sesion anterior (origen: \'addon\'). USAR SIEMPRE antes de enviar un panel: es la unica forma de saber que claves ya existen y evitar crear un duplicado cuando lo que se pide es modificar.",
      inputSchema: {},
    },
    async () => salida(await llamar("/paneles/indice"))
  );

  server.registerTool(
    "ver_panel",
    {
      title: "Ver el contenido de un panel",
      description:
        "Devuelve el HTML completo de un panel publicado. Usar antes de modificarlo o fusionarlo, para partir de lo que ya tiene en vez de rehacerlo de cero. Si el servidor se reinicio, el HTML puede no estar disponible aunque el panel siga visible en el navegador del usuario.",
      inputSchema: {
        clave: z.string().describe("Clave del panel"),
      },
    },
    async (a) =>
      salida(
        await llamar(`/paneles/${encodeURIComponent(a.clave)}`)
      )
  );

  server.registerTool(
    "borrar_panel",
    {
      title: "Borrar un panel",
      description:
        "Elimina un panel del dashboard, tanto del servidor como de la copia guardada en el navegador del usuario. El borrado local se aplica cuando la extension sincroniza (al abrir el panel o tocar Actualizar). SOLO usar cuando el usuario lo pide de forma explicita e inequivoca.",
      inputSchema: {
        clave: z.string().describe("Clave del panel a borrar"),

        confirmar: z
          .literal("BORRAR")
          .describe(
            "Debe ser exactamente 'BORRAR'. Enviarlo solo si el usuario pidio explicitamente eliminar el panel."
          ),
      },
    },
    async (a) =>
      salida(
        await llamar(
          `/paneles/${encodeURIComponent(a.clave)}`,
          {},
          "DELETE"
        )
      )
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
