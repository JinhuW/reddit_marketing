import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes, commas and line breaks inside quotes', () => {
    const text = '﻿name,notes\r\n"Shop, one","said ""hi""\nsecond line"\r\n\r\nplain,\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Shop, one', 'said "hi"\nsecond line'],
      ['plain', ''],
    ]);
  });
  it('reads a last line with no line break', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('toCsv', () => {
  it('quotes what needs it, defuses formulas, and round-trips', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,b')).toBe('"a,b"');
    const rows = [
      ['Shop, one', 'said "hi"\nsecond'],
      ['x', null],
    ];
    expect(parseCsv(toCsv(['name', 'notes'], rows))).toEqual([
      ['name', 'notes'],
      ['Shop, one', 'said "hi"\nsecond'],
      ['x', ''],
    ]);
  });
});
