import { chatDefaults, chatDefaultKeys, generationKeys } from '../domain/chatDefaults';
import type { SystemPromptPreset, PresetText } from '../domain/systemPrompts';
import { availablePresetName } from '../domain/systemPrompts';
import { searchText } from '../domain/chatSearch';
import { createCloudFixture } from './cloudFixtures';
import { createWebSearchFixture } from './webSearchFixtures';
import nativeDefaults from '../../src-tauri/src/configuration/defaults.json';
import backendManifest from '../../packaging/llama-runtime.json';
import type { DragDropEvent } from '@tauri-apps/api/webview';
import type {
  Configuration,
  Conversation,
  Delta,
  Settings,
  ServerStatus,
  UiPreferences,
  ServerDetails,
  Attachment,
} from '../domain/types';
import { emptyServer, fileName } from '../domain/types';
import {
  approximatePromptTokens,
  approximateTokens,
  attachmentTypes,
  imageTypes,
} from '../domain/attachments';
import { createProjectFixture } from './projectFixtures';
import { createHuggingFaceFixture } from './huggingFaceFixtures';

export type Scenario =
  | 'web-normal'
  | 'web-low'
  | 'web-exhausted'
  | 'web-offline'
  | 'web-invalid'
  | 'web-no-tools'
  | 'web-no-key'
  | 'cloud-ready'
  | 'cloud-unknown'
  | 'cloud-error'
  | 'cloud-cancel'
  | 'normal'
  | 'empty'
  | 'cpu'
  | 'multiple'
  | 'unknown-memory'
  | 'occupied'
  | 'save-error'
  | 'model-error'
  | 'cancel'
  | 'interrupted'
  | 'oom'
  | 'oom-startup'
  | 'oom-and-save-error'
  | 'backend-error'
  | 'history-error'
  | 'compute-error'
  | 'no-metrics'
  | 'no-reasoning'
  | 'effort-levels'
  | 'context-high'
  | 'context-full'
  | 'burst-stream'
  | 'reasoning-stream';

// Development data deliberately uses generic device names and no personal paths.
export const defaultSettings = {
  ...nativeDefaults,
  model: '/fixture/models/example.gguf',
} as Settings;

export const scenarios: Scenario[] = [
  'web-normal',
  'web-low',
  'web-exhausted',
  'web-offline',
  'web-invalid',
  'web-no-tools',
  'web-no-key',
  'cloud-ready',
  'cloud-unknown',
  'cloud-error',
  'cloud-cancel',
  'normal',
  'empty',
  'cpu',
  'multiple',
  'unknown-memory',
  'occupied',
  'save-error',
  'model-error',
  'cancel',
  'interrupted',
  'oom',
  'oom-startup',
  'oom-and-save-error',
  'backend-error',
  'history-error',
  'compute-error',
  'no-metrics',
  'no-reasoning',
  'effort-levels',
  'context-high',
  'context-full',
  'burst-stream',
  'reasoning-stream',
];

