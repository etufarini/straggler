import { expect, test, type Page } from '@playwright/test';

const projectId = '10000000-0000-4000-8000-000000000001';
const chatId = '20000000-0000-4000-8000-000000000001';

async function prepare(page: Page, web: string, reasoning: boolean) {
  const scenario = web === 'missing' ? 'web-no-key' : 'web-normal';
  await page.addInitScript(
    ({ scenario, reasoning, projectId, chatId }) => {
      localStorage.setItem(
        'straggler-fixture-ui-preferences',
        JSON.stringify({
          sidebarCollapsed: false,
          presenceExpanded: false,
          webSearchNoticeSeen: true,
        }),
      );
      localStorage.setItem(
        `straggler-fixture-projects-${scenario}`,
        JSON.stringify([
          {
            id: projectId,
            name: 'Composer layout project',
            description: '',
            instructions: 'Use project instructions.',
            starred: true,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            files: [],
          },
        ]),
      );
      localStorage.setItem(
        `straggler-fixture-${scenario}`,
        JSON.stringify([
          {
            id: chatId,
            title: 'Project composer',
            projectId,
            createdAt: 1,
            updatedAt: 1,
            messages: [],
            options: { systemPrompt: null, reasoning: reasoning ? 'on' : 'auto', effort: 'auto' },
          },
        ]),
      );
    },
    { scenario, reasoning, projectId, chatId },
  );
  await page.goto(`/?scenario=${scenario}`);
  await page
    .getByRole('button', { name: 'Project composer in Composer layout project', exact: true })
    .click();
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await expect(page.locator('.local-badge')).toHaveText('Ready');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check composer controls');
  if (web === 'on') await page.getByRole('button', { name: 'Web search', exact: true }).click();
}

async function inspectControls(page: Page) {
  const controls = page.locator('.composer-footer .composer-chip, .composer-footer .send-button');
  await expect(controls).toHaveCount(7);
  for (const control of await controls.all()) {
    await expect(control).toHaveAccessibleName(/\S/);
  }
  // Read geometry in one browser snapshot so the resize sweep does not spend
  // its timeout on a separate protocol round trip for every measurement.
  await expect
    .poll(() =>
      page.locator('.composer').evaluate((form) => {
        const bounds = form.getBoundingClientRect();
        const boxes = [
          ...form.querySelectorAll(
            '.composer-footer .composer-chip, .composer-footer .send-button',
          ),
        ].map((node) => node.getBoundingClientRect());
        const outside = boxes.some(
          (box) =>
            box.left < bounds.left ||
            box.right > bounds.right ||
            box.top < bounds.top ||
            box.bottom > bounds.bottom,
        );
        const overlaps = boxes.some((a, index) =>
          boxes
            .slice(index + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
                Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
            ),
        );
        const tooSmall = boxes
          .filter((box) => box.width < 24 || box.height < 24)
          .map((box) => ({ width: box.width, height: box.height }));
        return { count: boxes.length, tooSmall, outside, overlaps };
      }),
    )
    .toEqual({ count: 7, tooSmall: [], outside: false, overlaps: false });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(send).toBeEnabled();
  await expect(send).toBeInViewport();
}

