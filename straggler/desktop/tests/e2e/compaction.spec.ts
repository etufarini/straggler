import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { settingsSection } from './settings';

async function seed(
  page: Page,
  scenario = 'normal',
  size: 'short' | 'long' | 'over-16k' | 'small-savings' | 'adaptive' = 'short',
) {
  await page.addInitScript(
    ({ scenario, size }) => {
      const key = `straggler-fixture-${scenario}`;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: '40000000-0000-4000-8000-000000000001',
            title: 'Compact me',
            titleCustomized: true,
            createdAt: 1,
            updatedAt: 1,
            model: null,
            messages: Array.from({ length: 8 }, (_, index) => {
              const repeatedFacts = {
                'over-16k': 620,
                long: 160,
                short: 0,
                'small-savings': 0,
                adaptive: [16, 176, 32, 32][Math.floor(index / 2)],
              }[size];
              return {
                id: `40000000-0000-4000-8000-00000000001${index}`,
                role: index % 2 ? 'assistant' : 'user',
                content:
                  `Turn ${index}. ` +
                  (repeatedFacts
                    ? 'Context facts. '.repeat(repeatedFacts)
                    : 'Keep these decisions.') +
                  (size === 'small-savings' && index < 2
                    ? ' Preserve the initial project goals.'
                    : '') +
                  (size === 'short' && index < 2
                    ? ' Preserve the project goals and the agreed acceptance criteria.'
                    : ''),
                reasoning: index % 2 ? 'Private reasoning omitted' : '',
                status: 'complete',
              };
            }),
          },
        ]),
      );
    },
    { scenario, size },
  );
  await page.goto(`/?scenario=${scenario}`);
  await page.getByRole('button', { name: 'Compact me', exact: true }).click();
  if (!scenario.startsWith('cloud-'))
    await page.getByRole('button', { name: 'Launch server', exact: true }).click();
}
async function saved(page: Page, scenario = 'normal') {
  return page.evaluate(
    (scenario) => JSON.parse(localStorage.getItem(`straggler-fixture-${scenario}`)!)[0],
    scenario,
  );
}
async function menuCompact(page: Page) {
  await page.getByRole('button', { name: 'Options for Compact me', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Summarize earlier messages', exact: true }).click();
}

for (const size of ['long', 'small-savings'] as const) {
  test(`updates the next prompt and shows savings after ${size} chat compaction without a send`, async ({
    page,
  }) => {
    await page.addInitScript((small) => {
      localStorage.setItem('straggler-fixture-context-size', small ? '3600' : '5600');
      if (small) localStorage.setItem('straggler-fixture-summary-response', 'Kept.');
    }, size === 'small-savings');
    await seed(page, 'normal', size);
    const original = await saved(page);
    const counter = page.getByRole('button', { name: 'Context', exact: true });
    const popover = page.getByRole('dialog', { name: 'Context' });
    const meter = popover.getByRole('meter');
    await counter.click();
    await expect(popover).toContainText('Estimated with llama-server tokenization');
    expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
    const before = Number(await meter.getAttribute('value'));
    expect(before).toBeGreaterThan(0);
    const beforePercent = await counter.locator('.ctx-percent').innerText();
    await popover.getByRole('button', { name: 'Summarize earlier messages', exact: true }).click();
    const announcement = page.getByRole('status').filter({ hasText: 'tokens freed' });
    await expect(announcement).toBeVisible();
    await counter.click();
    await expect(popover).toContainText('Estimated with llama-server tokenization');
    const after = Number(await meter.getAttribute('value'));
    expect(after).toBeLessThan(before);
    const savedTokens = (before - after).toLocaleString('en-US');
    await expect(popover).toContainText(`${savedTokens} tokens freed`);
    const afterPercent = await counter.locator('.ctx-percent').innerText();
    if (size === 'small-savings') expect(afterPercent).toBe(beforePercent);
    else expect(Number.parseInt(afterPercent)).toBeLessThan(Number.parseInt(beforePercent));
    expect((await saved(page)).messages).toEqual(original.messages);
    if (size === 'long') {
      await popover.press('Escape');
      await page
        .locator('.compaction-status')
        .getByRole('button', { name: 'View summary' })
        .press('Enter');
      await expect(page.locator('.chat-summary summary')).toBeFocused();
      await expect(
        page
          .getByRole('region', { name: 'Earlier messages summarized' })
          .getByText('Goals and decisions retained.', { exact: false }),
      ).toBeVisible();

      await page.reload();
      await page.getByRole('button', { name: 'Compact me', exact: true }).click();
      await counter.click();
      await expect(popover).not.toContainText('tokens freed');
    }
    await popover.getByRole('button', { name: 'View summary' }).click();
    await expect(page.locator('.chat-summary details')).toHaveAttribute('open', '');
    await expect(page.locator('.chat-summary summary')).toBeFocused();
  });
}

for (const size of ['equal', 'larger'] as const) {
  test(`a first summary that leaves the context ${size} is discarded`, async ({ page }) => {
    await page.addInitScript((result) => {
      if (result === 'equal') localStorage.setItem('straggler-fixture-prompt-tokens', '200');
      else
        localStorage.setItem(
          'straggler-fixture-summary-response',
          'Redundant summary. '.repeat(40),
        );
    }, size);
    await seed(page);
    const original = await saved(page);
    const draft = 'Keep this draft.';
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(draft);
    await menuCompact(page);
    const status = page.locator('.compaction-status');
    await expect(status.getByRole('status')).toHaveText('No tokens saved. Summary skipped.');
    await expect(status.getByRole('button', { name: 'View summary' })).toHaveCount(0);
    await expect(page.locator('.chat-summary')).toHaveCount(0);
    await expect(composer).toHaveText(draft);
    expect(await saved(page)).toEqual(original);
    await page.getByRole('button', { name: 'Context', exact: true }).click();
    const context = page.getByRole('dialog', { name: 'Context' });
    await expect(context).toContainText('No tokens saved. Summary skipped.');
    await expect(context.getByRole('button', { name: 'View summary' })).toHaveCount(0);
  });
}

test('manual compaction preserves originals, supports editing/removal and branches on either side', async ({
  page,
}) => {
  await seed(page);
  const original = await saved(page);
  await menuCompact(page);
  await expect(page.locator('.chat-summary')).toBeVisible();
  const compacted = await saved(page);
  expect(compacted.messages).toEqual(original.messages);
  expect(compacted.summary.text).toContain('Goals and decisions retained.');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Unsent draft while editing.');
  await page.getByRole('button', { name: 'Summary options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit summary', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Edit summary', exact: true })
    .fill('Edited **summary**.');
  await page.getByRole('button', { name: 'Save summary', exact: true }).click();
  await expect.poll(async () => (await saved(page)).summary.text).toBe('Edited **summary**.');
  await expect(page.getByRole('button', { name: 'Summary options', exact: true })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
    'Unsent draft while editing.',
  );
  await page.getByRole('button', { name: 'Branch in new chat' }).nth(1).click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  await page.getByRole('button', { name: 'Compact me', exact: true }).click();
  await page.getByRole('button', { name: 'Branch in new chat' }).first().click();
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  await page.getByRole('button', { name: 'Compact me', exact: true }).click();
  await page.getByRole('button', { name: 'Summary options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove summary', exact: true }).click();
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  expect((await saved(page)).messages).toEqual(original.messages);
  await expect(page.getByRole('button', { name: 'Context', exact: true })).toBeFocused();
});

test('the next manual compaction becomes available after a reply and advances the summary', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '5600'));
  await seed(page, 'normal', 'long');
  await menuCompact(page);
  const summary = page.getByRole('region', { name: 'Earlier messages summarized' });
  await expect(summary).toBeVisible();
  const first = await saved(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  const context = page.getByRole('dialog', { name: 'Context' });
  const update = context.getByRole('button', { name: 'Summarize more messages', exact: true });
  await counter.click();
  await expect(update).toBeDisabled();
  await expect(update).toHaveAccessibleDescription('No older messages to summarize yet.');
  await context.getByRole('button', { name: 'View summary' }).click();
  await expect(summary.locator('summary')).toBeFocused();
  await page.getByRole('button', { name: 'Options for Compact me', exact: true }).click();
  const sidebarUpdate = page.getByRole('menuitem', {
    name: 'Summarize more messages',
    exact: true,
  });
  await expect(sidebarUpdate).toBeDisabled();
  await expect(sidebarUpdate).toHaveAccessibleDescription('No older messages to summarize yet.');
  await sidebarUpdate.press('Escape');

  await page.evaluate(() => localStorage.setItem('straggler-fixture-response-paused', 'true'));
  await composer.fill('New detail. '.repeat(250));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await counter.click();
  await expect(update).toBeDisabled();
  await expect(update).toHaveAccessibleDescription('Available after the current reply.');
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-response-paused'));
  await expect(update).toBeEnabled();
  expect(Number.parseInt(await counter.locator('.ctx-percent').innerText())).toBeLessThan(75);
  const continued = await saved(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    localStorage.setItem('straggler-fixture-summary-response', 'Updated with new details.');
    localStorage.setItem('straggler-fixture-response-paused', 'true');
  });
  await update.click();
  const status = page.locator('.compaction-status').getByRole('status');
  const spinner = status.locator('svg');
  await expect(status).toHaveText('Summarizing more messages…');
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveAttribute('aria-hidden', 'true');
  await expect(spinner).toHaveCSS('animation-name', 'spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(spinner).toHaveCSS('animation-name', 'none');
  await expect(status).toHaveText('Summarizing more messages…');
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-response-paused'));
  await expect.poll(async () => (await saved(page)).summary.text).toBe('Updated with new details.');
  const updated = await saved(page);
  expect(updated.messages).toEqual(continued.messages);
  expect(updated.summary.throughMessageId).toBe(first.messages[7].id);
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!)
      .messages.map((message: { content: string }) => message.content)
      .join('\n'),
  );
  expect(request).toContain(first.summary.text);
  expect(request).toContain('Turn 7.');
  expect(request).not.toContain('Turn 0.');
  await expect(summary).toHaveCount(1);
  await expect(page.locator('article.message').nth(7).locator('.chat-summary')).toBeVisible();
  await expect(status).toContainText('tokens freed');
  await expect(spinner).toHaveCount(0);
});

