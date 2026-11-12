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
