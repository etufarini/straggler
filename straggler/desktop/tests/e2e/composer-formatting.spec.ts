import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import { tabToNextControl } from './keyboard';

const message = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' }).last();

async function moveToBlockStart(page: Page, text: string) {
  for (let index = 0; index < text.length; index++) await message(page).press('ArrowLeft');
  // Native selectionchange is asynchronous; wait until the editor sees the caret.
  await expect
    .poll(() =>
      message(page).evaluate(
        (field) =>
          (field as HTMLElement & { editor: Editor }).editor.state.selection.$from.parentOffset,
      ),
    )
    .toBe(0);
}

async function start(page: Page) {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: /^Choose model · / }).click();
  await page.getByRole('button', { name: 'Use model', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await message(page).focus();
}
async function paste(page: Page, text: string, html = '') {
  await message(page).evaluate(
    (element, { text, html }) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      if (html) clipboardData.setData('text/html', html);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    { text, html },
  );
}
async function sentText(page: Page) {
  await expect(page.locator('.message.user').last()).toBeVisible();
  return page.evaluate(() => {
    const request = JSON.parse(localStorage.getItem('straggler-fixture-request')!);
    return request.messages.filter((item: { role: string }) => item.role === 'user').at(-1).content;
  });
}

async function holdFirstModelLoad(page: Page) {
  await page.addInitScript(() => localStorage.setItem('straggler-fixture-model-loading', 'true'));
  await page.goto('/?scenario=normal');
  await expect(message(page)).not.toBeEditable();
}

async function finishFirstModelLoad(page: Page) {
  await expect(page.getByRole('button', { name: 'Server log · Loading' })).toBeVisible();
  await expect(message(page)).not.toBeEditable();
  await page.evaluate(() => localStorage.removeItem('straggler-fixture-model-loading'));
  await expect(page.getByRole('button', { name: 'Server log · Ready' })).toBeVisible();
  await expect(message(page)).toBeEditable();
}

for (const [entry, buttonName] of [
  ['launch button', /^Launch server$/],
  ['model selector', /^Choose model · /],
  ['welcome button', /^Choose a model to get started/],
] as const) {
  test(`the first local model focuses the message field from the ${entry}`, async ({ page }) => {
    await holdFirstModelLoad(page);
    const button = page.getByRole('button', { name: buttonName });
    if (entry === 'launch button') await button.press('Enter');
    else {
      await button.click();
      await page.getByRole('button', { name: 'Use model', exact: true }).click();
    }
    await finishFirstModelLoad(page);
    await expect(message(page)).toBeFocused();
    await page.keyboard.type('My first message');
    await expect(message(page)).toHaveText('My first message');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
}

test('the first local model preserves focus moved during loading', async ({ page }) => {
  await holdFirstModelLoad(page);
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('button', { name: 'Server log · Loading' }).focus();
  await finishFirstModelLoad(page);
  await expect(page.getByRole('button', { name: 'Server log · Ready' })).toBeFocused();
});

for (const [typed, tag] of [
  ['*bold*', 'strong'],
  ['**bold**', 'strong'],
  ['_italic_', 'em'],
  ['~strike~', 's'],
  ['~~strike~~', 's'],
  ['`code`', 'code'],
  ['1. ', 'ol'],
  ['- ', 'ul'],
  ['* ', 'ul'],
  ['> ', 'blockquote'],
  ['```', 'pre'],
]) {
  test(`converts ${JSON.stringify(typed)} and undo restores the exact symbols`, async ({
    page,
  }) => {
    await start(page);
    await message(page).pressSequentially(typed);
    await expect(message(page).locator(tag)).toHaveCount(1);
    await message(page).press('ControlOrMeta+z');
    await expect(message(page)).toHaveText(typed, { useInnerText: true });
    await expect(message(page).locator(tag)).toHaveCount(0);
  });
}

const actions = [
  ['Bold', 'ControlOrMeta+b', 'strong'],
  ['Italic', 'ControlOrMeta+i', 'em'],
  ['Strikethrough', 'ControlOrMeta+Shift+KeyX', 's'],
  ['Numbered list', 'ControlOrMeta+Shift+Digit7', 'ol'],
  ['Bulleted list', 'ControlOrMeta+Shift+Digit8', 'ul'],
  ['Quote', 'ControlOrMeta+Shift+Digit9', 'blockquote'],
  ['Code', 'ControlOrMeta+Shift+KeyC', 'code'],
  ['Code block', 'ControlOrMeta+Alt+Shift+KeyC', 'pre'],
];
for (const [name, shortcut, tag] of actions) {
  for (const method of ['button', 'shortcut']) {
    test(`${name} through ${method} formats the selection and reports pressed state`, async ({
      page,
    }) => {
      await start(page);
      await message(page).fill('selected text');
      await message(page).press('ControlOrMeta+a');
      if (method === 'button')
        await toolbar(page).getByRole('button', { name, exact: true }).click();
      else await page.keyboard.press(shortcut);
      await expect(message(page).locator(tag)).toContainText('selected text');
      await expect(toolbar(page).getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(toolbar(page).getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-keyshortcuts',
        /Control|Meta/,
      );
    });
  }
}

test('plain Enter sends; Shift+Enter preserves one newline in Markdown and display', async ({
  page,
}) => {
  await start(page);
  await message(page).pressSequentially('first');
  await message(page).press('Shift+Enter');
  await page.keyboard.type('second');
  await message(page).press('Enter');
  expect(await sentText(page)).toBe('first\nsecond');
  await expect(page.locator('.message.user .markdown br')).toHaveCount(1);
});

test('list items indent, outdent and exit, while Enter sends', async ({ page }) => {
  await start(page);
  await message(page).pressSequentially('- first');
  await message(page).press('Shift+Enter');
  await page.keyboard.type('child');
  await message(page).press('Tab');
  await expect(message(page).locator('ul ul')).toHaveCount(1);
  await message(page).press('Shift+Tab');
  await expect(message(page).locator('ul ul')).toHaveCount(0);
  await message(page).press('Shift+Enter');
  await message(page).press('Shift+Enter');
  await page.keyboard.type('outside');
  await expect(message(page).locator(':scope > p')).toHaveText('outside');
  await message(page).press('Enter');
  expect(await sentText(page)).toBe('- first\n- child\n\noutside');
});

test('quote exits on an empty line or Backspace at its start', async ({ page }) => {
  await start(page);
  await message(page).pressSequentially('> quote');
  await message(page).press('Shift+Enter');
  await message(page).press('Shift+Enter');
  await page.keyboard.type('outside');
  await expect(message(page).locator(':scope > p')).toHaveText('outside');
  await start(page);
  await message(page).pressSequentially('> quote');
  await moveToBlockStart(page, 'quote');
  await page.keyboard.press('Backspace');
  await expect(message(page).locator('blockquote')).toHaveCount(0);
});

test('code keeps literal text, exits at the last empty line and supports Mod+Enter', async ({
  page,
}) => {
  await start(page);
  await message(page).pressSequentially('```*literal*');
  await expect(message(page).locator('pre')).toHaveText('*literal*');
  for (const button of await toolbar(page).getByRole('button').all()) {
    if ((await button.getAttribute('aria-label')) !== 'Code block')
      await expect(button).toBeDisabled();
  }
  await message(page).press('Enter');
  await page.keyboard.type('second');
  await expect(page.locator('.message.user')).toHaveCount(0);
  await message(page).press('Enter');
  await message(page).press('Enter');
  await page.keyboard.type('after code');
  await expect(message(page).locator(':scope > p')).toHaveText('after code');
  await start(page);
  await message(page).pressSequentially('```send code');
  await message(page).press('ControlOrMeta+Enter');
  expect(await sentText(page)).toBe('```\nsend code\n```');
});

test('ArrowDown exits the last code block; Backspace converts its start to text', async ({
  page,
}) => {
  await start(page);
  await message(page).pressSequentially('```code');
  await message(page).press('ArrowDown');
  await page.keyboard.type('below');
  await expect(message(page).locator(':scope > p')).toHaveText('below');
  await start(page);
  await message(page).pressSequentially('```code');
  await moveToBlockStart(page, 'code');
  await page.keyboard.press('Backspace');
  await expect(message(page).locator('pre')).toHaveCount(0);
  await expect(message(page)).toHaveText('code');
});

test('paste is plain text, explicit Markdown conversion is undoable, and URLs link selections', async ({
  page,
}) => {
  await start(page);
  await paste(page, '**bold**\n- item', '<b>bold</b><ul><li>item</li></ul>');
  await expect(message(page).locator('strong, ul')).toHaveCount(0);
  await message(page).press('ControlOrMeta+Shift+KeyF');
  await expect(message(page).locator('strong')).toHaveText('bold');
  await expect(message(page).locator('ul')).toHaveText('item');
  await message(page).press('ControlOrMeta+z');
  await expect(message(page).locator('strong, ul')).toHaveCount(0);
  await message(page).fill('selected');
  await message(page).press('ControlOrMeta+a');
  await paste(page, 'https://example.com');
  await expect(message(page).locator('a')).toHaveText('selected');
  await expect(message(page).locator('a')).toHaveAttribute('href', 'https://example.com');
});

test(
  'link popover validates email and protocols, edits and removes links',
  { tag: '@platform' },
  async ({ page }) => {
    await start(page);
    await message(page).fill('example');
    await message(page).press('ControlOrMeta+a');
    await message(page).press('ControlOrMeta+Shift+KeyU');
    const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
    await expect(dialog.getByText('Add link', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('example');
    for (const invalid of [
      'mailto:a@example.com,b@example.com',
      'mailto:a%0a@example.com',
      'javascript:alert(1)',
    ]) {
      await dialog.getByRole('textbox', { name: 'Link', exact: true }).fill(invalid);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByText('Enter a web link or an email address')).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Link', exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    }
    await dialog.getByRole('textbox', { name: 'Link', exact: true }).fill('example.com/a(b)');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(message(page).locator('a')).toHaveAttribute('href', 'https://example.com/a(b)');
    await expect(message(page)).toBeFocused();
    expect(
      await message(page).evaluate((field) => {
        const selection = window.getSelection()!;
        const beforeCaret = document.createRange();
        beforeCaret.selectNodeContents(field);
        beforeCaret.setEnd(selection.focusNode!, selection.focusOffset);
        return { collapsed: selection.isCollapsed, textBefore: beforeCaret.toString() };
      }),
    ).toEqual({ collapsed: true, textBefore: 'example' });
    await message(page).press('ArrowLeft');
    await toolbar(page).getByRole('button', { name: 'Link', exact: true }).click();
    await expect(dialog.getByText('Edit link', { exact: true })).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Text', exact: true }).fill('renamed');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(message(page).locator('a')).toHaveText('renamed');
    await message(page).press('ArrowLeft');
    await toolbar(page).getByRole('button', { name: 'Link', exact: true }).click();
    await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
    await expect(message(page).locator('a')).toHaveCount(0);
    await expect(message(page)).toHaveText('renamed');
  },
);

test('toolbar preference survives reload, applies to editing, and Enter still adds a line', async ({
  page,
}) => {
  await start(page);
  await message(page).pressSequentially('*bold*');
  await message(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Hide formatting' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show formatting' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
  await page.getByRole('button', { name: '**bold**', exact: true }).click();
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  const edit = page.getByRole('textbox', { name: 'Edit message', exact: true });
  await expect(edit.locator('strong')).toHaveText('bold');
  await edit.press('End');
  await edit.press('Enter');
  await page.keyboard.type('second');
  await expect(edit).toContainText('second');
  await expect(page.getByRole('button', { name: 'Save and regenerate' })).toBeVisible();
  await edit.press('Escape');
  await expect(edit).toHaveCount(0);
  await expect(page.locator('.message.user .markdown')).toHaveText('bold');
});

test(
  'IME Enter does not send; intraword symbols and inline code remain literal',
  { tag: '@platform' },
  async ({ page }) => {
    await start(page);
    await message(page).pressSequentially('2*3*4 snake_case_name ');
    await expect(message(page).locator('strong, em')).toHaveCount(0);
    await message(page).dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
    });
    await expect(page.locator('.message.user')).toHaveCount(0);
    await message(page).fill('code');
    await message(page).press('ControlOrMeta+a');
    await message(page).press('ControlOrMeta+Shift+KeyC');
    for (const name of ['Bold', 'Italic', 'Strikethrough', 'Link'])
      await expect(toolbar(page).getByRole('button', { name, exact: true })).toBeDisabled();
    await message(page).press('ControlOrMeta+u');
    await expect(message(page).locator('u')).toHaveCount(0);
  },
);

test(
  'toolbar has one tab stop, arrow navigation, Home, End and Escape; text does not trap Tab',
  { tag: '@platform' },
  async ({ page, browserName }) => {
    await start(page);
    await expect(toolbar(page).locator('button[tabindex="0"]')).toHaveCount(1);
    const bold = toolbar(page).getByRole('button', { name: 'Bold', exact: true });
    await bold.focus();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar(page).getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
    await page.keyboard.press('End');
    await expect(
      toolbar(page).getByRole('button', { name: 'Code block', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Home');
    await expect(bold).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(message(page)).toBeFocused();
    await tabToNextControl(page, browserName);
    await expect(page.getByRole('button', { name: 'Hide formatting' })).toBeFocused();
  },
);

for (const [width, height] of [
  [760, 620],
  [1200, 820],
  [1600, 1000],
]) {
  test(`formatting layout ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await start(page);
    await expect(toolbar(page).getByRole('button')).toHaveCount(9);
    for (const density of ['full', 'compact', 'icon', 'wrap']) {
      await page.locator('.composer').evaluate((form, density) => {
        form.setAttribute('data-density', density);
      }, density);
      const geometry = await page.locator('.composer').evaluate((form) => {
        const bounds = form.getBoundingClientRect();
        const boxes = [...form.querySelectorAll('.format-button')].map((element) =>
          element.getBoundingClientRect(),
        );
        const footerBoxes = [...form.querySelectorAll('.composer-footer button')].map((element) =>
          element.getBoundingClientRect(),
        );
        return {
          outside: boxes.some(
            (box) =>
              box.left < bounds.left ||
              box.right > bounds.right ||
              box.top < bounds.top ||
              box.bottom > bounds.bottom,
          ),
          overlap: boxes.some((a, i) =>
            [...boxes.slice(i + 1), ...footerBoxes].some(
              (b) =>
                Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
                Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
            ),
          ),
        };
      });
      expect(geometry).toEqual({ outside: false, overlap: false });
    }
    await message(page).pressSequentially('*Ready to discuss*');
    await message(page).press('Shift+Enter');
    await page.keyboard.type('A formatted local message.');
    await page.screenshot({ path: testInfo.outputPath(`composer-${width}x${height}.png`) });
  });
}

test('no loaded model disables the editor and toolbar and keeps its placeholder', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await expect(message(page)).not.toBeEditable();
  await expect(message(page)).toHaveAttribute(
    'aria-placeholder',
    'Load a model to start chatting…',
  );
  for (const button of await toolbar(page).getByRole('button').all())
    await expect(button).toBeDisabled();
  await expect(message(page).locator('[data-placeholder]')).toHaveAttribute(
    'data-placeholder',
    'Load a model to start chatting…',
  );
});

test(
  'physical key codes work on non-English layouts and preserve the temporary shortcut',
  { tag: '@platform' },
  async ({ page }) => {
    await start(page);
    await message(page).fill('item');
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await message(page).dispatchEvent('keydown', {
      key: '/',
      code: 'Digit7',
      shiftKey: true,
      ctrlKey: !mac,
      metaKey: mac,
    });
    await expect(message(page).locator('ol')).toHaveText('item');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await message(page).press('ControlOrMeta+Shift+KeyN');
    await expect(page.locator('.temp-status')).toBeVisible();
    await expect(page.locator('.workspace')).toHaveClass(/is-temporary/);
    await message(page).pressSequentially('_temporary_');
    await expect(message(page).locator('em')).toHaveText('temporary');
  },
);

test('composition events prevent automatic formatting while the IME is active', async ({
  page,
}) => {
  await start(page);
  await message(page).dispatchEvent('compositionstart', { data: '' });
  await message(page).pressSequentially('*composing*');
  await expect(message(page).locator('strong')).toHaveCount(0);
  await message(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(page.locator('.message.user')).toHaveCount(0);
  await message(page).dispatchEvent('compositionend', { data: '*composing*' });
});

test(
  'hidden toolbar supports the link shortcut and cancellation restores focus',
  { tag: '@platform' },
  async ({ page }) => {
    await start(page);
    await page.getByRole('button', { name: 'Hide formatting' }).click();
    await message(page).fill('link');
    await message(page).press('ControlOrMeta+a');
    await message(page).press('ControlOrMeta+Shift+KeyU');
    const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(message(page)).toBeFocused();
    await expect(message(page)).toHaveText('link');
    await expect(page.getByRole('button', { name: 'Show formatting' })).toBeVisible();
  },
);

test('email paste links selections, code stays literal and sent HTTP links open externally', async ({
  page,
}) => {
  await start(page);
  await message(page).fill('replace');
  await message(page).press('ControlOrMeta+a');
  await paste(page, 'person@example.com');
  await expect(message(page).locator('a')).toHaveAttribute('href', 'mailto:person@example.com');
  await expect(message(page)).toHaveText('replace');
  await start(page);
  await message(page).pressSequentially('```');
  await paste(page, '**literal**\n- text');
  await message(page).press('ControlOrMeta+Shift+KeyF');
  await expect(message(page).locator('pre')).toHaveText('**literal**\n- text');
  await expect(message(page).locator('strong, ul')).toHaveCount(0);
  await start(page);
  await page.evaluate(() =>
    window.addEventListener('straggler-fixture-external-url', (event) => {
      Object.assign(window, { openedComposerLink: (event as CustomEvent).detail });
    }),
  );
  await paste(page, '[Example](https://example.com/path)');
  await message(page).press('ControlOrMeta+Shift+KeyF');
  await message(page).locator('a').click();
  expect(
    await page.evaluate(
      () => (window as Window & { openedComposerLink?: string }).openedComposerLink,
    ),
  ).toBeUndefined();
  await message(page).press('ControlOrMeta+Enter');
  await page.locator('.message.user .markdown a').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as Window & { openedComposerLink?: string }).openedComposerLink),
    )
    .toBe('https://example.com/path');
});

test('unchanged user edits preserve exact Markdown through save and regeneration', async ({
  page,
}) => {
  await start(page);
  const markdown =
    '**bold _nested_**\nsecond line\n\n- first\n  - child\n\n> quote\n> next\n\n````\n```\n````\n\n[Example](https://example.com/a%28b%29)';
  await paste(page, markdown);
  await message(page).press('ControlOrMeta+Shift+KeyF');
  await message(page).press('ControlOrMeta+Enter');
  expect(await sentText(page)).toBe(markdown);
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  const edit = page.getByRole('textbox', { name: 'Edit message', exact: true });
  await expect(edit).toBeFocused();
  await expect(edit.locator('strong em')).toHaveText('nested');
  await expect(edit.locator('ul ul')).toHaveCount(1);
  await expect(edit.locator('blockquote')).toContainText('quote');
  await expect(edit.locator('pre')).toHaveText('```');
  await edit.press('ControlOrMeta+Enter');
  await expect(edit).toHaveCount(0);
  expect(await sentText(page)).toBe(markdown);
});

test('project start sends rich Markdown and retains attachment controls', async ({ page }) => {
  await start(page);
  await page.locator('[data-control-id="button-new-project"]').click();
  await page.locator('[data-control-id="input-project-name"]').fill('Formatting project');
  await page.locator('[data-control-id="button-create-project"]').click();
  const field = page.locator('[data-control-id="textarea-start-chat"]');
  await field.pressSequentially('*Project question*');
  await expect(field.locator('strong')).toHaveText('Project question');
  await field.press('Enter');
  await expect(page.locator('.message.user .markdown strong')).toHaveText('Project question');
  expect(await sentText(page)).toContain('**Project question**');
  await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toBeVisible();
});

test.describe('Safari focus restoration', { tag: '@platform' }, () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });

  test('Escape does not steal the following Tab when the next frame arrives', async ({
    page,
    browserName,
  }) => {
    await start(page);
    // Exercise TipTap's Safari branch even in Chromium, with a deterministic
    // frame boundary between the immediate focus and any delayed refocus.
    await page.evaluate(() => {
      const state = window as Window & { focusFrames?: FrameRequestCallback[] };
      state.focusFrames = [];
      window.requestAnimationFrame = (callback) => state.focusFrames!.push(callback);
    });
    await toolbar(page).getByRole('button', { name: 'Bold', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(message(page)).toBeFocused();
    await tabToNextControl(page, browserName);
    await expect(page.getByRole('button', { name: 'Hide formatting' })).toBeFocused();
    await page.evaluate(() => {
      const state = window as Window & { focusFrames?: FrameRequestCallback[] };
      for (const callback of state.focusFrames!.splice(0)) callback(performance.now());
    });
    await expect(page.getByRole('button', { name: 'Hide formatting' })).toBeFocused();
  });
});

test('email popover discloses removed headers and opens only the recipient', async ({ page }) => {
  await start(page);
  await message(page).fill('Email');
  await message(page).press('ControlOrMeta+a');
  await message(page).press('ControlOrMeta+Shift+KeyU');
  const dialog = page.getByRole('dialog', { name: 'Link', exact: true });
  await dialog
    .getByRole('textbox', { name: 'Link', exact: true })
    .fill('mailto:person@example.com?subject=Hello&body=Hi&bcc=hidden@example.com');
  await expect(dialog.getByText('Subject and body aren’t kept.')).toBeVisible();
  await expect(
    dialog.getByText('Email link · opens your email app, addressed to person@example.com'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(message(page).locator('a')).toHaveAttribute('href', 'mailto:person@example.com');
  await page.evaluate(() =>
    window.addEventListener('straggler-fixture-external-url', (event) => {
      Object.assign(window, { openedEmail: (event as CustomEvent).detail });
    }),
  );
  await message(page).press('ControlOrMeta+Enter');
  await page.locator('.message.user .markdown a').click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { openedEmail?: string }).openedEmail))
    .toBe('mailto:person@example.com');
});
