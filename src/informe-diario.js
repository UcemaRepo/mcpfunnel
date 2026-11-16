// ============================================================
// informe-diario.js — mail con el informe de conciliación
// ============================================================
//
// Los LUNES, entre las 9:00 y las 9:59 (hora de Argentina), arma
// el informe de conciliación y lo manda por mail UNA vez.
// (El nombre del archivo dice "diario" por historia: los días de
// envío se definen en DIAS_DE_ENVIO.)
//
// También se puede disparar a mano en cualquier momento:
//
//   POST /informe-diario/enviar
//   POST /informe-diario/enviar?desde=2026-03-01
//
// El mail muestra cada diferencia y EN QUÉ LADO FALTA:
//
//   - Faltan en el sistema:     están en Salesforce, no en lo cargado
//   - Faltan en Salesforce:     están en lo cargado, ya no en Salesforce
//
// Lo más grave va primero (lo que existía y no se cargó), después
// lo modificado y por último lo nuevo.
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
//   INFORME_HORA=9            hora de envío (0-23), default 9
//   INFORME_DIARIO=false      apaga el envío automático
//   INFORME_MAX_DETALLE=100   cuántas diferencias lista cada sección
//   MAIL_INCLUIR_NOMBRES      "true" para incluir nombres
//
// Limitaciones: no distingue feriados. Si el servicio se reinicia
// dentro de la hora de envío, puede mandar el mail dos veces
// (el "ya enviado hoy" vive en memoria).
// ============================================================

import { ejecutarConciliacion } from "./conciliacion.js";
import { enviarMail, variablesFaltantes, destinatarios } from "./mail.js";
import { generarExcelInforme } from "./excel.js";

const TZ = "America/Argentina/Buenos_Aires";

// Días en que se envía el informe automático (hora de Argentina).
//   "Mon" lunes     "Tue" martes   "Wed" miércoles  "Thu" jueves
//   "Fri" viernes   "Sat" sábado   "Sun" domingo
const DIAS_DE_ENVIO = new Set(["Mon"]);

const MAX_INTENTOS = 3;

// ------------------------------------------------------------
// Reloj
// ------------------------------------------------------------

function horaDeEnvio() {
  const h = Number.parseInt(process.env.INFORME_HORA, 10);
  return h >= 0 && h <= 23 ? h : 9;
}

function maxDetalle() {
  const n = Number.parseInt(process.env.INFORME_MAX_DETALLE, 10);
  return n > 0 ? n : 100;
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
    DIAS_DE_ENVIO.has(ahora.dia) &&
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
    largo: "El sistema coincide con Salesforce. No hace falta hacer nada.",
  },
  SESION_DESACTUALIZADA: {
    corto: "sistema desactualizado",
    largo:
      "Hubo cambios en Salesforce después de la última carga. Conviene ejecutar /cargar.",
  },
  CON_DIFERENCIAS: {
    corto: "REVISAR",
    largo:
      "Hay leads que existían antes de la carga, nadie los modificó y no entraron en el sistema. Hay que investigar.",
  },
};

const MOTIVOS = {
  creado_despues_de_la_carga: "creado después de la carga",
  modificado_despues_de_la_carga: "modificado después de la carga",
  creado_antes_y_no_esta: "existía y no se cargó (revisar)",
  ya_no_esta_en_salesforce: "ya no está en Salesforce",
};

// Lo más grave primero
const GRAVEDAD = {
  creado_antes_y_no_esta: 0,
  modificado_despues_de_la_carga: 1,
  creado_despues_de_la_carga: 2,
};
const porGravedad = (a, b) =>
  (GRAVEDAD[a.motivo] ?? 9) - (GRAVEDAD[b.motivo] ?? 9);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const ddmmaaaa = (iso) => {
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : String(iso);
};

const motivoLegible = (m) => MOTIVOS[m] || String(m || "").replace(/_/g, " ");

function lineaDetalle(f, donde, conNombre = true) {
  const nombreCompleto = f.nombreCompleto || [f.nombre, f.apellido].filter(Boolean).join(" ") || null;
  const partes = [f.idSalesforce, `falta en: ${donde}`, motivoLegible(f.motivo)];
  if (conNombre && nombreCompleto) partes.push(nombreCompleto);
  if (f.creadoEn) partes.push(`creado ${String(f.creadoEn).slice(0, 10)}`);
  return partes.join(" | ");
}

