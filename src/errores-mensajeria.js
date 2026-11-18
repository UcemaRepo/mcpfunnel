// ============================================================
// errores-mensajeria.js — conversaciones de WhatsApp del dia
// ============================================================
//
// GET /mensajeria/conversaciones?fecha=AAAA-MM-DD[&nombres=true]
//
// Devuelve una fila por conversacion de WhatsApp con actividad
// ese dia (la sesion mas reciente de cada una), con el link para
// abrirla en la consola, el asesor asignado y, si esta
// habilitado, nombre y apellido.
//
// Para que sirve:
//
// Los mensajes que no se pudieron entregar (cartel rojo dentro
// del chat) NO se pueden consultar desde el servidor:
//   - MessagingSession no lo refleja: un envio fallido y uno
//     entregado sin respuesta son identicos (Ended, 0 segundos,
//     0 mensajes). Verificado con 200 envios del 18/11/2026.
//   - MessagingDeliveryError solo registra fallos del sistema
//     viejo de "triggered outbound": para estos queda vacio.
//   - La API Connect (/connect/conversation/{id}/entries) devuelve
//     solo los mensajes, no las entradas MESSAGE_DELIVERY_FAILED.
//
// El dato solo lo muestra la consola. Por eso el reporte lo arma
// la extension de Chrome "Errores de WhatsApp": pide esta lista,
// abre cada conversacion en una pestaña en segundo plano con la
// sesion del asesor y busca el cartel de error.
//
// Datos personales: el telefono sale enmascarado y nombre y
// apellido solo aparecen con ENMASCARAR_PII=false o, para esta
// ruta sola, con ERRORES_CON_NOMBRE=true y nombres=true.
// ============================================================

import { clienteSoql } from "./persona.js";
import { maskTel } from "./transform.js";

const DIA = 24 * 60 * 60 * 1000;
// Sesiones abiertas antes del dia que siguen activas: se miran
// hasta esta antiguedad.
const DIAS_HACIA_ATRAS = 7;

// Argentina no tiene horario de verano: el dia local es UTC-3.
const OFFSET_AR = "-03:00";

const fechaSoql = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function rangoDelDia(fecha) {
  const f = String(fecha || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) {
    throw new Error(`Fecha invalida: '${f}'. Usar fecha=AAAA-MM-DD.`);
  }
  return {
    inicio: new Date(`${f}T00:00:00${OFFSET_AR}`),
    fin: new Date(`${f}T23:59:59${OFFSET_AR}`),
  };
}

// ------------------------------------------------------------
// Sesiones del dia (SOQL)
// ------------------------------------------------------------

const CAMPOS_SESION = `Id, Name, CreatedDate, EndTime, Origin, Status,
  EndUserMessageCount, MessagingEndUserId, ConversationId`;

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
// Una fila por conversacion
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

// Nombres: con ENMASCARAR_PII=false (todo el servidor sin
// enmascarar) o, solo para esta ruta, con ERRORES_CON_NOMBRE=true
// y el parametro nombres=true.
export function nombresPermitidos(pedidos, env = process.env) {
  if (env.ENMASCARAR_PII === "false") return true;
  return Boolean(pedidos) && env.ERRORES_CON_NOMBRE === "true";
}

export function conversacionesDelDia(sesiones, inst, opts = {}) {
  const { conNombres = false, enmascarar = true } = opts;

  // Agrupa por conversacion y se queda con la sesion mas reciente:
  // al abrirla, la consola muestra el historial completo.
  const porConversacion = new Map();
  for (const s of sesiones) {
    const clave = s.ConversationId || s.Id;
    const previa = porConversacion.get(clave);
    const respondio =
      previa?.respondio || false || (s.EndUserMessageCount || 0) > 0;
    if (
      !previa ||
      Date.parse(s.CreatedDate) >= Date.parse(previa.s.CreatedDate)
    ) {
      porConversacion.set(clave, {
        s,
        respondio,
        sesiones: (previa?.sesiones || 0) + 1,
      });
    } else {
      previa.respondio = respondio;
      previa.sesiones++;
    }
  }

  return [...porConversacion.entries()]
    .map(([conversationId, { s, respondio, sesiones: n }]) => {
      const usuario = s.MessagingEndUser || {};
      return {
        conversationId,
        sesion: s.Name,
        messagingSessionId: s.Id,
        url: lightningUrl(inst, "MessagingSession", s.Id),
        creada: s.CreatedDate,
        origen: s.Origin || null,
        estado: s.Status || null,
        sesionesEnElDia: n,
        respondio,
        asesorAsignado: usuario.Owner?.Name || s.Owner?.Name || null,
        canal: s.MessagingChannel?.MasterLabel || null,
        messagingEndUserId: s.MessagingEndUserId || null,
        telefono:
          maskTel(
            telefonoDe(usuario.MessagingPlatformKey),
            enmascarar && !conNombres,
          ) || null,
        ...(conNombres && {
          nombre: usuario.Contact?.FirstName || null,
          apellido: usuario.Contact?.LastName || null,
          nombreWhatsapp: usuario.Name || null,
        }),
      };
    })
    .sort((a, b) => a.creada.localeCompare(b.creada));
}

// ------------------------------------------------------------
// Rutas
// ------------------------------------------------------------

export function montarErroresMensajeria(app, auth) {
  const si = (v) => v === "true" || v === "si";

  app.get("/mensajeria/conversaciones", auth, async (req, res) => {
    try {
      const rango = rangoDelDia(req.query.fecha);
      const enmascarar = process.env.ENMASCARAR_PII !== "false";
      const conNombres = nombresPermitidos(si(req.query.nombres));

      const { query, inst } = await clienteSoql({ conInstancia: true });
      const { sesiones, nivelRelacion } = await traerSesiones(query, rango);
      const conversaciones = conversacionesDelDia(sesiones, inst, {
        conNombres,
        enmascarar,
      });

      res.json({
        ok: true,
        desde: rango.inicio.toISOString(),
        hasta: rango.fin.toISOString(),
        nombresIncluidos: conNombres,
        // 0 = con contacto y asesor asignado, 1 = sin ellos,
        // 2 = solo campos base (ver NIVELES_RELACION)
        nivelRelacion,
        sesiones: sesiones.length,
        total: conversaciones.length,
        conversaciones,
      });
    } catch (err) {
      console.error("Error /mensajeria/conversaciones:", err);
      const esPermiso = /INSUFFICIENT_ACCESS|INVALID_TYPE|sObject type/i.test(
        err.message,
      );
      const esFecha = /Fecha invalida/.test(err.message);
      res
        .status(esFecha ? 400 : esPermiso ? 403 : 500)
        .json({ ok: false, error: err.message });
    }
  });

  // La version anterior devolvia 0 errores aunque los hubiera
  // (las APIs del servidor no ven los fallos). Se deja la ruta
  // para que quien la llame reciba una explicacion y no un 0.
  app.get("/mensajeria/errores", auth, (req, res) => {
    res.status(501).json({
      ok: false,
      error:
        "Los fallos de entrega de WhatsApp no se pueden consultar desde el servidor: solo los muestra la consola. " +
        "Usar la extension de Chrome 'Errores de WhatsApp' (version 2 o posterior), que revisa las conversaciones " +
        "de GET /mensajeria/conversaciones en pestañas en segundo plano.",
    });
  });
}
