import { loadSelectedConfiguration, manageConfigurations, settingsSection } from './settings';
import { selectValue } from './select';
import { observeOrb } from './orb';
import { expect, test } from '@playwright/test';

test('sidebar preference persists and server log restores keyboard focus', async ({ page }) => {
  await page.goto('/?scenario=normal');
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' });
  await collapse.click();
  await expect(page.locator('.sidebar')).toHaveCSS('width', '68px');
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect(page.locator('.sidebar .server-card, .sidebar nav')).toHaveCount(0);
  const badge = page.getByRole('button', { name: /Server log/ });
  await badge.focus();
  await badge.press('Enter');
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Server log' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(badge).toBeFocused();
  await expect(badge).toHaveAttribute('aria-expanded', 'false');
});

test('restart indication remains accessible after returning to chat', async ({ page }) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await expect(page.locator('.local-badge')).toContainText('Ready');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await page.getByRole('textbox', { name: 'Custom size (tokens)', exact: true }).fill('8192');
  await page.getByRole('button', { name: 'Back to chat' }).click();
  await expect(page.locator('.local-badge')).toContainText('Restart required');
  await expect(page.locator('.configuration-strip, .settings-launch')).toHaveCount(0);
});

test('settings keep the server save action visible and per-item pages have their own actions', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Model settings');
  await page.locator('.settings-section').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => page.locator('.settings-section').evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Model settings', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await settingsSection(page, 'Model files');
  await expect(
    page.getByText(
      'Model files on this computer. Folders are saved after you accept and validate them.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0);
  await settingsSection(page, 'llama.cpp');
  await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Use bundled version', exact: true }).click();
  await expect(
    page.getByRole('alertdialog').getByRole('button', { name: 'Use bundled version', exact: true }),
  ).toBeVisible();
});

test('chat defaults save with profiles and only server fields require restart', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Chat defaults');
  const prompt = page.getByRole('textbox', { name: 'Default system prompt', exact: true });
  await prompt.fill('Default instructions\nLiteral $(touch unsafe)');
  await prompt.blur();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('straggler-fixture-chat-defaults-normal') || '{}')
            .chat_system_prompt,
      ),
    )
    .toBe('Default instructions\nLiteral $(touch unsafe)');
  await expect(page.locator('.local-badge')).not.toContainText('Restart required');
  await manageConfigurations(page);
  await page
    .getByRole('textbox', { name: 'New configuration name', exact: true })
    .fill('Chat defaults');
  await page.getByRole('button', { name: 'Save as new configuration' }).click();
  await expect(page.getByText('Configuration saved.', { exact: true })).toBeVisible();
  await settingsSection(page, 'Chat defaults');
  await prompt.fill('Changed');
  await prompt.blur();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('straggler-fixture-chat-defaults-normal') || '{}')
            .chat_system_prompt,
      ),
    )
    .toBe('Changed');
  await settingsSection(page, 'Model settings');
  await expect(page.getByText('Modified', { exact: true })).toBeVisible();
  await expect(page.locator('.local-badge')).not.toContainText('Restart required');
  await manageConfigurations(page);
  await loadSelectedConfiguration(page);
  await expect(page.getByRole('alertdialog')).toContainText('Also replaces your chat defaults.');
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Load configuration', exact: true })
    .click();
  await settingsSection(page, 'Chat defaults');
  await expect(prompt).toHaveValue('Default instructions\nLiteral $(touch unsafe)');
});

test('system prompt popover restores focus, dismisses outside, and persists a chat override', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  const prompt = page.getByRole('button', { name: 'System prompt', exact: true });
  await prompt.click();
  await expect(prompt).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveAttribute('aria-expanded', 'false');
  await prompt.click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).click();
  await expect(prompt).toHaveAttribute('aria-expanded', 'false');
  await prompt.click();
  await page.getByRole('radio', { name: 'This chat Custom text' }).check();
  await page
    .getByRole('textbox', { name: 'System prompt instructions' })
    .fill('Literal instructions\nUnicode: caffè ☕');
  await page.getByRole('button', { name: 'Apply to this chat' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Copy response' })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('straggler-fixture-request')!).messages[0],
    ),
  ).toEqual({ role: 'system', content: 'Literal instructions\nUnicode: caffè ☕' });
  await page.reload();
  await page.getByRole('button', { name: 'A question', exact: true }).click();
  await prompt.click();
  await expect(page.getByRole('textbox', { name: 'System prompt instructions' })).toHaveValue(
    'Literal instructions\nUnicode: caffè ☕',
  );
});

