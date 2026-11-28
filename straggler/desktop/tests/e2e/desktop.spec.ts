import { loadSelectedConfiguration, manageConfigurations, settingsSection } from './settings';
import { selectValue } from './select';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function mockDesktop(page: Page, mode = 'normal') {
  await page.addInitScript((value) => {
    if (!new URLSearchParams(location.search).has('scenario'))
      history.replaceState(null, '', `/?scenario=${value}`);
  }, mode);
}

async function loadModel(page: Page) {
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await page.getByRole('button', { name: 'Use model' }).click();
  await expect(page.locator('.local-badge')).toContainText('Ready');
}

test('browser preview reports that native services are unavailable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('This is the interface preview.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('model selection, Markdown, persistence, reopening and confirmed deletion', async ({
  page,
}) => {
  await mockDesktop(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracker.png')) requests.push(request.url());
  });
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Explain local inference');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.markdown strong')).toHaveText('local');
  await expect(page.getByRole('button', { name: 'Copy response' })).toBeVisible();
  await expect(page.locator('.markdown pre')).toContainText('echo hello');
  await expect(page.locator('.markdown script')).toHaveCount(0);
  expect(requests).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: 'Explain local inference', exact: true }).click();
  await expect(page.locator('.markdown strong')).toHaveText('local');
  await page.getByRole('button', { name: 'Options for Explain local inference' }).click();
  await page.getByRole('menuitem', { name: 'Delete Explain local inference' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Explain local inference', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Options for Explain local inference' }).click();
  await page.getByRole('menuitem', { name: 'Delete Explain local inference' }).click();
  await page.getByRole('alertdialog').getByRole('button').last().click();
  await expect(page.getByText('What’s on your mind?')).toBeVisible();
});

test('cancel keeps partial response and permits the next conversation', async ({ page }) => {
  await mockDesktop(page, 'cancel');
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Write something');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.markdown strong')).toHaveText('local');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(composer).toBeEditable();
  await expect(composer).toBeFocused();
  await composer.fill('My next question');
  await composer.press('Enter');
  await expect(page.locator('.message.user')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByText('Response stopped', { exact: true })).toBeVisible();
  await expect(page.locator('.markdown strong')).toHaveText('local');
  await expect(composer).toHaveText('My next question');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /New chat/ })).toBeEnabled();
});

test('typing during prompt validation preserves the next draft and the submitted request', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await loadModel(page);
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('First question');
  await page.evaluate(() => localStorage.setItem('straggler-fixture-prompt-tokens-paused', 'true'));
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('');
  await composer.fill('Next question');
  await composer.press('Enter');
  await expect(composer).toHaveText('Next question');
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-prompt-tokens-paused'));
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(composer).toHaveText('Next question');
  await expect(page.locator('.message.user')).toHaveCount(1);
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages).toEqual([{ role: 'user', content: 'First question' }]);
});

test('streaming permits multiline drafts without duplicate sends and keeps them after completion', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await loadModel(page);
  await page.evaluate(() => localStorage.setItem('straggler-fixture-response-paused', 'true'));
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('First question');
  await composer.press('Enter');
  await expect(page.locator('.markdown strong')).toHaveText('local');
  await expect(composer).toBeEditable();
  await expect(composer).toBeFocused();
  await composer.fill('Next question');
  await composer.press('Shift+Enter');
  await composer.press('Enter');
  await expect(composer).toHaveText('Next question\n');
  await expect(composer.locator(':scope > p')).toHaveCount(2);
  await expect(composer.locator(':scope > p').last()).toBeEmpty();
  await composer.evaluate((element) => element.closest('form')?.requestSubmit());
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-response-paused'));
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(composer).toHaveText('Next question\n');
  await expect(composer.locator(':scope > p')).toHaveCount(2);
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.locator('.message.user').last()).toContainText('Next question');
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages.filter((message: { role: string }) => message.role === 'user')).toEqual([
    { role: 'user', content: 'First question' },
    { role: 'user', content: 'Next question' },
  ]);
});

