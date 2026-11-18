// ============================================================
// errores-mensajeria.js — mensajes de WhatsApp que no llegaron
// ============================================================
//
// GET /mensajeria/errores?dias=7[&desde=&hasta=&tipo=&motivo=
//                         &asesor=&detalle=true&limite=200]
//
// Por que existe:
//
// En la consola de Servicio, el cartel rojo de un mensaje que no
// se pudo entregar ("No se pueden enviar mensajes a este
// destinatario porque lo ha bloqueado", plantilla rechazada,
// numero invalido...) solo se ve con el chat abierto: lo dibuja
// el componente scrt-message-error-info a partir de las entradas
// de la conversacion, que se cargan al abrirla.
//
// El registro MessagingSession NO lo refleja (ErrorReason queda
// vacio y AgentMessageCount en 0), asi que filtrar sesiones no
// sirve. Lo que si queda guardado es un registro del objeto
// estandar MessagingDeliveryError por cada envio fallido.
//
// Esta ruta lo consulta EN VIVO, sin pasar por la sesion en
// memoria: no hace falta /cargar antes.
//
// Devuelve conteos (por motivo, tipo, canal, quien envio,
// plantilla y dia) y personas con mas de un error. Con
// detalle=true agrega una fila por error con el Id del usuario
// de mensajeria, el asesor asignado y el link a su ficha en
// Lightning. El telefono sale enmascarado y nombre y apellido
// solo aparecen con ENMASCARAR_PII=false o, para esta ruta sola,
// con ERRORES_CON_NOMBRE=true y nombres=true (ver
// nombresPermitidos).
// ============================================================

import { clienteSoql, soqlSeguro } from "./persona.js";
import { maskTel } from "./transform.js";

const DIA = 24 * 60 * 60 * 1000;
const MAX_DIAS = 90;

const CAMPOS_BASE = `Id, CreatedDate, Type, FailureReason,
  DestinationPhoneNumber, MessagingEndUserId, MessagingChannelId,
  MessagingTemplateId, CreatedById`;

// Campos por relacion, en niveles. Si la integracion no puede
// leer alguno, se prueba el nivel siguiente (menos campos) hasta
// quedar solo con los campos base.
//   0: + contacto (nombre y apellido) y propietario del usuario
//      de mensajeria (el asesor asignado)
//   1: + nombre del usuario de mensajeria, canal y quien envio
//   2: solo campos base
const NIVELES_RELACION = [
  `, MessagingEndUser.Name, MessagingChannel.MasterLabel, CreatedBy.Name,
  MessagingEndUser.Contact.FirstName, MessagingEndUser.Contact.LastName,
  MessagingEndUser.Owner.Name`,
  `, MessagingEndUser.Name, MessagingChannel.MasterLabel, CreatedBy.Name`,
  "",
];

// Argentina no tiene horario de verano: el dia local es UTC-3.
const OFFSET_AR = "-03:00";