test('manual compaction advances after short replies in a large context window', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '131072'));
  await seed(page, 'normal', 'long');
  await menuCompact(page);
  const summary = page.getByRole('region', { name: 'Earlier messages summarized' });
  await expect(summary).toBeVisible();
  const first = await saved(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const messages = page.locator('article.message');
  for (const [index, text] of ['One detail', 'Another detail', 'Latest question'].entries()) {
    await composer.fill(text);
    await send.click();
    await expect(messages).toHaveCount(first.messages.length + (index + 1) * 2);
    await expect(send).toBeVisible();
  }
  const continued = await saved(page);
  const latestExchangeStart = continued.messages.length - 2;
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  const context = page.getByRole('dialog', { name: 'Context' });
  const update = context.getByRole('button', { name: 'Summarize more messages', exact: true });
  await counter.click();
  await expect(update).toBeEnabled();
  await update.click();
  await expect(messages.nth(latestExchangeStart - 1).locator('.chat-summary')).toBeVisible();
  const updated = await saved(page);
  expect(updated.summary.throughMessageId).toBe(continued.messages[latestExchangeStart - 1].id);
  expect(updated.messages).toEqual(continued.messages);
  await expect(summary).toHaveCount(1);
  const source = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!)
      .messages.map((message: { content: string }) => message.content)
      .join('\n'),
  );
  expect(source).toContain('Another detail');
  expect(source).not.toContain('Latest question');
  await counter.click();
  await expect(update).toBeDisabled();
  await expect(update).toHaveAccessibleDescription('No older messages to summarize yet.');
});

