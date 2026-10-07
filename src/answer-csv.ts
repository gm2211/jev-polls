/** Parse a small CSV answer list without relying on module-scoped helpers. */
export function parseAnswerCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > 256 * 1024) {
    throw new Error("CSV is too large. The maximum size is 256 KiB.");
  }

  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let afterQuote = false;
  let cellStarted = false;
  let rowStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === "\r") {
        if (input[index + 1] !== "\n") {
          throw new Error("CSV contains a bare carriage return. Use LF or CRLF line endings.");
        }
        cell += "\r\n";
        index += 1;
      } else {
        cell += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === " " || character === "\t") {
        continue;
      }
      if (character === ",") {
        row.push(cell.trim());
        cell = "";
        afterQuote = false;
        cellStarted = false;
        rowStarted = true;
        continue;
      }
      if (character === "\n" || character === "\r") {
        if (character === "\r") {
          if (input[index + 1] !== "\n") {
            throw new Error("CSV contains a bare carriage return. Use LF or CRLF line endings.");
          }
          index += 1;
        }
        row.push(cell.trim());
        if (row.some((value) => value !== "")) rows.push(row);
        row = [];
        cell = "";
        afterQuote = false;
        cellStarted = false;
        rowStarted = false;
        continue;
      }
      throw new Error(`CSV has unexpected text after a closing quote at character ${index + 1}.`);
    }

    if (character === '"') {
      if (cellStarted && !/^[ \t]*$/.test(cell)) {
        throw new Error(`CSV has a quote inside an unquoted cell at character ${index + 1}.`);
      }
      cell = "";
      inQuotes = true;
      cellStarted = true;
      rowStarted = true;
      continue;
    }

    if (character === ",") {
      row.push(cell.trim());
      cell = "";
      cellStarted = false;
      rowStarted = true;
      continue;
    }

    if (character === "\n" || character === "\r") {
      if (character === "\r") {
        if (input[index + 1] !== "\n") {
          throw new Error("CSV contains a bare carriage return. Use LF or CRLF line endings.");
        }
        index += 1;
      }
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      cellStarted = false;
      rowStarted = false;
      continue;
    }

    cell += character;
    cellStarted = true;
    rowStarted = true;
  }

  if (inQuotes) {
    throw new Error("CSV has an unterminated quoted cell.");
  }

  if (rowStarted || row.length > 0 || cell.length > 0 || afterQuote) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }

  return rows;
}