const fechaSoql = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function parsearFecha(valor, finDelDia = false) {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) {
    throw new Error(`Fecha invalida: '${s}'. Usar AAAA-MM-DD.`);
  }
  const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Fecha invalida: '${s}'. Usar AAAA-MM-DD.`);
  }
  if (finDelDia && s.length === 10) d.setUTCHours(23, 59, 59, 0);
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
    const n = Math.min(Math.max(parseInt(dias, 10) || 7, 1), MAX_DIAS);
    inicio = new Date(fin.getTime() - n * DIA);
  }

  if (inicio > fin) throw new Error("'desde' es posterior a 'hasta'.");
  if (fin - inicio > MAX_DIAS * DIA) {
    throw new Error(`El rango no puede superar ${MAX_DIAS} dias.`);
  }

  return { inicio, fin };
}

export function armarSoql({ inicio, fin, tipo }, nivel = 0) {
  const filtros = [
    `CreatedDate >= ${fechaSoql(inicio)}`,
    `CreatedDate <= ${fechaSoql(fin)}`,
  ];
  if (tipo) filtros.push(`Type = '${soqlSeguro(tipo)}'`);
  // FailureReason puede ser texto largo: no admite LIKE en SOQL,
  // por eso el filtro por motivo se aplica despues, en JS.

  const extra = NIVELES_RELACION[nivel] ?? "";
  return `SELECT ${CAMPOS_BASE}${extra}
    FROM MessagingDeliveryError
    WHERE ${filtros.join(" AND ")}
    ORDER BY CreatedDate DESC`;
}

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

export function lightningUrl(inst, objeto, id) {
  if (!id) return null;
  const base = String(inst || "").replace(
    /\.my\.salesforce\.com\/?$/,
    ".lightning.force.com"
  );
  return `${base}/lightning/r/${objeto}/${id}/view`;
}

// Nombres en el detalle: con ENMASCARAR_PII=false (todo el
// servidor sin enmascarar) o, solo para esta ruta, con
// ERRORES_CON_NOMBRE=true y el parametro nombres=true. Asi el
// reporte diario puede traer nombre y apellido sin desenmascarar
// los leads del resto de las herramientas.
export function nombresPermitidos(pedidos, env = process.env) {
  if (env.ENMASCARAR_PII === "false") return true;
  return Boolean(pedidos) && env.ERRORES_CON_NOMBRE === "true";
}

export function resumirErrores(registros, opts = {}) {
  const {
    motivo,
    asesor,
    detalle = false,
    limite = 200,
    enmascarar = true,
    conNombres = false,
    inst = "",
  } = opts;

  let filas = registros.map((r) => ({
    id: r.Id,
    fecha: r.CreatedDate,
    tipo: r.Type || null,
    motivo: r.FailureReason || null,
    canal: r.MessagingChannel?.MasterLabel || r.MessagingChannelId || null,
    enviadoPor: r.CreatedBy?.Name || r.CreatedById || null,
    asesorAsignado: r.MessagingEndUser?.Owner?.Name || null,
    plantillaId: r.MessagingTemplateId || null,
    messagingEndUserId: r.MessagingEndUserId || null,
    nombreWhatsapp: r.MessagingEndUser?.Name || null,
    nombre: r.MessagingEndUser?.Contact?.FirstName || null,
    apellido: r.MessagingEndUser?.Contact?.LastName || null,
    telefono: r.DestinationPhoneNumber || null,
  }));

  if (motivo) {
    // Compara por raiz de cada palabra: "bloqueado" encuentra
    // "bloqueo" y "bloqueó". El motivo puede venir en ingles:
    // si no aparece nada, conviene probar "block".
    const raices = sinTildes(motivo)
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w.length > 6 ? w.slice(0, 6) : w));
    filas = filas.filter((f) => {
      const t = sinTildes(f.motivo);
      return raices.every((r) => t.includes(r));
    });
  }
  if (asesor) {
    // Quien envio el mensaje O propietario del usuario de
    // mensajeria: un envio automatico puede figurar a nombre del
    // usuario de integracion aunque el contacto sea del asesor.
    const a = sinTildes(asesor);
    filas = filas.filter(
      (f) =>
        sinTildes(f.enviadoPor).includes(a) ||
        sinTildes(f.asesorAsignado).includes(a)
    );
  }

  const porPersona = {};
  for (const f of filas) {
    if (!f.messagingEndUserId) continue;
    porPersona[f.messagingEndUserId] =
      (porPersona[f.messagingEndUserId] || 0) + 1;
  }

  const reincidentes = Object.entries(porPersona)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([id, errores]) => ({
      messagingEndUserId: id,
      errores,
      link: lightningUrl(inst, "MessagingEndUser", id),
    }));

  const respuesta = {
    total: filas.length,
    personasAfectadas: Object.keys(porPersona).length,
    porMotivo: contar(filas, (f) => f.motivo),
    porTipo: contar(filas, (f) => f.tipo),
    porCanal: contar(filas, (f) => f.canal),
    porEnviadoPor: contar(filas, (f) => f.enviadoPor),
    porAsesorAsignado: contar(filas, (f) => f.asesorAsignado),
    porPlantilla: contar(filas, (f) => f.plantillaId),
    porDia: Object.fromEntries(
      Object.entries(contar(filas, (f) => (f.fecha || "").slice(0, 10))).sort(
        (a, b) => a[0].localeCompare(b[0])
      )
    ),
    reincidentes,
  };

  if (detalle) {
    const n = Math.min(Math.max(parseInt(limite, 10) || 200, 1), 2000);
    respuesta.detalle = filas.slice(0, n).map((f) => ({
      fecha: f.fecha,
      tipo: f.tipo,
      motivo: f.motivo,
      canal: f.canal,
      enviadoPor: f.enviadoPor,
      asesorAsignado: f.asesorAsignado,
      plantillaId: f.plantillaId,
      messagingEndUserId: f.messagingEndUserId,
      link: lightningUrl(inst, "MessagingEndUser", f.messagingEndUserId),
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

const esErrorDeCampo = (msg) =>
  /INVALID_FIELD|relationship|No such column/i.test(msg);

export async function traerErrores(params = {}) {
  const { inicio, fin } = rangoFechas(params);
  const { query, inst } = await clienteSoql({ conInstancia: true });

  // Prueba de mas a menos campos de relacion. Sin permiso de
  // lectura sobre alguno, baja de nivel; los campos base
  // alcanzan para los conteos.
  let ultimoError;
  for (let nivel = 0; nivel < NIVELES_RELACION.length; nivel++) {
    try {
      const registros = await query(armarSoql({ inicio, fin, ...params }, nivel));
      return { registros, inicio, fin, inst, nivelRelacion: nivel };
    } catch (err) {
      if (!esErrorDeCampo(err.message)) throw err;
      ultimoError = err;
    }
  }
  throw ultimoError;
}

export function montarErroresMensajeria(app, auth) {
  app.get("/mensajeria/errores", auth, async (req, res) => {
    try {
      const q = req.query;
      const si = (v) => v === "true" || v === "si";
      const detalle = si(q.detalle);
      const enmascarar = process.env.ENMASCARAR_PII !== "false";
      const conNombres = nombresPermitidos(si(q.nombres));

      const { registros, inicio, fin, inst, nivelRelacion } =
        await traerErrores(q);

      res.json({
        ok: true,
        desde: inicio.toISOString(),
        hasta: fin.toISOString(),
        piiEnmascarada: enmascarar && !conNombres,
        nombresIncluidos: detalle && conNombres,
        // 0 = con contacto y asesor asignado, 1 = sin ellos,
        // 2 = solo campos base (ver NIVELES_RELACION)
        nivelRelacion,
        ...resumirErrores(registros, {
          motivo: q.motivo,
          asesor: q.asesor,
          detalle,
          limite: q.limite,
          enmascarar,
          conNombres,
          inst,
        }),
      });
    } catch (err) {
      console.error("Error /mensajeria/errores:", err);
      const esPermiso = /INSUFFICIENT_ACCESS|INVALID_TYPE|sObject type/i.test(
        err.message
      );
      res.status(esPermiso ? 403 : 500).json({
        ok: false,
        error: esPermiso
          ? "La integracion no puede leer MessagingDeliveryError. Revisar permisos del usuario de la Connected App."
          : err.message,
      });
    }
  });
}