test('a successive summary that grows the context leaves the saved summary and draft in place', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '5600'));
  await seed(page, 'normal', 'long');
  await menuCompact(page);
  await expect(page.locator('.chat-summary')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('New detail. '.repeat(250));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const original = await saved(page);
  const draft = 'Keep this draft until I send it.';
  await composer.fill(draft);
  await page.evaluate(() =>
    localStorage.setItem('straggler-fixture-summary-response', 'Redundant summary. '.repeat(400)),
  );
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  const context = page.getByRole('dialog', { name: 'Context' });
  await counter.click();
  await context.getByRole('button', { name: 'Summarize more messages' }).click();
  await expect(page.locator('.compaction-status').getByRole('status')).toHaveText(
    'No tokens saved. Summary skipped.',
  );
  expect(await saved(page)).toEqual(original);
  await expect(composer).toHaveText(draft);
  await expect(page.locator('article.message').nth(5).locator('.chat-summary')).toBeVisible();
  await counter.click();
  await expect(context).toContainText('No tokens saved. Summary skipped.');
  await context.getByRole('button', { name: 'View summary' }).click();
  await expect(page.locator('.chat-summary')).toContainText(original.summary.text);
});

for (const shorter of [true, false]) {
  test(
    shorter
      ? 'a successive automatic compaction saves the shorter summary and sends the draft'
      : 'a successive automatic compaction that frees no space leaves an oversized draft for review',
    async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('straggler-fixture-context-size', '5600');
        localStorage.setItem(
          'straggler-fixture-chat-defaults-normal',
          '{"chat_auto_compact":"on"}',
        );
      });
      await seed(page, 'normal', 'long');
      await menuCompact(page);
      await expect(page.locator('.chat-summary')).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const send = page.getByRole('button', { name: 'Send message', exact: true });
      await composer.fill('New detail. '.repeat(250));
      await send.click();
      await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
      await expect(send).toBeVisible();
      const original = await saved(page);
      const summaryText = shorter ? 'New details retained.' : 'Redundant summary. '.repeat(400);
      await page.evaluate(
        (text) => localStorage.setItem('straggler-fixture-summary-response', text),
        summaryText,
      );
      const draft = 'D'.repeat(15200);
      await composer.fill(draft);
      await send.click();
      const result = page.locator('.compaction-status').getByRole('status');
      if (shorter) {
        await expect(result).toContainText('tokens freed');
        await expect(send).toBeVisible();
        const updated = await saved(page);
        expect(updated.messages.slice(0, -2)).toEqual(original.messages);
        expect(updated.messages.at(-2).content).toBe(draft);
        expect(updated.summary.text).toBe(summaryText);
        expect(updated.summary.throughMessageId).toBe(original.messages[7].id);
        await expect(composer).toBeEmpty();
      } else {
        await expect(result).toHaveText('No tokens saved. Summary skipped.');
        await expect(
          page.getByRole('button', { name: 'Context', exact: true }),
        ).toHaveAccessibleDescription(/^Free up space/);
        await expect(
          page
            .getByRole('alert')
            .filter({ hasText: 'This message needs more room' })
            .getByRole('button', { name: 'Shorten draft' }),
        ).toBeVisible();
        await expect(composer).toHaveText(draft);
        expect(await saved(page)).toEqual(original);
      }
    },
  );
}

