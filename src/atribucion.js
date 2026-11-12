// ============================================================
// atribucion.js — origen de la persona, ferias compradas y
// admisión en el término
// ============================================================
//
// Por que existe:
//
// Cada lead de la sesion es un Formulario_web__c, no una
// persona. Para medir ferias y eventos hacen falta tres cosas
// que el formulario solo no dice:
//
//   1. Si la persona entro UNICAMENTE por feria/evento, si ese
//      fue su PRIMER contacto, o si la feria vino despues.
//   2. Si la feria fue comprada (UCEMA no estuvo presente).
//   3. Si fue admitida EN EL TERMINO del formulario. El campo
//      `admitido` del lead es true si la persona tiene cualquier
//      Application admitida, de cualquier termino: por eso el
//      embudo de 2027S1 marcaba 397 y Salesforce dice 324.
//
// Todo se calcula una vez, al cargar la sesion, y queda como
// campos del lead para que /agregados y /leads filtren rapido.
// ============================================================

import { normalizar } from "./transform.js";

// ------------------------------------------------------------
// Configuracion (editable por variables de entorno en Render)
// ------------------------------------------------------------

// Origenes que cuentan como feria o evento. Se compara contra
// Origen_del_candidato__c, sin tildes y en minusculas.
// Para sumar "Actividades de Vinculacion con el Futuro":
//   ORIGENES_EVENTO=feria|evento|vinculacion
const ORIGEN_EVENTO = new RegExp(
  process.env.ORIGENES_EVENTO || "feria|evento",
  "i"
);

// Texto que indica que UCEMA no fue a la feria (feria comprada).
// Se busca en el comentario, en "como llegaste", en "por que
// queres estudiar" y en los nombres de campana.
// AJUSTAR con lo que realmente carga el formulario: usar
// agregados por='comentarioFeria' para ver los textos reales.
const FERIA_COMPRADA = new RegExp(
  process.env.FERIA_COMPRADA_REGEX ||
    [
      "no\\s+(fuimos|asistimos|estuvimos|participamos|asisti[oó]|estuvo|particip[oó]|fue)",
      "sin\\s+presencia",
      "comprad[ao]",
      "base\\s+comprada",
      "no\\s+presencial",
    ].join("|"),
  "i"
);

const esDniValido = (d) => /^\d{6,9}$/.test(String(d || ""));

export const esOrigenEvento = (origen) =>
  ORIGEN_EVENTO.test(normalizar(origen));

// ------------------------------------------------------------
// Nivel formulario (se llama desde salesforce.js por cada
// Formulario_web__c, cuando todavia estan los campos crudos)
// ------------------------------------------------------------

export function datosFeria(r, campanas = []) {
  const origen = r.Origen_del_candidato__c || "";

  if (!esOrigenEvento(origen)) {
    return { feriaComprada: "no_aplica", comentarioFeria: null };
  }

  const textos = [
    r.Comentario__c,
    r.C_mo_llegaste_a_nuestra_propuesta_educa__c,
    r.Por_qu_quer_s_estudiar_en_la_UCEMA__c,
    ...(campanas || []),
  ]
    .filter(Boolean)
    .map(normalizar)
    .join(" | ");

  return {
    feriaComprada: FERIA_COMPRADA.test(textos) ? "si" : "no",

    // Solo para calibrar FERIA_COMPRADA_REGEX con agregados.
    // Recortado, y solo en formularios de feria/evento.
    comentarioFeria: r.Comentario__c
      ? normalizar(r.Comentario__c).slice(0, 80)
      : "sin_comentario",
  };
}

// ------------------------------------------------------------
// Nivel persona (se llama una vez con todos los leads cargados)
// ------------------------------------------------------------
//
// Agrupa por DNI valido; si no hay, por Candidato (Lead); si
// tampoco, el formulario queda solo. Se usan TODOS los
// formularios de la persona, de cualquier cohorte: "solo
// feria" significa que nunca lleno otro formulario.
// ------------------------------------------------------------

