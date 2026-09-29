import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GcodeViewer } from '../../components/GcodeViewer';

const { resize } = vi.hoisted(() => ({ resize: vi.fn() }));

vi.mock('gcode-preview', () => ({
  WebGLPreview: class {
    scene = { children: [] };
    renderer = { render: vi.fn() };
    camera = {};
    layers = [];
    resize = resize;
    render = vi.fn();
    processGCode = vi.fn();
    dispose = vi.fn();
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resize.mockClear();
});

it('restores the G-code drawing buffer after the hidden phone panel is shown again', async () => {
  let width = 320;
  let height = 240;
  let notifyResize: ResizeObserverCallback | undefined;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height } as DOMRect));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notifyResize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'G1 X0 Y0 E1' }));

  const { container } = render(<div><GcodeViewer gcodeUrl="/cube.gcode" /></div>);
  const canvas = container.querySelector('canvas')!;
  expect(canvas.width).toBe(320);
  expect(canvas.height).toBe(240);

  width = 0;
  height = 0;
  act(() => {
    window.dispatchEvent(new Event('resize'));
    notifyResize?.([], {} as ResizeObserver);
  });
  expect(canvas.width).toBe(320);
  expect(canvas.height).toBe(240);

  width = 360;
  height = 280;
  act(() => { notifyResize?.([], {} as ResizeObserver); });
  expect(canvas.width).toBe(360);
  expect(canvas.height).toBe(280);
  expect(resize).toHaveBeenCalled();
});