test('context uses the draft before sending and updates without response metrics', async ({
  page,
}) => {
  await page.goto('/?scenario=no-metrics');
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  const contextMenu = page.locator('.context-menu');
  await expect(contextMenu).toHaveClass('composer-menu context-menu ctx-neutral');
  await expect(counter).toHaveText('Context—');
  await counter.click();
  const popover = page.getByRole('dialog', { name: 'Context' });
  await expect(popover).toContainText('Start the local server or choose a cloud model.');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('a'.repeat(13000));
  await expect(counter).toHaveAccessibleDescription(/^Getting full · 79%/);
  await expect(counter.getByText('Getting full', { exact: true })).toBeVisible();
  await expect(contextMenu).toHaveClass('composer-menu context-menu ctx-warning');
  await composer.fill('a'.repeat(15200));
  await expect(counter).toHaveAccessibleDescription(/^Little room for the reply · 93%/);
  await expect(counter.getByText('Little room for the reply', { exact: true })).toBeVisible();
  await expect(contextMenu).toHaveClass('composer-menu context-menu ctx-warning');
  await expect(page.locator('.context-recovery')).toHaveCount(0);
  await counter.click();
  await expect(popover).toContainText('Free 216 tokens for a 512-token reply.');
  await expect(popover.getByRole('button', { name: 'Shorten draft', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await composer.fill('a'.repeat(16500));
  await expect(counter).toHaveAccessibleDescription(/^Free up space/);
  await expect(counter.getByText('Free up space', { exact: true })).toBeVisible();
  await expect(contextMenu).toHaveClass('composer-menu context-menu ctx-error');
  await counter.click();
  await expect(popover.getByRole('button', { name: 'Summarize and send' })).toHaveCount(0);
  await popover.getByRole('button', { name: 'Shorten draft', exact: true }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveText('a'.repeat(16500));
  await composer.fill('Measure this prompt');
  await expect(contextMenu).toHaveClass('composer-menu context-menu ctx-neutral');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Copy response' })).toBeVisible();
  await counter.click();
  const meter = popover.getByRole('meter', { name: 'Context for next message' });
  await expect(meter).toHaveAttribute('max', '4096');
  await expect.poll(async () => Number(await meter.getAttribute('value'))).toBeGreaterThan(5);
  await expect(popover).toContainText('tokens available for the reply');
});

test('context tones color the ring and the recovery line matches the composer width', async ({
  page,
}) => {
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  const ring = counter.locator('.context-ring circle').last();
  const neutralText = await counter.evaluate((button) => getComputedStyle(button).color);
  const neutralStroke = await ring.evaluate((circle) => getComputedStyle(circle).stroke);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('a'.repeat(13000));
  await expect(ring).not.toHaveCSS('stroke', neutralStroke);
  await expect(counter).toHaveCSS('color', neutralText);
  const amberStroke = await ring.evaluate((circle) => getComputedStyle(circle).stroke);

  await message.fill('a'.repeat(16500));
  await expect(ring).not.toHaveCSS('stroke', amberStroke);
  await expect(ring).not.toHaveCSS('stroke', neutralStroke);
  await expect(counter).toHaveCSS('color', neutralText);
  const recovery = page.locator('.context-recovery');
  await expect(recovery).toHaveCSS('color', neutralText);
  const composer = page.locator('.composer');
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 820 });
    await expect
      .poll(async () => {
        const line = await recovery.boundingBox();
        const box = await composer.boundingBox();
        return line && box && [Math.abs(line.x - box.x), Math.abs(line.width - box.width)];
      })
      .toEqual([0, 0]);
  }
});

test('context shows an approximate token count when capacity and tokenization are unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('straggler-fixture-context-unavailable', 'true');
    localStorage.setItem('straggler-fixture-tokenize-unavailable', 'true');
  });
  await page.goto('/?scenario=normal');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('abc def ghi!');
  const counter = page.getByRole('button', { name: 'Context', exact: true });
  await expect(counter).toHaveText('Context—');
  await counter.click();
  const popover = page.getByRole('dialog', { name: 'Context' });
  await expect(popover).toContainText('≈3 tokens');
  await expect(popover).toContainText('The local context capacity is unavailable.');
  await expect(popover.getByRole('meter')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('reasoning uses advertised efforts and request-time overrides without a restart', async ({
  page,
}) => {
  await page.goto('/?scenario=effort-levels');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  const reasoning = page.getByRole('button', { name: 'Reasoning', exact: true });
  await expect(reasoning).toBeEnabled();
  await reasoning.click();
  await page.getByRole('radio', { name: 'On', exact: true }).check();
  const effort = page.getByRole('group', { name: 'Reasoning effort' });
  await expect(effort.getByRole('radio')).toHaveCount(2);
  await expect(effort.getByRole('radio', { name: 'Minimal', exact: true })).toBeVisible();
  await expect(effort.getByRole('radio', { name: 'Xhigh', exact: true })).toBeVisible();
  await effort.getByRole('radio', { name: 'Xhigh', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(reasoning).toBeFocused();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Use reasoning');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Copy response' })).toBeVisible();
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('straggler-fixture-request')!).options,
    ),
  ).toEqual({ reasoning: 'on', effort: 'xhigh' });
  await expect(page.locator('.local-badge')).not.toContainText('Restart required');
  await reasoning.click();
  await page.getByRole('radio', { name: 'Off', exact: true }).check();
  await expect(effort.getByRole('radio').first()).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Chat defaults');
  await page.getByRole('radio', { name: 'On', exact: true }).check();
  await settingsSection(page, 'Model settings');
  await selectValue(
    page.getByRole('combobox', { name: 'Default effort for this model' }),
    'minimal',
  );
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.locator('.local-badge')).not.toContainText('Restart required');
  await page.goto('/?scenario=no-reasoning');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await expect(reasoning).toBeDisabled();
  await expect(reasoning).toContainText('Unavailable');
});

