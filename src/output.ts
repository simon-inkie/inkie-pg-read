/**
 * Output formatters for pgr query results.
 *
 * Supported formats:
 * - json  — pretty-printed JSON array of objects (default)
 * - table — ASCII table with dynamic column widths and truncation
 * - csv   — RFC 4180 compliant CSV
 */

import { writeFileSync } from "fs";

export type OutputFormat = "json" | "table" | "csv";

export type Row = Record<string, unknown>;

/** Max column width for table output before truncation with '…' */
const DEFAULT_MAX_COL_WIDTH = 80;

// ── JSON ──────────────────────────────────────────────────────────────────────

export function formatJson(rows: Row[]): string {
  return JSON.stringify(rows, null, 2);
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/**
 * Escape a single CSV field per RFC 4180:
 * - Fields containing commas, double-quotes, or newlines are wrapped in double-quotes
 * - Internal double-quote characters are doubled
 */
function csvField(value: unknown): string {
  const str =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export function formatCsv(rows: Row[]): string {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]!);
  const lines: string[] = [];

  // Header row
  lines.push(headers.map(csvField).join(","));

  // Data rows
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(","));
  }

  return lines.join("\n") + "\n";
}

// ── Table ─────────────────────────────────────────────────────────────────────

function cellStr(value: unknown, maxWidth: number): string {
  const str =
    value === null || value === undefined
      ? "NULL"
      : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

  if (str.length > maxWidth) {
    return str.slice(0, maxWidth - 1) + "…";
  }
  return str;
}

export function formatTable(rows: Row[], maxColWidth = DEFAULT_MAX_COL_WIDTH): string {
  if (rows.length === 0) {
    return "(0 rows)\n";
  }

  const headers = Object.keys(rows[0]!);
  if (headers.length === 0) {
    return "(0 columns)\n";
  }

  // Compute column widths: max of header length and each cell length, capped at maxColWidth
  const colWidths: number[] = headers.map((h) => Math.min(h.length, maxColWidth));

  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      const cellLen = cellStr(row[headers[i]!], maxColWidth).length;
      colWidths[i] = Math.max(colWidths[i]!, cellLen);
    }
  }

  const pad = (str: string, width: number) => str.padEnd(width);

  // Build separator line
  const sep = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const sepLine = "+" + sep + "+";

  // Header row
  const headerCells = headers.map((h, i) =>
    " " + pad(cellStr(h, maxColWidth), colWidths[i]!) + " "
  );
  const headerLine = "|" + headerCells.join("|") + "|";

  const lines: string[] = [sepLine, headerLine, sepLine];

  // Data rows
  for (const row of rows) {
    const cells = headers.map((h, i) =>
      " " + pad(cellStr(row[h], maxColWidth), colWidths[i]!) + " "
    );
    lines.push("|" + cells.join("|") + "|");
  }

  lines.push(sepLine);
  lines.push(`(${rows.length} row${rows.length === 1 ? "" : "s"})\n`);

  return lines.join("\n");
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export function renderOutput(
  rows: Row[],
  format: OutputFormat,
  outputFile?: string
): void {
  let content: string;

  switch (format) {
    case "json":
      content = formatJson(rows);
      break;
    case "csv":
      content = formatCsv(rows);
      break;
    case "table":
      content = formatTable(rows);
      break;
    default: {
      // Exhaustiveness check
      const _: never = format;
      throw new Error(`Unknown format: ${_}`);
    }
  }

  if (outputFile) {
    writeFileSync(outputFile, content, "utf-8");
    process.stderr.write(`Wrote ${rows.length} row(s) to ${outputFile}\n`);
  } else {
    process.stdout.write(content + "\n");
  }
}
