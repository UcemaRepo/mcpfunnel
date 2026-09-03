// ============================================================
// paneles.js — almacen de paneles analiticos
// ============================================================
//
// Tres estructuras, y la distincion importa:
//
//   paneles   — los que estan en RAM del servidor. Se pierden
//               cuando Render apaga el servicio.
//
//   registro  — indice de lo que la EXTENSION tiene guardado
//               localmente. La extension lo reporta en cada
//               sincronizacion. Es como el servidor sabe que
//               paneles existen aunque su propia RAM este vacia.
//
//   borrados  — lapidas. El servidor no puede empujar nada a la
//               extension, asi que un borrado se anota aca y la
//               extension lo aplica en su proxima sincronizacion.
//
// Sin el registro, tras un reinicio de Render el servidor cree
// que no hay ningun panel, y un pedido de "modificar el panel X"
// termina creando uno nuevo en vez de reemplazarlo.
// ============================================================

const paneles = new Map();
const registro = new Map();
const borrados = new Map();

// ------------------------------------------------------------
// Validacion de PII
// ------------------------------------------------------------
// Un panel es un tablero de metricas. Si trae nombres, mails o
// documentos, algo se hizo mal aguas arriba: se rechaza en vez
// de publicarlo.
// ------------------------------------------------------------

const PATRONES_PII = [
  { nombre: "direcciones de correo", re: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/ },
  { nombre: "telefonos", re: /(?:\+?54\s?9?\s?)?(?:\d[\s-]?){10,}/ },
  {
    nombre: "campos de datos personales",
    re: /"?\b(nombre|apellido|dni|documento|telefono|email|mail|domicilio|nacimiento)\b"?\s*[:=]/i,
  },
];

export function validarPanel(html) {
  const problemas = PATRONES_PII
    .filter(({ re }) => re.test(html))
    .map(({ nombre }) => nombre);

  if (problemas.length) {
    throw new Error(
      "El panel parece contener datos personales (" +
        problemas.join(", ") +
        "). Los paneles solo pueden llevar metricas agregadas."
    );
  }
}

// ------------------------------------------------------------
// Guardar (upsert por clave)
// ------------------------------------------------------------

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

  // Reenviar una clave borrada la revive: manda la intencion
  // mas reciente.
  borrados.delete(clave);

  const previo = paneles.get(clave) || registro.get(clave);

  const panel = {
    clave,
    titulo: titulo || previo?.titulo || clave,
    html,
    orden: orden ?? previo?.orden ?? paneles.size,
    creado: previo?.creado || new Date().toISOString(),
    actualizado: new Date().toISOString(),
  };

  paneles.set(clave, panel);

  return {
    accion: previo ? "actualizado" : "creado",
    existiaEn: previo
      ? paneles.has(clave) && registro.has(clave)
        ? "servidor y addon"
        : registro.has(clave)
          ? "addon"
          : "servidor"
      : null,
    panel: { ...panel, html: undefined, bytes: html.length },
  };
}

export function listarPaneles() {
  return [...paneles.values()].sort(
    (a, b) => a.orden - b.orden || a.clave.localeCompare(b.clave)
  );
}

// ------------------------------------------------------------
// Vista unificada para Claude
// ------------------------------------------------------------
// Junta lo que hay en RAM con lo que reporto la extension, y
// marca de donde sale cada uno. Es lo que hay que consultar
// ANTES de enviar un panel, para reusar la clave existente en
// vez de crear un duplicado.
// ------------------------------------------------------------

export function indiceCompleto() {
  const mapa = new Map();

  for (const p of registro.values()) {
    mapa.set(p.clave, {
      clave: p.clave,
      titulo: p.titulo,
      actualizado: p.actualizado,
      origen: "addon",
    });
  }

  for (const p of paneles.values()) {
    const previo = mapa.get(p.clave);

    mapa.set(p.clave, {
      clave: p.clave,
      titulo: p.titulo,
      actualizado: p.actualizado,
      bytes: p.html.length,
      origen: previo ? "servidor y addon" : "servidor",
    });
  }

  return {
    paneles: [...mapa.values()].sort((a, b) =>
      a.clave.localeCompare(b.clave)
    ),

    borradosPendientes: [...borrados.entries()].map(([clave, cuando]) => ({
      clave,
      cuando,
    })),

    nota:
      "origen 'addon' = el panel existe en la copia local de la extension aunque el servidor se haya reiniciado. Para MODIFICAR o FUSIONAR un panel hay que reenviar SU MISMA CLAVE, no crear una nueva.",
  };
}

