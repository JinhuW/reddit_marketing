import { describe, expect, it } from 'vitest';
import { isFiltered, listHref, parseListParams, sortHref, tagChip } from './list-params';

describe('parseListParams', () => {
  it('reads the view from the URL and falls back to safe defaults', () => {
    expect(parseListParams({})).toEqual({
      q: '',
      group: '',
      tag: '',
      status: '',
      sort: 'serial',
      dir: 'asc',
      page: 1,
      trash: false,
      id: '',
      manage: false,
    });
    const p = parseListParams({
      q: ['  shop ', 'x'],
      group: 'g1',
      sort: 'name',
      dir: 'desc',
      page: '3',
      view: 'trash',
      manage: '1',
    });
    expect(p).toMatchObject({ q: 'shop', group: 'g1', sort: 'name', dir: 'desc', page: 3, trash: true });
    expect(p.manage).toBe(true);
    expect(parseListParams({ sort: 'drop table', dir: 'up', page: '-2' })).toMatchObject({
      sort: 'serial',
      dir: 'asc',
      page: 1,
    });
  });
});

describe('listHref / sortHref', () => {
  const base = parseListParams({ q: 'shop', group: 'g1', page: '2' });

  it('keeps the view and leaves defaults out', () => {
    expect(listHref(parseListParams({}))).toBe('/browsers');
    expect(listHref(base)).toBe('/browsers?q=shop&group=g1&page=2');
    expect(listHref(base, { id: 'p1' })).toBe('/browsers?q=shop&group=g1&page=2&id=p1');
    expect(listHref(base, { trash: true, page: 1 })).toBe('/browsers?view=trash&q=shop&group=g1');
  });

  it('sorts ascending first, flips on the same column, and goes back to page 1', () => {
    expect(sortHref(base, 'name')).toBe('/browsers?q=shop&group=g1&sort=name');
    const byName = parseListParams({ sort: 'name' });
    expect(sortHref(byName, 'name')).toBe('/browsers?sort=name&dir=desc');
    expect(sortHref(byName, 'status')).toBe('/browsers?sort=status');
  });

  it('knows a filtered view', () => {
    expect(isFiltered(base)).toBe(true);
    expect(isFiltered(parseListParams({ sort: 'name', page: '2' }))).toBe(false);
  });
});

describe('tagChip', () => {
  it('maps a color to a chip and unknown colors to the neutral chip', () => {
    expect(tagChip('green')).toBe('chip-ok');
    expect(tagChip('nope')).toBe('chip-mid');
  });
});
