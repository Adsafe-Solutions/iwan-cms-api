/* Rows as a spreadsheet. Hand-written rather than a dependency: the interesting
   part is not the escaping but deciding what the columns ARE.

   `toCsv` is the registrations one, whose columns come from the answers. `rowsToCsv`
   below is the plain case — a fixed list of columns, for the audience and the
   applications. */

/* ⚠ The whole of RFC 4180: quote on comma, quote or newline, and double an
   inner quote. Without it "Yes, but only on Saturday" becomes two columns and
   silently shifts every value after it. */
const cell = (value) => {
  const s =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : value instanceof Date
          ? /* ⚠ Before the object branch, or a Date lands there and renders
               as an empty {first,last} — every Submitted cell was blank. */
            value.toISOString()
          : typeof value === "object"
            ? [value.first, value.last].filter(Boolean).join(" ")
            : typeof value === "boolean"
              ? value
                ? "Yes"
                : "No"
              : String(value);

  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ⚠ A leading =, +, - or @ makes Excel treat the cell as a FORMULA, and
   `=HYPERLINK(...)` is a real phishing vector in a shared sheet. An apostrophe
   forces it back to text — still readable, no longer executable. */
const safe = (value) => {
  const s = cell(value);
  const bare = s.startsWith('"') ? s.slice(1) : s;
  return /^[=+\-@\t\r]/.test(bare)
    ? `"'${s.replace(/^"|"$/g, "").replace(/"/g, '""')}"`
    : s;
};

export function toCsv(rows = []) {
  if (rows.length === 0) return "";

  /* The union of every question ANSWERED, in the order first seen — so one
     event exports exactly its own form. Driven by the answers rather than the
     event's current form, so a since-deleted question is still exported. */
  const questions = [];
  for (const row of rows) {
    for (const a of row.answers ?? []) {
      if (!questions.some((q) => q.key === a.key)) {
        questions.push({ key: a.key, label: a.label });
      }
    }
  }

  const header = [
    "Submitted",
    "Event",
    "Country",
    "Status",
    /* Fixed, not one of the questions — it rides beside the answers on every
       registration. `cell` renders null as blank: no record, not "No". */
    "Photo consent",
    ...questions.map((q) => q.label),
    "Note",
  ];

  const lines = [header.map(safe).join(",")];

  for (const row of rows) {
    const byKey = Object.fromEntries((row.answers ?? []).map((a) => [a.key, a.value]));
    lines.push(
      [
        row.submittedAt ?? "",
        row.eventTitle || row.eventSlug,
        (row.country ?? "").toUpperCase(),
        row.status,
        row.photoConsent,
        ...questions.map((q) => byKey[q.key]),
        row.note ?? "",
      ]
        .map(safe)
        .join(",")
    );
  }

  /* ⚠ Without the BOM, Excel on Windows reads UTF-8 as the local codepage and
     mangles every accented name. */
  return `﻿${lines.join("\r\n")}\r\n`;
}

/* A fixed set of columns, given as [key, header] pairs. Anything a cell cannot
   render flat — a list of messages, say — is the caller's job to reduce first. */
export function rowsToCsv(rows = [], columns = []) {
  if (columns.length === 0) return "";

  const lines = [columns.map(([, header]) => safe(header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map(([key]) => safe(row[key])).join(","));
  }

  return `\ufeff${lines.join("\r\n")}\r\n`;
}

export default toCsv;
