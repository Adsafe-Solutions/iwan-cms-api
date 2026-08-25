/* Registrations as a spreadsheet.

   Hand-written rather than a dependency: the whole job is quoting, and the
   interesting part is not the escaping but deciding what the columns ARE. */

/* ⚠ A field is quoted if it contains a comma, a quote, or a newline, and a
   quote inside is doubled. That is the whole of RFC 4180 and it is what stops
   one person's answer — "Yes, but only on Saturday" — from becoming two
   columns and silently shifting every value after it. */
const cell = (value) => {
  const s =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : typeof value === "object"
          ? [value.first, value.last].filter(Boolean).join(" ")
          : typeof value === "boolean"
            ? value
              ? "Yes"
              : "No"
            : String(value);

  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/* ⚠ A leading =, +, - or @ makes Excel and Sheets treat the cell as a FORMULA.
   An answer of `=1+1` would be evaluated, and `=HYPERLINK(...)` is a real
   phishing vector in a shared spreadsheet. Prefixing an apostrophe forces it
   back to text. The answer is still readable; it just cannot execute. */
const safe = (value) => {
  const s = cell(value);
  const bare = s.startsWith('"') ? s.slice(1) : s;
  return /^[=+\-@\t\r]/.test(bare)
    ? `"'${s.replace(/^"|"$/g, "").replace(/"/g, '""')}"`
    : s;
};

export function toCsv(rows = []) {
  if (rows.length === 0) return "";

  /* The question columns are the union of every question ANSWERED across these
     rows, in the order first seen. Exporting one event therefore produces
     exactly that event's form; exporting across events gives every column with
     blanks where a form did not ask. Driven by the answers rather than by the
     event's current form, so a question deleted since is still exported — the
     answers are the record. */
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
        ...questions.map((q) => byKey[q.key]),
        row.note ?? "",
      ]
        .map(safe)
        .join(",")
    );
  }

  /* ⚠ A BOM, and CRLF line endings. Without the BOM, Excel on Windows opens a
     UTF-8 file as the local codepage and every accented name is mangled. */
  return `﻿${lines.join("\r\n")}\r\n`;
}

export default toCsv;