export function armarMail(informe, { ahora, recienCargada = false } = {}) {
  const conNombres = process.env.MAIL_INCLUIR_NOMBRES !== "false";
  const limite = maxDetalle();
  const est = ESTADOS[informe.estado] || { corto: informe.estado, largo: "" };
  const fechaHoy = ddmmaaaa(ahora?.fecha || new Date().toISOString());
  const desde = ddmmaaaa(informe.alcance?.desde || "");

  const asunto = `Informe de leads UCEMA ${fechaHoy} - ${est.corto}`;

  const secciones = [
    {
      titulo: "Faltan en el sistema (están en Salesforce)",
      donde: "sistema",
      lista: [...(informe.faltantes || [])].sort(porGravedad),
    },
    {
      titulo: "Faltan en Salesforce (están en el sistema)",
      donde: "Salesforce",
      lista: informe.sobrantes || [],
    },
  ];

  const aviso = recienCargada
    ? "Nota: el sistema estaba vacío (el servicio se reinició), así que se cargó Salesforce recién para este informe. Por eso casi no puede haber diferencias."
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
  t.push(`Leads en el sistema: ${informe.totalSesion}`);
  t.push(`Cobertura:           ${informe.porcentajeCobertura}%`);
  t.push("");
  t.push(`Faltan en el sistema (están en Salesforce): ${informe.faltantesEnSesion}`);
  t.push(`   - sin explicación (revisar):       ${informe.anomalias}`);
  t.push(`   - modificados después de la carga: ${informe.modificadosDespuesDeLaCarga}`);
  t.push(`   - creados después de la carga:     ${informe.creadosDespuesDeLaCarga}`);
  t.push(`Faltan en Salesforce (están en el sistema): ${informe.sobrantesEnSesion}`);

  for (const s of secciones) {
    if (!s.lista.length) continue;

    const mostrados = Math.min(s.lista.length, limite);
    t.push("", `${s.titulo.toUpperCase()} - ${mostrados} de ${s.lista.length}:`);
    s.lista.slice(0, limite).forEach((f) => t.push(`  ${lineaDetalle(f, s.donde, conNombres)}`));
    if (s.lista.length > limite) {
      t.push(`  ... y ${s.lista.length - limite} más (el listado completo está en /conciliacion)`);
    }
  }

  const texto = t.join("\n");

  // ---- HTML -------------------------------------------------
  const fila = (a, b) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(a)}</td><td style="padding:4px 0"><b>${esc(b)}</b></td></tr>`;

  const th = (x) =>
    `<th style="text-align:left;padding:3px 10px 3px 0;border-bottom:1px solid #ccc">${esc(x)}</th>`;
  const td = (x, extra = "") =>
    `<td style="padding:3px 10px 3px 0;${extra}">${esc(x)}</td>`;

  const tabla = (s) => {
    if (!s.lista.length) return "";

    const mostrados = Math.min(s.lista.length, limite);

    const cabecera =
      `<tr>${th("ID Salesforce")}${th("Falta en")}${th("Motivo")}` +
      `${conNombres ? `${th("Nombre")}${th("Apellido")}` : ""}${th("Creado")}</tr>`;

    const filas = s.lista
      .slice(0, limite)
      .map(
        (f) =>
          `<tr>${td(f.idSalesforce, "font-family:monospace")}${td(s.donde)}${td(motivoLegible(f.motivo))}` +
          `${conNombres ? `${td(f.nombre || "")}${td(f.apellido || "")}` : ""}${td(f.creadoEn ? String(f.creadoEn).slice(0, 10) : "")}</tr>`
      )
      .join("");

    const mas =
      s.lista.length > limite
        ? `<p style="color:#555">... y ${s.lista.length - limite} más (el listado completo está en /conciliacion).</p>`
        : "";

    return (
      `<h3 style="margin:20px 0 6px">${esc(s.titulo)} (${mostrados} de ${s.lista.length})</h3>` +
      `<table style="border-collapse:collapse;font-size:13px">${cabecera}${filas}</table>${mas}`
    );
  };

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:720px">` +
    `<h2 style="margin:0 0 4px">Informe de conciliación de leads</h2>` +
    `<p style="margin:0;color:#555">${esc(fechaHoy)} · comparación desde ${esc(desde)}</p>` +
    `<p style="margin:16px 0 4px"><b>Estado: ${esc(informe.estado)}</b></p>` +
    `<p style="margin:0">${esc(est.largo)}</p>` +
    (aviso ? `<p style="margin:12px 0;color:#8a5a00">${esc(aviso)}</p>` : "") +
    `<table style="margin-top:14px">` +
    fila("Leads en Salesforce", informe.totalSalesforce) +
    fila("Leads en el sistema", informe.totalSesion) +
    fila("Cobertura", `${informe.porcentajeCobertura}%`) +
    fila("Faltan en el sistema (están en Salesforce)", informe.faltantesEnSesion) +
    fila("   sin explicación (revisar)", informe.anomalias) +
    fila("   modificados después de la carga", informe.modificadosDespuesDeLaCarga) +
    fila("   creados después de la carga", informe.creadosDespuesDeLaCarga) +
    fila("Faltan en Salesforce (están en el sistema)", informe.sobrantesEnSesion) +
    `</table>` +
    secciones.map(tabla).join("") +
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
//
// opciones.desde: AAAA-MM-DD (opcional, default 2026-01-01)
// ------------------------------------------------------------