test('Context compaction removes the summary after an earlier response is edited', async ({
  page,
}) => {
  await seed(page);
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  await page.getByRole('button', { name: 'Summarize earlier messages', exact: true }).click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'tokens freed' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit response', exact: true }).first().click();
  await page
    .getByRole('textbox', { name: 'Edit response', exact: true })
    .fill('Changed earlier response.');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  await expect(
    page.getByText('Summary removed because earlier messages changed.', { exact: true }),
  ).toBeVisible();
});

test('cloud compaction requires consent and Stop keeps the prior chat unchanged', async ({
  page,
}) => {
  await seed(page, 'cloud-cancel');
  const original = await saved(page, 'cloud-cancel');
  await menuCompact(page);
  await expect(page.getByRole('dialog', { name: 'Send this chat to OpenRouter?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop summarizing', exact: true });
  await expect(stop).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.parse(localStorage.getItem('straggler-fixture-cloud-requests') || '[]').some(
          (call: { method: string }) => call.method === 'POST',
        ),
      ),
    )
    .toBe(true);
  const status = page.locator('.compaction-status').getByRole('status');
  await expect(status).toHaveText('Summarizing earlier messages…');
  await expect(status.locator('svg')).toBeVisible();
  await stop.click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  expect(await saved(page, 'cloud-cancel')).toEqual(original);
  await expect(page.getByRole('status').filter({ hasText: 'Summary canceled.' })).toBeVisible();
  await expect(page.locator('.chat-summary')).toHaveCount(0);
});

test('full context compacts in bounded blocks and continues the preserved draft', async ({
  page,
}) => {
  await seed(page, 'normal', 'long');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Continue with this exact draft.');
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  await expect(counter).toHaveAccessibleDescription(/^Free up space/);
  await counter.click();
  await page
    .getByRole('dialog', { name: 'Context' })
    .getByRole('button', { name: 'Summarize and send', exact: true })
    .click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  const chat = await saved(page);
  expect(chat.messages.at(-2).content).toBe('Continue with this exact draft.');
  expect(chat.messages).toHaveLength(10);
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  const firstUser = request.messages.find((turn: { role: string }) => turn.role === 'user');
  expect(firstUser.content).toMatch(
    /^Earlier conversation summary \(historical context\):\n> Goals and decisions retained\./,
  );
  const systemMessages = request.messages.filter(
    (turn: { role: string }) => turn.role === 'system',
  );
  expect(systemMessages.map((turn: { content: string }) => turn.content).join('\n')).not.toContain(
    chat.summary.text,
  );
  expect(request.messages.at(-1)).toEqual({
    role: 'user',
    content: 'Continue with this exact draft.',
  });
  expect(
    request.messages.map((turn: { content: string }) => turn.content).join('\n'),
  ).not.toContain('Turn 0.');
});

