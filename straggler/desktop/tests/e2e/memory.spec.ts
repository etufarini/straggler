import { expect, test } from '@playwright/test';
import { selectValue } from './select';

test('memory summary uses actual context and opens the context setting', async ({ page }) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await expect(page.locator('.model-list')).toContainText('Memory unknown');
  await expect(
    page.getByText('Estimate from the file size and detected memory;', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await page.locator('.local-badge').click();
  const memory = page.getByRole('region', { name: 'Memory', exact: true });
  await expect(memory).toContainText('4,096');
  await expect(memory).toContainText('Layers on the GPU');
  await memory.getByRole('button', { name: 'Model settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Context size', exact: true })).toBeFocused();
});

test('model settings show the active window separately from a pending context change', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '16384'));
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.locator('.local-badge').click();
  await page
    .getByRole('region', { name: 'Memory', exact: true })
    .getByRole('button', { name: 'Model settings' })
    .click();
  const context = page.getByRole('combobox', { name: 'Context size', exact: true });
  const active = page.getByText('Active context · 16K · 16,384 tokens', { exact: true });
  await expect(active).toBeVisible();
  await selectValue(context, '32768');
  await expect(
    page.getByText('Next launch · 32K · 32,768 tokens · Apply changes and restart', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(active).toBeVisible();
});
