import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function ready(page: Page, scenario = 'normal') {
  await page.goto(`/?scenario=${scenario}`);
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
}
async function choose(page: Page, paths: string[]) {
  await page.evaluate(
    (values) => localStorage.setItem('straggler-fixture-attachment-paths', JSON.stringify(values)),
    paths,
  );
  await page.getByRole('button', { name: 'Choose files', exact: true }).click();
}

test('CHAT-10 can attach before the first message; CHAT-15 sorts files and exposes download and removal', async ({
  page,
}) => {
  await ready(page);
  await expect(page.getByText('Drop files here', { exact: true })).toBeVisible();
  await expect(page.locator('.dropzone-types')).toContainText('.pdf');
  await choose(page, [
    '/fixture/z.md',
    '/fixture/a.txt',
    '/fixture/brief.docx',
    '/fixture/budget.xlsx',
    '/fixture/slides.pptx',
    '/fixture/report.PDF',
    '/fixture/legacy.ppt',
  ]);
  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(7);
  await expect(page.locator('.file-name')).toHaveText([
    'a.txt',
    'z.md',
    'brief.docx',
    'budget.xlsx',
    'slides.pptx',
    'report.PDF',
    'legacy.ppt',
  ]);
  await expect(
    page.getByText('PowerPoint 97–2003 (.ppt) is not supported.', { exact: false }),
  ).toBeVisible();
  await expect(page.locator('.type-docx .file-tile')).toHaveCSS('color', 'rgb(127, 176, 255)');
  await expect(page.locator('.type-xlsx .file-ext')).toHaveCSS('color', 'rgb(95, 211, 154)');
  await expect(page.locator('.type-pdf .file-ext')).toHaveText('.pdf');
  await expect(page.locator('.type-pdf .file-tile')).toHaveCSS('color', 'rgb(255, 143, 159)');
  await expect(page.getByRole('button', { name: 'Download report.PDF' })).toBeVisible();
  await page.getByRole('button', { name: 'Download report.PDF' }).click();
  await expect(page.getByText('Attachment downloaded.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-save-name'))).toBe(
    'report.PDF',
  );
  await page.getByRole('button', { name: 'Remove legacy.ppt' }).click();
  await expect(rows).toHaveCount(6);
  await page.getByRole('button', { name: 'Remove a.txt' }).click();
  await expect(rows).toHaveCount(5);
  await page.reload();
  await page
    .locator('.conversation-row')
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  await expect(rows).toHaveCount(5);
  await expect(page.locator('.type-pdf .file-name')).toHaveText('report.PDF');
  await page.getByRole('button', { name: 'Remove report.PDF' }).click();
  await expect(page.locator('.type-pdf')).toHaveCount(0);
});

test('CHAT-02 includes attachment blocks in every request and Context includes their text', async ({
  page,
}) => {
  await ready(page);
  await choose(page, ['/fixture/report.pdf']);
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  await expect(
    page.getByText('Estimated with llama-server tokenization', { exact: false }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  for (const question of ['First question', 'Next question']) {
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(question);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
    const request = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('straggler-fixture-request')!),
    );
    expect(request.messages[0].content).toContain('--- BEGIN ATTACHMENT "report.pdf" ---');
    expect(request.messages[0].content).toContain('Extracted fixture text from report.pdf.');
  }
  await expect(page.getByText('Add files', { exact: true })).toBeVisible();
});

test('CHAT-03 disables changing files while generation preserves the current attachment', async ({
  page,
}) => {
  await ready(page, 'cancel');
  await choose(page, ['/fixture/notes.txt']);
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Attachments can be changed when the response finishes.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
});

test('CHAT-16 uses native-shaped enter, over, leave and drop events and announces names', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('straggler-fixture-drag-drop', {
        detail: {
          type: 'enter',
          paths: ['/fixture/a.txt', '/fixture/b.md'],
          position: { x: 100, y: 100 },
        },
      }),
    ),
  );
  await expect(page.locator('.dropzone')).toHaveClass(/is-dragover/);
  await expect(
    page.getByText('2 files will be attached: a.txt, b.md', { exact: true }),
  ).toHaveAttribute('role', 'status');
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('straggler-fixture-drag-drop', {
        detail: { type: 'over', position: { x: 110, y: 100 } },
      }),
    ),
  );
  await expect(page.locator('.dropzone')).toContainText('a.txt, b.md');
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('straggler-fixture-drag-drop', { detail: { type: 'leave' } }),
    ),
  );
  await expect(page.locator('.dropzone')).not.toHaveClass(/is-dragover/);
  await expect(page.locator('.file-row')).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('straggler-fixture-drag-drop', {
        detail: { type: 'drop', paths: ['/fixture/a.txt'], position: { x: 100, y: 100 } },
      }),
    ),
  );
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
});

