import nativeDefaults from '../../src-tauri/src/configuration/defaults.json';
import type { WebSource, WebSearchTurn } from './webSearch';
export interface Model {
  path: string;
  label: string;
  template?: string | null;
  projector?: string | null;
  sizeBytes?: number | null;
}
export interface Settings {
  chat_system_prompt: string;
  chat_reasoning: 'auto' | 'on' | 'off';
  chat_reasoning_effort: string;
  chat_auto_compact: 'on' | 'off';
  model: string;
  chat_template_file: string;
  mtp: 'off' | 'model' | 'file';
  mtp_file: string;
  context: string;
  port: string;
  device: string;
  threads: string;
  gpu_layers: string;
  prompt_processing: string;
  cache_type_k: string;
  cache_type_v: string;
  split_mode: string;
  tensor_split: string;
  fit_target: string;
  temperature: string;
  top_p: string;
  top_k: string;
  min_p: string;
  repeat_penalty: string;
  presence_penalty: string;
  frequency_penalty: string;
  seed: string;
  max_tokens: string;
}
export interface Listener {
  pid: number;
  identity: string;
  details: string;
}
export interface Memory {
  unified?: boolean;
  availableRamMiB: number | null;
  devices: { name: string; availableMiB: number }[];
}
export interface Confirmation {
  title: string;
  text: string;
  action: () => Promise<void>;
  actionLabel: string;
  destructive?: boolean;
  alternative?: { label: string; action: () => Promise<void> };
}
export interface Configuration {
  llamaDir: string;
  modelsDir: string;
  serverAvailable: boolean;
  bundledAvailable: boolean;
  appStore: boolean;
  port: number;
  portStatus: string;
  warning: string;
  models: Model[];
  settings: Settings;
  generationPreset: string;
  presets: Record<string, string[]>;
  devices: { name: string; label: string }[];
  listeners: Listener[];
  memory: Memory;
  build: {
    tag?: string;
    backend?: string;
    commit?: string;
    previous?: string;
    version?: string;
    buildNumber?: number;
    releaseDate?: string | null;
  } | null;
  capabilities: {
    cacheTypesK: string[];
    cacheTypesV: string[];
    splitModes: string[];
    multipleDevices: boolean;
    chatTemplateFile: boolean;
    mtp: boolean;
    mtpFile: boolean;
    templateOverride: string;
    mtpOverride: string;
    buildNote: string;
  };
  profiles: string[];
  currentProfile: string | null;
  savedSettings: Settings | null;
  modified: boolean;
  restartRequired: boolean;
}
export interface ServerStatus {
  runId?: string;
  phase: 'stopped' | 'loading' | 'ready' | 'stopping' | 'error' | 'needs-restart';
  model: string | null;
  url: string | null;
  logs: string[];
  error: string | null;
  runningSettings?: Settings | null;
  issue: { kind: 'memory' | 'backend'; details: string } | null;
}
export type MessageStatus =
  'complete' | 'streaming' | 'stopped' | 'interrupted' | 'error' | 'length';
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  model?: string;
  cloud?: { providerId: string; name: string };
  status: MessageStatus;
  error?: string;
  metrics?: GenerationMetrics;
  serverRunId?: string;
  sources?: WebSource[];
  projectSources?: ProjectPassage[];
  attachmentSources?: ProjectPassage[];
  webSearch?: WebSearchTurn;
}
export interface ProjectPassage {
  n: number;
  projectId?: string;
  conversationId?: string;
  fileId: string;
  name: string;
  section: number;
  text: string;
}
export interface Attachment {
  id: string;
  name: string;
  extension: string;
  image?: { width: number; height: number; resized: boolean; thumbnail: string };
  size: number;
  text: string;
}
export interface ChatSummary {
  throughMessageId: string;
  text: string;
  model: string;
  createdAt: number;
}
export interface Conversation {
  summary?: ChatSummary;
  id: string;
  title: string;
  starred?: boolean;
  titleCustomized?: boolean;
  branchedFrom?: { conversationId: string; messageId: string };
  createdAt: number;
  updatedAt: number;
  model: string | null;
  messages: Message[];
  options?: ChatOptions;
  attachments?: Attachment[];
  projectId?: string | null;
  ownSystemPrompt?: string | null;
}
export interface Delta {
  sources?: WebSource[];
  webSearch?: WebSearchTurn;
  metrics?: GenerationMetrics;
  content: string;
  reasoning: string;
}
export interface Response extends Delta {
  status: MessageStatus;
  error: string | null;
}

