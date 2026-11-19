// ============================================================
// calidad.js — calidad de lead por reglas de admisiones
// ============================================================
//
// Reglas definidas por el equipo (nov 2026), en orden de
// precedencia: la primera que aplica gana.
//
//   MALA        - DNI fuera de rango (< 44.000.000 o >= 50.000.000)
//               - ingreso un año o mas despues del objetivo
//                 (con objetivo 2027S1: 2028S1, 2029S1, ...)
//               - mas de 4 carreras elegidas en el formulario
//   MEDIA_BAJA  - 3 o 4 carreras elegidas
//               - formulario de feria comprada (UCEMA no estuvo):
//                 la tasa de respuesta es casi nula
//   MEDIA       - colegio publico, sin dato o no determinado
//               - ingreso distinto del objetivo sin ser posterior
//   ALTA        - DNI 44M-49.999.999, 1 o 2 carreras, ingreso en
//                 el objetivo y colegio privado
//
// Sin DNI: NO es mala. Casi todos los formularios sin DNI son de
// ferias, que no lo piden; castigarlos mandaria a "mala" a la
// mitad de la campaña por un dato que nunca se pidio. Se reporta
// aparte con la dimension 'rangoDni' = 'sin_dni'.
//
// Tipo de colegio: Salesforce no lo trae, sale del nombre libre
// que escribe el lead. Es una heuristica: lo que no se reconoce
// queda 'no_determinado' (cuenta como media, igual que sin dato)
// para que se pueda revisar con por='colegioNorm', sub='tipoColegio'.
// ============================================================

import { normalizar } from "./transform.js";
import { GRADO, normalizarCodigo } from "./programas.js";

export const DNI_MIN = 44_000_000;
export const DNI_MAX = 49_999_999;
export const TERMINO_OBJETIVO_DEFAULT = "2027S1";

// ------------------------------------------------------------
// Carreras
// ------------------------------------------------------------
// El campo programa mezcla siglas y nombres de la misma carrera
// ("LICP N, Ciencias Políticas"). Se lleva todo a un nombre
// canonico para no contar dos veces la misma.
// ------------------------------------------------------------

const GRADO_UP = Object.fromEntries(
  Object.entries(GRADO).map(([k, v]) => [k.toUpperCase(), v]),
);

function canonCarrera(nombre) {
  return normalizar(nombre)
    .replace(/^no usar\s+/, "")
    .replace(/^(lic\.?|licenciatura)\s+en\s+/, "")
    .replace(/^ba\s*(-|en)\s*/, "ba ")
    .trim();
}

const CARRERAS_GRADO = new Set(Object.values(GRADO).map(canonCarrera));

export function carrerasDe(lead) {
  const out = new Set();
  for (const token of String(lead.programa || "").split(/[,;]/)) {
    const t = token.trim();
    if (!t) continue;
    const porCodigo = GRADO_UP[normalizarCodigo(t)];
    const c = canonCarrera(porCodigo || t);
    // Eventos y campañas que se cuelan en programa no son carreras.
    if (CARRERAS_GRADO.has(c)) out.add(c);
  }
  return [...out];
}

// ------------------------------------------------------------
// Tipo de colegio
// ------------------------------------------------------------

const RE_BASURA =
  /^(-+|\.+|n|no|c|test|ninguno|ninguna|no especifico|no se|xx+|abcdefghi|ya me egrese|soy docente|fracasados)$/;

const RE_UNIVERSIDAD =
  /\b(universidad|uba|uade|ucema|unla|uns|utn|unsam|ucasal|uca)\b/;

const RE_PUBLICO = new RegExp(
  [
    "\\b(e\\.?e\\.?s\\.?|eesn?|eem|eet|eest|eesa|enet|ens|ensam|enslv|enciba|cens|cpem\\d*|cpes|ipea|ifts|isfd|idfdyt|ept)\\b",
    "\\bescuela\\s+(n|nro|n°|numero|municipal|normal|nacional|provincial|tecnica|secundaria|media|de educacion)\\b",
    "\\b(nacional|normal|municipal|provincial|estatal|publica|publico|oficial)\\b",
    "\\blenguas vivas\\b",
    "\\b(comercial|tecnica|industrial|media)\\s*(n|nro|n°)?\\s*\\d",
    "\\bn\\s?°?\\s?\\d+\\b|\\bnro\\.?\\s?\\d+|\\bnumero\\s?\\d+",
    "^\\d",
    "\\bdistrito\\b|\\bd\\.?e\\.?\\s?\\d+\\b|\\b\\d+\\s+de\\s+\\d+\\b",
    "\\b(adultos|bachillerato popular|polimodal)\\b",
    "\\bsecundari[ao]\\s+(n|nro|dos|uno|tres|\\d|azucena|basica)",
    "\\b(carlos pellegrini|nacional buenos aires|cnba|escuela de minas|paula albarracin)\\b",
  ].join("|"),
);