test('reading rows serialize request options and persist attachment-only chat options', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'System prompt', exact: true }).click();
  await page.getByRole('radio', { name: /This chat/ }).check();
  await page
    .getByRole('textbox', { name: 'System prompt instructions' })
    .fill('Preserve this attachment chat prompt');
  await page.evaluate(() => {
    localStorage.setItem('straggler-fixture-reading-paused', 'true');
    window.dispatchEvent(
      new CustomEvent('straggler-fixture-drag-drop', {
        detail: { type: 'drop', paths: ['/fixture/notes.txt'], position: { x: 100, y: 100 } },
      }),
    );
  });
  await expect(page.getByText('Reading text…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download notes.txt' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply to this chat' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'System prompt', exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-reading-paused'));
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
  await expect(page.locator('.file-meta')).toContainText('~');
  await expect(page.getByRole('button', { name: 'Apply to this chat' })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply to this chat' }).click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('straggler-fixture-normal')!)[0].options?.systemPrompt,
      ),
    )
    .toBe('Preserve this attachment chat prompt');
  await page.reload();
  await page
    .locator('.conversation-row')
    .getByRole('button', { name: 'New chat', exact: true })
    .click();
  await page.getByRole('button', { name: 'System prompt', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'System prompt instructions' })).toHaveValue(
    'Preserve this attachment chat prompt',
  );
});

test('context overflow blocks Send, keeps input and never sends generation', async ({ page }) => {
  await ready(page);
  await choose(page, ['/fixture/notes.txt']);
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A'.repeat(20000));
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.locator('.composer-wrap').getByRole('alert')).toContainText(
    'exceed the 4,096-token context',
  );
  expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A shorter question');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('Attach exposes image previews and explicitly excludes images without vision', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() =>
    localStorage.setItem(
      'straggler-fixture-attachment-paths',
      JSON.stringify(['/fixture/diagram.png']),
    ),
  );
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await expect(page.locator('.file-thumb')).toHaveAttribute('width', '30');
  await expect(page.locator('.feedback.warning')).toContainText(
    'This model can’t read images. It won’t be sent.',
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A text-only request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.assistant .markdown')).toContainText('local answer');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.imageIds).toEqual([]);
  expect(JSON.stringify(request.messages)).not.toContain('[Image:');
  await page.getByRole('button', { name: 'Remove image', exact: true }).click();
  await expect(page.locator('.file-thumb')).toHaveCount(0);
});

test('a vision-capable server receives owned image identifiers with the message', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-vision', 'true'));
  await ready(page);
  await choose(page, ['/fixture/diagram.webp']);
  await expect(page.locator('.file-row')).toContainText('Resized to 2,048 px');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Describe the image');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.assistant .markdown')).toContainText('local answer');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.imageIds).toHaveLength(1);
  expect(request.conversationId).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  const context = page.getByRole('dialog', { name: 'Context' });
  await expect(context).toContainText('Includes estimated image tokens.');
  await expect(context).toContainText(/≈[\d,]+ of 4,096 tokens/);
});

test('context recovery points to files when an image consumes the available room by itself', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-context-size', '2048');
    localStorage.setItem('straggler-fixture-vision', 'true');
  });
  await ready(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  for (const [index, question] of ['First question', 'Second question'].entries()) {
    await composer.fill(question);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.assistant .markdown')).toHaveCount(index + 1);
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  }
  await choose(page, ['/fixture/diagram.webp']);
  await expect(page.locator('.file-row.is-ready')).toHaveCount(1);
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  await expect(counter).toHaveAccessibleDescription(/^Little room for the reply/);
  await page.getByRole('button', { name: 'Collapse assistant panel' }).click();
  await counter.click();
  const popover = page.getByRole('dialog', { name: 'Context' });
  await expect(popover.getByRole('button', { name: 'Summarize and send' })).toHaveCount(0);
  await popover.getByRole('button', { name: 'Review files' }).click();
  const files = page.getByRole('region', { name: 'Attachments' });
  await expect(files).toBeFocused();
  await expect(files.getByRole('button', { name: 'Remove diagram.webp' })).toBeVisible();
});