for (const automatic of [false, true]) {
  test(`recovers a full draft by advancing the saved summary with ${automatic ? 'automatic compaction' : 'Summarize and send'}`, async ({
    page,
  }) => {
    await page.addInitScript((automatic) => {
      localStorage.setItem('straggler-fixture-context-size', '8192');
      if (automatic)
        localStorage.setItem(
          'straggler-fixture-chat-defaults-normal',
          '{"chat_auto_compact":"on"}',
        );
    }, automatic);
    await seed(page, 'normal', 'adaptive');
    await menuCompact(page);
    await expect(page.locator('.chat-summary')).toBeVisible();
    const original = await saved(page);
    expect(original.summary.throughMessageId).toBe(original.messages[1].id);

    const draft = 'D'.repeat(26000);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(draft);
    if (automatic) {
      const counter = page.getByRole('button', { name: 'Context', exact: true });
      await expect(counter).toHaveAccessibleDescription(/^Will summarize on send/);
      await expect(counter.getByText('Will summarize on send', { exact: true })).toBeVisible();
      await expect(page.locator('.context-menu')).toHaveClass(
        'composer-menu context-menu ctx-warning',
      );
    }
    await page
      .getByRole('button', { name: automatic ? 'Send message' : 'Summarize and send', exact: true })
      .click();
    await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
    await expect(composer).toBeEmpty();

    const updated = await saved(page);
    expect(updated.summary.throughMessageId).toBe(original.messages[3].id);
    expect(updated.messages.slice(0, -2)).toEqual(original.messages);
    expect(updated.messages.at(-2).content).toBe(draft);
    const request = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('straggler-fixture-request')!),
    );
    expect(request.maxOutputTokens).toBeUndefined();
    const prompt = request.messages
      .map((message: { content: string }) => message.content)
      .join('\n');
    expect(prompt).not.toContain('Turn 3.');
    expect(prompt).toContain('Turn 4.');
    expect(prompt).toContain('Turn 7.');
  });
}

test('a full 16K chat recovers from a truncated summary and sends every older turn to the summarizer', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-context-size', '16384');
    localStorage.setItem('straggler-fixture-summary-truncation', 'once');
  });
  await seed(page, 'normal', 'over-16k');
  const original = await saved(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue planning.');
  await page.getByRole('button', { name: 'Summarize and send', exact: true }).click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const chat = await saved(page);
  expect(chat.messages.slice(0, -2)).toEqual(original.messages);
  expect(chat.messages.at(-2).content).toBe('Continue planning.');
  expect(chat.summary.text).not.toContain('Truncated summary fixture');

  const attempts = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('straggler-fixture-summary-attempts')!) as {
        messages: { content: string }[];
        truncated: boolean;
        maxOutputTokens: number;
        options: { reasoning?: string };
      }[],
  );
  const chunk = (attempt: (typeof attempts)[number]) =>
    attempt.messages.at(-1)!.content.split('EARLIER CHAT:\n')[1];
  expect(attempts[0].truncated).toBe(true);
  expect(attempts[1].maxOutputTokens).toBeGreaterThan(attempts[0].maxOutputTokens);
  expect(chunk(attempts[1]).length).toBeLessThan(chunk(attempts[0]).length);
  expect(attempts.every((attempt) => attempt.options.reasoning === 'off')).toBe(true);
  expect(attempts.slice(1).every((attempt) => !attempt.truncated)).toBe(true);
  const boundary = original.messages.findIndex(
    (message: { id: string }) => message.id === chat.summary.throughMessageId,
  );
  const source = original.messages
    .slice(0, boundary + 1)
    .map(
      (message: { role: string; content: string }) =>
        `${message.role.toUpperCase()}:\n${message.content}`,
    )
    .join('\n\n');
  expect(attempts.slice(1).map(chunk).join('')).toBe(source);
});

