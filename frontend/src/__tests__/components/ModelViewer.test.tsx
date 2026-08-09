import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelViewer } from '../../components/ModelViewer';

const rendererCreated = vi.hoisted(() => vi.fn());

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class WebGLRenderer {
    domElement = document.createElement('canvas');
    setSize = vi.fn();
    setPixelRatio = vi.fn();
    render = vi.fn();
    dispose = vi.fn();

    constructor() {
      rendererCreated();
    }
  }

  return { ...actual, WebGLRenderer };
});

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = { copy: vi.fn(), set: vi.fn() };
    enableDamping = false;
    dampingFactor = 0;
    update = vi.fn();
    dispose = vi.fn();
  },
}));

function triangleStl(): ArrayBuffer {
  const buffer = new ArrayBuffer(134);
  const view = new DataView(buffer);
  view.setUint32(80, 1, true);

  const values = [
    0, 0, 1,
    0, 0, 0,
    10, 0, 0,
    0, 10, 0,
  ];
  let offset = 84;
  for (const value of values) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  view.setUint16(offset, 0, true);
  return buffer;
}

function Harness() {
  const [parentRenders, setParentRenders] = useState(0);
  const [url, setUrl] = useState('/model-a.stl');
  const [buildVolume, setBuildVolume] = useState<{ x: number; y: number; z: number }>();

  return (
    <>
      <button onClick={() => setParentRenders((count) => count + 1)}>Rerender parent</button>
      <button onClick={() => setUrl('/model-b.stl')}>Change URL</button>
      <button onClick={() => setBuildVolume({ x: 300, y: 250, z: 200 })}>Change build volume</button>
      <output data-testid="parent-renders">{parentRenders}</output>
      <ModelViewer url={url} fileType="stl" buildVolume={buildVolume} />
    </>
  );
}

describe('ModelViewer lifecycle', () => {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  let fetchResolvers: Array<(response: Response) => void>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rendererCreated.mockClear();
    fetchResolvers = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => fetchResolvers.push(resolve)),
    );
    window.requestAnimationFrame = vi.fn(() => 1);
    window.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  async function finishFetch(index: number) {
    act(() => {
      fetchResolvers[index](new Response(triangleStl(), { status: 200 }));
    });
    await waitFor(() => {
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  }

  it('loads once for unchanged inputs and reloads once for semantic changes', async () => {
    render(<Harness />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await finishFetch(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(rendererCreated).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Rerender parent' }));
    expect(screen.getByTestId('parent-renders')).toHaveTextContent('1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(rendererCreated).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change URL' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    await finishFetch(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(rendererCreated).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Change build volume' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    await finishFetch(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(rendererCreated).toHaveBeenCalledTimes(3);
  });
});
