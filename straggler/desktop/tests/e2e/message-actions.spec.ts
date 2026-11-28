import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function start(page: Page, scenario = 'normal') {
  await page.goto(`/?scenario=${scenario}`);
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
}
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
}

test('keyboard editing, cancel and save regenerate replace an earlier exchange', async ({
  page,
}) => {
  await start(page);
  await send(page, 'First question');
  await send(page, 'Later question');
  const edit = page.getByRole('button', { name: 'Edit message', exact: true }).first();
  await edit.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('textbox', { name: 'Edit message', exact: true });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText('First question');
  await expect(
    page.getByText('Saving replaces the response below and removes later messages.'),
  ).toBeVisible();
  await editor.fill('Canceled edit');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.message.user').first()).toContainText('First question');
  await expect(edit).toBeFocused();
  await edit.click();
  await editor.fill('Revised question');
  await page.getByRole('button', { name: 'Save and regenerate' }).click();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.user')).toContainText('Revised question');
  await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'First question', exact: true }).click();
  await expect(page.locator('.message.user')).toContainText('Revised question');
});

test('assistant edits use Markdown source and become context without generation', async ({
  page,
}) => {
  await start(page);
  await send(page, 'First question');
  await page.getByRole('button', { name: 'Edit response', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit response', exact: true });
  await expect(editor).toHaveValue(/A \*\*local\*\* answer/);
  await editor.fill('An **edited** answer');
  await page.getByRole('button', { name: 'Save response' }).click();
  await expect(page.locator('.message.assistant .markdown strong')).toHaveText('edited');
  await send(page, 'Next question');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages[1]).toEqual({ role: 'assistant', content: 'An **edited** answer' });
});

test('regeneration keeps current request options and removes later turns', async ({ page }) => {
  await start(page);
  await send(page, 'First question');
  await send(page, 'Later question');
  await page.getByRole('button', { name: 'Regenerate response' }).first().click();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(1);
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages).toEqual([{ role: 'user', content: 'First question' }]);
});

test('generation keeps user copy and disables editing; stopped output gains actions', async ({
  page,
}) => {
  await start(page, 'cancel');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Copy message' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Edit message', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Regenerate response' })).toBeDisabled();
  await expect(page.getByText('Edit and regenerate when the response ends.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Edit response', exact: true })).toBeEnabled();
});

test('failed edit persistence preserves the response and the editor text', async ({ page }) => {
  await start(page);
  await send(page, 'A question');
  await page.getByRole('button', { name: 'Edit response', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit response', exact: true }).fill('Keep this edit');
  await page.evaluate(() => localStorage.setItem('straggler-fixture-fail-next-save', 'true'));
  await page.getByRole('button', { name: 'Save response' }).click();
  await expect(page.getByText('Chat not saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit response', exact: true })).toHaveValue(
    'Keep this edit',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.message.assistant .markdown')).toContainText('A local answer.');
});

test('failed user replacement preserves later turns and the edit without requesting a new response', async ({
  page,
}) => {
  await start(page);
  await send(page, 'First question');
  await send(page, 'Later question');
  await page.getByRole('button', { name: 'Edit message', exact: true }).first().click();
  const editor = page.getByRole('textbox', { name: 'Edit message', exact: true });
  await editor.fill('Keep this proposed edit');
  await page.evaluate(() => localStorage.setItem('straggler-fixture-fail-next-save', 'true'));
  await page.getByRole('button', { name: 'Save and regenerate' }).click();
  await expect(page.getByText('Chat not saved', { exact: true })).toBeVisible();
  await expect(editor).toHaveText('Keep this proposed edit');
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('straggler-fixture-normal')!)[0],
  );
  expect(saved.messages).toHaveLength(4);
  expect(saved.messages[0].content).toBe('First question');
  expect(saved.messages[2].content).toBe('Later question');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages.at(-1).content).toBe('Later question');
});

test('an empty stopped response can be edited without running the model', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'straggler-fixture-normal',
      JSON.stringify([
        {
          id: crypto.randomUUID(),
          title: 'Stopped before text',
          createdAt: 1,
          updatedAt: 1,
          model: null,
          messages: [
            {
              id: crypto.randomUUID(),
              role: 'user',
              content: 'A question',
              reasoning: '',
              status: 'complete',
            },
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: '',
              reasoning: 'Read-only reasoning',
              status: 'stopped',
            },
          ],
        },
      ]),
    ),
  );
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Stopped before text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit response', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit response', exact: true }).fill('A saved response');
  await page.getByRole('button', { name: 'Save response' }).click();
  await expect(page.locator('.message.assistant .markdown')).toHaveText('A saved response');
  expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
});
