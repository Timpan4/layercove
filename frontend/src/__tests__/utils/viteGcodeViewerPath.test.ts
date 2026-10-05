import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveGcodeViewerPath } from '../../../vite.config';

const DIR = path.resolve('/srv/app/gcode_viewer');

describe('resolveGcodeViewerPath', () => {
  it('serves files under the viewer directory and defaults to index.html', () => {
    expect(resolveGcodeViewerPath('/gcode-viewer', DIR)).toBe(path.join(DIR, 'index.html'));
    expect(resolveGcodeViewerPath('/gcode-viewer/', DIR)).toBe(path.join(DIR, 'index.html'));
    expect(resolveGcodeViewerPath('/gcode-viewer/js/a.js?v=1', DIR)).toBe(path.join(DIR, 'js/a.js'));
  });

  it.each([
    '/gcode-viewer../.env',
    '/gcode-viewer/../.env',
    '/gcode-viewer/../../etc/passwd',
    '/gcode-viewer/%2e%2e/.env',
    '/gcode-viewer/..%2f.env',
    '/gcode-viewerx/index.html',
  ])('does not resolve %s', (url) => {
    expect(resolveGcodeViewerPath(url, DIR)).toBeNull();
  });
});
