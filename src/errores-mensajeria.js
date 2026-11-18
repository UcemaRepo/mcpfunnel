// ============================================================
// errores-mensajeria.js — mensajes de WhatsApp que no llegaron
// ============================================================
//
// GET /mensajeria/errores?fecha=AAAA-MM-DD[&detalle=true
//                         &nombres=true&motivo=&asesor=&limite=]
//     (tambien acepta dias=N o desde/hasta en vez de fecha)
// GET /mensajeria/diagnostico?sesion=MS-00168850
//
// De donde sale el dato:
//
// Con mensajeria mejorada (WhatsApp de UCEMA), cuando un mensaje
// no se puede entregar, Salesforce agrega a la conversacion una
// entrada de tipo MESSAGE_DELIVERY_FAILED con errorCode,
// errorMessage y el identificador del mensaje que fallo. Es lo
// que la consola dibuja como cartel rojo dentro del chat.
//
// Ese dato NO esta en ningun objeto consultable por SOQL:
//   - MessagingSession no lo refleja (Status Ended, sin error).
//   - MessagingDeliveryError solo registra fallos del sistema
//     viejo de "triggered outbound"; para estos queda vacio
//     (la primera version de esta ruta lo usaba y devolvia 0).
//
// Asi que la ruta:
//   1. busca por SOQL las sesiones de mensajeria activas ese dia
//      (con el identificador de su conversacion),
//   2. pide las entradas de cada conversacion a la API Connect
//      (/connect/conversation/{id}/entries), filtradas por el dia,
//   3. se queda con las MESSAGE_DELIVERY_FAILED.
//
// Es una llamada a la API por conversacion: con muchos envios
// en el dia tarda (se hacen de a 5 en paralelo).
//
// Datos personales: el telefono sale enmascarado y nombre y
// apellido solo aparecen con ENMASCARAR_PII=false o, para esta
// ruta sola, con ERRORES_CON_NOMBRE=true y nombres=true.
// ============================================================

import { clienteSoql } from "./persona.js";
import { maskTel } from "./transform.js";

const DIA = 24 * 60 * 60 * 1000;
const MAX_DIAS = 31;
const API_CONNECT = "v62.0";
const CONCURRENCIA = 5;
const MAX_CONVERSACIONES = 1500;
// Sesiones abiertas antes del dia que siguen activas: se miran
// hasta esta antiguedad.
const DIAS_HACIA_ATRAS = 7;

// Argentina no tiene horario de verano: el dia local es UTC-3.
const OFFSET_AR = "-03:00";

// ------------------------------------------------------------
// Fechas
// ------------------------------------------------------------

