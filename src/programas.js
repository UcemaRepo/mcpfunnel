// ============================================================
// programas.js — catalogo de codigos de programa
// ============================================================
//
// En Formulario_web__c el programa viene como sigla ("MAF",
// "INIA", "EGP N"). Sin un catalogo no hay forma de saber si un
// lead es de grado o de posgrado, y esa distincion es la que
// define que entra al dataset.
//
// El sufijo " N" que traen algunos codigos ("MADE N", "EGP N")
// parece ser una variante de carga, no un programa distinto:
// se normaliza antes de clasificar.
//
// IMPORTANTE: los codigos marcados con //? estan inferidos por
// el prefijo, no confirmados. Si alguno esta mal clasificado,
// se corrige aca y nada mas.
// ============================================================

// ── Grado ───────────────────────────────────────────────────
export const GRADO = {
  INIA: "Ingeniería en Inteligencia Artificial",
  ININF: "Ingeniería en Informática",
  ABOG: "Abogacía",
  LICP: "Lic. en Ciencias Políticas",
  LIE: "Lic. en Economía",
  LIRI: "Lic. en Relaciones Internacionales",
  LIFI: "Lic. en Finanzas",
  LIND: "Lic. en Negocios Digitales",
  LIMA: "Lic. en Marketing",
  LIA: "Lic. en Administración de Empresas",
  CPN: "Contador Público",
  LEC: "Lic. en Economía Empresarial",
  LDI: "Lic. en Dirección de Empresas",
};

// ── Posgrado ────────────────────────────────────────────────
export const POSGRADO = {
  MADE: "Maestría en Dirección de Empresas",
  MAF: "Maestría en Finanzas",
  MAE: "Maestría en Economía",
  MAG: "Maestría en Agronegocios",
  MEI: "Maestría en Evaluación de Impacto", //?
  EGP: "Especialización en Gestión Pública", //?
  EGN: "Especialización en Gestión de Negocios", //?
  EMKT: "Especialización en Marketing", //?
  EFI: "Especialización en Finanzas", //?
  PCON: "Programa de Consultoría", //?
  PEICP: "Programa Ejecutivo", //?
  PRRHH: "Programa de Recursos Humanos", //?
  PND: "Programa de Negocios Digitales", //?
  PDA: "Programa de Dirección Avanzada", //?
  DOFI: "Doctorado en Finanzas", //?
  DOE: "Doctorado en Economía", //?
  DDE: "Doctorado en Dirección de Empresas", //?
  CeNB: "Certificación en Negocios", //?
  CeNES: "Certificación en Negocios y Estrategia", //?
};

// Normaliza: quita el sufijo " N" y espacios sobrantes.
export function normalizarCodigo(codigo) {
  return String(codigo || "")
    .trim()
    .replace(/\s+N$/i, "")
    .toUpperCase();
}

// Un campo puede traer varios codigos: "ABOG N, LICP N, LIE N"
export function separarCodigos(valor) {
  return String(valor || "")
    .split(/[,;]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

const GRADO_UP = Object.fromEntries(
  Object.entries(GRADO).map(([k, v]) => [k.toUpperCase(), v])
);

const POSGRADO_UP = Object.fromEntries(
  Object.entries(POSGRADO).map(([k, v]) => [k.toUpperCase(), v])
);

// ------------------------------------------------------------
// Clasificacion de UN codigo
// ------------------------------------------------------------
// Devuelve "grado", "posgrado" o "desconocido".
//
// Un codigo fuera del catalogo NO se adivina por prefijo: se
// marca desconocido. Adivinar mal es peor que no saber, porque
// mete un posgrado en un conteo de grado sin que nadie se
// entere.
// ------------------------------------------------------------

export function clasificarCodigo(codigo) {
  const c = normalizarCodigo(codigo);
  if (!c) return "desconocido";
  if (GRADO_UP[c]) return "grado";
  if (POSGRADO_UP[c]) return "posgrado";
  return "desconocido";
}

export function nombreDe(codigo) {
  const c = normalizarCodigo(codigo);
  return GRADO_UP[c] || POSGRADO_UP[c] || codigo || "";
}

// ------------------------------------------------------------
// Clasificacion de un CAMPO completo
// ------------------------------------------------------------
// Si el campo trae varios codigos y son de distinto tipo, el
// resultado es "mixto": es justo el caso que interesa detectar
// (alguien que consulto por una maestria y tambien por grado).
// ------------------------------------------------------------

export function clasificarCampo(valor) {
  const codigos = separarCodigos(valor);

  if (!codigos.length) return { tipo: "sin_programa", codigos: [] };

  const detalle = codigos.map((c) => ({
    codigo: normalizarCodigo(c),
    nombre: nombreDe(c),
    tipo: clasificarCodigo(c),
  }));

  const tipos = new Set(detalle.map((d) => d.tipo));

  let tipo;
  if (tipos.size === 1) {
    tipo = [...tipos][0];
  } else if (tipos.has("grado") && tipos.has("posgrado")) {
    tipo = "mixto";
  } else {
    // grado o posgrado + algun desconocido: manda el conocido
    tipo = tipos.has("grado")
      ? "grado"
      : tipos.has("posgrado")
        ? "posgrado"
        : "desconocido";
  }

  return { tipo, codigos: detalle };
}

// Codigos de posgrado en formato SOQL, para filtrar del lado
// de Salesforce en vez de traer todo y descartar aca.
export const CODIGOS_POSGRADO_SOQL = Object.keys(POSGRADO)
  .flatMap((c) => [`'${c}'`, `'${c} N'`])
  .join(", ");

export const CODIGOS_GRADO_SOQL = Object.keys(GRADO)
  .flatMap((c) => [`'${c}'`, `'${c} N'`])
  .join(", ");
