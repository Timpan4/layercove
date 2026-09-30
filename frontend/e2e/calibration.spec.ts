import { expect, test } from './test';

// Uses the isolated preview catalog. Never run this workflow against a printer installation.
test('calibration retains a draft result when saving test values and resumes all steps', async ({ page, request }) => {
  test.skip(process.env.CALIBRATION_E2E !== '1', 'Requires the isolated calibration preview backend');
  const status = await (await request.get('/api/v1/auth/status')).json();
  expect(status.auth_enabled).toBe(false);
  const printers = await (await request.get('/api/v1/printers/')).json();
  const printer = printers.find((item: { name: string; is_active: boolean }) => item.name === 'Preview printer' && !item.is_active);
  expect(printer, 'Only the disconnected preview printer is permitted').toBeTruthy();
  const profiles = await (await request.get('/api/v1/slicer/catalog/profiles')).json();
  const filament = profiles.find((item: { display_name: string }) => item.display_name === 'Preview PLA');
  expect(filament).toBeTruthy();
  await page.goto('/profiles?calibration=guided');
  await page.getByLabel('Printer', { exact: true }).selectOption(String(printer.id));
  await page.getByLabel('Filament', { exact: true }).selectOption(String(filament.profile_id));
  await page.getByLabel('Nozzle diameter (mm)').fill('0.4');
  await page.getByRole('button', { name: 'Start calibration', exact: true }).click();
  await expect(page.getByLabel('Baseline value (°C)', { exact: true })).toHaveValue('210');
  await page.getByLabel('Lowest test value (°C)', { exact: true }).fill('200');
  await page.getByLabel('Highest test value (°C)', { exact: true }).fill('220');
  await page.getByLabel('Step size (°C)', { exact: true }).fill('5');
  await page.getByLabel('Custom result (°C)', { exact: true }).fill('210');
  const saved = page.waitForResponse(response => response.url().includes('/parameters/temperature') && response.ok());
  await page.getByRole('button', { name: 'Save test values', exact: true }).click();
  await saved;
  await expect(page.getByLabel('Custom result (°C)', { exact: true })).toHaveValue('210');
  await page.screenshot({ path: 'test-results/calibration-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Custom result (°C)', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByLabel('Custom result (°C)', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/calibration-mobile.png', fullPage: true });
  const steps = [
    { name: 'Temperature', unit: '°C', value: '210' },
    { name: 'Flow rate', unit: 'ratio', value: '0.98' },
    { name: 'Pressure advance', unit: 'PA / K', value: '0.021' },
    { name: 'Retraction', unit: 'mm', value: '0.6' },
    { name: 'Volumetric flow', unit: 'mm³/s', value: '18' },
  ];
  for (const [index, step] of steps.entries()) {
    await page.getByLabel(`Custom result (${step.unit})`, { exact: true }).fill(step.value);
    await page.getByRole('button', { name: 'Use value', exact: true }).click();
    await expect(page.getByText('Result recorded', { exact: true })).toBeVisible();
    if (index < steps.length - 1) await page.getByRole('button', { name: `Next: ${steps[index + 1].name}`, exact: true }).click();
  }
  await page.reload();
  await expect(page.getByLabel('Custom result (mm³/s)', { exact: true })).toHaveValue('18');
  await page.getByLabel('Profile name', { exact: true }).fill('Preview calibrated PLA');
  await page.getByLabel('Share this copy on this installation').check();
  await page.getByRole('button', { name: 'Save profile copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Profile saved', exact: true })).toBeVisible();
});