for (const edited of [false, true]) {
  test(`prompt rejection ${edited ? 'keeps a newer draft' : 'restores the untouched submitted text'}`, async ({
    page,
  }) => {
    await mockDesktop(page);
    await page.goto('/');
    await loadModel(page);
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Rejected question');
    await page.evaluate(() => {
      localStorage.setItem('straggler-fixture-prompt-tokens-paused', 'true');
      localStorage.setItem('straggler-fixture-prompt-tokens', '5000');
    });
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(composer).toHaveText('');
    if (edited) await composer.fill('A newer draft');
    await page.evaluate(() => localStorage.removeItem('straggler-fixture-prompt-tokens-paused'));
    await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
    await expect(composer).toHaveText(edited ? 'A newer draft' : 'Rejected question');
    await expect(page.getByRole('alert')).toContainText('exceed the 4,096-token context');
    await expect(page.locator('.message.user')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('straggler-fixture-request'))).toBeNull();
  });
}

for (const cleared of [false, true]) {
  test(`late server rejection preserves ${cleared ? 'a deliberately cleared draft' : 'a newer draft'}`, async ({
    page,
  }) => {
    await mockDesktop(page);
    await page.goto('/');
    await loadModel(page);
    await page.evaluate(() => {
      localStorage.setItem('straggler-fixture-generation-paused', 'true');
      localStorage.setItem('straggler-fixture-context-rejection', 'true');
    });
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Rejected question');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('straggler-fixture-request')))
      .not.toBeNull();
    await composer.fill('A newer draft');
    if (cleared) {
      await composer.press('ControlOrMeta+a');
      await composer.press('Backspace');
      await expect(composer).toHaveText('');
    }
    await page.evaluate(() => localStorage.removeItem('straggler-fixture-generation-paused'));
    await expect(page.getByText('Response failed', { exact: true })).toBeVisible();
    await expect(composer).toHaveText(cleared ? '' : 'A newer draft');
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.user')).toContainText('Rejected question');
  });
}

test('a shortened draft fits without counting the rejected turn again', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await loadModel(page);
  await page.evaluate(() => localStorage.setItem('straggler-fixture-context-rejection', 'true'));
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('D'.repeat(10000));
  await send.click();
  await expect(page.getByText('Response failed', { exact: true })).toBeVisible();
  await expect(composer).toHaveText('D'.repeat(10000));
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-context-rejection'));
  const shortened = 'D'.repeat(8000);
  await composer.fill(shortened);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole('button', { name: 'Copy response' })).toBeVisible();
  const request = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('straggler-fixture-request')!),
  );
  expect(request.messages).toEqual([{ role: 'user', content: shortened }]);
  await expect(page.locator('.message.user')).toHaveCount(1);
});

test('clipboard failure stays beside its response without blocking chat', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A response to copy');
  await page.getByRole('button', { name: 'Send message' }).click();
  const copy = page.getByRole('button', { name: 'Copy response' });
  await expect(copy).toBeVisible();
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard unavailable');
        },
      },
    }),
  );
  await copy.click();
  await expect(page.locator('.message.assistant').getByRole('alert')).toContainText(
    'Couldn’t copy the text',
  );
  await expect(page.locator('.workspace-feedback')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
});

