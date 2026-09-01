// ============================================================
// paneles.js — almacen de paneles analiticos
// ============================================================
//
// Los paneles viven en RAM, igual que la sesion de leads.
// Se pierden cuando Render apaga el servicio por inactividad
// o al redeployar. Es aceptable: un panel se vuelve a generar
// en segundos pidiendoselo a Claude.
//
// Lo que NO se pierde con eso es informacion irrecuperable:
// aca solo hay metricas agregadas, nunca datos de personas.
// ============================================================

const paneles = new Map();

// ------------------------------------------------------------
// Validacion de PII
// ------------------------------------------------------------
//
// Un panel es un tablero de metricas. Si trae nombres, mails o
// documentos, algo se hizo mal aguas arriba: se rechaza en vez
// de publicarlo.
//
// Se revisa el HTML completo, no solo las claves: el HTML puede
// traer los datos embebidos en una tabla o en un objeto JS.
// ------------------------------------------------------------

const PATRONES_PII = [
  {
    nombre: "direcciones de correo",
    re: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/,
  },
  {
    nombre: "telefonos",
    re: /(?:\+?54\s?9?\s?)?(?:\d[\s-]?){10,}/,
  },
  {
    nombre: "campos de datos personales",
    re: /"?\b(nombre|apellido|dni|documento|telefono|email|mail|domicilio|nacimiento)\b"?\s*[:=]/i,
  },
];

export function validarPanel(html) {
  const problemas = [];

  for (const { nombre, re } of PATRONES_PII) {
    if (re.test(html)) problemas.push(nombre);
  }

  if (problemas.length) {
    throw new Error(
      "El panel parece contener datos personales (" +
        problemas.join(", ") +
        "). Los paneles solo pueden llevar metricas agregadas. " +
        "Si es un falso positivo, revisa el HTML y quita el texto que dispara la coincidencia."
    );
  }
}

// ------------------------------------------------------------
// Operaciones
// ------------------------------------------------------------

// Upsert por clave: crea si no existe, actualiza si existe.
export function guardarPanel({ clave, titulo, html, orden }) {
  if (!clave || !/^[a-z0-9][a-z0-9-]{1,48}$/i.test(clave)) {
    throw new Error(
      "La clave debe tener entre 2 y 49 caracteres alfanumericos o guiones."
    );
  }

  if (!html || !html.trim()) {
    throw new Error("El panel no puede estar vacio.");
  }

  if (html.length > 400_000) {
    throw new Error("El panel supera los 400 KB.");
  }

  validarPanel(html);

  const existente = paneles.get(clave);

  const panel = {
    clave,
    titulo: titulo || existente?.titulo || clave,
    html,
    orden: orden ?? existente?.orden ?? paneles.size,
    creado: existente?.creado || new Date().toISOString(),
    actualizado: new Date().toISOString(),
  };

  paneles.set(clave, panel);

  return {
    accion: existente ? "actualizado" : "creado",
    panel: { ...panel, html: undefined, bytes: html.length },
  };
}

export function listarPaneles() {
  return [...paneles.values()].sort(
    (a, b) => a.orden - b.orden || a.clave.localeCompare(b.clave)
  );
}

export function borrarPanel(clave) {
  const existia = paneles.delete(clave);
  if (!existia) throw new Error(`No existe un panel con clave "${clave}".`);
  return { ok: true, borrado: clave };
}

export function borrarTodos() {
  const n = paneles.size;
  paneles.clear();
  return { ok: true, borrados: n };
}

// ------------------------------------------------------------
// Rutas
// ------------------------------------------------------------

export function montarPaneles(app, auth) {
  // La extension llama a este. Devuelve el HTML completo.
  app.get("/paneles", auth, (req, res) => {
    res.json({
      ok: true,
      paneles: listarPaneles(),
      timestamp: new Date().toISOString(),
    });
  });

  // Solo metadata, sin el HTML. Util para que Claude sepa que
  // hay sin traerse cientos de KB al contexto.
  app.get("/paneles/indice", auth, (req, res) => {
    res.json({
      ok: true,
      paneles: listarPaneles().map((p) => ({
        clave: p.clave,
        titulo: p.titulo,
        orden: p.orden,
        bytes: p.html.length,
        creado: p.creado,
        actualizado: p.actualizado,
      })),
    });
  });

  app.post("/paneles", auth, (req, res) => {
    try {
      res.json({ ok: true, ...guardarPanel(req.body || {}) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete("/paneles/:clave", auth, (req, res) => {
    try {
      res.json(borrarPanel(req.params.clave));
    } catch (err) {
      res.status(404).json({ ok: false, error: err.message });
    }
  });

  app.delete("/paneles", auth, (req, res) => {
    res.json(borrarTodos());
  });
}
