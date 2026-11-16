// ============================================================
// excel.js — Generación del archivo Excel (.xlsx) del informe
// ============================================================

import ExcelJS from "exceljs";

const MOTIVOS_LEGIBLES = {
  creado_despues_de_la_carga: "creado después de la carga",
  modificado_despues_de_la_carga: "modificado después de la carga",
  creado_antes_y_no_esta: "existía y no se cargó (revisar)",
  ya_no_esta_en_salesforce: "ya no está en Salesforce",
};

const GRAVEDAD = {
  creado_antes_y_no_esta: 0,
  modificado_despues_de_la_carga: 1,
  creado_despues_de_la_carga: 2,
};

export async function generarExcelInforme(informe, { ahora } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "UCEMA Funnel API";
  wb.created = new Date();

  // ------------------------------------------------------------
  // Hoja 1: Resumen
  // ------------------------------------------------------------
  const wsResumen = wb.addWorksheet("Resumen", {
    views: [{ showGridLines: true }],
  });

  wsResumen.columns = [
    { header: "Métrica / Parámetro", key: "parametro", width: 45 },
    { header: "Valor", key: "valor", width: 35 },
  ];

  const headerFill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1B365D" },
  };
  const headerFont = { bold: true, color: { argb: "FFFFFFFF" } };

  wsResumen.getRow(1).font = headerFont;
  wsResumen.getRow(1).fill = headerFill;

  const fechaHoy = ahora?.fecha || new Date().toISOString().slice(0, 10);
  const desde = informe.alcance?.desde || "";

  wsResumen.addRow({ parametro: "Fecha del Informe", valor: fechaHoy });
  wsResumen.addRow({ parametro: "Comparación desde", valor: desde });
  wsResumen.addRow({ parametro: "Estado de la Conciliación", valor: informe.estado });
  wsResumen.addRow({ parametro: "Total leads en Salesforce", valor: informe.totalSalesforce ?? 0 });
  wsResumen.addRow({ parametro: "Total leads en el sistema", valor: informe.totalSesion ?? 0 });
  wsResumen.addRow({ parametro: "Porcentaje de Cobertura", valor: `${informe.porcentajeCobertura ?? 100}%` });
  wsResumen.addRow({ parametro: "Faltan en el sistema (están en Salesforce)", valor: informe.faltantesEnSesion ?? 0 });
  wsResumen.addRow({ parametro: "  - Anomalías (sin explicación, revisar)", valor: informe.anomalias ?? 0 });
  wsResumen.addRow({ parametro: "  - Modificados después de la carga", valor: informe.modificadosDespuesDeLaCarga ?? 0 });
  wsResumen.addRow({ parametro: "  - Creados después de la carga", valor: informe.creadosDespuesDeLaCarga ?? 0 });
  wsResumen.addRow({ parametro: "Faltan en Salesforce (están en el sistema)", valor: informe.sobrantesEnSesion ?? 0 });

  // ------------------------------------------------------------
  // Hoja 2: Diferencias (Nombre, Apellido y detalle completo)
  // ------------------------------------------------------------
  const wsDetalle = wb.addWorksheet("Diferencias", {
    views: [{ showGridLines: true }],
  });

  wsDetalle.columns = [
    { header: "ID Salesforce", key: "id", width: 22 },
    { header: "Falta en", key: "faltaEn", width: 14 },
    { header: "Motivo", key: "motivo", width: 34 },
    { header: "Nombre", key: "nombre", width: 22 },
    { header: "Apellido", key: "apellido", width: 22 },
    { header: "Fecha Creación", key: "creadoEn", width: 18 },
    { header: "Fecha Modificación", key: "modificadoEn", width: 20 },
  ];

  wsDetalle.getRow(1).font = headerFont;
  wsDetalle.getRow(1).fill = headerFill;

  const faltantes = [...(informe.faltantes || [])].sort(
    (a, b) => (GRAVEDAD[a.motivo] ?? 9) - (GRAVEDAD[b.motivo] ?? 9)
  );

  for (const f of faltantes) {
    wsDetalle.addRow({
      id: f.idSalesforce,
      faltaEn: "sistema",
      motivo: MOTIVOS_LEGIBLES[f.motivo] || f.motivo || "",
      nombre: f.nombre || "",
      apellido: f.apellido || "",
      creadoEn: f.creadoEn ? String(f.creadoEn).slice(0, 10) : "",
      modificadoEn: f.modificadoEn ? String(f.modificadoEn).slice(0, 19).replace("T", " ") : "",
    });
  }

  for (const s of informe.sobrantes || []) {
    wsDetalle.addRow({
      id: s.idSalesforce,
      faltaEn: "salesforce",
      motivo: MOTIVOS_LEGIBLES[s.motivo] || s.motivo || "",
      nombre: s.nombre || "",
      apellido: s.apellido || "",
      creadoEn: s.creadoEn ? String(s.creadoEn).slice(0, 10) : "",
      modificadoEn: "",
    });
  }

  wsDetalle.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: wsDetalle.columns.length },
  };

  return await wb.xlsx.writeBuffer();
}
