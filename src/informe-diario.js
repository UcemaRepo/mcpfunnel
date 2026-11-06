// ============================================================
// informe-diario.js — mail con el informe, lunes a viernes 9:00
// ============================================================
//
// Cada día hábil, entre las 9:00 y las 9:59 (hora de Argentina),
// arma el informe de conciliación y lo manda por mail UNA vez.
//
// Por qué un temporizador propio y no un Cron Job de Render: el
// servicio ya se mantiene despierto con keepalive.js, así que
// alcanza con revisar la hora cada minuto. No agrega dependencias.
//
// Qué pasa si no hay sesión cargada (Render reinició el servicio):
// carga Salesforce primero, así el mail sale igual, y lo aclara.
//
// Fallos: reintenta cada minuto hasta 3 veces. Si sigue fallando,
// manda un aviso corto de error y no insiste más ese día.
//
// Privacidad: por defecto el mail lleva sólo IDs de Salesforce y
// motivos, SIN nombres. Para incluirlos: MAIL_INCLUIR_NOMBRES=true
//
// Variables (además de las de mail.js):
//   INFORME_HORA=9           hora de envío (0-23), default 9
//   INFORME_DIARIO=false     apaga el envío automático
//   MAIL_INCLUIR_NOMBRES     "true" para incluir nombres
//
// Limitaciones: no distingue feriados. Si el servicio se reinicia
// dentro de la hora de envío, puede mandar el mail dos veces
// (el "ya enviado hoy" vive en memoria).
// ============================================================

import { ejecutarConciliacion } from "./conciliacion.js";
import { enviarMail, variablesFaltantes, destinatarios } from "./mail.js";

const TZ = "America/Argentina/Buenos_Aires";
const DIAS_HABILES = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const MAX_DETALLE = 50;
const MAX_INTENTOS = 3;

// ------------------------------------------------------------
// Reloj
// ------------------------------------------------------------

function horaDeEnvio() {
  const h = Number.parseInt(process.env.INFORME_HORA, 10);
  return h >= 0 && h <= 23 ? h : 9;
}

export function ahoraAR(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(fecha);

  const g = (t) => partes.find((p) => p.type === t)?.value;

  return {
    fecha: `${g("year")}-${g("month")}-${g("day")}`,
    dia: g("weekday"),
    hora: Number(g("hour")),
  };
}

export function debeEnviar(ahora, ultimoDia, hora = horaDeEnvio()) {
  return (
    DIAS_HABILES.has(ahora.dia) &&
    ahora.hora === hora &&
    ahora.fecha !== ultimoDia
  );
}

// ------------------------------------------------------------
// Armado del mail
// ------------------------------------------------------------

const ESTADOS = {
  SIN_DIFERENCIAS: {
    corto: "sin diferencias",
    largo: "La sesión coincide con Salesforce. No hace falta hacer nada.",
  },
  SESION_DESACTUALIZADA: {
    corto: "sesión desactualizada",
    largo:
      "Hubo cambios en Salesforce después de la última carga. Conviene ejecutar /cargar.",
  },
  CON_DIFERENCIAS: {
    corto: "REVISAR",
    largo:
      "Hay leads que existían antes de la carga, nadie los modificó y no entraron en la sesión. Hay que investigar.",
  },
};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const ddmmaaaa = (iso) => {
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : String(iso);
};

const MOTIVOS = {
  creado_despues_de_la_carga: "creado después de la carga",
  modificado_despues_de_la_carga: "modificado después de la carga",
  creado_antes_y_no_esta: "existía y no se cargó (revisar)",
  ya_no_esta_en_salesforce: "ya no está en Salesforce",
};

const motivoLegible = (m) => MOTIVOS[m] || String(m || "").replace(/_/g, " ");

function lineaDetalle(f, conNombre) {
  const partes = [f.idSalesforce, motivoLegible(f.motivo)];
  if (conNombre && f.nombre) partes.push(f.nombre);
  if (f.creadoEn) partes.push(`creado ${String(f.creadoEn).slice(0, 10)}`);
  return partes.join(" | ");
}

