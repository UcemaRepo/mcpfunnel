// ============================================================
// admitidos-por-mes.js — admitidos de una cohorte por MES
// ============================================================
//
// Para comparar campañas "al mismo punto" (cuántos admitidos
// tenía 2026S1 a esta altura del año pasado) hace falta saber
// en qué mes entró cada admitido. Esta función agrupa los
// admitidos de la sesión en memoria por mes, usando la mejor
// fecha disponible de cada Application:
//
//   1. fechaDecision  → hed__Application_Decision_Date__c (si la cargás)
//   2. fechaSolicitud → hed__Application_Date__c
//   3. fechaCreacion  → CreatedDate de la Application
//
// Devuelve sólo conteos: nada de nombres ni DNI.
// ============================================================

import { normalizarTermino, terminosCompatibles, terminoInfo } from "./salesforce.js";

export const CAMPOS_FECHA = ["fechaDecision", "fechaSolicitud", "fechaCreacion"];

const mesDe = (v) => {
  const s = String(v ?? "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
};

// Elige el primer campo (en orden de preferencia) que tenga fecha
// en al menos el 80% de los registros. Si ninguno llega, el que más tenga.
function elegirCampo(admitidos, forzado) {
  if (forzado && CAMPOS_FECHA.includes(forzado)) return forzado;
  let mejor = null, mejorCobertura = -1;
  for (const campo of CAMPOS_FECHA) {
    const conFecha = admitidos.filter((a) => mesDe(a[campo])).length;
    const cobertura = admitidos.length ? conFecha / admitidos.length : 0;
    if (cobertura >= 0.8) return campo;
    if (cobertura > mejorCobertura) { mejor = campo; mejorCobertura = cobertura; }
  }
  return mejorCobertura > 0 ? mejor : null;
}

export function admitidosPorMes(sesion, { termino, ano, campoFecha } = {}) {
  const todos = Array.isArray(sesion?.admitidosSalesforce) ? sesion.admitidosSalesforce : [];

  // Mismo filtro de cohorte que /admitidos, así los totales coinciden.
  let admitidos = todos;
  if (termino) {
    const buscado = normalizarTermino(termino);
    admitidos = admitidos.filter((a) => terminosCompatibles(buscado, a.termino));
  } else if (ano) {
    const buscado = String(ano).trim();
    admitidos = admitidos.filter((a) => terminoInfo(a.termino).ano === buscado);
  }

  const campo = elegirCampo(admitidos, campoFecha);
  const porMes = {};
  let sinFecha = 0;
  for (const a of admitidos) {
    const mes = campo ? mesDe(a[campo]) : null;
    if (mes) porMes[mes] = (porMes[mes] || 0) + 1;
    else sinFecha++;
  }

  let acumulado = 0;
  const curva = Object.keys(porMes).sort().map((mes) => ({
    mes,
    admitidos: porMes[mes],
    acumulado: (acumulado += porMes[mes]),
  }));

  return {
    ok: true,
    filtroAplicado: termino ? `Término ${normalizarTermino(termino)}` : ano ? `Año ${ano}` : "Todos",
    totalAdmitidos: admitidos.length,
    campoFecha: campo,
    sinFecha,
    nota: campo === "fechaDecision"
      ? "Mes de la decisión de admisión."
      : campo === "fechaSolicitud"
        ? "Mes de la solicitud (Application Date): es cuándo aplicó la persona, no cuándo se la admitió."
        : campo === "fechaCreacion"
          ? "Mes de creación de la Application en Salesforce (aproximación)."
          : "Ningún admitido tiene fecha.",
    curva,
  };
}
