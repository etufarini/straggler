import { generationKeys } from './types';
export { generationKeys } from './types';
import type { Settings } from './types';
import type { CloudProvider, CloudStatus } from './cloudModels';

export const chatDefaultKeys = [
  'chat_system_prompt',
  'chat_reasoning',
  'chat_auto_compact',
  ...generationKeys,
] as const;
export type GenerationKey = (typeof generationKeys)[number];
export type ChatDefaultKey = (typeof chatDefaultKeys)[number];
export type ChatDefaultValues = Pick<Settings, ChatDefaultKey>;

export function chatDefaults(settings: Settings): ChatDefaultValues {
  return Object.fromEntries(
    chatDefaultKeys.map((key) => [key, settings[key]]),
  ) as ChatDefaultValues;
}

export function fieldScope(field: GenerationKey, status: CloudStatus): string | undefined {
  const configured = status.providers.filter((provider) => provider.saved);
  if (!configured.length) return;
  const accepts = (provider: CloudProvider) =>
    status.generationParameters[provider.kind]?.includes(field) ?? false;
  const accepted = configured.filter(accepts).map((provider) => provider.name);
  const excluded = configured
    .filter((provider) => !accepts(provider))
    .map((provider) => provider.name);
  if (!excluded.length) return;
  if (!accepted.length) return 'This computer only';
  const list = (names: string[]) =>
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
  const omitted = `Not sent to ${list(excluded)}`;
  const included =
    accepted.length === 1
      ? `This computer and ${accepted[0]} only`
      : `This computer, ${accepted.slice(0, -1).join(', ')} and ${accepted.at(-1)} only`;
  return omitted.length <= included.length ? omitted : included;
}