test('repeated truncation stops at the retry limit and keeps the chat and draft intact', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('straggler-fixture-summary-truncation', 'always'),
  );
  await seed(page, 'no-reasoning');
  const original = await saved(page, 'no-reasoning');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Keep this draft.');
  await menuCompact(page);
  const error = page.getByRole('alert').filter({ hasText: 'Couldn’t summarize earlier messages' });
  await expect(error).toContainText('reached its generation limit before finishing the summary');
  await expect(error).toContainText('Original messages are kept.');
  await expect(error.getByText('Technical details')).toHaveCount(0);
  await expect(composer).toHaveText('Keep this draft.');
  expect(await saved(page, 'no-reasoning')).toEqual(original);
  expect(
    await page.evaluate(() => {
      const attempts = JSON.parse(localStorage.getItem('straggler-fixture-summary-attempts')!);
      return attempts.map((attempt: { options: object }) => attempt.options);
    }),
  ).toEqual([{}, {}, {}]);
});

test('Summarize and send uses the available space for a shorter reply', async ({ page }) => {
  await seed(page, 'normal', 'long');
  const draft = 'D'.repeat(10400);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(draft);
  await page.getByRole('button', { name: 'Summarize and send', exact: true }).click();
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.locator('.chat-summary')).toBeVisible();
  const chat = await saved(page);
  expect(chat.messages.at(-2).content).toBe(draft);
  await expect(composer).toBeEmpty();
  const { maxOutputTokens } = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(maxOutputTokens).toBeGreaterThanOrEqual(128);
  expect(maxOutputTokens).toBeLessThan(512);
});

test('recovery offers to shorten a draft that cannot fit with the retained turns', async ({
  page,
}) => {
  await seed(page, 'normal', 'long');
  const original = await saved(page);
  const draft = 'D'.repeat(12000);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(draft);
  const recovery = page.getByRole('alert').filter({ hasText: 'This message needs more room' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Summarize and send' })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Shorten draft' }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText(draft);
  expect(await saved(page)).toEqual(original);
  expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
});

test('a summary that still leaves too little room keeps the original chat and draft', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-summary-response', 'Oversized summary. '.repeat(125));
  });
  await seed(page, 'normal', 'long');
  const original = await saved(page);
  const draft = 'D'.repeat(10400);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(draft);
  await page.getByRole('button', { name: 'Summarize and send', exact: true }).click();
  const recovery = page.getByRole('alert').filter({ hasText: 'This message needs more room' });
  await expect(recovery).toContainText(/Free (?:about )?[\d,]+ more tokens/);
  await expect(recovery.getByRole('button', { name: 'Summarize and send' })).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: 'Shorten draft' })).toBeVisible();
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  await expect(composer).toHaveText(draft);
  expect(await saved(page)).toEqual(original);
});

for (const mode of ['manual', 'automatic', 'partial'] as const) {
  test(`a backend context rejection during ${mode} continuation keeps the previous summary`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      localStorage.setItem('straggler-fixture-context-size', '8192');
      localStorage.setItem(
        'straggler-fixture-context-rejection',
        mode === 'partial' ? 'partial-reply' : 'reply',
      );
      if (mode === 'automatic')
        localStorage.setItem(
          'straggler-fixture-chat-defaults-normal',
          '{"chat_auto_compact":"on"}',
        );
    }, mode);
    await seed(page, 'normal', 'adaptive');
    await menuCompact(page);
    await expect(page.locator('.chat-summary')).toBeVisible();
    const original = await saved(page);
    const draft = 'D'.repeat(26000);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await composer.fill(draft);
    await page
      .getByRole('button', {
        name: mode === 'automatic' ? 'Send message' : 'Summarize and send',
        exact: true,
      })
      .click();
    await expect(page.getByText('The model ran out of context.', { exact: false })).toBeVisible();
    await expect(send).toBeVisible();
    await expect(composer).toHaveText(draft);
    const retained = await saved(page);
    expect(retained.summary).toEqual(original.summary);
    if (mode === 'partial') {
      expect(retained.messages.slice(0, -2)).toEqual(original.messages);
      expect(retained.messages.at(-1)).toMatchObject({
        status: 'error',
        content: expect.stringContaining('A **local** answer.'),
      });
      await page.evaluate(() => localStorage.removeItem('straggler-fixture-context-rejection'));
      const shortened = 'Shortened question';
      await composer.fill(shortened);
      await expect(send).toBeEnabled();
      await send.click();
      await expect.poll(async () => (await saved(page)).messages.at(-1)?.status).toBe('complete');

      const request = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('straggler-fixture-request')!),
      );
      expect(request.messages.at(-1)).toEqual({ role: 'user', content: shortened });
      expect(JSON.stringify(request.messages).includes(draft)).toBe(false);
      expect((await saved(page)).messages.slice(0, -2)).toEqual(retained.messages);
    } else {
      expect(retained).toEqual(original);
    }
  });
}

