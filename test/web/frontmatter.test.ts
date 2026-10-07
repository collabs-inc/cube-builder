import { test, expect } from 'vitest';
import { parseFileToViewerItem, splitFrontmatter } from '../../src/shared/viewer-item';
test('YAML frontmatter parses multiline values and leaves the Markdown body intact', () => {
  const item = parseFileToViewerItem('/note.md', '---\ntype: memo\nsummary: |\n  First line\n  Second line\ncustom: [one, two]\nquotes: [hello]\n---\n# Body\n');
  expect(item.type).toBe('memo'); expect(item.text).toBe('# Body\n');
  expect(item.summary).toBe('First line\nSecond line\n'); expect(item.frontmatter?.custom).toEqual(['one', 'two']);
});
test('invalid YAML stays visible and unexpected metadata shapes do not crash the viewer', () => {
  const invalid = '---\nquotes: [broken\n---\nBody';
  expect(parseFileToViewerItem('/note.md', invalid).text).toBe(invalid);
  expect(() => parseFileToViewerItem('/note.md', '---\nquotes: wrong-shape\n---\nBody')).not.toThrow();
});

test('rich saves preserve either YAML delimiter without duplicating malformed metadata', () => {
  for (const close of ['---', '...']) {
    const prefix = `---\ntitle: Example\n${close}\n`;
    const split = splitFrontmatter(prefix + 'Body');
    expect(split.body).toBe('Body'); expect(split.prefix + 'Edited').toBe(prefix + 'Edited');
  }
  const malformed = '---\ntitle: [broken\n---\nBody';
  const split = splitFrontmatter(malformed);
  expect(split.prefix + split.body).toBe(malformed); expect(split.prefix).toBe('');
});
