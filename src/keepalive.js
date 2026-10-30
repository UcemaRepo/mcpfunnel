// ============================================================
// keepalive.js — evita que Render free apague el servicio
// ============================================================
//
// Render free apaga el servicio tras ~15 minutos sin trafico
// ENTRANTE. Por eso el ping tiene que salir a la URL publica
// (pasa por el balanceador de Render y cuenta como visita);
// un ping a 127.0.0.1 no cuenta.
//
// Pega a "/", el health check publico: no pide token ni
// devuelve datos.
//
// Variables:
//   RENDER_EXTERNAL_URL  la define Render sola. Si no esta
//                        (entorno local), no hace nada.
//   KEEPALIVE_URL        opcional, para forzar otra URL.
//   KEEPALIVE_MINUTOS    opcional, default 4.
//   KEEPALIVE=false      lo desactiva.
// ============================================================

export function iniciarKeepAlive() {
  if (process.env.KEEPALIVE === "false") return;

  const base =
    process.env.KEEPALIVE_URL ||
    process.env.RENDER_EXTERNAL_URL;

  if (!base) return;

  const minutos =
    Number(process.env.KEEPALIVE_MINUTOS) || 4;

  const url = new URL("/", base).toString();

  const ping = async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        console.warn(`Keep-alive: ${url} respondio ${res.status}`);
      }
    } catch (err) {
      console.warn(`Keep-alive: fallo el ping a ${url}: ${err.message}`);
    }
  };

  // unref: el timer no impide que el proceso termine.
  setInterval(ping, minutos * 60 * 1000).unref();

  console.log(`Keep-alive: ping a ${url} cada ${minutos} min`);
}