export function enriquecerPersonas(leads) {
  const grupos = new Map();

  for (const l of leads) {
    const key = esDniValido(l.dni)
      ? `dni:${l.dni}`
      : l.idCandidato
        ? `cand:${l.idCandidato}`
        : `form:${l.sfId}`;

    l.personaKey = key;

    if (!grupos.has(key)) grupos.set(key, []);
    grupos.get(key).push(l);
  }

  for (const forms of grupos.values()) {
    forms.sort((a, b) =>
      String(a.createdDate).localeCompare(String(b.createdDate))
    );

    // Los formularios de inscripcion (cargados en las 24 h de la
    // Application) no dicen como llego la persona: se ignoran
    // para el recorrido, salvo que sean los unicos que tiene.
    const reales = forms.filter((f) => !f.formularioInscripcion);
    const base = reales.length ? reales : forms;
    const soloInscripcion = !reales.length && forms.length > 0;

    const eventos = base.map((f) => esOrigenEvento(f.origen));
    const hayEvento = eventos.some(Boolean);
    const todosEvento = eventos.every(Boolean);

    const tipo = !hayEvento
      ? "sin_evento"
      : todosEvento
        ? "solo_evento"
        : eventos[0]
          ? "primero_evento"
          : "evento_posterior";

    // Solo feria comprada: todos sus formularios son de
    // feria/evento y todos esos son comprados.
    const soloComprada =
      todosEvento && base.every((f) => f.feriaComprada === "si");

    forms.forEach((f, i) => {
      f.formulariosPersona = forms.length;
      f.ordenFormulario = i + 1;
      f.primerOrigen = base[0].origen || "sin_origen";
      f.soloInscripcion = soloInscripcion ? "si" : "no";
      f.tipoFormularios = tipo;
      f.soloFeriaComprada = soloComprada ? "si" : "no";
    });
  }

  return leads;
}

// ------------------------------------------------------------
// Admision en el termino del formulario
// ------------------------------------------------------------

export function estadoAdmision(l) {
  if (!l.admitido) return "no_admitido";

  const enTermino =
    l.idApplication &&
    l.matchTermino &&
    l.matchTermino !== "sin_match" &&
    l.matchTermino !== "sin_application";

  return enTermino ? "admitido_termino" : "admitido_otro_termino";
}

// Beca en %: la de la Application si esta cargada; si no, se
// deduce de la capita (0,70 => 30%).
export function becaPct(l) {
  if (l.becaAplicada != null && !isNaN(Number(l.becaAplicada))) {
    return Number(l.becaAplicada);
  }
  const c = Number(l.capita);
  return isNaN(c) ? 0 : Math.max(0, Math.round((1 - c) * 100));
}

// ------------------------------------------------------------
// Filtros extra, compartidos por /agregados y /leads
// ------------------------------------------------------------

const lista = (v) =>
  String(v)
    .split(",")
    .map((x) => normalizar(x))
    .filter(Boolean);

const siNo = (v) => {
  const t = normalizar(v);
  return t === "true" || t === "si" || t === "1";
};

export function aplicarFiltrosExtra(leads, f = {}) {
  let out = leads;

  if (f.colegio) {
    const c = normalizar(f.colegio);
    out = out.filter((l) => normalizar(l.colegio).includes(c));
  }

  // admitido: 'si' / 'termino' => admitido en el termino;
  // 'cualquiera' => admitido en cualquier termino; 'no'.
  if (f.admitido) {
    const a = normalizar(f.admitido);
    out = out.filter((l) => {
      const e = estadoAdmision(l);
      if (a === "no") return e === "no_admitido";
      if (a === "cualquiera") return e !== "no_admitido";
      return e === "admitido_termino";
    });
  }

  if (f.feriaComprada) {
    const v = normalizar(f.feriaComprada);
    out = out.filter((l) => normalizar(l.feriaComprada) === v);
  }

  if (f.tipoFormularios) {
    const vs = lista(f.tipoFormularios);
    out = out.filter((l) => vs.includes(normalizar(l.tipoFormularios)));
  }

  if (f.soloFeriaComprada) {
    const v = normalizar(f.soloFeriaComprada);
    out = out.filter((l) => normalizar(l.soloFeriaComprada) === v);
  }

  if (f.primerOrigen) {
    const o = normalizar(f.primerOrigen);
    out = out.filter((l) => normalizar(l.primerOrigen).includes(o));
  }

  // Un registro por persona: el formulario mas antiguo que
  // paso los demas filtros. Para contar personas, no forms.
  if (f.porPersona && siNo(f.porPersona)) {
    const vistos = new Map();
    for (const l of out) {
      const k = l.personaKey || l.sfId;
      const prev = vistos.get(k);
      if (!prev || String(l.createdDate) < String(prev.createdDate)) {
        vistos.set(k, l);
      }
    }
    out = [...vistos.values()];
  }

  return out;
}
