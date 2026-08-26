/* Registrations as a spreadsheet. Hand-written rather than a dependency: the
   interesting part is not the escaping but deciding what the columns ARE. */

/* ⚠ The whole of RFC 4180: quote on comma, quote or newline, and double an
   inner quote. Without it "Yes, but only on Saturday" becomes two columns and
   silently shifts every value after it. */
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

  /* ⚠ Without the BOM, Excel on Windows reads UTF-8 as the local codepage and
     mangles every accented name. */
  return `﻿${lines.join("\r\n")}\r\n`;
}

export default toCsv;
