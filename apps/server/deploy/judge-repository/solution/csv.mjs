// Copy this implementation into src/csv.mjs in the developer's reward PR.
export function toCsv(records, columns) {
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns.map(cell).join(","), ...records.map((row) => columns.map((key) => cell(row[key])).join(","))].join("\r\n");
}
