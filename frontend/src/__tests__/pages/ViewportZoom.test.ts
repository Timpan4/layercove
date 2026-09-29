import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('allows browser pinch zoom', () => {
  const html = readFileSync('index.html', 'utf8');
  expect(html).not.toContain('user-scalable=no');
  expect(html).not.toContain('maximum-scale=1');
});
