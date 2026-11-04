/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), CRLF/LF. */
export const parseCsv = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: Array<Array<string>> = []
  const state = { row: [] as Array<string>, field: "", quoted: false }
  const endField = () => {
    state.row.push(state.field)
    state.field = ""
  }
  const endRow = () => {
    endField()
    if (!(state.row.length === 1 && state.row[0] === "")) rows.push(state.row)
    state.row = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (state.quoted) {
      if (c === "\"") {
        if (text[i + 1] === "\"") {
          state.field += "\""
          i++
        } else state.quoted = false
      } else state.field += c
    } else if (c === "\"") state.quoted = true
    else if (c === ",") endField()
    else if (c === "\n") endRow()
    else if (c !== "\r") state.field += c
  }
  if (state.field !== "" || state.row.length > 0) endRow()
  return rows
}

/** Parse CSV with a header row into records keyed by column name. */
export const parseCsvRecords = (text: string): ReadonlyArray<Readonly<Record<string, string>>> => {
  const [header, ...rows] = parseCsv(text)
  if (header === undefined) return []
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])))
}
