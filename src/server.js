// ============================================================
// server.js
// Backend principal — Salesforce + Gemini + Funnel
// ============================================================

import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  cargarLeads,
  buscarAdmitidos,
  resumirAdmitidosCapitas,
  normalizarTermino,
} from "./salesforce.js";

import {
  contarEmbudo,
  tasas,
} from "./transform.js";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(
  express.json({
    limit: "10mb",
  })
);

// ============================================================
// Estado en memoria
// ============================================================

let sesion = null;

let ultimaCarga = null;

let cargaEnProceso = false;

// ============================================================
// Helpers
// ============================================================

function ok(res, data) {
  return res.json({
    ok: true,
    ...data,
  });
}

function errorResponse(
  res,
  error,
  status = 500
) {
  console.error(error);

  return res.status(status).json({
    ok: false,
    error:
      error?.message ||
      String(error),
  });
}

function getSesion() {
  if (!sesion) {
    throw new Error(
      "No hay datos cargados de Salesforce. Ejecutá /cargar primero."
    );
  }

  return sesion;
}

// ============================================================
// Health
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      servicio:
        "UCEMA Funnel API",

      timestamp:
        new Date().toISOString(),

      sesionCargada:
        !!sesion,

      cantidadLeads:
        sesion?.leads?.length ||
        0,

      cantidadAdmitidos:
        sesion
          ?.admitidosSalesforce
          ?.length ||
        0,

      ultimaCarga:
        ultimaCarga,
    });
  }
);

// ============================================================
// CARGAR SALESFORCE
// ============================================================

app.post(
  "/cargar",
  async (req, res) => {
    if (cargaEnProceso) {
      return res.status(409).json({
        ok: false,
        error:
          "Ya hay una carga de Salesforce en proceso.",
      });
    }

    cargaEnProceso = true;

    try {
      const {
        desde,
        todosLosAsesores = false,
      } = req.body || {};

      console.log(
        "=========================================="
      );

      console.log(
        "INICIANDO CARGA SALESFORCE"
      );

      console.log(
        "=========================================="
      );

      const resultado =
        await cargarLeads({
          desde:
            desde ||
            "2025-01-01T00:00:00Z",

          todosLosAsesores:
            !!todosLosAsesores,
        });

      sesion =
        resultado;

      ultimaCarga =
        new Date().toISOString();

      console.log(
        "------------------------------------------"
      );

      console.log(
        "CARGA FINALIZADA"
      );

      console.log(
        `Leads: ${
          resultado.leads?.length ||
          0
        }`
      );

      console.log(
        `Applications admitidas: ${
          resultado
            .admitidosSalesforce
            ?.length ||
          0
        }`
      );

      console.log(
        `Cápitas admitidos: ${
          resultado
            .diagnostico
            ?.capitasAdmitidosSalesforce ||
          0
        }`
      );

      console.log(
        `Admitidos con lead: ${
          resultado
            .diagnostico
            ?.admitidosConLead ||
          0
        }`
      );

      console.log(
        `Admitidos sin lead: ${
          resultado
            .diagnostico
            ?.admitidosSinLead ||
          0
        }`
      );

      console.log(
        "------------------------------------------"
      );

      return ok(res, {
        cargadoEn:
          resultado.cargadoEn,

        duracionMs:
          resultado.duracionMs,

        leads:
          resultado.leads?.length ||
          0,

        admitidos:
          resultado
            .admitidosSalesforce
            ?.length ||
          0,

        capitasAdmitidos:
          resultado
            .diagnostico
            ?.capitasAdmitidosSalesforce ||
          0,

        diagnostico:
          resultado.diagnostico,
      });
    } catch (error) {
      return errorResponse(
        res,
        error
      );
    } finally {
      cargaEnProceso =
        false;
    }
  }
);

// ============================================================
// RESUMEN GENERAL
// ============================================================

