import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEngineResult } from '../src/result.mjs';

test('raw result decoder retains duplicate, numeric-like and prototype column names in order', () => {
  const result = parseEngineResult('{"ok":true,"fields":["2","1","__proto__","x","x","x"],"types":[],"rows":[{"2":"second","1":"first","__proto__":"literal","x":"18446744073709551615","x":null,"x":{"$h":"00ff"}}]}');
  assert.deepEqual(result.rowValues, [['second', 'first', 'literal', '18446744073709551615', null, { $h: '00ff' }]]);
  assert.equal(Object.getPrototypeOf(result.rows[0]), Object.prototype);
});

test('raw result decoder respects escaped strings and nested metadata without rewriting values', () => {
  const value = '"rows":[{"x":"fake"}], \\ \n 🐱';
  const field = 'quote"\\name';
  const json = `{"extra":{"nested":[1,{"value":${JSON.stringify(value)}}]},"fields":[${JSON.stringify(field)},${JSON.stringify(field)}],"rows":[{${JSON.stringify(field)}:${JSON.stringify(value)},${JSON.stringify(field)}:"tail"},{${JSON.stringify(field)}:null,${JSON.stringify(field)}:{"$h":"000102"}}],"ok":true}`;
  assert.deepEqual(parseEngineResult(json).rowValues, [[value, 'tail'], [null, { $h: '000102' }]]);
});

test('raw result decoder accepts zero rows and rejects inconsistent native envelopes', () => {
  assert.deepEqual(parseEngineResult('{"ok":true,"fields":["x","x"],"rows":[]}').rowValues, []);
  for (const source of [
    '{"fields":["x","x"],"rows":[{"x":"first"}]}',
    '{"fields":["x","y"],"rows":[{"y":"second","x":"first"}]}',
    '{"fields":["x"],"rows":[{"x":"first","x":"extra"}]}',
    '{"fields":["x"],"rows":[],"rows":[]}',
    '{"fields":["x"],"rows":[["unexpected"]]}',
    '{"fields":["x"],"rows":[{"x":"unfinished}]}',
  ]) assert.throws(() => parseEngineResult(source), SyntaxError);
});
