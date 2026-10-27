/**
 * Decode the pinned MariaDB JSON ABI without losing repeated column names.
 * The native serializer writes row members in field order, including duplicate
 * keys. JSON.parse validates the envelope; a second token walk retains every
 * row value before object-property replacement or integer-key reordering.
 */
export function parseEngineResult(json) {
  const result = JSON.parse(json);
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Array.isArray(result.fields) || !Array.isArray(result.rows)) return result;

  let position = 0;
  const whitespace = () => {
    while (position < json.length && /\s/.test(json[position])) position++;
  };
  const expect = character => {
    whitespace();
    if (json[position++] !== character) throw new SyntaxError(`Expected ${character} in MariaDB result`);
  };
  const string = () => {
    whitespace();
    const start = position;
    if (json[position++] !== '"') throw new SyntaxError('Expected a MariaDB result property name');
    while (position < json.length) {
      const character = json[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(json.slice(start, position));
    }
    throw new SyntaxError('Unterminated MariaDB result string');
  };
  const skipValue = () => {
    whitespace();
    if (json[position] === '"') { string(); return; }
    if (json[position] === '{' || json[position] === '[') {
      let depth = 0;
      do {
        const character = json[position];
        if (character === '"') { string(); continue; }
        position++;
        if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') depth--;
      } while (depth > 0 && position < json.length);
      return;
    }
    while (position < json.length && !/[\s,}\]]/.test(json[position])) position++;
  };
  const rows = () => {
    const values = [];
    expect('[');
    whitespace();
    if (json[position] === ']') { position++; return values; }
    while (position < json.length) {
      expect('{');
      const row = [];
      whitespace();
      if (json[position] !== '}') {
        while (position < json.length) {
          const name = string();
          if (row.length >= result.fields.length || name !== result.fields[row.length]) {
            throw new SyntaxError('MariaDB row columns differ from field order');
          }
          expect(':');
          whitespace();
          const start = position;
          skipValue();
          row.push(JSON.parse(json.slice(start, position)));
          whitespace();
          if (json[position] !== ',') break;
          position++;
        }
      }
      expect('}');
      if (row.length !== result.fields.length) throw new SyntaxError('MariaDB row width differs from field count');
      values.push(row);
      whitespace();
      if (json[position] !== ',') break;
      position++;
    }
    expect(']');
    return values;
  };

  expect('{');
  let rowValues;
  while (position < json.length) {
    whitespace();
    if (json[position] === '}') break;
    const name = string();
    expect(':');
    if (name === 'rows') {
      if (rowValues !== undefined) throw new SyntaxError('Duplicate MariaDB result rows envelope');
      rowValues = rows();
    } else skipValue();
    whitespace();
    if (json[position] !== ',') break;
    position++;
  }
  expect('}');
  if (!rowValues || rowValues.length !== result.rows.length) throw new SyntaxError('MariaDB row envelope differs from decoded rows');
  result.rowValues = rowValues;
  return result;
}