export async function enviarInformeDiario(deps, { desde } = {}) {
  const { data, recienCargada } = await deps.asegurarSesion();

  const informe = await ejecutarConciliacion(data, deps.traerFormularios, desde);

  const ahora = ahoraAR();
  const mail = armarMail(informe, { ahora, recienCargada });

  // Generar y adjuntar archivo Excel (.xlsx)
  const bufferExcel = await generarExcelInforme(informe, { ahora });
  const fechaArchivo = ahora?.fecha || new Date().toISOString().slice(0, 10);
  const nombreArchivo = `informe-leads-ucema-${fechaArchivo}.xlsx`;

  mail.attachments = [
    {
      filename: nombreArchivo,
      content: Buffer.from(bufferExcel).toString("base64"),
    },
  ];

  const idMail = await enviarMail(mail);

  return {
    idMail,
    estado: informe.estado,
    destinatarios: destinatarios().length,
    recienCargada,
    faltanEnSistema: informe.faltantesEnSesion,
    faltanEnSalesforce: informe.sobrantesEnSesion,
    sinExplicacion: informe.anomalias,
    archivoAdjunto: nombreArchivo,
  };
}

async function avisarFallo(error) {
  await enviarMail({
    asunto: "Informe de leads UCEMA - NO SE PUDO GENERAR",
    texto: `No se pudo generar el informe después de ${MAX_INTENTOS} intentos.\n\nError: ${String(error.message).slice(0, 300)}\n\nRevisá los logs del servicio en Render.`,
    html: `<p>No se pudo generar el informe después de ${MAX_INTENTOS} intentos.</p><p><b>Error:</b> ${esc(String(error.message).slice(0, 300))}</p><p>Revisá los logs del servicio en Render.</p>`,
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
    console.log("Informe automático: desactivado (INFORME_DIARIO=false)");
    return null;
  }

  const faltan = variablesFaltantes();
  if (faltan.length) {
    console.warn(
      `Informe automático: desactivado, faltan variables de entorno: ${faltan.join(", ")}`
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
        `Informe enviado (${ahora.fecha}): estado ${r.estado}, ` +
          `${r.faltanEnSistema} faltan en el sistema, ${r.faltanEnSalesforce} faltan en Salesforce`
      );
    } catch (error) {
      // Hay una carga en curso: se reintenta en el próximo minuto
      if (error.code === "CARGA_EN_PROCESO") return;

      if (fallos.fecha !== ahora.fecha) fallos = { fecha: ahora.fecha, n: 0 };
      fallos.n++;

      console.error(
        `Informe automático: intento ${fallos.n}/${MAX_INTENTOS} falló: ${error.message}`
      );

      if (fallos.n >= MAX_INTENTOS) {
        ultimoDia = ahora.fecha; // no insistir más hoy
        await avisarFallo(error).catch((e) =>
          console.error(`Informe automático: tampoco se pudo enviar el aviso: ${e.message}`)
        );
      }
    } finally {
      enCurso = false;
    }
  };

  const timer = setInterval(tick, cadaMs);
  timer.unref();

  const nombres = { Mon: "lunes", Tue: "martes", Wed: "miércoles", Thu: "jueves", Fri: "viernes", Sat: "sábados", Sun: "domingos" };
  const dias = [...DIAS_DE_ENVIO].map((d) => nombres[d] || d).join(", ");
  console.log(`Informe automático: ${dias} a las ${horaDeEnvio()}:00 (hora Argentina)`);

  return { tick, detener: () => clearInterval(timer) };
}

// ------------------------------------------------------------
// Ruta manual
// ------------------------------------------------------------
//
// POST /informe-diario/enviar
// POST /informe-diario/enviar?desde=2026-03-01
//
// Hace lo mismo que el envío automático, cuando vos quieras.
// No altera el horario automático.
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
      const r = await enviarInformeDiario(deps, { desde: req.query.desde });
      return res.json({ ok: true, ...r });
    } catch (error) {
      if (!error.status) console.error(error);
      return res
        .status(error.status || 500)
        .json({ ok: false, error: error.message });
    }
  });
}