const RE_PRIVADO = new RegExp(
  [
    "\\bprivad[oa]\\b",
    "\\b(colegio|instituto|school|college|schule|high|grammar|day school|academy|academia)\\b",
    "\\b(san|santa|santo|santos|sto|nuestra senora|ntra|virgen|sagrad[oa]|inmaculad[oa]|maria|jesus|cristo|divina|madre|padre|beata|mater|corazon|don bosco|donbosco|marista|marianista|salesian[oa]|lasalle|la salle|esquiu|champagnat|claret|loreto|guadalupe|pias|apostol)\\b",
    "\\b(ort|labarden|godspell|andersen|milton|barker|winter garden|ilse|northfield|dover|oxford|norbridge|michael ham|canada school|scholem|wolfsohn|ward|balmoral|ranelagh|st nicholas|southern|lincoln|cangallo|holmberg|innova|bedes|bede|arrayanes|presencia|obras|nuevos aires|ceciema|cci|cnll|esba|germinare|glaux|jefferson|uzzi|farmingdale|glasgow|parish robertson|las cumbres|siglo xxi|tiempos modernos|da vinci|modelo|cultura inglesa|liceo mermoz|piaget|paiget|crear|consolacion|casa de jesus|rudolf steiner|aleman)\\b",
  ].join("|"),
);

export function tipoColegio(colegio) {
  const c = normalizar(colegio);
  if (!c || c.length < 3 || RE_BASURA.test(c)) return "sin_dato";
  if (!/[aeiou]/.test(c) || /(.)\1{3,}/.test(c)) return "sin_dato";
  if (RE_UNIVERSIDAD.test(c)) return "sin_dato";
  if (/\bprivad[oa]\b/.test(c)) return "privado";
  if (RE_PUBLICO.test(c)) return "publico";
  if (RE_PRIVADO.test(c)) return "privado";
  return "no_determinado";
}

// ------------------------------------------------------------
// DNI e ingreso
// ------------------------------------------------------------

function dniNumero(lead) {
  const d = String(lead.dni || "").replace(/\D/g, "");
  return d ? Number(d) : null;
}

export function rangoDni(lead) {
  const n = dniNumero(lead);
  if (n === null) return "sin_dni";
  if (n < DNI_MIN) return "menor_44M";
  if (n > DNI_MAX) return "50M_o_mas";
  return "44M_a_49M";
}

// "2027S1" -> { anio: 2027, sem: 1 }. Acepta las variantes que
// ya normaliza el resto del servidor (2027SEM1, "2027SEM 1").
function parseTermino(t) {
  const m = String(t || "")
    .toUpperCase()
    .match(/(20\d\d)\s*S(?:EM)?\s*([12])/);
  if (!m) return null;
  return { anio: Number(m[1]), sem: Number(m[2]) };
}

export function ingresoVsObjetivo(lead, objetivo = TERMINO_OBJETIVO_DEFAULT) {
  const t = parseTermino(lead.cohorte || lead.semestre);
  const o = parseTermino(objetivo);
  if (!t || !o) return "sin_dato";
  if (t.anio === o.anio && t.sem === o.sem) return "objetivo";
  if (t.anio > o.anio) return "posterior";
  return "otro";
}

// ------------------------------------------------------------
// Clasificacion
// ------------------------------------------------------------

export function calidadLead(lead, objetivo = TERMINO_OBJETIVO_DEFAULT) {
  const motivos = [];

  const dni = rangoDni(lead);
  const ingreso = ingresoVsObjetivo(lead, objetivo);
  const nCarreras = carrerasDe(lead).length;
  const colegio = tipoColegio(lead.colegio);
  const feriaComprada = lead.feriaComprada === "si";

  // Mala
  if (dni === "menor_44M" || dni === "50M_o_mas")
    motivos.push("dni_fuera_de_rango");
  if (ingreso === "posterior") motivos.push("ingreso_posterior");
  if (nCarreras > 4) motivos.push("mas_de_4_carreras");
  if (motivos.length) return { nivel: "mala", motivos };

  // Media-baja
  if (nCarreras >= 3) motivos.push("3_o_4_carreras");
  if (feriaComprada) motivos.push("feria_comprada");
  if (motivos.length) return { nivel: "media_baja", motivos };

  // Media
  if (colegio !== "privado") motivos.push(`colegio_${colegio}`);
  if (ingreso !== "objetivo") motivos.push(`ingreso_${ingreso}`);
  if (motivos.length) return { nivel: "media", motivos };

  return { nivel: "alta", motivos: [] };
}

// ------------------------------------------------------------
// Contactabilidad
// ------------------------------------------------------------
// Separa "el asesor no logro respuesta" de "hubo conversacion".
// - sin_respuesta: Contactado Sin respuesta, o Desiste por un
//   motivo de contactabilidad (Sin respuesta, No quiso
//   informacion, Datos incorrectos).
// - con_respuesta: Contactado, Interesado, Negociando, Qualified,
//   Unqualified, o Desiste por un motivo real (Precio, etc.).
// - nuevo: estado Nuevo. Segun el equipo se contacta por fuera de
//   Salesforce, asi que no es "sin contactar"; pero tampoco se
//   sabe si respondio.
// ------------------------------------------------------------

export function contactabilidad(lead) {
  const e = normalizar(lead.estado);
  if (!e) return "sin_estado";
  if (e === "nuevo") return "nuevo";
  if (e.includes("sin respuesta")) return "sin_respuesta";
  if (e === "desiste") {
    const m = normalizar(lead.motivoDesiste);
    return /sin respuesta|no quiso|datos incorrectos|no hubo respuesta/.test(m)
      ? "sin_respuesta"
      : "con_respuesta";
  }
  return "con_respuesta";
}

export function cantCarreras(lead) {
  const n = carrerasDe(lead).length;
  if (n === 0) return "0";
  if (n >= 5) return "5_o_mas";
  return String(n);
}
