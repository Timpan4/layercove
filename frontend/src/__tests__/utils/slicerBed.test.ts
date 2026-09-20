import { describe, expect, it } from 'vitest';
import { slicerBedFromProfile } from '../../utils/slicerBed';

describe('selected machine bed geometry', () => {
  it.each([256, 300, 350])('uses %s mm from content, not a printer-name heuristic', (size) => {
    expect(slicerBedFromProfile({ name: 'Definitely 256', printable_area: ['0x0', `${size}x0`, `${size}x${size}`, `0x${size}`], printable_height: '400' }))
      .toEqual({ x: size, y: size, z: 400, origin: [0, 0] });
  });
  it('preserves nonzero origins and rectangular extents', () => {
    expect(slicerBedFromProfile({ printable_area: ['-100x-120', '100x-120', '100x120', '-100x120'], printable_height: ['300'] }))
      .toEqual({ x: 200, y: 240, z: 300, origin: [-100, -120] });
  });
  it.each([{}, {printable_area: ['0x0', 'NaNx300', '300x300'], printable_height: 300}, {printable_area: ['0x0','300x0','300x300'], printable_height: 0}])('does not invent a bed for malformed/missing metadata', (content) => {
    expect(slicerBedFromProfile(content)).toBeNull();
  });
});


describe('serialized cloud bed geometry', () => {
  const area = ['-50x-20', '250x-20', '250x280', '-50x280'];
  it.each([
    area.join(','),
    JSON.stringify(area),
    [area.join(',')],
  ].map((printable_area) => ({ printable_area })))('reads the same bed from cloud-serialized coordinates: %j', ({ printable_area }) => {
    expect(slicerBedFromProfile({ printable_area, printable_height: '300' }))
      .toEqual({ x: 300, y: 300, z: 300, origin: [-50, -20] });
  });
  it('supports serialized Prusa-style aliases without guessing dimensions', () => {
    expect(slicerBedFromProfile({ bed_shape: '0x0,220x0,220x250,0x250', max_print_height: 270 }))
      .toEqual({ x: 220, y: 250, z: 270, origin: [0, 0] });
  });
  it.each([true, ['300', '400'], '0x100', [], null].map((printable_height) => ({ printable_height })))('rejects malformed heights instead of coercing %j', ({ printable_height }) => {
    expect(slicerBedFromProfile({ printable_area: area, printable_height })).toBeNull();
  });
  it.each([
    '0x0,300x0,300xNaN,0x300',
    '0x0,,300x300,0x300',
    '0x0,300x0,300x300,0x300,',
    '["0x0",true,"300x300"]',
    '0x0,1x1,2x2',
    '0x0,30001x0,30001x300,0x300',
    '0x0,'.repeat(513),
    ' '.repeat(32769),
  ])('does not accept malformed or unbounded serialized coordinates', (printable_area) => {
    expect(slicerBedFromProfile({ printable_area, printable_height: 300 })).toBeNull();
  });
  it('does not fall back to an alias to hide invalid explicit geometry', () => {
    expect(slicerBedFromProfile({ printable_area: 'bad', bed_shape: area, printable_height: '300' })).toBeNull();
  });
});
