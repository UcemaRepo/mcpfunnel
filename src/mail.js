// ============================================================
// mail.js — envío de mails por API HTTPS (Resend)
// ============================================================
//
// Por qué NO SMTP: los web services gratis de Render bloquean los
// puertos SMTP salientes (25, 465 y 587). nodemailer con SMTP
// termina en timeout. Una API por HTTPS (puerto 443) funciona.
//
// Si mañana se cambia de proveedor (SendGrid, Brevo, Postmark...),
// sólo hay que tocar enviarMail(): el resto del proyecto no se entera.
//
// Variables de entorno:
//   RESEND_API_KEY   clave de la API de Resend
//   MAIL_FROM        remitente, ej: Funnel UCEMA <informes@tu-dominio.edu.ar>
//                    (el dominio tiene que estar verificado en Resend)
//   MAIL_TO          destinatarios separados por coma
// ============================================================

const VARIABLES = ["RESEND_API_KEY", "MAIL_FROM", "MAIL_TO"];

export function variablesFaltantes() {
  return VARIABLES.filter((v) => !process.env[v]);
}

export function destinatarios() {
  return (process.env.MAIL_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function enviarMail({ asunto, texto, html }) {
  const faltan = variablesFaltantes();
  if (faltan.length) {
    throw new Error(`Faltan variables de entorno: ${faltan.join(", ")}`);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: destinatarios(),
      subject: asunto,
      text: texto,
      html,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Resend ${res.status}: ${data.message || JSON.stringify(data)}`.slice(0, 300)
    );
  }

  return data.id || null;
}
