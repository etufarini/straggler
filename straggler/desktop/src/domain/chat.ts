import { isContextRejection } from './errors';
import type { ChatOptions, Message, Settings } from './types';

export const compactionThresholdPercent = 75;

export function resolveChatOptions(
  options: ChatOptions | undefined,
  settings: Settings | undefined,
  cloud = false,
) {
  return {
    systemPrompt: options?.systemPrompt ?? settings?.chat_system_prompt ?? '',
    reasoning: options?.reasoning ?? settings?.chat_reasoning ?? 'auto',
    effort: options?.effort ?? (cloud ? 'auto' : settings?.chat_reasoning_effort) ?? 'auto',
  };
}

export const inheritedChatOptions: ChatOptions = {
  systemPrompt: null,
  reasoning: null,
  effort: null,
};

export function historyForDraft(messages: Message[], rejectedUserId?: string) {
  if (!rejectedUserId) return messages;
  const index = messages.findIndex((message) => message.id === rejectedUserId);
  return index < 0 ? messages : messages.slice(0, index);
}

function isRejectedPartialReply(message: Message | undefined) {
  return (
    message?.role === 'assistant' &&
    message.status === 'error' &&
    !!(message.content || message.reasoning) &&
    !!message.error &&
    isContextRejection(message.error)
  );
}

export function withoutRejectedPartialExchanges(messages: Message[]) {
  // Keep the failed exchange visible in history while allowing a shorter retry.
  return messages.filter(
    (message, index) =>
      !isRejectedPartialReply(message) &&
      !(message.role === 'user' && isRejectedPartialReply(messages[index + 1])),
  );
}

export function replyTargetTokens(capacity: number, maxTokens?: string, cloud = false) {
  // Leave room for ordinary replies while keeping small windows usable. Longest reply can
  // reduce this target, and local prompt-only evaluation deliberately needs no reply room.
  const target = Math.max(1, Math.min(2048, Math.floor(capacity / 8)));
  if (maxTokens === '0' && !cloud) return 0;
  const limit = Number(maxTokens);
  return limit > 0 ? Math.min(target, limit) : target;
}

export function contextWindowUsage(tokens: number, capacity: number | null) {
  if (!capacity) return null;
  const used = tokens / capacity;
  return {
    capacity,
    percent: Math.round(used * 100),
    remaining: capacity - tokens,
    atCompactionThreshold: used >= compactionThresholdPercent / 100,
  } as const;
}