app.get(
  "/resumen",
  (req, res) => {
    try {
      const data =
        getSesion();

      return ok(res, {
        fechaCarga:
          data.cargadoEn,

        duracionMs:
          data.duracionMs,

        totalLeads:
          data.leads?.length ||
          0,

        embudo:
          data.embudoGlobal,

        tasas:
          data.tasasGlobales,

        diagnostico:
          data.diagnostico,

        totalAdmitidos:
          data
            .admitidosSalesforce
            ?.length ||
          0,

        totalCapitas:
          data
            .admitidosSalesforce
            ?.reduce(
              (sum, a) =>
                sum +
                (
                  Number(
                    a.capita
                  ) || 0
                ),
              0
            ) ||
          0,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// ADMITIDOS
// ============================================================
//
// Esta ruta es especialmente importante.
//
// Permite consultar:
//
// /admitidos?termino=2027S1
//
// /admitidos?termino=2027 SEM 1
//
// /admitidos?termino=2027SEM1
//
// /admitidos?termino=2027
//
// Todas las variantes se normalizan.
// ============================================================

app.get(
  "/admitidos",
  (req, res) => {
    try {
      const data =
        getSesion();

      const {
        termino,
        term,
        ano,
        year,
        capita_min,
        capita_max,
        nombre,
        incluirDetalle = "false",
      } = req.query;

      const resultado =
        resumirAdmitidosCapitas(
          {
            termino:
              termino ||
              term,

            ano:
              ano ||
              year,

            capita_min:
              capita_min !==
              undefined
                ? Number(
                    capita_min
                  )
                : undefined,

            capita_max:
              capita_max !==
              undefined
                ? Number(
                    capita_max
                  )
                : undefined,

            nombre,
          },

          data
        );

      // Por defecto devolvemos
      // un resumen compacto.
      //
      // Si Gemini necesita auditar
      // personas individuales:
      //
      // ?incluirDetalle=true

      if (
        String(
          incluirDetalle
        ).toLowerCase() !==
        "true"
      ) {
        delete resultado.admitidos;
      }

      return ok(res, resultado);
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// ADMITIDOS — DIAGNÓSTICO
// ============================================================
//
// Ruta pensada para detectar por qué faltan personas.
//
// Ejemplo:
//
// /admitidos/diagnostico?termino=2027S1
//
// Devuelve:
//
// - total Salesforce
// - con lead
// - sin lead
// - cápitas
// - método de match
// - compatibilidad de término
// - lista de personas sin lead
// ============================================================

app.get(
  "/admitidos/diagnostico",
  (req, res) => {
    try {
      const data =
        getSesion();

      const {
        termino,
        term,
        ano,
        year,
      } = req.query;

      const resultado =
        resumirAdmitidosCapitas(
          {
            termino:
              termino ||
              term,

            ano:
              ano ||
              year,
          },

          data
        );

      const admitidos =
        resultado.admitidos ||
        [];

      const sinLead =
        admitidos.filter(
          (a) =>
            !a.tieneLead
        );

      const conLead =
        admitidos.filter(
          (a) =>
            a.tieneLead
        );

      const bajaConfianza =
        admitidos.filter(
          (a) =>
            a.confianza ===
              "baja"
        );

      return ok(res, {
        filtroAplicado:
          resultado.filtroAplicado,

        totalAdmitidos:
          resultado.totalAdmitidos,

        totalCapitas:
          resultado.totalCapitas,

        matching:
          resultado.matching,

        desglosePorTermino:
          resultado
            .desglosePorTermino,

        diagnostico: {
          total:
            admitidos.length,

          conLead:
            conLead.length,

          sinLead:
            sinLead.length,

          bajaConfianza:
            bajaConfianza.length,
        },

        // Esta parte es deliberadamente
        // detallada para poder investigar.
        admitidosSinLead:
          sinLead.map(
            (a) => ({
              idApplication:
                a.idApplication,

              numeroSolicitud:
                a.numeroSolicitud,

              idContacto:
                a.idContacto,

              dni:
                a.dni,

              nombre:
                a.nombreAlumno,

              termino:
                a.termino,

              terminoOriginal:
                a.terminoOriginal,

              capita:
                a.capita,
            })
          ),

        matchesBajaConfianza:
          bajaConfianza.map(
            (a) => ({
              idApplication:
                a.idApplication,

              nombre:
                a.nombreAlumno,

              dni:
                a.dni,

              termino:
                a.termino,

              leadNombre:
                a.leadNombre,

              leadCohorte:
                a.leadCohorteOriginal,

              metodoMatch:
                a.metodoMatch,

              matchTermino:
                a.matchTermino,

              confianza:
                a.confianza,
            })
          ),
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// ADMITIDOS — LISTA COMPLETA
// ============================================================

app.get(
  "/admitidos/lista",
  (req, res) => {
    try {
      const data =
        getSesion();

      const {
        termino,
        term,
        ano,
        year,
      } = req.query;

      const resultado =
        resumirAdmitidosCapitas(
          {
            termino:
              termino ||
              term,

            ano:
              ano ||
              year,
          },

          data
        );

      return ok(res, {
        filtroAplicado:
          resultado.filtroAplicado,

        totalAdmitidos:
          resultado.totalAdmitidos,

        totalCapitas:
          resultado.totalCapitas,

        admitidos:
          resultado.admitidos,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// ADMITIDOS — BUSQUEDA DIRECTA SALESFORCE
// ============================================================
//
// Esta ruta consulta Salesforce directamente.
//
// Sirve para verificar si el problema está en:
//
// 1. Salesforce
// 2. nuestra carga
// 3. el matching
// 4. Gemini
//
// Ejemplo:
//
// /admitidos/salesforce?termino=2027S1
// ============================================================

app.get(
  "/admitidos/salesforce",
  async (req, res) => {
    try {
      const {
        termino,
        term,
        ano,
        year,
        nombre,
        capita_min,
        capita_max,
        limite,
        offset,
      } = req.query;

      const resultado =
        await buscarAdmitidos({
          termino:
            termino ||
            term,

          ano:
            ano ||
            year,

          nombre,

          capita_min:
            capita_min !==
            undefined
              ? Number(
                  capita_min
                )
              : undefined,

          capita_max:
            capita_max !==
            undefined
              ? Number(
                  capita_max
                )
              : undefined,

          limite:
            limite
              ? Number(
                  limite
                )
              : undefined,

          offset:
            offset
              ? Number(
                  offset
                )
              : undefined,
        });

      return ok(res, resultado);
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// COHORTES
// ============================================================

app.get(
  "/cohortes",
  (req, res) => {
    try {
      const data =
        getSesion();

      const porCohorte =
        data.porCohorte ||
        {};

      return ok(res, {
        cohortes:
          porCohorte,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// LEADS
// ============================================================

app.get(
  "/leads",
  (req, res) => {
    try {
      const data =
        getSesion();

      const {
        termino,
        term,
        ano,
        year,
        programa,
        estado,
      } = req.query;

      let leads =
        Array.isArray(
          data.leads
        )
          ? data.leads
          : [];

      if (
        termino ||
        term
      ) {
        const buscado =
          normalizarTermino(
            termino ||
            term
          );

        leads =
          leads.filter(
            (l) =>
              normalizarTermino(
                l.cohorte ||
                l.cuandoIngresaria ||
                l.termino
              ) ===
              buscado
          );
      } else if (
        ano ||
        year
      ) {
        const buscado =
          String(
            ano ||
            year
          );

        leads =
          leads.filter(
            (l) =>
              String(
                l.cohorte ||
                l.cuandoIngresaria ||
                l.termino ||
                ""
              ).startsWith(
                buscado
              )
          );
      }

      if (
        programa
      ) {
        const p =
          String(
            programa
          ).toLowerCase();

        leads =
          leads.filter(
            (l) =>
              String(
                l.programa ||
                ""
              )
                .toLowerCase()
                .includes(p)
          );
      }

      if (
        estado
      ) {
        const e =
          String(
            estado
          ).toLowerCase();

        leads =
          leads.filter(
            (l) =>
              String(
                l.estado ||
                ""
              )
                .toLowerCase()
                .includes(e)
          );
      }

      return ok(res, {
        total:
          leads.length,

        leads,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// FUNNEL
// ============================================================

app.get(
  "/funnel",
  (req, res) => {
    try {
      const data =
        getSesion();

      let leads =
        data.leads || [];

      const {
        termino,
        term,
        ano,
        year,
      } = req.query;

      if (
        termino ||
        term
      ) {
        const buscado =
          normalizarTermino(
            termino ||
            term
          );

        leads =
          leads.filter(
            (l) =>
              normalizarTermino(
                l.cohorte ||
                l.cuandoIngresaria ||
                l.termino
              ) ===
              buscado
          );
      } else if (
        ano ||
        year
      ) {
        const buscado =
          String(
            ano ||
            year
          );

        leads =
          leads.filter(
            (l) =>
              terminoInfoSeguro(
                l.cohorte ||
                l.cuandoIngresaria ||
                l.termino
              ).ano ===
              buscado
          );
      }

      const embudo =
        contarEmbudo(
          leads
        );

      return ok(res, {
        totalLeads:
          leads.length,

        embudo,

        tasas:
          tasas(
            embudo
          ),
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// DEBUG — TERMINOS
// ============================================================
//
// Esta ruta sirve para que podamos ver exactamente
// qué interpreta el sistema:
//
// /debug/termino?valor=2027%20SEM%201
//
// ============================================================

app.get(
  "/debug/termino",
  (req, res) => {
    const valor =
      req.query.valor ||
      "";

    return ok(res, {
      original:
        valor,

      normalizado:
        normalizarTermino(
          valor
        ),
    });
  }
);

// ============================================================
// DEBUG — TODOS LOS TÉRMINOS DE APPLICATIONS
// ============================================================
//
// Muy útil para detectar casos inesperados:
//
// 2027
// 2027S1
// 2027 SEM 1
// etc.
//
// ============================================================

app.get(
  "/debug/terminos-admitidos",
  (req, res) => {
    try {
      const data =
        getSesion();

      const mapa =
        {};

      for (
        const app
        of
          data
            .admitidosSalesforce ||
          []
      ) {
        const original =
          app
            .terminoOriginal ||
          "SIN_TERMINO";

        const normalizado =
          normalizarTermino(
            original
          );

        if (
          !mapa[original]
        ) {
          mapa[original] = {
            original,

            normalizado,

            cantidad:
              0,

            capitas:
              0,
          };
        }

        mapa[original]
          .cantidad++;

        mapa[original]
          .capitas +=
            Number(
              app.capita
            ) || 0;
      }

      const terminos =
        Object.values(
          mapa
        ).sort(
          (a, b) =>
            a.original.localeCompare(
              b.original
            )
        );

      return ok(res, {
        totalTerminos:
          terminos.length,

        terminos,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// DEBUG — MATCH 2027S1
// ============================================================
//
// Atajo para revisar el caso que estamos investigando.
// ============================================================

app.get(
  "/debug/match-2027s1",
  (req, res) => {
    try {
      const data =
        getSesion();

      const resultado =
        resumirAdmitidosCapitas(
          {
            termino:
              "2027S1",
          },

          data
        );

      return ok(res, {
        filtroAplicado:
          resultado.filtroAplicado,

        totalAdmitidos:
          resultado.totalAdmitidos,

        totalCapitas:
          resultado.totalCapitas,

        matching:
          resultado.matching,

        desglosePorTermino:
          resultado
            .desglosePorTermino,

        sinLead:
          resultado.admitidos
            .filter(
              (a) =>
                !a.tieneLead
            )
            .map(
              (a) => ({
                nombre:
                  a.nombreAlumno,

                dni:
                  a.dni,

                termino:
                  a.termino,

                terminoOriginal:
                  a.terminoOriginal,

                capita:
                  a.capita,
              })
            ),
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);

// ============================================================
// ESTADO
// ============================================================

app.get(
  "/estado",
  (req, res) => {
    return ok(res, {
      sesionCargada:
        !!sesion,

      cargaEnProceso:
        cargaEnProceso,

      ultimaCarga,

      totalLeads:
        sesion?.leads?.length ||
        0,

      totalAdmitidos:
        sesion
          ?.admitidosSalesforce
          ?.length ||
        0,

      diagnostico:
        sesion?.diagnostico ||
        null,
    });
  }
);

// ============================================================
// RESET
// ============================================================

app.post(
  "/reset",
  (req, res) => {
    sesion = null;

    ultimaCarga =
      null;

    return ok(res, {
      mensaje:
        "Sesión eliminada.",
    });
  }
);

// ============================================================
// Helper seguro
// ============================================================

function terminoInfoSeguro(
  valor
) {
  const normalizado =
    normalizarTermino(
      valor
    );

  if (
    /^\d{4}S[12]$/.test(
      normalizado
    )
  ) {
    return {
      ano:
        normalizado.slice(
          0,
          4
        ),

      semestre:
        normalizado.slice(
          5
        ),
    };
  }

  if (
    /^\d{4}$/.test(
      normalizado
    )
  ) {
    return {
      ano:
        normalizado,

      semestre:
        null,
    };
  }

  return {
    ano:
      null,

    semestre:
      null,
  };
}

app.get(
  "/debug/duplicados-dni",
  (req, res) => {
    try {
      const data = getSesion();

      const apps =
        data.admitidosSalesforce || [];

      const mapa = new Map();

      for (const app of apps) {
        if (!app.dni) continue;

        if (!mapa.has(app.dni)) {
          mapa.set(app.dni, []);
        }

        mapa.get(app.dni).push(app);
      }

      const duplicados = [];

      for (const [dni, registros] of mapa) {
        if (registros.length > 1) {
          duplicados.push({
            dni,
            cantidad: registros.length,
            capitas: +registros
              .reduce(
                (sum, a) =>
                  sum +
                  (Number(a.capita) || 0),
                0
              )
              .toFixed(2),

            personas: registros.map(
              (a) => ({
                idApplication:
                  a.idApplication,

                idContacto:
                  a.idContacto,

                nombre:
                  a.nombreAlumno,

                termino:
                  a.termino,

                terminoOriginal:
                  a.terminoOriginal,

                capita:
                  a.capita,
              })
            ),
          });
        }
      }

      return ok(res, {
        totalAdmitidos:
          apps.length,

        dnisUnicos:
          mapa.size,

        cantidadDnisDuplicados:
          duplicados.length,

        duplicados,
      });
    } catch (error) {
      return errorResponse(
        res,
        error,
        400
      );
    }
  }
);
// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    });
  }
);

// ============================================================
// Error global
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "ERROR GLOBAL:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "Error interno del servidor.",
    });
  }
);

// ============================================================
// PORT
// ============================================================

const PORT =
  Number(
    process.env.PORT
  ) || 3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "=========================================="
    );

    console.log(
      `UCEMA Funnel API escuchando en puerto ${PORT}`
    );

    console.log(
      "=========================================="
    );
  }
);