export function armarMail(informe, { ahora, recienCargada = false } = {}) {
  const conNombres = process.env.MAIL_INCLUIR_NOMBRES === "true";
  const est = ESTADOS[informe.estado] || { corto: informe.estado, largo: "" };
  const fechaHoy = ddmmaaaa(ahora?.fecha || new Date().toISOString());
  const desde = ddmmaaaa(informe.alcance?.desde || "");

  const asunto = `Informe de leads UCEMA ${fechaHoy} - ${est.corto}`;

  const faltantes = informe.faltantes || [];
  const sobrantes = informe.sobrantes || [];

  const aviso = recienCargada
    ? "Nota: la sesión estaba vacía (el servicio se reinició), así que se cargó Salesforce recién para este informe. Por eso casi no puede haber diferencias."
    : "";

  // ---- Texto plano ------------------------------------------
  const t = [];
  t.push("INFORME DE CONCILIACIÓN DE LEADS");
  t.push(`Fecha: ${fechaHoy}   |   Comparación desde: ${desde}`);
  t.push("");
  t.push(`Estado: ${informe.estado}`);
  t.push(est.largo);
  if (aviso) t.push("", aviso);
  t.push("");
  t.push(`Leads en Salesforce: ${informe.totalSalesforce}`);
  t.push(`Leads en la sesión:  ${informe.totalSesion}`);
  t.push(`Cobertura:           ${informe.porcentajeCobertura}%`);
  t.push("");
  t.push(`Faltan en la sesión: ${informe.faltantesEnSesion}`);
  t.push(`  - creados después de la carga:     ${informe.creadosDespuesDeLaCarga}`);
  t.push(`  - modificados después de la carga: ${informe.modificadosDespuesDeLaCarga}`);
  t.push(`  - sin explicación (revisar):       ${informe.anomalias}`);
  t.push(`Sobran en la sesión: ${informe.sobrantesEnSesion}`);

  const bloque = (titulo, lista) => {
    if (!lista.length) return;
    t.push("", `${titulo} (${Math.min(lista.length, MAX_DETALLE)} de ${lista.length}):`);
    lista.slice(0, MAX_DETALLE).forEach((f) => t.push(`  ${lineaDetalle(f, conNombres)}`));
    if (lista.length > MAX_DETALLE) t.push(`  ... y ${lista.length - MAX_DETALLE} más`);
  };

  bloque("Faltan en la sesión", faltantes);
  bloque("Sobran en la sesión", sobrantes);

  const texto = t.join("\n");

  // ---- HTML -------------------------------------------------
  const fila = (a, b) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(a)}</td><td style="padding:4px 0"><b>${esc(b)}</b></td></tr>`;

  const tabla = (titulo, lista) => {
    if (!lista.length) return "";
    const filas = lista
      .slice(0, MAX_DETALLE)
      .map(
        (f) =>
          `<tr><td style="padding:3px 10px 3px 0;font-family:monospace">${esc(f.idSalesforce)}</td>` +
          `<td style="padding:3px 10px 3px 0">${esc(motivoLegible(f.motivo))}</td>` +
          `<td style="padding:3px 10px 3px 0">${conNombres ? esc(f.nombre || "") : ""}</td>` +
          `<td style="padding:3px 0">${esc(f.creadoEn ? String(f.creadoEn).slice(0, 10) : "")}</td></tr>`
      )
      .join("");
    const mas =
      lista.length > MAX_DETALLE
        ? `<p style="color:#555">... y ${lista.length - MAX_DETALLE} más.</p>`
        : "";
    return (
      `<h3 style="margin:20px 0 6px">${esc(titulo)} (${Math.min(lista.length, MAX_DETALLE)} de ${lista.length})</h3>` +
      `<table style="border-collapse:collapse;font-size:13px">${filas}</table>${mas}`
    );
  };

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:680px">` +
    `<h2 style="margin:0 0 4px">Informe de conciliación de leads</h2>` +
    `<p style="margin:0;color:#555">${esc(fechaHoy)} · comparación desde ${esc(desde)}</p>` +
    `<p style="margin:16px 0 4px"><b>Estado: ${esc(informe.estado)}</b></p>` +
    `<p style="margin:0">${esc(est.largo)}</p>` +
    (aviso ? `<p style="margin:12px 0;color:#8a5a00">${esc(aviso)}</p>` : "") +
    `<table style="margin-top:14px">` +
    fila("Leads en Salesforce", informe.totalSalesforce) +
    fila("Leads en la sesión", informe.totalSesion) +
    fila("Cobertura", `${informe.porcentajeCobertura}%`) +
    fila("Faltan en la sesión", informe.faltantesEnSesion) +
    fila("   creados después de la carga", informe.creadosDespuesDeLaCarga) +
    fila("   modificados después de la carga", informe.modificadosDespuesDeLaCarga) +
    fila("   sin explicación (revisar)", informe.anomalias) +
    fila("Sobran en la sesión", informe.sobrantesEnSesion) +
    `</table>` +
    tabla("Faltan en la sesión", faltantes) +
    tabla("Sobran en la sesión", sobrantes) +
    `</div>`;

  return { asunto, texto, html };
}