// ------------------------------------------------------------
// Registro reportado por la extension
// ------------------------------------------------------------

export function actualizarRegistro(lista) {
  registro.clear();

  for (const p of lista || []) {
    if (!p?.clave) continue;

    registro.set(p.clave, {
      clave: p.clave,
      titulo: p.titulo || p.clave,
      actualizado: p.actualizado || null,
      orden: p.orden ?? 0,
      creado: p.creado || null,
    });
  }

  return registro.size;
}

// ------------------------------------------------------------
// Borrado
// ------------------------------------------------------------
// Se borra de RAM y se deja la lapida para que la extension
// haga el wipe local en su proxima sincronizacion.
// ------------------------------------------------------------

export function borrarPanel(clave) {
  const enRam = paneles.delete(clave);
  const enAddon = registro.delete(clave);

  borrados.set(clave, new Date().toISOString());

  return {
    ok: true,
    clave,
    borradoDeServidor: enRam,
    estabaEnAddon: enAddon,
    aviso: enAddon
      ? "Marcado para borrado. La extension lo elimina de su copia local en la proxima sincronizacion (al abrir el panel o tocar Actualizar)."
      : "Borrado del servidor.",
  };
}

export function borrarTodos() {
  const claves = new Set([...paneles.keys(), ...registro.keys()]);
  const ahora = new Date().toISOString();

  for (const c of claves) borrados.set(c, ahora);

  paneles.clear();
  registro.clear();

  return { ok: true, borrados: claves.size };
}

export function lapidas() {
  return [...borrados.keys()];
}

// ------------------------------------------------------------
// Rutas
// ------------------------------------------------------------

export function montarPaneles(app, auth) {
  // La extension llama a este en cada sincronizacion:
  // reporta lo que tiene y recibe paneles + lapidas.
  app.post("/paneles/sincronizar", auth, (req, res) => {
    const reportados = actualizarRegistro(req.body?.locales);

    res.json({
      ok: true,
      recibidos: reportados,
      paneles: listarPaneles(),
      borrar: lapidas(),
      timestamp: new Date().toISOString(),
    });
  });

  // Compatibilidad con la version anterior de la extension
  app.get("/paneles", auth, (req, res) => {
    res.json({
      ok: true,
      paneles: listarPaneles(),
      borrar: lapidas(),
      timestamp: new Date().toISOString(),
    });
  });

  // Vista para Claude: servidor + addon, sin el HTML
  app.get("/paneles/indice", auth, (req, res) => {
    res.json({ ok: true, ...indiceCompleto() });
  });

  // Contenido de un panel puntual, para poder editarlo o
  // fusionarlo sin adivinar que tenia adentro
  app.get("/paneles/:clave", auth, (req, res) => {
    const p = paneles.get(req.params.clave);

    if (!p) {
      const enAddon = registro.get(req.params.clave);

      return res.status(404).json({
        ok: false,
        error: enAddon
          ? `El panel "${req.params.clave}" existe en la copia local de la extension, pero su HTML no esta en el servidor (se reinicio). Para modificarlo hay que reenviarlo completo con esa misma clave.`
          : `No existe un panel con clave "${req.params.clave}".`,
        existeEnAddon: !!enAddon,
      });
    }

    res.json({ ok: true, panel: p });
  });

  app.post("/paneles", auth, (req, res) => {
    try {
      res.json({ ok: true, ...guardarPanel(req.body || {}) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.delete("/paneles/:clave", auth, (req, res) => {
    res.json(borrarPanel(req.params.clave));
  });

  app.delete("/paneles", auth, (req, res) => {
    res.json(borrarTodos());
  });
}