// Cover compact/tall windows, both sides of the overlay boundary and a wide
// desktop. Web-key availability and reasoning vary without multiplying every case.
for (const { width, height, web, reasoning } of [
  { width: 760, height: 560, web: 'off', reasoning: false },
  { width: 820, height: 820, web: 'missing', reasoning: true },
  { width: 1024, height: 560, web: 'on', reasoning: true },
  { width: 1100, height: 820, web: 'off', reasoning: true },
  { width: 1101, height: 820, web: 'missing', reasoning: false },
  { width: 1440, height: 820, web: 'on', reasoning: true },
]) {
  test(`composer ${width}x${height}, web ${web}, reasoning ${reasoning}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await prepare(page, web, reasoning);
    for (const sidebar of ['normal', 'compact']) {
      if (sidebar === 'compact')
        await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await inspectControls(page);
      await page.getByRole('button', { name: 'Send message', exact: true }).click({ trial: true });
      await page.getByRole('button', { name: 'Expand assistant panel', exact: true }).click();
      if (width > 1100) await inspectControls(page);
      // At <=1100px the existing panel intentionally overlays chat. Close it to send.
      if (width > 1100)
        await page
          .getByRole('button', { name: 'Send message', exact: true })
          .click({ trial: true });
      await page.getByRole('button', { name: 'Collapse assistant panel', exact: true }).click();
      await page.getByRole('button', { name: 'Send message', exact: true }).click({ trial: true });
    }
    for (const label of [
      'System prompt: Project instructions',
      'Reasoning',
      'Context',
      ...(web === 'missing' ? ['Web search'] : []),
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const popover = page.getByRole('dialog', { name: label, exact: true });
      await expect(popover).toBeVisible();
      const form = (await page.locator('.composer').boundingBox())!;
      const box = (await popover.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(form.x);
      expect(box.x + box.width).toBeLessThanOrEqual(form.x + form.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Escape');
    }
  });
}

async function resizeComposer(page: Page, width: number) {
  const composer = page.locator('.composer');
  await composer.evaluate((form, width) => {
    form.style.width = `${width}px`;
  }, width);
  await expect
    .poll(() => composer.evaluate((form) => Math.round(form.getBoundingClientRect().width)))
    .toBe(width);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

test('all four densities follow measured space with hysteresis and accessible active icons', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 820 });
  await prepare(page, 'on', true);
  const composer = page.locator('.composer');
  const { fullWidth, compactWidth, iconWidth, fullWithHint } = await composer.evaluate(
    async (form) => {
      await document.fonts.ready;
      const footer = form.querySelector('.composer-footer')!;
      const tools = form.querySelector('.composer-tools')!;
      const send = form.querySelector('.composer-send')!;
      const style = getComputedStyle(footer);
      const overhead =
        form.getBoundingClientRect().width -
        footer.clientWidth +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.columnGap);
      const original = form.getAttribute('data-density')!;
      const originalNarrow = form.getAttribute('data-narrow')!;
      function requiredWidth(density: string) {
        form.setAttribute('data-density', density);
        return Math.ceil(
          tools.getBoundingClientRect().width + send.getBoundingClientRect().width + overhead,
        );
      }
      form.setAttribute('data-narrow', 'true');
      const [fullWidth, compactWidth, iconWidth] = ['full', 'compact', 'icon'].map(requiredWidth);
      form.setAttribute('data-narrow', 'false');
      const fullWithHint = requiredWidth('full');
      form.setAttribute('data-density', original);
      form.setAttribute('data-narrow', originalNarrow);
      return { fullWidth, compactWidth, iconWidth, fullWithHint };
    },
  );
  // Widening the composer can reveal the keyboard hint and raise its minimum width.
  const widthWithRoomForFull = Math.max(fullWidth, fullWithHint) + 32;
  const transitionWidth = fullWidth - 2;
  for (const [width, density] of [
    [widthWithRoomForFull, 'full'],
    [transitionWidth, 'compact'],
    [compactWidth - 2, 'icon'],
    [iconWidth - 2, 'wrap'],
    [160, 'wrap'],
  ] as const) {
    await resizeComposer(page, width);
    await expect(composer).toHaveAttribute('data-density', density);
    await inspectControls(page);
  }
  for (const name of ['Reasoning', 'Web search']) {
    const chip = page.getByRole('button', { name, exact: true });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toHaveAttribute('title', /\S/);
  }
  await composer.evaluate((form, width) => {
    form.style.width = `${width}px`;
  }, transitionWidth);
  await expect(composer).toHaveAttribute('data-density', 'compact');
  await composer.evaluate((form, width) => {
    form.style.width = `${width + 8}px`;
  }, transitionWidth);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(composer).toHaveAttribute('data-density', 'compact');
  await resizeComposer(page, widthWithRoomForFull);
  await expect(composer).toHaveAttribute('data-density', 'full');
});

for (const close of ['Escape', 'button', 'outside']) {
  test(`overlay protects covered controls and restores focus after ${close}`, async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 560 });
    await prepare(page, 'on', true);
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    await message.focus();
    await page.getByRole('button', { name: 'Expand assistant panel', exact: true }).click();
    await expect(page.locator('.chat-main')).toHaveJSProperty('inert', true);
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('.chat-main'))).toBe(
        false,
      );
    }
    if (close === 'Escape') await page.keyboard.press('Escape');
    else if (close === 'button')
      await page.getByRole('button', { name: 'Collapse assistant panel', exact: true }).click();
    else await page.locator('.notice').click();
    await expect(page.locator('.chat-main')).toHaveJSProperty('inert', false);
    await expect(message).toBeFocused();
    await page.getByRole('button', { name: 'Send message', exact: true }).click({ trial: true });
  });
}