const fechaSoql = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function parsearFecha(valor, finDelDia = false) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) {
    throw new Error(`Fecha invalida: '${s}'. Usar AAAA-MM-DD.`);
  }
  const d = new Date(s.length === 10 ? `${s}T00:00:00${OFFSET_AR}` : s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Fecha invalida: '${s}'. Usar AAAA-MM-DD.`);
  }
  if (finDelDia && s.length === 10) {
    return new Date(`${s}T23:59:59${OFFSET_AR}`);
  }
  return d;
}

export function rangoFechas(
  { dias, desde, hasta, fecha } = {},
  ahora = new Date(),
) {
  // fecha=AAAA-MM-DD: el dia completo en hora de Buenos Aires.
  if (fecha) {
    const f = String(fecha).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) {
      throw new Error(`Fecha invalida: '${f}'. Usar AAAA-MM-DD.`);
    }
    return {
      inicio: new Date(`${f}T00:00:00${OFFSET_AR}`),
      fin: new Date(`${f}T23:59:59${OFFSET_AR}`),
    };
  }

  const fin = parsearFecha(hasta, true) || ahora;
  let inicio = parsearFecha(desde);

  if (!inicio) {
    const n = Math.min(Math.max(parseInt(dias, 10) || 1, 1), MAX_DIAS);
    inicio = new Date(fin.getTime() - n * DIA);
  }

  if (inicio > fin) throw new Error("'desde' es posterior a 'hasta'.");
  if (fin - inicio > MAX_DIAS * DIA) {
    throw new Error(`El rango no puede superar ${MAX_DIAS} dias.`);
  }

  return { inicio, fin };
}

// ------------------------------------------------------------
// Paso 1: sesiones del dia (SOQL)
// ------------------------------------------------------------

const CAMPOS_SESION = `Id, Name, CreatedDate, EndTime, Origin, Status,
  MessagingEndUserId, ConversationId, Conversation.ConversationIdentifier`;

// Campos por relacion, en niveles. Si la integracion no puede
// leer alguno, se prueba el nivel siguiente (menos campos).
//   0: + contacto (nombre y apellido), propietario del usuario de
//      mensajeria (asesor asignado), telefono, canal
//   1: sin contacto ni propietario del usuario de mensajeria
//   2: solo campos base
const NIVELES_RELACION = [
  `, MessagingEndUser.Name, MessagingEndUser.MessagingPlatformKey,
  MessagingEndUser.Contact.FirstName, MessagingEndUser.Contact.LastName,
  MessagingEndUser.Owner.Name, Owner.Name, MessagingChannel.MasterLabel`,
  `, MessagingEndUser.Name, MessagingEndUser.MessagingPlatformKey,
  Owner.Name, MessagingChannel.MasterLabel`,
  "",
];

export function armarSoqlSesiones({ inicio, fin }, nivel = 0) {
  const desdeCreacion = new Date(inicio.getTime() - DIAS_HACIA_ATRAS * DIA);
  return `SELECT ${CAMPOS_SESION}${NIVELES_RELACION[nivel] ?? ""}
    FROM MessagingSession
    WHERE CreatedDate <= ${fechaSoql(fin)}
      AND CreatedDate >= ${fechaSoql(desdeCreacion)}
      AND (EndTime >= ${fechaSoql(inicio)} OR EndTime = null)
    ORDER BY CreatedDate`;
}

const esErrorDeCampo = (msg) =>
  /INVALID_FIELD|relationship|No such column/i.test(msg);

async function traerSesiones(query, rango) {
  let ultimoError;
  for (let nivel = 0; nivel < NIVELES_RELACION.length; nivel++) {
    try {
      const sesiones = await query(armarSoqlSesiones(rango, nivel));
      return { sesiones, nivelRelacion: nivel };
    } catch (err) {
      if (!esErrorDeCampo(err.message)) throw err;
      ultimoError = err;
    }
  }
  throw ultimoError;
}

// ------------------------------------------------------------
// Paso 2: entradas de cada conversacion (API Connect)
// ------------------------------------------------------------

const parsear = (v) => {
  if (!v) return {};
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};

const tipoNormalizado = (t) =>
  String(t || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

// La API Connect y la consola devuelven formatos parecidos pero
// no iguales: los campos pueden venir arriba o dentro de
// entryPayload (como objeto o como texto JSON). Esto los unifica.
export function normalizarEntrada(e) {
  const payload = parsear(e.entryPayload);
  const ts =
    e.serverReceivedTimestamp ??
    e.transcriptedTimestamp ??
    e.timestamp ??
    e.clientTimestamp ??
    null;
  const estatico = payload.abstractMessage?.staticContent || {};
  const plantilla = estatico.externalTemplate || {};
  return {
    id: e.identifier ?? e.id ?? payload.id ?? null,
    tipo: tipoNormalizado(e.entryType || payload.entryType),
    ts: typeof ts === "number" ? ts : Date.parse(ts),
    emisor: e.senderDisplayName ?? e.sender?.displayName ?? null,
    rol: e.sender?.role ?? null,
    texto:
      e.messageText ??
      estatico.text ??
      (plantilla.name || plantilla.templateName
        ? `Plantilla: ${plantilla.name || plantilla.templateName}`
        : null),
    errorCode: payload.errorCode ?? e.errorCode ?? null,
    errorMessage: payload.errorMessage ?? e.errorMessage ?? null,
    idFallido:
      payload.failedConversationEntryIdentifier ??
      e.failedConversationEntryIdentifier ??
      null,
  };
}

export const esFallo = (entrada) => entrada.tipo === "MESSAGEDELIVERYFAILED";

function rutaEntradas(identificador, rango) {
  const p = new URLSearchParams({ recordLimit: "1000" });
  if (rango) {
    p.set("startTimestamp", String(rango.inicio.getTime()));
    p.set("endTimestamp", String(rango.fin.getTime()));
  }
  return `/services/data/${API_CONNECT}/connect/conversation/${encodeURIComponent(
    identificador,
  )}/entries?${p}`;
}

function errorConnect(status, data) {
  const detalle = Array.isArray(data) ? data[0] : data;
  return `${status} ${detalle?.errorCode || ""} ${detalle?.message || ""}`.trim();
}

async function entradasDeConversacion(getJson, identificador, rango) {
  const { status, data } = await getJson(rutaEntradas(identificador, rango));
  if (status !== 200) return { error: errorConnect(status, data) };
  const lista = data?.conversationEntries || data?.entries || [];
  return { entradas: lista.map(normalizarEntrada) };
}

async function enLotes(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  }
  return out;
}

// ------------------------------------------------------------
// Paso 3: armar una fila por fallo
// ------------------------------------------------------------

export function lightningUrl(inst, objeto, id) {
  if (!id) return null;
  const base = String(inst || "").replace(
    /\.my\.salesforce\.com\/?$/,
    ".lightning.force.com",
  );
  return `${base}/lightning/r/${objeto}/${id}/view`;
}

const telefonoDe = (clave) =>
  String(clave || "").replace(/^[a-z]+:/i, "") || null;

// La sesion a la que pertenece un fallo: la ultima que se abrio
// antes del fallo, dentro de la misma conversacion.
function sesionDelFallo(sesiones, ts) {
  const previas = sesiones.filter(
    (s) => Date.parse(s.CreatedDate) <= ts + 60000,
  );
  return (previas.length ? previas : sesiones).at(-1);
}

export function filasDeFallos(sesionesDeConv, entradas, rango, inst) {
  const porId = new Map(entradas.map((e) => [e.id, e]));
  return entradas
    .filter(esFallo)
    .filter(
      (f) =>
        !rango ||
        (f.ts >= rango.inicio.getTime() && f.ts <= rango.fin.getTime()),
    )
    .map((f) => {
      const original = porId.get(f.idFallido) || {};
      const s = sesionDelFallo(sesionesDeConv, f.ts);
      const usuario = s.MessagingEndUser || {};
      return {
        id: f.id,
        fecha: new Date(f.ts).toISOString(),
        codigo: f.errorCode ? String(f.errorCode) : null,
        motivo: f.errorMessage || null,
        mensaje: original.texto || null,
        enviadoPor: original.emisor || null,
        asesorAsignado: usuario.Owner?.Name || s.Owner?.Name || null,
        canal: s.MessagingChannel?.MasterLabel || null,
        origenSesion: s.Origin || null,
        sesion: s.Name || null,
        messagingSessionId: s.Id || null,
        messagingEndUserId: s.MessagingEndUserId || null,
        link: lightningUrl(inst, "MessagingSession", s.Id),
        nombreWhatsapp: usuario.Name || null,
        nombre: usuario.Contact?.FirstName || null,
        apellido: usuario.Contact?.LastName || null,
        telefono: telefonoDe(usuario.MessagingPlatformKey),
      };
    });
}

// ------------------------------------------------------------
// Resumen
// ------------------------------------------------------------

const sinTildes = (t) =>
  String(t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const contar = (filas, clave) => {
  const out = {};
  for (const f of filas) {
    const k = clave(f) || "sin_dato";
    out[k] = (out[k] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

const diaAR = (iso) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(iso));

// Nombres en el detalle: con ENMASCARAR_PII=false (todo el
// servidor sin enmascarar) o, solo para esta ruta, con
// ERRORES_CON_NOMBRE=true y el parametro nombres=true.
export function nombresPermitidos(pedidos, env = process.env) {
  if (env.ENMASCARAR_PII === "false") return true;
  return Boolean(pedidos) && env.ERRORES_CON_NOMBRE === "true";
}

export function resumirErrores(filasEntrada, opts = {}) {
  const {
    motivo,
    asesor,
    detalle = false,
    limite = 200,
    enmascarar = true,
    conNombres = false,
  } = opts;

  let filas = [...filasEntrada].sort((a, b) => b.fecha.localeCompare(a.fecha));

  if (motivo) {
    // Compara por raiz de cada palabra, en motivo y codigo.
    const raices = sinTildes(motivo)
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
    filas = filas.filter((f) => {
      const t = sinTildes(`${f.motivo} ${f.codigo}`);
      return raices.every((r) => t.includes(r));
    });
  }
  if (asesor) {
    const a = sinTildes(asesor);
    filas = filas.filter(
      (f) =>
        sinTildes(f.enviadoPor).includes(a) ||
        sinTildes(f.asesorAsignado).includes(a),
    );
  }

  const porPersona = {};
  for (const f of filas) {
    const k = f.messagingEndUserId || f.telefono;
    if (k) porPersona[k] = (porPersona[k] || 0) + 1;
  }

  const respuesta = {
    total: filas.length,
    personasAfectadas: Object.keys(porPersona).length,
    porMotivo: contar(filas, (f) => f.motivo),
    porCodigo: contar(filas, (f) => f.codigo),
    porEnviadoPor: contar(filas, (f) => f.enviadoPor),
    porAsesorAsignado: contar(filas, (f) => f.asesorAsignado),
    porCanal: contar(filas, (f) => f.canal),
    porDia: Object.fromEntries(
      Object.entries(contar(filas, (f) => diaAR(f.fecha))).sort((a, b) =>
        a[0].localeCompare(b[0]),
      ),
    ),
    reincidentes: Object.values(porPersona).filter((n) => n > 1).length,
  };

  if (detalle) {
    const n = Math.min(Math.max(parseInt(limite, 10) || 200, 1), 2000);
    respuesta.detalle = filas.slice(0, n).map((f) => ({
      fecha: f.fecha,
      codigo: f.codigo,
      motivo: f.motivo,
      mensaje: f.mensaje,
      enviadoPor: f.enviadoPor,
      asesorAsignado: f.asesorAsignado,
      canal: f.canal,
      origenSesion: f.origenSesion,
      sesion: f.sesion,
      messagingEndUserId: f.messagingEndUserId,
      link: f.link,
      telefono: maskTel(f.telefono, enmascarar && !conNombres) || null,
      ...(conNombres && {
        nombre: f.nombre,
        apellido: f.apellido,
        nombreWhatsapp: f.nombreWhatsapp,
      }),
    }));
    respuesta.detalleTruncado = filas.length > n;
  }

  return respuesta;
}

// ------------------------------------------------------------
// Orquestacion
// ------------------------------------------------------------

export async function traerErrores(params = {}) {
  const rango = rangoFechas(params);
  const { query, inst, getJson } = await clienteSoql({ conInstancia: true });

  const { sesiones, nivelRelacion } = await traerSesiones(query, rango);

  // Una conversacion puede tener varias sesiones: se agrupan para
  // pedir sus entradas una sola vez.
  const porConversacion = new Map();
  for (const s of sesiones) {
    const id = s.Conversation?.ConversationIdentifier;
    if (!id) continue;
    if (!porConversacion.has(id)) porConversacion.set(id, []);
    porConversacion.get(id).push(s);
  }

  const ids = [...porConversacion.keys()];
  const revisadas = ids.slice(0, MAX_CONVERSACIONES);

  const resultados = await enLotes(revisadas, CONCURRENCIA, async (id) => ({
    id,
    ...(await entradasDeConversacion(getJson, id, rango)),
  }));

  const fallidas = resultados.filter((r) => r.error);
  if (revisadas.length && fallidas.length === revisadas.length) {
    // Ninguna conversacion se pudo leer: casi seguro un permiso
    // o la API desactivada. Mejor fallar que devolver 0.
    const e = new Error(
      `No se pudieron leer las conversaciones (API Connect: ${fallidas[0].error}). ` +
        "Revisar que el usuario de la Connected App tenga acceso a las conversaciones de mensajeria " +
        "y que en Configuracion este activado 'Conversation Service APIs'.",
    );
    e.esPermiso = true;
    throw e;
  }

  const filas = resultados
    .filter((r) => r.entradas)
    .flatMap((r) =>
      filasDeFallos(porConversacion.get(r.id), r.entradas, rango, inst),
    );

  return {
    filas,
    rango,
    nivelRelacion,
    sesionesRevisadas: sesiones.length,
    conversacionesRevisadas: revisadas.length,
    conversacionesSinRevisar: ids.length - revisadas.length,
    conversacionesConError: fallidas.length,
    ejemploError: fallidas[0]?.error || null,
  };
}

// Para verificar con una sesion conocida que la API Connect
// devuelve las entradas de fallo. Sin datos personales.
export async function diagnosticarSesion(nombreSesion) {
  if (!/^MS-\d+$/.test(String(nombreSesion || ""))) {
    throw new Error(
      "Pasar sesion=MS-00000000 (el numero de la sesion de mensajeria).",
    );
  }
  const { query, getJson } = await clienteSoql({ conInstancia: true });
  const [s] = await query(
    `SELECT Id, Name, CreatedDate, Origin, Status, Conversation.ConversationIdentifier
     FROM MessagingSession WHERE Name = '${nombreSesion}' LIMIT 1`,
  );
  if (!s) return { encontrada: false };

  const id = s.Conversation?.ConversationIdentifier;
  if (!id) return { encontrada: true, conversationIdentifier: null };

  const { status, data } = await getJson(rutaEntradas(id, null));
  const lista = data?.conversationEntries || data?.entries || [];
  const entradas = lista.map(normalizarEntrada);
  return {
    encontrada: true,
    sesion: {
      nombre: s.Name,
      creada: s.CreatedDate,
      origen: s.Origin,
      estado: s.Status,
    },
    apiConnect: status === 200 ? "ok" : errorConnect(status, data),
    cantidadEntradas: entradas.length,
    tiposDeEntrada: contar(entradas, (e) => e.tipo),
    camposDeLaPrimeraEntrada: lista[0] ? Object.keys(lista[0]) : [],
    fallos: entradas.filter(esFallo).map((f) => ({
      fecha: Number.isFinite(f.ts) ? new Date(f.ts).toISOString() : null,
      codigo: f.errorCode,
      motivo: f.errorMessage,
      mensajeEncontrado: entradas.some((e) => e.id === f.idFallido),
    })),
  };
}

// ------------------------------------------------------------
// Rutas
// ------------------------------------------------------------

export function montarErroresMensajeria(app, auth) {
  const si = (v) => v === "true" || v === "si";

  const responderError = (res, ruta) => (err) => {
    console.error(`Error ${ruta}:`, err);
    const esPermiso =
      err.esPermiso ||
      /INSUFFICIENT_ACCESS|INVALID_TYPE|sObject type/i.test(err.message);
    res.status(esPermiso ? 403 : 500).json({ ok: false, error: err.message });
  };

  app.get("/mensajeria/errores", auth, async (req, res) => {
    try {
      const q = req.query;
      const detalle = si(q.detalle);
      const enmascarar = process.env.ENMASCARAR_PII !== "false";
      const conNombres = nombresPermitidos(si(q.nombres));

      const r = await traerErrores(q);

      res.json({
        ok: true,
        fuente: "entradas de conversacion (MESSAGE_DELIVERY_FAILED)",
        desde: r.rango.inicio.toISOString(),
        hasta: r.rango.fin.toISOString(),
        piiEnmascarada: enmascarar && !conNombres,
        nombresIncluidos: detalle && conNombres,
        // 0 = con contacto y asesor asignado, 1 = sin ellos,
        // 2 = solo campos base (ver NIVELES_RELACION)
        nivelRelacion: r.nivelRelacion,
        sesionesRevisadas: r.sesionesRevisadas,
        conversacionesRevisadas: r.conversacionesRevisadas,
        conversacionesSinRevisar: r.conversacionesSinRevisar,
        conversacionesConError: r.conversacionesConError,
        ...(r.ejemploError && { ejemploError: r.ejemploError }),
        ...resumirErrores(r.filas, {
          motivo: q.motivo,
          asesor: q.asesor,
          detalle,
          limite: q.limite,
          enmascarar,
          conNombres,
        }),
      });
    } catch (err) {
      responderError(res, "/mensajeria/errores")(err);
    }
  });

  app.get("/mensajeria/diagnostico", auth, async (req, res) => {
    try {
      res.json({ ok: true, ...(await diagnosticarSesion(req.query.sesion)) });
    } catch (err) {
      responderError(res, "/mensajeria/diagnostico")(err);
    }
  });
}
