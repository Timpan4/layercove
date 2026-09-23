import { useState } from 'react';
import { Box3, Vector3, type Scene } from 'three';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelViewer } from '../../components/ModelViewer';
import { slicerBedFromProfile } from '../../utils/slicerBed';

const rendererCreated = vi.hoisted(() => vi.fn());
const renderedScene = vi.hoisted(() => ({ current: null as Scene | null }));

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class WebGLRenderer {
    domElement = document.createElement('canvas');
    setSize = vi.fn();
    setPixelRatio = vi.fn();
    render = vi.fn((scene: Scene) => { renderedScene.current = scene; });
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


  it.each([true, false])('centers STL mesh bounds on the selected bed with arrange=%s, matching the CLI', async (arrange) => {
    render(<ModelViewer url="/cube.stl" fileType="stl" buildVolume={{x: 300, y: 300, z: 300, origin: [0, 0]}} centerOnBed={arrange} />);
    await finishFetch(0);
    const group = renderedScene.current!.children.find((object) => object.type === 'Group')!;
    expect(group).toBeDefined();
    const bounds = new Box3().setFromObject(group);
    const center = bounds.getCenter(new Vector3());
    expect(center.x).toBeCloseTo(150);
    expect(center.z).toBeCloseTo(150);
    expect(bounds.min.y).toBeCloseTo(0);
    const size = bounds.getSize(new Vector3());
    expect(size.x).toBeCloseTo(10);
    expect(size.z).toBeCloseTo(10);
  });

  it('places the actual mesh at the center of a serialized cloud bed', async () => {
    const volume = slicerBedFromProfile({
      printable_area: '0x0,300x0,300x300,0x300', printable_height: '300',
    });
    expect(volume).not.toBeNull();
    render(<ModelViewer url="/cube.stl" fileType="stl" buildVolume={volume!} centerOnBed />);
    await finishFetch(0);
    const group = renderedScene.current!.children.find((object) => object.type === 'Group')!;
    const bounds = new Box3().setFromObject(group);
    const center = bounds.getCenter(new Vector3());
    expect(center.x).toBeCloseTo(150);
    expect(center.z).toBeCloseTo(150);
    expect(bounds.min.y).toBeCloseTo(0);
  });

  it('renders a nonrectangular bed at its nonzero origin', async () => {
    const volume = slicerBedFromProfile({
      printable_area: ['-50x-25', '150x-25', '150x75', '50x75', '50x175', '-50x175'],
      printable_height: 275,
    });
    render(<ModelViewer url="/cube.stl" fileType="stl" buildVolume={volume!} centerOnBed />);
    await finishFetch(0);
    const plate = renderedScene.current!.children.find((object) => object.type === 'Mesh' && 'geometry' in object && object.geometry.type === 'ShapeGeometry');
    expect(plate).toBeDefined();
    const bounds = new Box3().setFromObject(plate!);
    expect([bounds.min.x, bounds.max.x, bounds.min.z, bounds.max.z]).toEqual([-50, 150, -25, 175]);
  });

  it('does not center a bedless STL on the hidden default 256 mm plate', async () => {
    render(<ModelViewer url="/cube.stl" fileType="stl" showBuildPlate={false} centerOnBed={false} />);
    await finishFetch(0);
    const group = renderedScene.current!.children.find((object) => object.type === 'Group')!;
    const center = new Box3().setFromObject(group).getCenter(new Vector3());
    expect(center.x).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
  });

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