test('storage failure preserves input in conversation and can be retried', async ({ page }) => {
  await mockDesktop(page, 'save-error');
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.user')).toContainText('Keep this question');
  await expect(page.getByRole('alert').filter({ hasText: 'Chat not saved' })).toContainText(
    'Disk is full',
  );
  await page.getByRole('button', { name: 'Retry saving' }).click();
  await expect(page.getByRole('button', { name: 'Retry saving' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Keep this question', exact: true }).click();
  await expect(page.locator('.message.user')).toContainText('Keep this question');
});

test('unsupported chat is reported and leaves the conversation usable', async ({ page }) => {
  await mockDesktop(page, 'model-error');
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('Unsupported chat template');
  await expect(page.getByText('Response failed', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
});

test('small desktop window keeps model and chat controls accessible', async ({ page }) => {
  await mockDesktop(page);
  await page.setViewportSize({ width: 760, height: 560 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeInViewport();
  await loadModel(page);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('empty setup gives a usable message and keeps launch disabled', async ({ page }) => {
  await mockDesktop(page, 'empty');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select a llama.cpp build', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose external build…' })).toBeVisible();
  await settingsSection(page, 'Model settings');
  await expect(page.getByText('No GGUF models found', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Launch server', exact: true }).last(),
  ).toBeDisabled();
});

test('settings retain generation and performance values through profile operations', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Chat defaults');
  await page.getByRole('textbox', { name: /^Seed/ }).fill('42');
  await page.getByRole('textbox', { name: /^Longest reply/ }).fill('512');
  await selectValue(page.getByRole('combobox', { name: 'Reply style' }), 'focused');
  await expect(page.getByRole('textbox', { name: /^Seed/ })).toHaveValue('42');
  await expect(page.getByRole('textbox', { name: /^Longest reply/ })).toHaveValue('512');
  await settingsSection(page, 'Model settings');
  await selectValue(page.getByRole('combobox', { name: /^Device/ }), 'none');
  await expect(page.getByRole('textbox', { name: 'Model on the GPU', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: /^CPU threads/ }).fill('3');
  await manageConfigurations(page);
  await page.getByRole('textbox', { name: 'New configuration name', exact: true }).fill('Writing');
  await page.getByRole('button', { name: 'Save as new configuration', exact: true }).click();
  await expect(page.getByText('Configuration saved.', { exact: true })).toBeVisible();
  await settingsSection(page, 'Model settings');
  await page.getByRole('textbox', { name: /^CPU threads/ }).fill('4');
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
  await manageConfigurations(page);
  await loadSelectedConfiguration(page);
  await expect(page.getByRole('alertdialog')).toContainText('Replaces your unapplied changes.');
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Load configuration', exact: true })
    .click();
  await settingsSection(page, 'Model settings');
  await expect(page.getByRole('textbox', { name: /^CPU threads/ })).toHaveValue('3');
  await expect(page.locator('.local-badge')).toHaveText('Stopped');
  await settingsSection(page, 'Chat defaults');
  await expect(page.getByRole('textbox', { name: /^Seed/ })).toHaveValue('42');
  await expect(page.getByRole('combobox', { name: 'Reply style' })).toHaveText('Focused');
});

test('folder selection separates browsing, hidden directories, cancel and confirmation', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await settingsSection(page, 'llama.cpp');
  await page.getByRole('button', { name: 'Choose external build…', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose folder' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show hidden folders' }).check();
  await expect(page.getByRole('button', { name: '.hidden', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Folder path' }).fill('/fixture/new backend');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.folder-setting').first().locator('code')).toHaveText(
    '/fixture/llama.cpp',
  );
  await page.getByRole('button', { name: 'Choose external build…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Folder path' }).fill('/fixture/new backend');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(page.locator('.folder-setting').first().locator('code')).toHaveText(
    '/fixture/new backend',
  );
});

test('invalid settings preserve the draft and display validation feedback', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await page.getByRole('textbox', { name: /^CPU threads/ }).fill('0');
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('CPU threads must be positive');
  await expect(page.getByRole('textbox', { name: /^CPU threads/ })).toHaveValue('0');
  await expect(page.getByRole('textbox', { name: /^CPU threads/ })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('.workspace-feedback')).toHaveCount(0);
  await page.getByRole('textbox', { name: /^CPU threads/ }).fill('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('fatal OOM stays visible through polling, preserves partial text and supports reviewed recovery', async ({
  page,
}) => {
  await mockDesktop(page, 'oom');
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this response');
  await page.evaluate(() => localStorage.setItem('straggler-fixture-response-paused', 'true'));
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Stop response' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep this draft too');
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-response-paused'));
  const failure = page.locator('.workspace-feedback .feedback');
  await expect(failure).toContainText('Not enough memory');
  await expect(page.locator('.local-badge')).toHaveText('Needs restart');
  await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy message' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.evaluate(() => {
    const state = window as Window & { errorNode?: Element | null; contentNode?: Element | null };
    state.errorNode = document.querySelector('.workspace-feedback .feedback');
    state.contentNode = document.querySelector('.image-placeholder');
  });
  // Observe the same elements across background status/configuration updates.
  await page.waitForTimeout(5500);
  expect(
    await page.evaluate(() => {
      const state = window as Window & { errorNode?: Element | null; contentNode?: Element | null };
      return (
        state.errorNode === document.querySelector('.workspace-feedback .feedback') &&
        state.contentNode === document.querySelector('.image-placeholder')
      );
    }),
  ).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
    'Keep this draft too',
  );
  await failure.getByRole('button', { name: 'Stop server', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(failure).toContainText('Not enough memory');
  await failure.getByRole('button', { name: 'Stop server', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Stop server', exact: true })
    .click();
  await expect(failure).toContainText('Server stopped after a memory error');
  await failure.getByRole('button', { name: 'Review settings' }).click();
  await selectValue(page.getByRole('combobox', { name: 'Context size', exact: true }), '4096');
  await settingsSection(page, 'Model settings');
  await selectValue(page.getByRole('combobox', { name: /^Reading your message/ }), 'low-memory');
  await page.getByRole('button', { name: 'Launch server', exact: true }).last().click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
    'Keep this draft too',
  );
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Copy response' })).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'Keep this response', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('.message.assistant').first()).toContainText('Compute error.');
});

test('startup OOM is persistent without opening a modal or accepting new requests', async ({
  page,
}) => {
  await mockDesktop(page, 'oom-startup');
  await page.goto('/');
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Needs restart');
  await expect(page.getByRole('alert')).toContainText('Not enough memory');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
});

test('memory and storage failures remain independently actionable in a small window', async ({
  page,
}) => {
  await mockDesktop(page, 'oom-and-save-error');
  await page.setViewportSize({ width: 760, height: 560 });
  await page.goto('/');
  await loadModel(page);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Preserve despite both failures');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough memory' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Chat not saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: /New chat/ })).toBeDisabled();
  const retry = page.getByRole('button', { name: 'Retry saving' });
  await retry.scrollIntoViewIfNeeded();
  await expect(retry).toBeInViewport();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough memory' })).toBeVisible();
  await expect(page.getByRole('button', { name: /New chat/ })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('unknown compute errors stay with the response and do not diagnose an OOM', async ({
  page,
}) => {
  await mockDesktop(page, 'compute-error');
  await page.goto('/');
  await loadModel(page);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A request');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message.assistant').getByRole('alert')).toContainText(
    'Compute error.',
  );
  await expect(page.locator('.workspace-feedback')).toHaveCount(0);
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
});

test('history and backend errors use their own context and recovery actions', async ({ page }) => {
  await mockDesktop(page, 'history-error');
  await page.goto('/');
  await expect(page.locator('.composer-wrap').getByRole('alert')).toContainText(
    'Chat history unavailable',
  );
  await page.evaluate(() => localStorage.setItem('straggler-fixture-history-recovered', 'true'));
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.goto('/?scenario=backend-error');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await settingsSection(page, 'llama.cpp');
  await page.getByRole('button', { name: 'Use bundled version', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Use bundled version', exact: true })
    .click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation.getByRole('alert')).toContainText('Couldn’t complete the action');
  await confirmation.getByText('Technical details', { exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText(
    'The bundled backend could not be selected.',
  );
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Use bundled version', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.workspace-feedback')).toHaveCount(0);
});

test('hardware scenarios preserve generic controls and unknown memory', async ({ page }) => {
  for (const scenario of ['cpu', 'multiple', 'unknown-memory']) {
    await page.goto(`/?scenario=${scenario}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settingsSection(page, 'Chat defaults');
    await settingsSection(page, 'Model settings');
    await expect(
      page.getByText('Auto lets llama.cpp choose for your hardware.', { exact: false }),
    ).toBeVisible();
    if (scenario === 'multiple') {
      await expect(
        page.getByText('Advanced: several devices · 4 settings', { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText('Advanced: several devices · 4 settings', { exact: true }),
      ).toHaveCount(0);
    }
    if (scenario === 'unknown-memory') {
      await settingsSection(page, 'Model settings');
      await expect(page.getByText('Available RAM: Unavailable')).toBeVisible();
    }
  }
});

test('occupying listeners require separate normal and force confirmations', async ({ page }) => {
  await page.goto('/?scenario=occupied');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await expect(page.getByRole('button', { name: 'Force quit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close programs using it', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('SIGTERM');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Force quit', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close programs using it', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button').last().click();
  await page.getByRole('button', { name: 'Force quit', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText('SIGKILL');
  await page.getByRole('alertdialog').getByRole('button').last().click();
  await expect(page.getByText('Port 9931 is free')).toBeVisible();
});
