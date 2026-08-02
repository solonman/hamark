export function translateSqlPlaceholders(sql: string) {
  let index = 0;
  let inSingleQuote = false;
  let translated = "";

  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position];
    const next = sql[position + 1];

    if (char === "'") {
      translated += char;
      if (inSingleQuote && next === "'") {
        translated += next;
        position += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (char === "?" && !inSingleQuote) {
      index += 1;
      translated += `$${index}`;
      continue;
    }

    translated += char;
  }

  return translated;
}
