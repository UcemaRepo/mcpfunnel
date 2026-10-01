// Herramienta para LeadFunnel: admitidos por MES DE ADMISIÓN de una cohorte.
// Es lo que necesita Tech&Grow para comparar campañas "al mismo punto" y
// proyectar mes a mes. Devuelve sólo conteos (sin nombres ni datos personales).
//
// Cómo integrarla:
//  1. Copiá este archivo en tu proyecto de LeadFunnel.
//  2. En `obtenerAdmitidos(termino)` usá la misma fuente que ya usa tu herramienta
//     "admitidos" (sesión en memoria o consulta a Salesforce) y devolvé la lista de registros.
//  3. Registrá la herramienta con el nombre "admitidos_por_mes" (ver ejemplos al final).
// Tech&Grow la detecta sola por el nombre.

// Campos de fecha que se prueban, en orden. Agregá el de tu org si es otro
// (por ejemplo Fecha_de_Admision__c).
const CAMPOS_FECHA = ['Fecha_de_Admision__c', 'FechaAdmision__c', 'fechaAdmision', 'fecha_admision', 'Fecha_Admision__c', 'CreatedDate', 'createdDate', 'fecha'];

function campoFechaDe(registros) {
  for (const c of CAMPOS_FECHA) if (registros.some((r) => r && /^\d{4}-\d{2}/.test(String(r[c] ?? '')))) return c;
  // Último recurso: el primer campo que tenga fechas ISO en la mayoría de los registros.
  const claves = Object.keys(registros[0] || {});
  return claves.find((k) => registros.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(String(r[k] ?? ''))).length >= registros.length * 0.6) || null;
}

/**
 * @param {object[]} registros  admitidos de la cohorte (como los devuelve tu herramienta "admitidos")
 * @param {{ campoFecha?: string }} [opciones]
 * @returns {{ totalAdmitidos: number, campoFecha: string|null, sinFecha: number, curva: {mes: string, admitidos: number, acumulado: number}[] }}
 */
function admitidosPorMes(registros, opciones = {}) {
  const campo = opciones.campoFecha || campoFechaDe(registros);
  const porMes = {};
  let sinFecha = 0;
  for (const r of registros) {
    const mes = campo ? String(r[campo] ?? '').slice(0, 7) : '';
    if (/^\d{4}-\d{2}$/.test(mes)) porMes[mes] = (porMes[mes] || 0) + 1; else sinFecha++;
  }
  let acumulado = 0;
  const curva = Object.keys(porMes).sort().map((mes) => ({ mes, admitidos: porMes[mes], acumulado: (acumulado += porMes[mes]) }));
  return { totalAdmitidos: registros.length, campoFecha: campo, sinFecha, curva };
}

module.exports = { admitidosPorMes, campoFechaDe };

/* ---------- Ejemplo con @modelcontextprotocol/sdk ----------
const { z } = require('zod');
server.registerTool('admitidos_por_mes', {
  title: 'Admitidos por mes de admisión',
  description: 'Cantidad de admitidos de una cohorte por mes en que fueron admitidos (sin datos personales). Usar para comparar campañas al mismo punto y proyectar.',
  inputSchema: { termino: z.string().describe("Cohorte: '2027S1', '2027SEM1' o '2026S2'") },
}, async ({ termino }) => {
  const registros = await obtenerAdmitidos(termino);           // tu función actual
  const r = admitidosPorMes(registros);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, termino, ...r }) }] };
});

---------- Ejemplo si tu servidor maneja tools/call a mano ----------
case 'admitidos_por_mes': {
  const registros = await obtenerAdmitidos(args.termino);
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, termino: args.termino, ...admitidosPorMes(registros) }) }] };
}
------------------------------------------------------------------ */