test('cloud summary generation uses the active destination without search or reasoning history', async ({
  page,
}) => {
  await seed(page, 'cloud-ready');
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  const context = page.getByRole('dialog', { name: 'Context' });
  await expect(context).toContainText(/≈\d+ of 8,192 tokens/);
  expect(
    await page.evaluate(() => localStorage.getItem('straggler-fixture-cloud-requests')),
  ).toBeNull();
  await page.keyboard.press('Escape');
  await menuCompact(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  const chat = await saved(page, 'cloud-ready');
  expect(chat.summary.model).toBe('openrouter/example');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.cloud.providerId).toBe('openrouter');
  expect(request.webSearch).toBe(false);
  expect(request.maxOutputTokens).toBeGreaterThan(0);
  expect(JSON.stringify(request.messages)).not.toContain('Private reasoning omitted');
});

test('summary storage failure preserves the previous chat and reports the failed commit', async ({
  page,
}) => {
  await seed(page);
  const original = await saved(page);
  await page.evaluate(() => localStorage.setItem('straggler-fixture-fail-next-save', 'true'));
  await menuCompact(page);
  await expect(
    page.getByText('Couldn’t summarize earlier messages', { exact: true }),
  ).toBeVisible();
  expect(await saved(page)).toEqual(original);
  await expect(page.locator('.chat-summary')).toHaveCount(0);
});

test('a failed summary commit preserves the completed reply with the previous summary', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '8192'));
  await seed(page, 'normal', 'adaptive');
  await menuCompact(page);
  await expect(page.locator('.chat-summary')).toBeVisible();
  const original = await saved(page);
  await page.evaluate((boundary: string) => {
    localStorage.setItem('straggler-fixture-fail-summary-save', boundary);
  }, original.messages[3].id);

  const draft = 'D'.repeat(26000);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
  await page.getByRole('button', { name: 'Summarize and send', exact: true }).click();
  const feedback = page.getByText('Couldn’t summarize earlier messages', { exact: true });
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  const conversation = await saved(page);
  expect(conversation.summary).toEqual(original.summary);
  expect(conversation.messages.slice(0, -2)).toEqual(original.messages);
  expect(conversation.messages.at(-2).content).toBe(draft);
  expect(conversation.messages.at(-1)).toMatchObject({
    status: 'complete',
    content: expect.stringContaining('A **local** answer.'),
  });
  await expect(feedback).toBeVisible();
  await page.getByText('Technical details', { exact: true }).click();
  await expect(page.getByText('Disk is full', { exact: true })).toBeVisible();
});