export function createFixture(scenario: Scenario) {
  const webSearch = createWebSearchFixture(scenario);
  const initialModel =
    localStorage.getItem('straggler-fixture-model') ??
    (scenario === 'empty' ? '' : defaultSettings.model);
  let settings = { ...defaultSettings, model: initialModel };
  settings = {
    ...settings,
    ...JSON.parse(localStorage.getItem(`straggler-fixture-chat-defaults-${scenario}`) || '{}'),
  };
  let status: ServerStatus = { ...emptyServer };
  let llamaDir = scenario === 'empty' ? '' : '/fixture/llama.cpp';
  const bundledAvailable = scenario !== 'empty';
  let modelsDir = scenario === 'empty' ? '' : '/fixture/models';
  let currentProfile: string | null = null;
  let savedSettings: Settings | null = null;
  const profiles = new Map<string, Settings>();
  const historyKey = `straggler-fixture-${scenario}`;
  const history: Conversation[] = JSON.parse(localStorage.getItem(historyKey) || '[]');
  let failedWrites = scenario === 'save-error' ? 2 : 0;
  let finish: (() => void) | undefined;
  let occupied = scenario === 'occupied';
  let memoryFailureSeen = false;
  let generatingConversation: string | null = null;
  let temporary: { id: string; attachments: Map<string, Attachment> } | null = null;
  const downloadedModels: { path: string; label: string }[] = [];
  const huggingFace = createHuggingFaceFixture(configuration, (model) => {
    if (!downloadedModels.some((existing) => existing.path === model.path))
      downloadedModels.push(model);
    if (!settings.model) settings.model = model.path;
  });
  const projectFixture = createProjectFixture(
    `straggler-fixture-projects-${scenario}`,
    history,
    persistHistory,
    () => generatingConversation,
  );

  const cloud = createCloudFixture(scenario, () => {
    status = { ...status, phase: 'stopped', url: null, runningSettings: undefined };
  });

  if (scenario === 'cloud-error')
    status.issue = { kind: 'memory', details: 'Earlier local backend failure' };

  function failMemory() {
    memoryFailureSeen = true;
    status = {
      ...status,
      phase: 'needs-restart',
      issue: { kind: 'memory', details: 'Insufficient Memory; backend is in error state' },
      logs: ['Insufficient Memory', 'backend is in error state - recreate the backend to recover'],
    };
  }

  function configuration(): Configuration {
    const devices =
      scenario === 'cpu'
        ? []
        : scenario === 'multiple'
          ? [
              { name: 'Device0', label: 'First accelerator' },
              { name: 'Device1', label: 'Second accelerator' },
            ]
          : [{ name: 'Device0', label: 'Example accelerator' }];
    return {
      llamaDir,
      modelsDir,
      serverAvailable: !!llamaDir || bundledAvailable,
      bundledAvailable,
      appStore: false,
      settings: structuredClone(settings),
      port: Number(settings.port),
      portStatus: `Port ${settings.port}: ${occupied ? 'IN USE' : 'FREE'}`,
      warning: '',
      generationPreset: 'default',
      presets: {
        default: ['auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
        focused: ['0.6', '0.95', '20', '0', '1', '0', '0'],
        exploratory: ['1', '0.95', '20', '0', '1', '0', '0'],
        'min-p': ['1', '1', '0', '0.05', '1', '0', '0'],
      },
      models: [
        ...(initialModel
          ? [
              {
                path: initialModel,
                label: fileName(initialModel),
                template: localStorage.getItem('straggler-fixture-template-candidate'),
              },
            ]
          : []),
        ...downloadedModels,
      ],
      devices,
      listeners: occupied
        ? [{ pid: 12345, identity: 'fixture-process', details: '12345 fixture Example listener' }]
        : [],
      memory: { availableRamMiB: scenario === 'unknown-memory' ? null : 8192, devices: [] },
      capabilities: {
        cacheTypesK: ['q4_0', 'f16'],
        cacheTypesV: ['q4_0', 'f16'],
        splitModes: ['layer', 'row'],
        multipleDevices: devices.length > 1,
        chatTemplateFile: !localStorage.getItem('straggler-fixture-unsupported-model-options'),
        mtp: !localStorage.getItem('straggler-fixture-unsupported-model-options'),
        mtpFile: !localStorage.getItem('straggler-fixture-unsupported-model-options'),
        templateOverride: localStorage.getItem('straggler-fixture-template-override') || '',
        mtpOverride: localStorage.getItem('straggler-fixture-mtp-override') || '',
        buildNote: 'Available features are advertised by the selected llama-server.',
      },
      build:
        !llamaDir && bundledAvailable
          ? {
              tag: backendManifest.tag,
              backend: 'bundled',
              commit: backendManifest.commit,
              previous: '',
              version: backendManifest.version,
              buildNumber: backendManifest.buildNumber,
              releaseDate: backendManifest.releaseDate,
            }
          : scenario === 'empty'
            ? null
            : {
                backend: 'external',
                version: '0.9.0-fixture',
                buildNumber: 42,
                commit: 'abc1234',
                releaseDate: null,
              },
      profiles: [...profiles.keys()],
      currentProfile,
      savedSettings,
      modified: savedSettings ? JSON.stringify(settings) !== JSON.stringify(savedSettings) : false,
      restartRequired: false,
    };
  }

  function persistHistory() {
    localStorage.setItem(historyKey, JSON.stringify(history));
  }

  async function readAttachment(path: string): Promise<Attachment> {
    while (localStorage.getItem('straggler-fixture-reading-paused'))
      await new Promise((resolve) => setTimeout(resolve, 20));
    const name = path.split('/').at(-1)!;
    const suffix = name.split('.').at(-1)!.toLowerCase();
    if (suffix === 'ppt')
      throw new Error(
        'PowerPoint 97–2003 (.ppt) is not supported. Save it as .pptx and add it again.',
      );
    const extension = attachmentTypes.find((type) => type === suffix);
    if (!extension) throw new Error('This file type is not supported.');
    return {
      id: crypto.randomUUID(),
      name,
      extension,
      size: 1234,
      text: imageTypes.some((type) => type === extension)
        ? `[Image: ${name}]`
        : `Extracted fixture text from ${name}.`,
      ...(imageTypes.some((type) => type === extension)
        ? {
            image: {
              width: 2048,
              height: 1024,
              resized: true,
              thumbnail:
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDaYAAAAASUVORK5CYII=',
            },
          }
        : {}),
    };
  }

  async function invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (command.startsWith('cloud_')) return cloud.invoke(command, args);
    if (command.startsWith('hf_') || command === 'models_folder_info')
      return huggingFace.invoke(command, args);
    if (command === 'projects_list' || command.startsWith('project_'))
      return projectFixture.invoke(command, args);
    switch (command) {
      case 'create_models_folder':
        modelsDir = '/fixture/app-data/io.github.etufarini.straggler/models';
        return configuration();
      case 'backend_release': {
        const calls = Number(localStorage.getItem('straggler-fixture-release-requests')) || 0;
        localStorage.setItem('straggler-fixture-release-requests', String(calls + 1));
        while (localStorage.getItem('straggler-fixture-release-paused'))
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (localStorage.getItem('straggler-fixture-release-error'))
          throw new Error(
            'Cannot reach GitHub to read the release date: fixture network unavailable',
          );
        const result = localStorage.getItem('straggler-fixture-release-status') || 'verified';
        return result === 'verified'
          ? { status: 'verified', date: '2026-10-04', tag: 'b42' }
          : { status: result };
      }
      case 'choose_model_file': {
        const choice = localStorage.getItem(`straggler-fixture-${args.kind}-choice`);
        if (choice === 'cancel') return null;
        if (choice === 'error') throw new Error('Cannot read the selected model file.');
        return (
          choice ||
          (args.kind === 'template' ? '/fixture/models/custom.jinja' : '/fixture/models/mtp.gguf')
        );
      }
      case 'choose_models_folder': {
        const selected = localStorage.getItem('straggler-fixture-models-folder-choice');
        if (selected === 'cancel') return null;
        modelsDir = selected || '/fixture/linked-models';
        return configuration();
      }
      case 'web_search_status':
      case 'web_search_key_save':
      case 'open_web_url':
        return webSearch.invoke(command, args);
      case 'system_prompts_export': {
        const presets: SystemPromptPreset[] = JSON.parse(
          localStorage.getItem('straggler-fixture-presets') || '[]',
        );
        return JSON.stringify({
          format: 'straggler.system-prompts',
          version: 1,
          presets: presets
            .filter((p) => (args.ids as string[]).includes(p.id))
            .map(({ name, description, prompt }) => ({ name, description, prompt })),
        });
      }
      case 'system_prompts_list':
        if (localStorage.getItem('straggler-fixture-presets-error'))
          throw new Error('Cannot read system prompts. The file was kept.');
        return JSON.parse(localStorage.getItem('straggler-fixture-presets') || '[]');
      case 'system_prompt_save':
      case 'system_prompt_delete':
      case 'system_prompts_import': {
        if (localStorage.getItem('straggler-fixture-presets-write-error'))
          throw new Error('Disk is full. Previous data was kept.');
        let presets: SystemPromptPreset[] = JSON.parse(
          localStorage.getItem('straggler-fixture-presets') || '[]',
        );
        if (command === 'system_prompt_delete') presets = presets.filter((p) => p.id !== args.id);
        else {
          const choices =
            command === 'system_prompt_save'
              ? [{ preset: args.preset as PresetText, replace: false }]
              : (args.choices as { preset: PresetText; replace: boolean }[]);
          for (const choice of choices) {
            const existing =
              command === 'system_prompt_save'
                ? presets.find((p) => p.id === args.id)
                : choice.replace
                  ? presets.find((p) => p.name.toLowerCase() === choice.preset.name.toLowerCase())
                  : undefined;
            if (existing) Object.assign(existing, choice.preset, { updatedAt: Date.now() });
            else
              presets.push({
                ...choice.preset,
                name: availablePresetName(choice.preset.name, presets),
                id: crypto.randomUUID(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
          }
        }
        localStorage.setItem('straggler-fixture-presets', JSON.stringify(presets));
        return presets;
      }
      case 'system_prompts_read_import':
        return JSON.parse(
          localStorage.getItem('straggler-fixture-preset-import') ||
            '[{"name":"Imported prompt","description":"From a file","prompt":"Imported instructions."}]',
        );
      case 'preferences_read':
        return JSON.parse(
          localStorage.getItem('straggler-fixture-ui-preferences') ||
            '{"sidebarCollapsed":false,"presenceExpanded":null}',
        );
      case 'preferences_save':
        localStorage.setItem(
          'straggler-fixture-ui-preferences',
          JSON.stringify(args.preferences as UiPreferences),
        );
        return;
      case 'configuration':
        return configuration();
      case 'save_chat_defaults': {
        if (localStorage.getItem('straggler-fixture-chat-defaults-save-paused')) {
          const started =
            Number(localStorage.getItem('straggler-fixture-chat-defaults-save-started') || 0) + 1;
          localStorage.setItem('straggler-fixture-chat-defaults-save-started', String(started));
          await new Promise<void>((resolve) =>
            window.addEventListener(
              'straggler-fixture-chat-defaults-save-resume',
              () => resolve(),
              { once: true },
            ),
          );
        }
        if (localStorage.getItem('straggler-fixture-chat-defaults-save-error'))
          throw new Error('Fixture chat defaults storage is read-only.');
        const patch = args.values as Partial<Settings>;
        for (const [field, value] of Object.entries(patch)) {
          if (!(chatDefaultKeys as readonly string[]).includes(field))
            throw new Error('Not a chat default.');
          // Native tests own the complete validator; these representative failures exercise field feedback.
          if (
            (generationKeys as readonly string[]).includes(field) &&
            value !== 'auto' &&
            (!/^-?\d+(\.\d+)?$/.test(value) ||
              (['temperature', 'top_k'].includes(field) && Number(value) < 0))
          )
            throw {
              field,
              message: `Invalid STRAGGLER_${field.toUpperCase()}. Use auto or a valid generation value.`,
            };
        }
        settings = { ...settings, ...patch };
        localStorage.setItem(
          `straggler-fixture-chat-defaults-${scenario}`,
          JSON.stringify(chatDefaults(settings)),
        );
        return configuration();
      }
      case 'preview_profile':
        return structuredClone(profiles.get(String(args.name))!);
      case 'apply_settings': {
        const next = args.settings as Settings;
        // This is a fixture response; numeric validation belongs to the native configuration tests.
        if (next.threads === '0')
          throw { field: 'threads', message: 'CPU threads must be positive.' };
        settings = structuredClone(next);
        return configuration();
      }
      case 'server_details':
        return {
          runId: status.runId!,
          contextSize: localStorage.getItem('straggler-fixture-context-unavailable')
            ? null
            : Number(localStorage.getItem('straggler-fixture-context-size')) || 4096,
          reasoningSupported: scenario !== 'no-reasoning',
          effortLevels:
            scenario === 'no-reasoning'
              ? []
              : scenario === 'effort-levels'
                ? ['minimal', 'xhigh']
                : ['low', 'medium', 'high'],
          systemRoleSupported: true,
          visionSupported: localStorage.getItem('straggler-fixture-vision') === 'true',
          error: null,
        } satisfies ServerDetails;
      case 'server_status':
        return structuredClone(
          status.phase === 'ready' && localStorage.getItem('straggler-fixture-model-loading')
            ? { ...status, phase: 'loading', logs: ['Fixture model loading'] }
            : status,
        );
      case 'start_server':
        cloud.clear();
        if (occupied) throw new Error(`Port ${settings.port}: IN USE`);
        status = {
          phase: 'ready',
          runId: crypto.randomUUID(),
          model: String(args.model),
          url: 'http://127.0.0.1:9931',
          logs: ['Fixture server ready'],
          error: null,
          issue: null,
          runningSettings: structuredClone(settings),
        };
        if (scenario === 'oom-startup' && !memoryFailureSeen) failMemory();
        return;
      case 'stop_server':
        status = { ...status, phase: 'stopped', url: null, runningSettings: undefined };
        finish?.();
        return;
      case 'cancel_generation':
        finish?.();
        return;
      case 'workspace_action': {
        const action = String(args.action);
        const values = (args.arguments || []) as string[];
        const name = values[0];
        switch (action) {
          case 'save-profile':
            if (localStorage.getItem('straggler-fixture-profile-write-error'))
              throw new Error('Configuration folder is not writable.');
            profiles.set(name, structuredClone(settings));
            currentProfile = name;
            savedSettings = structuredClone(settings);
            break;
          case 'review-profile': {
            const loaded = profiles.get(name)!;
            settings = { ...settings, ...chatDefaults(loaded) };
            localStorage.setItem(
              `straggler-fixture-chat-defaults-${scenario}`,
              JSON.stringify(chatDefaults(settings)),
            );
            currentProfile = name;
            savedSettings = structuredClone(loaded);
            break;
          }
          case 'load-profile':
            settings = structuredClone(profiles.get(name)!);
            currentProfile = name;
            savedSettings = structuredClone(settings);
            break;
          case 'delete-profile':
            profiles.delete(name);
            if (currentProfile === name) {
              currentProfile = null;
              savedSettings = null;
            }
            break;
          case 'set-path':
            if (name === 'models') modelsDir = values[1];
            else llamaDir = values[1];
            break;
          case 'browse':
            return {
              path: name || '/fixture',
              parent: '/',
              directories: [
                { name: 'models', path: '/fixture/models' },
                ...(values[1] === 'true' ? [{ name: '.hidden', path: '/fixture/.hidden' }] : []),
              ],
            };
          case 'use-bundled':
            if (scenario === 'backend-error')
              throw new Error('The bundled backend could not be selected.');
            llamaDir = '';
            break;
          case 'stop-listeners':
            if (values[0] === 'KILL') occupied = false;
            break;
          default:
            throw new Error(`Unknown fixture action: ${action}`);
        }
        return configuration();
      }
      case 'tokenize_text':
        if (
          status.phase !== 'ready' ||
          localStorage.getItem('straggler-fixture-tokenize-unavailable')
        )
          throw new Error('Tokenization unavailable');
        return approximateTokens(String(args.content));
      case 'prompt_tokens': {
        while (localStorage.getItem('straggler-fixture-prompt-tokens-paused'))
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (
          status.phase !== 'ready' ||
          localStorage.getItem('straggler-fixture-tokenize-unavailable')
        )
          throw new Error('Tokenization unavailable');
        const messages = args.messages as { content: string }[];
        return {
          tokens:
            Number(localStorage.getItem('straggler-fixture-prompt-tokens')) ||
            approximatePromptTokens(messages),
          templated: true,
        };
      }
      case 'attachment_add': {
        const conversation = structuredClone(history.find((item) => item.id === args.id));
        if (!conversation) throw new Error('Conversation does not exist');
        conversation.attachments = [
          ...(conversation.attachments || []),
          await readAttachment(String(args.path)),
        ];
        conversation.updatedAt = Date.now();
        history[history.findIndex((item) => item.id === args.id)] = conversation;
        persistHistory();
        return conversation;
      }
      case 'attachment_remove': {
        const conversation = structuredClone(history.find((item) => item.id === args.id));
        if (!conversation) throw new Error('Conversation does not exist');
        conversation.attachments = conversation.attachments?.filter(
          (item) => item.id !== args.attachmentId,
        );
        history[history.findIndex((item) => item.id === args.id)] = conversation;
        persistHistory();
        return conversation;
      }
      case 'attachment_download':
        localStorage.setItem('straggler-fixture-download', String(args.attachmentId));
        return;
      case 'read_conversation_import':
        if (localStorage.getItem('straggler-fixture-import-error'))
          throw new Error('Message 2 has an unsupported role: tool.');
        return {
          title: 'Imported conversation',
          createdAt: '2026-11-10T00:00:00Z',
          model: 'imported.gguf',
          systemPrompt: 'Imported instructions',
          messages: [
            { role: 'user', content: 'Imported question', reasoning: '', model: null },
            {
              role: 'assistant',
              content: 'Imported answer',
              reasoning: 'Imported reasoning',
              model: 'imported.gguf',
            },
          ],
        };
      case 'write_export':
        if (localStorage.getItem('straggler-fixture-write-error'))
          throw new Error('Destination is not writable');
        localStorage.setItem('straggler-fixture-export', String(args.contents));
        return;
      case 'attachment_search': {
        if (localStorage.getItem('straggler-fixture-attachment-search-error'))
          throw new Error('Attachment search is unavailable.');
        const files = args.temporary
          ? [...(temporary?.attachments.values() ?? [])]
          : (history.find((chat) => chat.id === args.id)?.attachments ?? []);
        const query = String(args.query).toLowerCase().split(/\W+/).filter(Boolean);
        const file = files.find(
          (file) => !file.image && query.some((word) => file.text.toLowerCase().includes(word)),
        );
        if (!file || Number(args.budget) < 32) return [];
        return [
          {
            n: 1,
            conversationId: args.id,
            fileId: file.id,
            name: file.name,
            section: 1,
            text: file.text.slice(0, 120),
          },
        ];
      }
      case 'history_search_text': {
        if (localStorage.getItem('straggler-fixture-chat-text-error'))
          throw new Error('Chat message search is unavailable.');
        const query = searchText(String(args.query));
        return history
          .filter(
            (chat) =>
              chat.messages.some((message) => searchText(message.content).includes(query)) ||
              (chat.attachments ?? []).some(
                (file) => !file.image && searchText(file.text).includes(query),
              ),
          )
          .map((chat) => chat.id);
      }
      case 'history_list':
        if (
          scenario === 'history-error' &&
          localStorage.getItem('straggler-fixture-history-recovered') !== 'true'
        ) {
          throw new Error('Conversation storage is unavailable');
        }
        return structuredClone(history);
      case 'history_create':
      case 'history_save': {
        if ((args.conversation as Conversation).id === temporary?.id)
          throw new Error('Temporary chats can only be stored with Save chat.');
        if (localStorage.getItem('straggler-fixture-fail-next-save') === 'true') {
          localStorage.removeItem('straggler-fixture-fail-next-save');
          throw new Error('Disk is full');
        }
        if (failedWrites > 0) {
          failedWrites--;
          throw new Error('Disk is full');
        }
        const conversation = structuredClone(args.conversation as Conversation);
        const index = history.findIndex((value) => value.id === conversation.id);
        const previous = history[index];
        if (conversation.projectId && projectFixture.find(conversation.projectId).archived)
          throw new Error('Restore the project before making changes.');
        if (previous?.projectId && projectFixture.find(previous.projectId).archived)
          throw new Error('Restore the project before making changes.');
        if (previous && (previous.projectId ?? null) !== (conversation.projectId ?? null))
          throw new Error('Move the conversation through the project action before saving.');
        if (command === 'history_create' && index !== -1)
          throw new Error('Conversation already exists');
        if (index === -1) history.push(conversation);
        else history[index] = conversation;
        persistHistory();
        return;
      }
      case 'history_branch': {
        const source = history.find((chat) => chat.id === args.id);
        if (!source) throw new Error('Chat is unavailable.');
        projectFixture.assertChatWritable(source);
        if (localStorage.getItem('straggler-fixture-fail-next-branch') === 'true') {
          localStorage.removeItem('straggler-fixture-fail-next-branch');
          throw new Error('Disk is full');
        }
        const index = source.messages.findIndex(
          (message) =>
            message.id === args.messageId &&
            message.role === 'assistant' &&
            message.status !== 'streaming' &&
            message.status !== 'error',
        );
        if (index < 0) throw new Error('Choose a saved response to branch from.');
        const branch = structuredClone(source);
        branch.id = crypto.randomUUID();
        branch.title =
          Array.from(source.title.trim()).slice(0, 71).join('').trimEnd() + ' (branch)';
        branch.titleCustomized = true;
        delete branch.starred;
        if (
          branch.summary &&
          source.messages.findIndex((message) => message.id === branch.summary!.throughMessageId) >=
            index
        )
          delete branch.summary;
        branch.messages = branch.messages.slice(0, index + 1);
        branch.branchedFrom = { conversationId: source.id, messageId: branch.messages[index].id };
        branch.createdAt = branch.updatedAt = Date.now();
        history.push(branch);
        persistHistory();
        return branch;
      }
      case 'history_delete':
        projectFixture.assertChatWritable(history.find((value) => value.id === args.id)!);
        history.splice(
          history.findIndex((value) => value.id === args.id),
          1,
        );
        persistHistory();
        return;
      case 'temporary_begin':
        if (temporary) throw new Error('Leave the current temporary chat first.');
        temporary = { id: String(args.id), attachments: new Map() };
        return;
      case 'temporary_attachment_add': {
        if (!temporary || temporary.id !== args.id) throw new Error('Temporary chat unavailable.');
        const attachment = await readAttachment(String(args.path));
        temporary.attachments.set(attachment.id, attachment);
        return attachment;
      }
      case 'temporary_attachment_remove':
        if (!temporary || temporary.id !== args.id) throw new Error('Temporary chat unavailable.');
        temporary.attachments.delete(String(args.attachmentId));
        return;
      case 'temporary_finish': {
        if (!temporary || temporary.id !== args.id) throw new Error('Temporary chat unavailable.');
        if (args.conversation) {
          if (localStorage.getItem('straggler-fixture-fail-next-save') === 'true') {
            localStorage.removeItem('straggler-fixture-fail-next-save');
            throw new Error('Disk is full');
          }
          const conversation = structuredClone(args.conversation as Conversation);
          if (
            conversation.id !== temporary.id ||
            history.some((value) => value.id === conversation.id)
          )
            throw new Error('Conversation already exists');
          history.push(conversation);
          persistHistory();
        }
        temporary = null;
        return null;
      }
      case 'generate': {
        const request = args.request as {
          requestId: string;
          maxOutputTokens?: number;
          cloud?: import('../domain/cloudModels').CloudSelection;
          messages: { role: string; content: string }[];
          webSearch?: boolean;
          webSearchQuery?: string;
          conversationId?: string;
          temporaryId?: string;
        };
        if (request.cloud) cloud.generate(request.cloud);
        if (request.temporaryId) {
          if (temporary?.id !== request.temporaryId || request.conversationId)
            throw new Error('Invalid temporary request');
        } else {
          if (temporary) throw new Error('Temporary mode needs its session identifier');
          localStorage.setItem('straggler-fixture-request', JSON.stringify(args.request));
        }
        if (request.conversationId) {
          const current = history.find((value) => value.id === request.conversationId);
          if (current?.projectId && projectFixture.find(current.projectId).archived)
            throw new Error('Restore this project to make changes.');
        }
        while (localStorage.getItem('straggler-fixture-generation-paused'))
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (localStorage.getItem('straggler-fixture-context-rejection'))
          throw new Error(
            'HTTP 400: {"error":{"code":400,"type":"exceed_context_size_error","message":"request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it","n_prompt_tokens":5000,"n_ctx":4096}}',
          );
        if (scenario === 'compute-error') throw new Error('Compute error.');
        if (scenario === 'model-error') throw new Error('Unsupported chat template');
        generatingConversation = request.conversationId ?? null;
        const delta: Delta = {
          ...(scenario === 'no-metrics'
            ? {}
            : {
                metrics: {
                  contextTokens:
                    scenario === 'context-full' ? 3930 : scenario === 'context-high' ? 3360 : 212,
                  contextSource: 'usage' as const,
                  outputTokens: 35,
                  tokensPerSecond: 52.9,
                  generationMs: 661.1,
                  promptMs: 31,
                },
              }),
          content:
            'A **local** answer.\n\n```bash\necho hello\n```\n\n![remote](https://example.com/tracker.png)\n<script>alert(1)</script>',
          reasoning: 'Example reasoning text.',
        };
        const channel = args.onDelta as { onmessage: (delta: Delta) => void };
        const webResult = await webSearch.search(request, channel);
        Object.assign(delta, webResult);
        if (delta.sources?.length)
          delta.content =
            'This simulated local answer cites a source [1], another source [2], and leaves an unknown citation [99] as text.\n\n`Code [1]`';
        if (request.cloud) {
          delta.content = 'An answer from the selected cloud fixture.';
          delta.metrics = {
            contextTokens: 212,
            contextSource: 'usage',
            outputTokens: 35,
            cost: 0.001,
            costCurrency: 'USD',
          };
        }
        const savedResponse = history
          .find((chat) => chat.id === request.conversationId)
          ?.messages.at(-1);
        if (savedResponse?.projectSources?.length)
          delta.content += '\n\nThe project notes support this answer [P1].';
        if (
          request.messages.some((message: { content: string }) => message.content.includes('[A1]'))
        )
          delta.content += '\n\nThe attachment supports this answer [A1].';
        if (request.maxOutputTokens) {
          delta.content =
            localStorage.getItem('straggler-fixture-summary-response') ||
            'Goals and decisions retained. Continue the open questions.';
          delta.reasoning = 'Internal reasoning is not part of the summary.';
        }
        if (scenario === 'burst-stream') {
          delta.content =
            '## Streamed answer\n\n' + 'A **local** answer with caffè ☕.\n\n'.repeat(80);
          for (let offset = 0; offset < delta.content.length; offset += 7)
            channel.onmessage({
              content: delta.content.slice(offset, offset + 7),
              reasoning: offset === 0 ? delta.reasoning : '',
            });
          localStorage.setItem('straggler-fixture-burst-emitted', '1');
        } else if (scenario === 'reasoning-stream') {
          channel.onmessage({ content: '', reasoning: delta.reasoning });
          await new Promise((resolve) => setTimeout(resolve, 1200));
          channel.onmessage({ ...delta, reasoning: '' });
          await new Promise((resolve) => setTimeout(resolve, 1200));
        } else channel.onmessage(delta);
        while (localStorage.getItem('straggler-fixture-response-paused'))
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (['oom', 'oom-and-save-error'].includes(scenario) && !memoryFailureSeen) {
          generatingConversation = null;
          failMemory();
          if (scenario === 'oom-and-save-error') failedWrites = 1;
          return { ...delta, status: 'error', error: 'Compute error.' };
        }
        if (scenario === 'cancel' || scenario === 'cloud-cancel')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        else await new Promise((resolve) => setTimeout(resolve, 120));
        generatingConversation = null;
        return {
          ...delta,
          status:
            scenario === 'cancel' || scenario === 'cloud-cancel'
              ? 'stopped'
              : scenario === 'cloud-error'
                ? 'error'
                : scenario === 'interrupted'
                  ? 'interrupted'
                  : 'complete',
          error:
            scenario === 'cloud-error'
              ? 'The cloud service has no credit left.'
              : scenario === 'interrupted'
                ? 'Connection interrupted'
                : null,
        };
      }
      default:
        throw new Error(`Unexpected fixture command: ${command}`);
    }
  }
  function chooseSavePath(defaultPath: string) {
    localStorage.setItem('straggler-fixture-save-name', defaultPath);
    const selected = localStorage.getItem('straggler-fixture-save-path');
    return selected === 'cancel' ? null : selected || '/fixture/export.json';
  }
  function chooseImportPath() {
    return localStorage.getItem('straggler-fixture-import-path') === 'cancel'
      ? null
      : '/fixture/import.json';
  }
  function chooseAttachmentFiles(): string[] {
    return JSON.parse(
      localStorage.getItem('straggler-fixture-attachment-paths') ||
        '["/fixture/meeting-notes.txt"]',
    );
  }
  function watchAttachmentDrop(handler: (event: DragDropEvent) => void) {
    const receive = (event: Event) => handler((event as CustomEvent<DragDropEvent>).detail);
    window.addEventListener('straggler-fixture-drag-drop', receive);
    return () => window.removeEventListener('straggler-fixture-drag-drop', receive);
  }
  return { invoke, chooseSavePath, chooseImportPath, chooseAttachmentFiles, watchAttachmentDrop };
}
