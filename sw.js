// Sirve ./tg-stream/<id>?s=<tamaño>&t=<mime> como si fuera un archivo con soporte Range.
// Los bytes los pide a la página (que los descarga de Telegram). No guarda estado.
const CHUNK = 2 * 1024 * 1024;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  const m = u.pathname.match(/\/tg-stream\/([^/]+)$/);
  if (!m) return;
  e.respondWith(serve(e, m[1], Number(u.searchParams.get("s")), u.searchParams.get("t") || "video/mp4"));
});

async function serve(e, id, size, mime) {
  if (!size) return new Response("Falta el tamaño", { status: 400 });
  let start = 0, end = size - 1;
  const r = /bytes=(\d*)-(\d*)/.exec(e.request.headers.get("range") || "");
  if (r) {
    if (r[1] !== "") start = Number(r[1]);
    if (r[2] !== "") end = Math.min(Number(r[2]), size - 1);
  }
  if (start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  end = Math.min(end, start + CHUNK - 1);

  const client = (await self.clients.get(e.clientId)) || (await self.clients.matchAll({ type: "window" }))[0];
  if (!client) return new Response("Sin página activa", { status: 503 });

  try {
    const buf = await new Promise((resolve, reject) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (m) => (m.data.error ? reject(new Error(m.data.error)) : resolve(m.data.chunk));
      client.postMessage({ type: "RANGE", id, start, end }, [ch.port2]);
    });
    if (!buf.byteLength) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    return new Response(buf, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${start + buf.byteLength - 1}/${size}`,
        "Content-Length": String(buf.byteLength),
      },
    });
  } catch (err) {
    return new Response(String(err.message || err), { status: 502 });
  }
}
