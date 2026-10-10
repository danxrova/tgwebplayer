// Modo compatible: convierte en el navegador (ffmpeg.wasm) cualquier códec/contenedor a H.264 + AAC
// y lo reproduce por ventanas de pocos segundos con Media Source Extensions.
//
//   Compat.supported()  -> ¿puede este navegador usar el modo compatible?
//   Compat.start({ video, size, duration, read(start, end) -> Promise<ArrayBuffer>, onStatus(txt), onError(txt) })
//   Compat.stop()
//
// `read` es el mismo readRange() de la página (bytes del archivo en Telegram, `end` inclusive).
(() => {
  const FF_VER = "0.12.10";          // @ffmpeg/ffmpeg
  const CORE_VER = "0.12.6";         // @ffmpeg/core y @ffmpeg/core-mt
  const CDN = "https://cdn.jsdelivr.net/npm/";
  const SEG = 6;                     // segundos de vídeo por ventana convertida
  const AHEAD = 45;                  // segundos que se convierten por delante del punto de reproducción
  const KEEP_BEHIND = 60;            // segundos que se conservan por detrás
  const DL_CHUNK = 4 * 1024 * 1024;  // tamaño de cada petición de descarga
  const MB = 1024 * 1024;
  const LADDER = [720, 540, 432, 360, 288]; // alturas de salida, de mejor a peor
  const mime = (audio) => `video/mp4; codecs="avc1.640028${audio ? ",mp4a.40.2" : ""}"`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- carga de ffmpeg.wasm (una sola vez) ---------- */
  let ffPromise = null;
  const blobURL = async (url, type) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error("No se pudo descargar " + url);
    return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
  };
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("No se pudo cargar " + src));
    document.head.appendChild(s);
  });
  async function loadFFmpeg() {
    if (!window.FFmpegWASM) await loadScript(`${CDN}@ffmpeg/ffmpeg@${FF_VER}/dist/umd/ffmpeg.js`);
    // El Worker no puede crearse desde otro origen: se sirve el chunk del worker como blob local.
    const classWorkerURL = await blobURL(`${CDN}@ffmpeg/ffmpeg@${FF_VER}/dist/umd/814.ffmpeg.js`, "text/javascript");
    // Con la página "cross-origin isolated" se usa la versión multihilo (mucho más rápida).
    const attempts = self.crossOriginIsolated ? [true, false] : [false];
    let lastErr;
    for (const mt of attempts) {
      try {
        const base = `${CDN}@ffmpeg/core${mt ? "-mt" : ""}@${CORE_VER}/dist/umd/`;
        const cfg = {
          classWorkerURL,
          coreURL: await blobURL(base + "ffmpeg-core.js", "text/javascript"),
          wasmURL: await blobURL(base + "ffmpeg-core.wasm", "application/wasm"),
        };
        if (mt) cfg.workerURL = await blobURL(base + "ffmpeg-core.worker.js", "text/javascript");
        const ff = new FFmpegWASM.FFmpeg();
        await ff.load(cfg);
        try { await ff.createDir("/in"); } catch (_) {}
        return ff;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  function getFF() {
    if (!ffPromise) ffPromise = loadFFmpeg().catch((e) => { ffPromise = null; throw e; });
    return ffPromise;
  }

  /* ---------- utilidades ---------- */
  // Interpreta la salida de `ffmpeg -i archivo` (códecs, tamaño, duración).
  function parseProbe(text) {
    const lines = text.split("\n");
    const vline = lines.find((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
    const aline = lines.find((l) => /Stream #\d+:\d+.*: Audio:/.test(l));
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
    const wh = vline && /\b(\d{2,5})x(\d{2,5})\b/.exec(vline.replace(/(^|[\s\/(])0x[0-9a-f]+/gi, "$1"));
    const fps = vline && /(\d+(?:\.\d+)?) fps/.exec(vline);
    return {
      hasVideo: !!vline,
      hasAudio: !!aline,
      vcodec: vline ? (/Video: (\w+)/.exec(vline) || [])[1] || "" : "",
      acodec: aline ? (/Audio: (\w+)/.exec(aline) || [])[1] || "" : "",
      dur: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
      w: wh ? Number(wh[1]) : 0,
      h: wh ? Number(wh[2]) : 0,
      fps: fps ? Number(fps[1]) : 0,
    };
  }

  // Rango contiguo del SourceBuffer que contiene el instante t.
  function rangeAt(sb, t) {
    const b = sb.buffered;
    for (let i = 0; i < b.length; i++)
      if (t >= b.start(i) - 0.1 && t <= b.end(i) + 0.15) return { found: true, end: b.end(i), start: b.start(i) };
    return { found: false, end: t, start: t };
  }

  const once = (target, ev) => new Promise((r) => target.addEventListener(ev, r, { once: true }));
  function sbOp(sb, fn) {
    return new Promise((res, rej) => {
      const onEnd = () => { sb.removeEventListener("error", onErr); res(); };
      const onErr = () => { sb.removeEventListener("updateend", onEnd); rej(new Error("El navegador rechazó un fragmento convertido.")); };
      sb.addEventListener("updateend", onEnd, { once: true });
      sb.addEventListener("error", onErr, { once: true });
      try { fn(); } catch (e) { sb.removeEventListener("updateend", onEnd); sb.removeEventListener("error", onErr); rej(e); }
    });
  }
  const sbRemove = (sb, a, b) => (b > a ? sbOp(sb, () => sb.remove(a, b)) : Promise.resolve());
  async function sbAppend(sb, data, offset, video) {
    try {
      await sbOp(sb, () => { sb.timestampOffset = offset; sb.appendBuffer(data); });
    } catch (e) {
      if (e && e.name === "QuotaExceededError") { // sin sitio: se libera lo ya visto y se reintenta
        await sbRemove(sb, 0, Math.max(0, video.currentTime - 15));
        await sbOp(sb, () => { sb.timestampOffset = offset; sb.appendBuffer(data); });
      } else throw e;
    }
  }

  /* ---------- descarga progresiva del archivo ---------- */
  async function download(s) {
    while (s.alive && s.have < s.size) {
      const end = Math.min(s.have + DL_CHUNK, s.size) - 1;
      const buf = await s.read(s.have, end);
      if (!buf.byteLength) break;
      s.store = new Blob([s.store, buf]); // los Blob grandes los puede paginar el navegador a disco
      s.have += buf.byteLength;
    }
    s.complete = s.have >= s.size;
  }
  async function waitBytes(s, n, label) {
    n = Math.min(n, s.size);
    while (s.alive && s.have < n && !s.complete) {
      if (s.dlError) throw s.dlError;
      s.onStatus(`${label} ${Math.round((100 * s.have) / s.size)} %`);
      await sleep(250);
    }
    if (s.dlError && !s.complete && s.have < n) throw s.dlError;
  }
  // Monta lo descargado hasta ahora como /in/src (sin copiarlo a la memoria de wasm).
  async function withInput(s, ff, fn) {
    try { await ff.unmount("/in"); } catch (_) {}
    await ff.mount("WORKERFS", { blobs: [{ name: "src", data: s.store }] }, "/in");
    try { return await fn(); } finally { try { await ff.unmount("/in"); } catch (_) {} }
  }

  async function probe(s, ff) {
    let need = 8 * MB;
    for (;;) {
      await waitBytes(s, need, "Descargando cabecera");
      if (!s.alive) return null;
      const logs = [];
      const on = ({ message }) => logs.push(message);
      ff.on("log", on);
      try { await withInput(s, ff, () => ff.exec(["-hide_banner", "-i", "/in/src"])); } finally { ff.off("log", on); }
      const info = parseProbe(logs.join("\n"));
      if (info.hasVideo) return info;
      if (s.complete) throw new Error("No se reconoce ninguna pista de vídeo en este archivo.");
      need = s.size; // p. ej. MP4 con el índice (moov) al final: hace falta el archivo entero
    }
  }

  /* ---------- sesión ---------- */
  let current = null, prevDone = Promise.resolve();

  async function start(o) {
    await stop();
    await prevDone;
    const s = Object.assign({ alive: true, store: new Blob([]), have: 0, complete: false, dlError: null }, o);
    current = s;
    s.done = run(s).catch((e) => { if (s.alive) s.onError(String((e && e.message) || e)); });
    prevDone = s.done;
    return s;
  }
  async function stop() {
    const s = current;
    current = null;
    if (!s) return prevDone;
    s.alive = false;
    if (s.url) { URL.revokeObjectURL(s.url); s.url = null; }
    return prevDone;
  }

  async function run(s) {
    const video = s.video;
    s.download = download(s).catch((e) => { s.dlError = e; });
    s.onStatus("Cargando el conversor (la primera vez descarga unos 30 MB)…");
    const ff = await getFF();
    if (!s.alive) return;

    const info = await probe(s, ff);
    if (!s.alive) return;
    const dur = info.dur || Number(s.duration) || 0;
    if (!dur) throw new Error("No se pudo averiguar la duración del vídeo.");

    // Altura de salida adaptable: baja si el equipo no llega a tiempo real, sube si va sobrado.
    const maxH = Math.min(info.h || 720, 720) & ~1;
    const ladder = LADDER.filter((h) => h <= maxH);
    if (!ladder.length || ladder[0] < maxH) ladder.unshift(maxH);
    let qi = 0;

    const ms = new MediaSource();
    s.url = URL.createObjectURL(ms);
    video.src = s.url;
    await Promise.race([once(ms, "sourceopen"), (async () => { while (s.alive) await sleep(200); })()]);
    if (!s.alive) return;
    const sb = ms.addSourceBuffer(mime(info.hasAudio));
    sb.mode = "segments";
    ms.duration = dur;

    let first = true, stuck = 0, lastC = -1;
    while (s.alive) {
      const t = video.currentTime;
      const { found, end } = rangeAt(sb, t);

      if (found && end >= dur - 0.4) { // cubierto hasta el final
        if (ms.readyState === "open" && !sb.updating) { try { ms.endOfStream(); } catch (_) {} }
        await sleep(400); continue;
      }
      if (t > KEEP_BEHIND + 10 && !sb.updating && sb.buffered.length && sb.buffered.start(0) < t - KEEP_BEHIND - 5)
        await sbRemove(sb, 0, t - KEEP_BEHIND);
      if (found && end - t > AHEAD) { await sleep(400); continue; } // ya hay suficiente por delante

      // Siguiente ventana a convertir, derivada de lo que hay en el buffer (así los saltos del usuario se resuelven solos).
      let c;
      if (found) { const r = end / SEG; c = Math.abs(r - Math.round(r)) < 0.06 ? Math.round(r) : Math.floor(r); }
      else c = Math.floor(t / SEG);
      const T = c * SEG;
      if (T >= dur) { await sleep(400); continue; }
      if (c === lastC) { if (++stuck >= 3) throw new Error("La conversión no avanza. Prueba a abrir el vídeo desde Telegram."); }
      else { stuck = 0; lastC = c; }

      // Hace falta haber descargado hasta aquí (estimación con margen para VBR).
      const tEnd = Math.min(T + SEG, dur);
      await waitBytes(s, 6 * MB + s.size * (tEnd / dur) * 1.35, "Descargando");
      if (!s.alive) return;

      const H = ladder[qi];
      const vf = `scale=-2:${H}:flags=fast_bilinear` + (info.fps > 30.5 ? ",fps=30" : "");
      const args = [
        "-ss", String(T), "-i", "/in/src", "-t", String(SEG),
        "-map", "0:v:0", ...(info.hasAudio ? ["-map", "0:a:0"] : ["-an"]), "-sn", "-dn",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0",
        "-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-crf", "27",
        ...(info.hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"] : []),
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "/out.mp4",
      ];

      let data = null;
      const t0 = performance.now();
      for (let attempt = 0; ; attempt++) {
        const code = await withInput(s, ff, () => ff.exec(args));
        let out = null;
        try { out = await ff.readFile("/out.mp4"); } catch (_) {}
        try { await ff.deleteFile("/out.mp4"); } catch (_) {}
        if (!s.alive) return;
        if (out && out.length > 1000) { data = out; break; }
        if (s.complete || attempt >= 6) throw new Error(`No se pudo convertir este vídeo (código ffmpeg ${code}).`);
        await waitBytes(s, s.have + 16 * MB, "Descargando"); // ventana fuera de lo descargado: se espera y se reintenta
      }
      const elapsed = (performance.now() - t0) / 1000;

      await sbAppend(sb, data, T, video);
      if (!s.alive) return;
      if (first) { first = false; video.play().catch(() => {}); }

      const speed = Math.min(SEG, dur - T) / elapsed; // >1 = más rápido que el tiempo real
      if (speed < 1.05 && qi < ladder.length - 1) qi++;
      else if (speed > 2.8 && qi > 0) qi--;
      s.onStatus(`Conversión en vivo · ${ladder[qi]}p · ${speed.toFixed(1)}× la velocidad real` +
        (speed < 1 && qi === ladder.length - 1 ? " (tu equipo va justo: habrá pausas)" : ""));
    }
  }

  window.Compat = {
    supported: () => !!(window.WebAssembly && window.MediaSource && MediaSource.isTypeSupported(mime(true))),
    start, stop, _parseProbe: parseProbe,
  };
})();
