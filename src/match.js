// ============================================================
// match.js — recuperar el formulario de admitidos sin DNI
// ============================================================
//
// Por que existe:
//
// El cruce admitido <-> formulario era solo por DNI. Revisando
// los admitidos 2027S1 sin formulario aparecieron tres casos:
//
//   1. Formulario cargado SIN DNI. Tipico del formulario que el
//      asesor completa en el momento de inscribir ("Llamado o
//      WA Espontaneo"), segundos antes de crear la Application.
//   2. Formulario de otra cohorte o sin semestre: el cruce
//      filtraba por cohorte ANTES de buscar el DNI.
//   3. Sin formulario en absoluto (solicitud directa).
//
// Este modulo resuelve el 1 (DNI inferido por nombre) y marca
// los formularios de inscripcion, que no sirven para saber el
// primer contacto. El 2 se arregla en resumirAdmitidosCapitas.
// El 3 no tiene arreglo: se informa en /admitidos/sin-match.
// ============================================================

import { normalizar } from "./transform.js";

const esDniValido = (d) => /^\d{6,9}$/.test(String(d || ""));

// Tokens de un nombre, sin tildes ni signos. Se descartan los
// de una letra ("Tomas ." / iniciales).
export function tokensNombre(texto) {
  return normalizar(texto)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

const fechaMs = (iso) => {
  const t = Date.parse(iso || "");
  return isNaN(t) ? null : t;
};

const fechaApp = (app) =>
  fechaMs(app.fechaCreacion) ?? fechaMs(app.fechaSolicitud);

const DIA = 24 * 60 * 60 * 1000;

// Ventana para inferir: el formulario puede ser anterior a la
// Application (cualquier momento) o hasta 3 dias posterior.
const MARGEN_POSTERIOR = 3 * DIA;

// ------------------------------------------------------------
// Indice de Applications admitidas por token de nombre
// ------------------------------------------------------------

export function indexarAppsPorNombre(apps) {
  const porToken = new Map();
  const tokensDe = new Map();

  for (const app of apps) {
    if (!esDniValido(app.dni)) continue;
    const toks = new Set(tokensNombre(app.nombreAlumno));
    if (toks.size < 2) continue;

    tokensDe.set(app, toks);

    for (const t of toks) {
      if (!porToken.has(t)) porToken.set(t, new Set());
      porToken.get(t).add(app);
    }
  }

  return { porToken, tokensDe };
}

// Devuelve { dni, app } si el nombre del formulario coincide con
// UNA sola persona admitida; si hay ambiguedad, null.
//
// Regla: todos los tokens del formulario (al menos 2) estan en el
// nombre de la Application. "Sofia Romero" matchea "Sofia Belen
// Romero Romanelli"; "Tomas" solo, no.
export function inferirDniPorNombre(r, indice) {
  const toks = tokensNombre(`${r.Nombres__c || ""} ${r.Apellidos__c || ""}`);
  if (toks.length < 2) return null;

  let candidatos = null;
  for (const t of toks) {
    const set = indice.porToken.get(t);
    if (!set) return null;
    candidatos = candidatos
      ? new Set([...candidatos].filter((a) => set.has(a)))
      : new Set(set);
    if (!candidatos.size) return null;
  }

  const fForm = fechaMs(r.CreatedDate);
  const validos = [...candidatos].filter((app) => {
    const fA = fechaApp(app);
    return fForm == null || fA == null || fForm <= fA + MARGEN_POSTERIOR;
  });

  const dnis = new Set(validos.map((a) => a.dni));
  if (dnis.size !== 1) return null;

  return { dni: validos[0].dni, app: validos[0] };
}

// Formulario cargado dentro de las 24 h de la Application (antes
// o despues): es el de inscripcion, no el primer contacto.
export function esFormularioInscripcion(createdDate, aplicaciones = []) {
  const f = fechaMs(createdDate);
  if (f == null) return false;
  return aplicaciones.some((app) => {
    const fA = fechaApp(app);
    return fA != null && Math.abs(f - fA) <= DIA;
  });
}

// ------------------------------------------------------------
// Mail y telefono
// ------------------------------------------------------------
//
// Cuando el formulario no tiene DNI y el nombre no alcanza, se
// prueba con el mail y despues con el telefono del Contact de la
// Application admitida. Mismas reglas que por nombre: solo contra
// admitidos, una sola persona y la misma ventana de fechas.
//
// Los datos de contacto de la Application viajan como propiedades
// NO enumerables (ver conContacto en salesforce.js): no se
// serializan, asi que nunca salen en una respuesta.
// ------------------------------------------------------------

export function normalizarEmail(texto) {
  const e = String(texto || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Ultimos 8 digitos: iguala "+54 9 11 5555-1234", "011 15 5555 1234"
// y "1155551234". Menos de 8 digitos no alcanza para identificar.
export function normalizarTelefono(texto) {
  const d = String(texto || "").replace(/\D/g, "");
  if (d.length < 8) return null;
  const ult = d.slice(-8);
  return /^(\d)\1{7}$/.test(ult) ? null : ult; // descarta 11111111
}

export function indexarAppsPorContacto(apps) {
  const porEmail = new Map();
  const porTelefono = new Map();

  const sumar = (mapa, clave, app) => {
    if (!clave) return;
    if (!mapa.has(clave)) mapa.set(clave, new Set());
    mapa.get(clave).add(app);
  };

  for (const app of apps) {
    if (!esDniValido(app.dni)) continue;
    sumar(porEmail, normalizarEmail(app.emailContacto), app);
    for (const t of app.telefonosContacto || []) {
      sumar(porTelefono, normalizarTelefono(t), app);
    }
  }

  return { porEmail, porTelefono };
}

function unicaEnVentana(candidatos, createdDate) {
  if (!candidatos || !candidatos.size) return null;
  const fForm = fechaMs(createdDate);
  const validos = [...candidatos].filter((app) => {
    const fA = fechaApp(app);
    return fForm == null || fA == null || fForm <= fA + MARGEN_POSTERIOR;
  });
  const dnis = new Set(validos.map((a) => a.dni));
  return dnis.size === 1 ? validos[0] : null;
}

// Devuelve { dni, app, metodo: "email" | "telefono" } o null.
export function inferirDniPorContacto(r, indice) {
  const email = normalizarEmail(r.Correo_electronico__c);
  const porMail = email && unicaEnVentana(indice.porEmail.get(email), r.CreatedDate);
  if (porMail) return { dni: porMail.dni, app: porMail, metodo: "email" };

  const tel = normalizarTelefono(r.Telefono__c);
  const porTel = tel && unicaEnVentana(indice.porTelefono.get(tel), r.CreatedDate);
  if (porTel) return { dni: porTel.dni, app: porTel, metodo: "telefono" };

  return null;
}

// Para un formulario CON DNI que no es de ningun admitido (DNI mal
// tipeado): solo se acepta el cruce por mail/telefono si ademas
// comparten al menos una palabra del nombre. Evita pasarle el
// formulario de un hermano al admitido que dejo el mismo mail.
export function compartenNombre(r, app) {
  const a = new Set(tokensNombre(app.nombreAlumno));
  return tokensNombre(`${r.Nombres__c || ""} ${r.Apellidos__c || ""}`).some(
    (t) => t.length >= 3 && a.has(t)
  );
}