test('temporary cloud compaction keeps saved history unchanged', async ({ page }) => {
  await seed(page, 'cloud-ready');
  const original = await saved(page, 'cloud-ready');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Temporary', exact: true }).click();
  for (let index = 0; index < 2; index++) {
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(
        `Temporary question ${index} about the project goals and the agreed acceptance criteria.`,
      );
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    if (index === 0)
      await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(index + 1);
    await expect(page.getByRole('button', { name: 'Stop response', exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  await page.getByRole('button', { name: 'Summarize earlier messages', exact: true }).click();
  await expect(page.locator('.chat-summary')).toBeVisible();
  expect(await saved(page, 'cloud-ready')).toEqual(original);
  await page.locator('.compaction-status').getByRole('button', { name: 'View summary' }).click();
  await expect(page.locator('.chat-summary')).toContainText(
    'You can read the original messages above.',
  );
});

test('a temporary local context rejection restores the draft and removes the attempted turn', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Temporary', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  for (const [index, letter] of ['A', 'B'].entries()) {
    await composer.fill(letter.repeat(4000));
    await send.click();
    await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(index + 1);
    await expect(send).toBeVisible();
  }
  const original = await page.locator('.message').allTextContents();
  await page.evaluate(() => localStorage.setItem('straggler-fixture-context-rejection', 'reply'));
  const draft = 'D'.repeat(10400);
  await composer.fill(draft);
  await page.getByRole('button', { name: 'Summarize and send', exact: true }).click();
  await expect(page.getByText('The model ran out of context.', { exact: false })).toBeVisible();
  await expect(composer).toHaveText(draft);
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  expect(await page.locator('.message').allTextContents()).toEqual(original);
  await expect(page.locator('.conversation-row')).toHaveCount(0);
});

test('an OpenRouter model without response limits skips compaction and can still send', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-cloud-no-output-limit', 'true');
    localStorage.setItem(
      'straggler-fixture-chat-defaults-cloud-ready',
      '{"chat_auto_compact":"on"}',
    );
  });
  await seed(page, 'cloud-ready', 'long');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('D'.repeat(18000));
  await expect(
    page.getByRole('alert').filter({ hasText: 'This message needs more room' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Summarize and send', exact: true })).toHaveCount(
    0,
  );

  await composer.fill('D'.repeat(8000));
  await page.getByRole('button', { name: 'Context', exact: true }).click();
  const context = page.getByRole('dialog', { name: 'Context' });
  const meter = context.getByRole('meter');
  const fraction =
    Number(await meter.getAttribute('value')) / Number(await meter.getAttribute('max'));
  expect(fraction).toBeGreaterThanOrEqual(0.75);
  expect(fraction).toBeLessThan(1);
  await expect(context.getByRole('button', { name: 'Summarize earlier messages' })).toBeDisabled();
  await expect(context).toContainText('Choose a model that supports a response token limit');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.assistant .markdown').last()).toContainText('selected cloud fixture');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.locator('.chat-summary')).toHaveCount(0);
  const requests = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-cloud-requests')!),
  );
  expect(requests).toEqual([
    { providerId: 'openrouter', method: 'POST', path: '/chat/completions' },
  ]);
});

test('automatic compaction is opt-in, persists, and starts at the next send for an already long chat', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-context-size', '5600'));
  await seed(page, 'normal', 'long');
  const original = await saved(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Chat defaults');
  const autoCompact = page.getByRole('switch', { name: 'Summarize long chats automatically' });
  await expect(autoCompact).not.toBeChecked();
  await expect(autoCompact).toHaveAccessibleDescription(
    'Summarizes earlier messages before sending at 75% context usage or higher.',
  );
  await autoCompact.press('Space');
  await expect(autoCompact).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('straggler-fixture-chat-defaults-normal')!)
            .chat_auto_compact,
      ),
    )
    .toBe('on');
  expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
  expect(await saved(page)).toEqual(original);

  await page.reload();
  await page.getByRole('button', { name: 'Compact me', exact: true }).click();
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep going.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.assistant .markdown').last()).toContainText('local answer');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.locator('.chat-summary')).toBeVisible();
  const chat = await saved(page);
  expect(chat.messages.slice(0, -2)).toEqual(original.messages);
  expect(chat.messages.at(-2).content).toBe('Keep going.');
});

test('automatic compaction can be stopped before the draft is sent', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-chat-defaults-cancel', '{"chat_auto_compact":"on"}');
  });
  await seed(page, 'cancel', 'long');
  await page.getByRole('button', { name: 'Collapse assistant panel' }).click();
  const original = await saved(page, 'cancel');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Please keep this draft.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const progress = page.getByRole('status').filter({ hasText: 'Summarizing earlier messages…' });
  await expect(progress).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('straggler-fixture-request')))
    .toContain('EARLIER CHAT');
  await page.getByRole('button', { name: 'Stop summarizing', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(composer).toHaveText('Please keep this draft.');
  expect(await saved(page, 'cancel')).toEqual(original);
});

test('automatic compaction waits for cloud consent before sending history', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'straggler-fixture-chat-defaults-cloud-ready',
      '{"chat_auto_compact":"on"}',
    );
  });
  await seed(page, 'cloud-ready', 'over-16k');
  const original = await saved(page, 'cloud-ready');
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Keep going in the cloud.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const notice = page.getByRole('dialog', { name: 'Send this chat to OpenRouter?' });
  await expect(notice).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem('straggler-fixture-cloud-requests')),
  ).toBeNull();
  expect(await saved(page, 'cloud-ready')).toEqual(original);
  await notice.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.assistant .markdown').last()).toContainText('selected cloud fixture');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  expect((await saved(page, 'cloud-ready')).summary.text).toContain(
    'Goals and decisions retained.',
  );
});
