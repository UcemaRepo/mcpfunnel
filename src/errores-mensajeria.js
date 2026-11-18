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
// de mensajeria y el link a su ficha en Lightning. El telefono
// sale enmascarado y el nombre solo aparece si ENMASCARAR_PII
// es "false", igual que en el resto del servidor.
// ============================================================

import { clienteSoql, soqlSeguro } from "./persona.js";
import { maskTel } from "./transform.js";

const DIA = 24 * 60 * 60 * 1000;
const MAX_DIAS = 90;

const CAMPOS_BASE = `Id, CreatedDate, Type, FailureReason,
  DestinationPhoneNumber, MessagingEndUserId, MessagingChannelId,
  MessagingTemplateId, CreatedById`;

// Campos por relacion. Si la integracion no puede leer alguno,
// la consulta se repite solo con los campos base.
const CAMPOS_RELACION = `, MessagingEndUser.Name,
  MessagingChannel.MasterLabel, CreatedBy.Name`;

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

export function rangoFechas({ dias, desde, hasta } = {}, ahora = new Date()) {
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

export function armarSoql({ inicio, fin, tipo, motivo }, conRelaciones = true) {
  const filtros = [
    `CreatedDate >= ${fechaSoql(inicio)}`,
    `CreatedDate <= ${fechaSoql(fin)}`,
  ];
  if (tipo) filtros.push(`Type = '${soqlSeguro(tipo)}'`);
  // FailureReason puede ser texto largo: no admite LIKE en SOQL,
  // por eso el filtro por motivo se aplica despues, en JS.

  return `SELECT ${CAMPOS_BASE}${conRelaciones ? CAMPOS_RELACION : ""}
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
    ".lightning.force.com",
  );
  return `${base}/lightning/r/${objeto}/${id}/view`;
}

export function resumirErrores(registros, opts = {}) {
  const {
    motivo,
    asesor,
    detalle = false,
    limite = 200,
    enmascarar = true,
    inst = "",
  } = opts;

  let filas = registros.map((r) => ({
    id: r.Id,
    fecha: r.CreatedDate,
    tipo: r.Type || null,
    motivo: r.FailureReason || null,
    canal: r.MessagingChannel?.MasterLabel || r.MessagingChannelId || null,
    enviadoPor: r.CreatedBy?.Name || r.CreatedById || null,
    plantillaId: r.MessagingTemplateId || null,
    messagingEndUserId: r.MessagingEndUserId || null,
    nombre: r.MessagingEndUser?.Name || null,
    telefono: r.DestinationPhoneNumber || null,
  }));

  if (motivo) {
    // Compara por raiz de cada palabra: "bloqueado" encuentra
    // "bloqueo", "bloqueó" y "blocked" no (el motivo puede venir
    // en ingles: conviene probar ambos idiomas).
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
    const a = sinTildes(asesor);
    filas = filas.filter((f) => sinTildes(f.enviadoPor).includes(a));
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
    porPlantilla: contar(filas, (f) => f.plantillaId),
    porDia: Object.fromEntries(
      Object.entries(contar(filas, (f) => (f.fecha || "").slice(0, 10))).sort(
        (a, b) => a[0].localeCompare(b[0]),
      ),
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
      plantillaId: f.plantillaId,
      messagingEndUserId: f.messagingEndUserId,
      link: lightningUrl(inst, "MessagingEndUser", f.messagingEndUserId),
      telefono: maskTel(f.telefono, enmascarar) || null,
      ...(!enmascarar && { nombre: f.nombre }),
    }));
    respuesta.detalleTruncado = filas.length > n;
  }

  return respuesta;
}

export async function traerErrores(params = {}) {
  const { inicio, fin } = rangoFechas(params);
  const { query, inst } = await clienteSoql({ conInstancia: true });

  let registros;
  let conRelaciones = true;
  try {
    registros = await query(armarSoql({ inicio, fin, ...params }, true));
  } catch (err) {
    // Sin permiso de lectura sobre alguna relacion: reintenta
    // con los campos base, que alcanzan para los conteos.
    if (!/INVALID_FIELD|relationship|No such column/i.test(err.message)) {
      throw err;
    }
    conRelaciones = false;
    registros = await query(armarSoql({ inicio, fin, ...params }, false));
  }

  return { registros, inicio, fin, inst, conRelaciones };
}

export function montarErroresMensajeria(app, auth) {
  app.get("/mensajeria/errores", auth, async (req, res) => {
    try {
      const q = req.query;
      const detalle = q.detalle === "true" || q.detalle === "si";
      const enmascarar = process.env.ENMASCARAR_PII !== "false";

      const { registros, inicio, fin, inst, conRelaciones } =
        await traerErrores(q);

      res.json({
        ok: true,
        desde: inicio.toISOString(),
        hasta: fin.toISOString(),
        piiEnmascarada: enmascarar,
        camposDeRelacion: conRelaciones,
        ...resumirErrores(registros, {
          motivo: q.motivo,
          asesor: q.asesor,
          detalle,
          limite: q.limite,
          enmascarar,
          inst,
        }),
      });
    } catch (err) {
      console.error("Error /mensajeria/errores:", err);
      const esPermiso = /INSUFFICIENT_ACCESS|INVALID_TYPE|sObject type/i.test(
        err.message,
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