export const emptyServer: ServerStatus = {
  phase: 'stopped',
  model: null,
  url: null,
  logs: [],
  error: null,
  issue: null,
};
export const serverActive = (server: ServerStatus) =>
  ['ready', 'loading', 'stopping', 'needs-restart'].includes(server.phase);
export const fileName = (path: string) => path.split('/').pop() || path;
export function settingsForModel(settings: Settings, model: string): Settings {
  if (settings.model === model) return settings;
  return {
    ...settings,
    model,
    chat_template_file: nativeDefaults.chat_template_file,
    mtp: nativeDefaults.mtp as Settings['mtp'],
    mtp_file: nativeDefaults.mtp_file,
  };
}

export const equalSettings = (a: Settings, b: Settings) =>
  Object.keys(a).every((key) => a[key as keyof Settings] === b[key as keyof Settings]);
export const chatSettingKeys = [
  'chat_system_prompt',
  'chat_reasoning',
  'chat_reasoning_effort',
  'chat_auto_compact',
] as const;
export const sameServerConfiguration = (a: Settings, b: Settings) =>
  Object.keys(a).every(
    (key) =>
      (chatSettingKeys as readonly string[]).includes(key) ||
      (generationKeys as readonly string[]).includes(key) ||
      a[key as keyof Settings] === b[key as keyof Settings],
  );
export const samplingKeys = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
] as const;
export const generationKeys = [...samplingKeys, 'seed', 'max_tokens'] as const;
export function samplingPreset(settings: Settings, presets: Record<string, string[]>) {
  return (
    Object.keys(presets).find((name) =>
      samplingKeys.every((key, index) => settings[key] === presets[name][index]),
    ) || 'custom'
  );
}
export function newConversation(): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: null,
    messages: [],
  };
}
export function requestMessages(messages: Message[], includeReasoning = false) {
  // Empty or failed assistant placeholders must not become chat template input.
  const result: { role: Message['role']; content: string; reasoning_content?: string }[] = [];
  for (const message of messages) {
    if (!message.content.trim() || (message.role === 'assistant' && message.status === 'error'))
      continue;
    const previous = result[result.length - 1];
    if (previous?.role === message.role) {
      previous.content += `\n\n${message.content}`;
      if (includeReasoning && message.role === 'assistant')
        previous.reasoning_content = [previous.reasoning_content, message.reasoning]
          .filter(Boolean)
          .join('\n\n');
    } else
      result.push({
        role: message.role,
        content: message.content,
        ...(includeReasoning && message.role === 'assistant'
          ? { reasoning_content: message.reasoning }
          : {}),
      });
  }
  return result;
}

export interface UiPreferences {
  formattingToolbarVisible?: boolean;
  sidebarCollapsed: boolean;
  presenceExpanded: boolean | null;
  webSearchNoticeSeen?: boolean;
  cloudNoticeSeen?: Record<string, string>;
  webSearchMaxSearches?: number;
  webSearchProvider?: string;
}

export interface ServerDetails {
  runId: string;
  contextSize: number | null;
  toolsSupported?: boolean | null;
  visionSupported?: boolean | null;
  reasoningSupported: boolean | null;
  effortLevels: string[];
  systemRoleSupported: boolean | null;
  error: string | null;
}
export interface GenerationMetrics {
  contextTokens?: number;
  contextSource?: 'usage' | 'timings';
  outputTokens?: number;
  tokensPerSecond?: number;
  generationMs?: number;
  promptMs?: number;
  cost?: number;
  costCurrency?: string;
  runId?: string;
}
export interface ChatOptions {
  systemPrompt: string | null;
  reasoning: 'auto' | 'on' | 'off' | null;
  effort: string | null;
}
