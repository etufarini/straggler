import { expect, test } from 'vitest';
import { contextWindowUsage, replyTargetTokens, resolveChatOptions } from '../src/domain/chat';
import { sameServerConfiguration, equalSettings, generationKeys } from '../src/domain/types';
import { defaultSettings } from '../src/services/fixtures';

test('request defaults and overrides are independent of server restart comparisons', () => {
  const settings = {
    ...defaultSettings,
    chat_system_prompt: 'Default instructions',
    chat_reasoning: 'on' as const,
    chat_reasoning_effort: 'xhigh',
  };
  expect(resolveChatOptions(undefined, settings)).toEqual({
    systemPrompt: 'Default instructions',
    reasoning: 'on',
    effort: 'xhigh',
  });
  expect(
    resolveChatOptions({ systemPrompt: '', reasoning: 'off', effort: null }, settings),
  ).toEqual({ systemPrompt: '', reasoning: 'off', effort: 'xhigh' });
  expect(resolveChatOptions(undefined, settings, true)).toEqual({
    systemPrompt: 'Default instructions',
    reasoning: 'on',
    effort: 'auto',
  });
  expect(equalSettings(defaultSettings, settings)).toBe(false);
  expect(sameServerConfiguration(defaultSettings, settings)).toBe(true);
  for (const key of generationKeys) {
    const changed = { ...settings, [key]: '1' };
    expect(sameServerConfiguration(settings, changed)).toBe(true);
    expect(equalSettings(settings, changed)).toBe(false);
  }
  expect(sameServerConfiguration(defaultSettings, { ...settings, context: '8192' })).toBe(false);
});

test('context thresholds use the unrounded ratio and unknown capacity has no percentage', () => {
  expect(contextWindowUsage(749, 1000)).toMatchObject({
    percent: 75,
    remaining: 251,
    atCompactionThreshold: false,
  });
  expect(contextWindowUsage(750, 1000)?.atCompactionThreshold).toBe(true);
  expect(contextWindowUsage(1200, 1000)).toMatchObject({
    percent: 120,
    remaining: -200,
    atCompactionThreshold: true,
  });
  expect(contextWindowUsage(749, null)).toBeNull();
});

test('reply headroom follows the window and keeps shorter and prompt-only settings usable', () => {
  expect(replyTargetTokens(4096, 'auto')).toBe(512);
  expect(replyTargetTokens(16384, 'auto')).toBe(2048);
  expect(replyTargetTokens(32768, 'auto')).toBe(2048);
  expect(replyTargetTokens(16384, '256')).toBe(256);
  expect(replyTargetTokens(16384, '0')).toBe(0);
  expect(replyTargetTokens(16384, '0', true)).toBe(2048);
});
