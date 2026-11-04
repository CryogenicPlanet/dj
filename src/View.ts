/** The public, read-only live view served at `/`. Self-contained: polls /api/now. */
export const VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dj · now playing</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E%3Crect width=%2232%22 height=%2232%22 rx=%227%22 fill=%22%230c0c0e%22/%3E%3Ccircle cx=%2223%22 cy=%2223%22 r=%224%22 fill=%22%23d8ff5f%22/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0c0c0e; --panel: #151518; --ink: #f2efe9; --muted: #8d8a85; --faint: #3a3936;
    --accent: #d8ff5f; --skip: #ff7a5c;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f4f1ea; --panel: #ebe7de; --ink: #17171a; --muted: #6c6963; --faint: #cfcac0; --accent: #3f6b00; --skip: #b8401f; }
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 28px; }
  .logo { font: 700 22px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: -0.04em; }
  .logo span { color: var(--accent); }
  .status { color: var(--muted); font-size: 13px; }
  .now { display: grid; grid-template-columns: minmax(140px, 260px) 1fr; gap: 28px; align-items: end; margin-bottom: 40px; }
  .cover { width: 100%; aspect-ratio: 1; border-radius: 6px; background: var(--panel) center/cover; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
  .label { text-transform: uppercase; letter-spacing: .12em; font-size: 11px; color: var(--muted); margin-bottom: 10px; }
  .title { font-size: clamp(28px, 5vw, 52px); font-weight: 750; line-height: 1.02; letter-spacing: -0.03em; }
  .title a { color: inherit; text-decoration: none; }
  .artist { font-size: 19px; color: var(--muted); margin-top: 8px; }
  .vibe { display: inline-block; margin-top: 16px; padding: 4px 10px; border: 1px solid var(--accent); color: var(--accent); border-radius: 999px; font-size: 13px; }
  .bar { height: 3px; background: var(--faint); border-radius: 2px; margin-top: 22px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; background: var(--ink); transition: width 1s linear; }
  .times { display: flex; justify-content: space-between; font: 12px ui-monospace, Menlo, monospace; color: var(--muted); margin-top: 6px; }
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 36px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); font-weight: 600; margin-bottom: 12px; }
  ol { list-style: none; padding: 0; }
  li { display: grid; grid-template-columns: 44px 1fr auto; gap: 12px; align-items: center; padding: 9px 0; border-top: 1px solid var(--faint); }
  li img, li .ph { width: 44px; height: 44px; border-radius: 3px; object-fit: cover; background: var(--panel); }
  .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .a { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .note { color: var(--muted); font-size: 12.5px; font-style: italic; margin-top: 2px; }
  .tag { font: 11px ui-monospace, Menlo, monospace; color: var(--muted); }
  .tag.skip { color: var(--skip); }
  .tag.dj { color: var(--accent); }
  li > div { min-width: 0; }
  .first { opacity: 1; } .later { opacity: .82; }
  .empty { color: var(--muted); padding: 12px 0; border-top: 1px solid var(--faint); }
  footer { margin-top: 48px; color: var(--muted); font-size: 12px; }
  footer a { color: inherit; }
  @media (max-width: 720px) {
    .now { grid-template-columns: 1fr; } .cover { max-width: 300px; }
    .cols { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <header><div class="logo">dj<span>.</span></div><div class="status" id="status">connecting…</div></header>
  <section class="now">
    <div class="cover" id="cover"></div>
    <div>
      <div class="label" id="state">now playing</div>
      <div class="title" id="title">—</div>
      <div class="artist" id="artist"></div>
      <div id="vibe"></div>
      <div class="bar"><i id="bar"></i></div>
      <div class="times"><span id="pos">0:00</span><span id="dur">0:00</span></div>
    </div>
  </section>
  <section class="cols">
    <div><h2>Up next · the DJ's plan</h2><ol id="next"></ol></div>
    <div><h2>Recently played</h2><ol id="recent"></ol></div>
  </section>
  <footer>A live queue curated by an AI DJ for Rahul. Agents: <a href="/init">/init</a>.</footer>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const art = (t) => t.image ? '<img loading="lazy" src="' + esc(t.image) + '" alt="">' : '<span class="ph"></span>';
  let anchor = null; // { progress, duration, at, playing }

  const row = (t, i, extra) =>
    '<li class="' + (i === 0 ? "first" : "later") + '">' + art(t) +
    '<div><div class="t"><a href="' + esc(t.url) + '" style="color:inherit;text-decoration:none">' + esc(t.title) + '</a></div>' +
    '<div class="a">' + esc(t.artists) + (t.vibe ? ' · ' + esc(t.vibe) : '') + (t.queued_by ? ' · by ' + esc(t.queued_by) : '') + '</div>' +
    (t.note ? '<div class="note">' + esc(t.note) + '</div>' : '') + '</div>' + (extra || '<span></span>') + '</li>';

  function tick() {
    if (!anchor) return;
    const elapsed = anchor.playing ? Date.now() - anchor.at : 0;
    const pos = Math.min(anchor.duration, anchor.progress + elapsed);
    $("bar").style.width = (anchor.duration ? (pos / anchor.duration) * 100 : 0) + "%";
    $("pos").textContent = mmss(pos);
    $("dur").textContent = mmss(anchor.duration);
  }

  async function refresh() {
    try {
      const r = await fetch("/api/now", { cache: "no-store" });
      const d = await r.json();
      const p = d.playing, t = p && p.track;
      $("status").textContent = (p ? (p.is_playing ? "live · " + (p.device || "").toLowerCase() : "paused") : "nothing playing") +
        (d.driver ? " · " + d.driver.name + " is driving" : "");
      $("state").textContent = p && !p.is_playing ? "paused" : "now playing";
      $("title").innerHTML = t ? '<a href="' + esc(t.url) + '">' + esc(t.title) + '</a>' : "—";
      $("artist").textContent = t ? t.artists : "";
      $("cover").style.backgroundImage = t && t.image ? "url('" + t.image + "')" : "none";
      $("vibe").innerHTML = d.vibe ? '<span class="vibe">' + esc(d.vibe) + '</span>' : "";
      document.title = t ? t.title + " · " + t.artists + " — dj" : "dj · now playing";
      anchor = t ? { progress: p.progress_ms, duration: t.duration_ms, at: Date.now(), playing: p.is_playing } : null;
      tick();
      $("next").innerHTML = d.up_next.length
        ? d.up_next.map((x, i) => row(x, i, i === 0 ? '<span class="tag dj">next</span>' : '')).join("")
        : '<li class="empty">Nothing planned. Spotify autoplay is driving.</li>';
      $("recent").innerHTML = d.recent.length
        ? d.recent.map((x, i) => row(x, i, x.skipped ? '<span class="tag skip">skipped</span>' : '<span class="tag ' + (x.by === "dj" ? "dj" : "") + '">' + x.by + '</span>')).join("")
        : '<li class="empty">No history yet.</li>';
    } catch (e) {
      $("status").textContent = "reconnecting…";
    }
  }
  refresh();
  setInterval(refresh, 4000);
  setInterval(tick, 1000);
</script>
</body>
</html>
`