test('presence rail overlays narrow chat, remembers preference and keeps status text', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto('/?scenario=normal');
  const expand = page.getByRole('button', { name: 'Expand assistant panel' });
  await expect(expand).toBeVisible();
  await expect(page.locator('.presence')).toHaveCSS('width', '60px');
  await expect(page.locator('.presence-rail-status')).toHaveText('Offline');
  const composerWidth = await page
    .locator('.composer')
    .evaluate((element) => element.getBoundingClientRect().width);
  await expand.click();
  await expect(page.getByRole('button', { name: 'Collapse assistant panel' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.locator('.presence')).toHaveCSS('position', 'absolute');
  expect(
    await page.locator('.composer').evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(composerWidth);
  await page.keyboard.press('Escape');
  await expect(expand).toBeFocused();
  await page.reload();
  await expect(expand).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 820 });
  await expect(expand).toBeVisible();
  await expand.click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Collapse assistant panel' })).toBeVisible();
  await expect(page.locator('.presence-stage')).toHaveAttribute('aria-hidden', 'true');
});

test('reduced-motion presence draws a still and destroys the renderer in Settings', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?scenario=cancel');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep generating');
  await observeOrb(page);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.assistant-presence')).toHaveAttribute('data-state', 'generating');
  // A committed caption does not prove that React's passive effect has reached
  // the renderer. Observe its actual state before checking that drawing stops.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__stragglerOrbMeasurement.draws.some((draw) => draw.state === 'generating'),
      ),
    )
    .toBe(true);
  // Give layout/resize callbacks their paint opportunities after the real draw.
  const stillFrames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(window.__stragglerOrbMeasurement.frames.length);
          });
        });
      }),
  );
  expect(stillFrames).toBeGreaterThan(0);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.__stragglerOrbMeasurement.frames.length)).toBe(
    stillFrames,
  );
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.locator('.assistant-presence')).toHaveAttribute('data-state', 'stopped');
  await expect(page.locator('.presence-caption')).toContainText('Stopped');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsSection(page, 'Chat defaults');
  await expect(page.locator('.presence-stage canvas')).toHaveCount(0);
  const frames = await page.evaluate(() => window.__stragglerOrbMeasurement.frames.length);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(() => window.__stragglerOrbMeasurement.frames.length)).toBe(frames);
  await page.evaluate(() => window.__stragglerOrbMeasurement.stop());
});

test('presence follows reasoning deltas through completion', async ({ page }) => {
  await page.goto('/?scenario=reasoning-stream');
  await page.getByRole('button', { name: 'Launch server', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Think, then answer');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.assistant-presence')).toHaveAttribute('data-state', 'reasoning');
  await expect(page.locator('.presence-caption')).toContainText('Thinking…');
  await expect(page.locator('.typing-indicator')).toHaveText('Thinking');
  await expect(page.locator('.assistant-presence')).toHaveAttribute('data-state', 'generating');
  await expect(page.locator('.typing-indicator')).toHaveText('Generating');
  await expect(page.locator('.assistant-presence')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.typing-indicator')).toHaveCount(0);
});

test('renderer holds state and size changes while native visibility reports a pause', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/features/presence/renderers/OrbRenderer.ts';
    const { OrbRenderer } = await import(modulePath);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;width:224px;height:224px;left:0;top:0';
    document.body.append(host);
    let frames = 0;
    const original = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.parentElement === host) frames++;
      return original.apply(this, args);
    };
    const pause = (milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds));
    async function waitForFrame(after: number) {
      const deadline = performance.now() + 5000;
      while (frames <= after) {
        if (performance.now() >= deadline)
          throw new Error('The renderer did not draw an animation frame within five seconds.');
        await pause(20);
      }
    }
    const renderer = new OrbRenderer();
    try {
      renderer.mount(host);
      renderer.setState('generating');
      await waitForFrame(0);
      renderer.setPaused(true);
      await pause(100);
      const before = frames;
      for (let i = 0; i < 3; i++) {
        renderer.setPaused(true);
        renderer.setState(i % 2 ? 'reasoning' : 'generating');
        renderer.resize(200 + i);
        await pause(100);
      }
      const paused = frames;
      renderer.setPaused(false);
      await waitForFrame(paused);
      const resumed = frames;
      renderer.destroy();
      await pause(100);
      return { before, paused, resumed, destroyed: frames };
    } finally {
      renderer.destroy();
      host.remove();
      CanvasRenderingContext2D.prototype.clearRect = original;
    }
  });
  expect(result.before).toBeGreaterThan(0);
  expect(result.paused).toBe(result.before);
  expect(result.resumed).toBeGreaterThan(result.paused);
  expect(result.destroyed).toBe(result.resumed);
});