// ------------------------------------------------------------
// Generar y enviar
// ------------------------------------------------------------
//
// deps (los pasa server.js):
//   asegurarSesion()      -> { data, recienCargada }
//   traerFormularios(...) -> leads actuales de Salesforce
// ------------------------------------------------------------

export async function enviarInformeDiario(deps) {
  const { data, recienCargada } = await deps.asegurarSesion();

  const informe = await ejecutarConciliacion(data, deps.traerFormularios);

  const mail = armarMail(informe, { ahora: ahoraAR(), recienCargada });
  const idMail = await enviarMail(mail);

  return {
    idMail,
    estado: informe.estado,
    destinatarios: destinatarios().length,
    recienCargada,
    faltantes: informe.faltantesEnSesion,
    sobrantes: informe.sobrantesEnSesion,
  };
}

async function avisarFallo(error) {
  await enviarMail({
    asunto: "Informe de leads UCEMA - NO SE PUDO GENERAR",
    texto: `No se pudo generar el informe diario después de ${MAX_INTENTOS} intentos.\n\nError: ${String(error.message).slice(0, 300)}\n\nRevisá los logs del servicio en Render.`,
    html: `<p>No se pudo generar el informe diario después de ${MAX_INTENTOS} intentos.</p><p><b>Error:</b> ${esc(String(error.message).slice(0, 300))}</p><p>Revisá los logs del servicio en Render.</p>`,
  });
}

// ------------------------------------------------------------
// Programación
// ------------------------------------------------------------
//
// Devuelve { tick, detener } (o null si queda deshabilitado).
// tick y reloj son inyectables para poder probarlo sin esperar
// a las 9 de la mañana.
// ------------------------------------------------------------

export function iniciarInformeDiario(deps, opciones = {}) {
  const { reloj = () => ahoraAR(), cadaMs = 60_000 } = opciones;

  if (process.env.INFORME_DIARIO === "false") {
    console.log("Informe diario: desactivado (INFORME_DIARIO=false)");
    return null;
  }

  const faltan = variablesFaltantes();
  if (faltan.length) {
    console.warn(
      `Informe diario: desactivado, faltan variables de entorno: ${faltan.join(", ")}`
    );
    return null;
  }

  let ultimoDia = null;
  let enCurso = false;
  let fallos = { fecha: null, n: 0 };

  const tick = async () => {
    const ahora = reloj();

    if (enCurso || !debeEnviar(ahora, ultimoDia)) return;

    enCurso = true;

    try {
      const r = await enviarInformeDiario(deps);
      ultimoDia = ahora.fecha;
      console.log(
        `Informe diario enviado (${ahora.fecha}): estado ${r.estado}, ` +
          `${r.faltantes} faltantes, ${r.sobrantes} sobrantes`
      );
    } catch (error) {
      // Hay una carga en curso: se reintenta en el próximo minuto
      if (error.code === "CARGA_EN_PROCESO") return;

      if (fallos.fecha !== ahora.fecha) fallos = { fecha: ahora.fecha, n: 0 };
      fallos.n++;

      console.error(
        `Informe diario: intento ${fallos.n}/${MAX_INTENTOS} falló: ${error.message}`
      );

      if (fallos.n >= MAX_INTENTOS) {
        ultimoDia = ahora.fecha; // no insistir más hoy
        await avisarFallo(error).catch((e) =>
          console.error(`Informe diario: tampoco se pudo enviar el aviso: ${e.message}`)
        );
      }
    } finally {
      enCurso = false;
    }
  };

  const timer = setInterval(tick, cadaMs);
  timer.unref();

  console.log(
    `Informe diario: lunes a viernes a las ${horaDeEnvio()}:00 (hora Argentina)`
  );

  return { tick, detener: () => clearInterval(timer) };
}

// ------------------------------------------------------------
// Ruta manual (para probar sin esperar a las 9)
// ------------------------------------------------------------
//
// POST /informe-diario/enviar
// ------------------------------------------------------------

export function montarInformeDiario(app, auth, deps) {
  app.post("/informe-diario/enviar", auth, async (req, res) => {
    const faltan = variablesFaltantes();

    if (faltan.length) {
      return res.status(400).json({
        ok: false,
        error: `Faltan variables de entorno: ${faltan.join(", ")}`,
      });
    }

    try {
      const r = await enviarInformeDiario(deps);
      return res.json({ ok: true, ...r });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });
}
