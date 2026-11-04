import { HttpServerResponse } from "effect/http"

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c] ?? c)

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;background:#111;color:#eee}
h1{color:#1ed760}code{background:#222;padding:.1em .3em;border-radius:4px}
.muted{color:#999}label{display:block;margin:1.2rem 0}
button{font:inherit;padding:.6em 1.4em;border-radius:999px;border:0;margin-right:.6rem;cursor:pointer}
button.go{background:#1ed760;color:#000;font-weight:600}button.no{background:#333;color:#eee}`

/** A full page. `bodyHtml` must already be escaped. Pages can't be framed, so consent can't be clickjacked. */
export const pageHtml = (bodyHtml: string, status = 200): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.html(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dj</title><style>${STYLE}</style></head><body>${bodyHtml}</body></html>`
  ).pipe(
    HttpServerResponse.setStatus(status),
    HttpServerResponse.setHeaders({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "cache-control": "no-store" })
  )

/** A one-message page. */
export const page = (title: string, body: string, status = 200): HttpServerResponse.HttpServerResponse =>
  pageHtml(`<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`, status)
