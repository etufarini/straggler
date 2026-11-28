import generationParameters from '../../tests/fixtures/generation-parameters.json';
import type { GenerationKey } from '../domain/chatDefaults';
import type {
  ActiveCloud,
  CloudProvider,
  CloudSelection,
  CloudStatus,
} from '../domain/cloudModels';

// Synthetic metadata and key-presence flags only; no credentials are persisted by fixtures.
export function createCloudFixture(scenario: string, stopLocal: () => void) {
  const storage = `straggler-fixture-cloud-${scenario}`;
  const providers: CloudProvider[] =
    JSON.parse(localStorage.getItem(storage) || 'null') ??
    [
      ['deepseek', 'DeepSeek', 'https://api.deepseek.com'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
      ['mistral', 'Mistral', 'https://api.mistral.ai/v1'],
    ].map(([id, name, baseUrl]) => ({
      id,
      name,
      baseUrl,
      kind: id,
      models: [],
      shown: [],
      saved: false,
      keyError: null,
    }));
  let active: ActiveCloud | null = null;
  function listed(provider: CloudProvider) {
    return [
      {
        id: `${provider.id}/example`,
        name: 'Example cloud model',
        details: {
          runId: '00000000-0000-0000-0000-000000000000',
          contextSize: provider.kind === 'deepseek' ? null : 8192,
          visionSupported: provider.kind === 'openrouter' ? true : null,
          toolsSupported: provider.kind === 'openrouter' ? true : null,
          reasoningSupported: provider.kind === 'openrouter' ? true : null,
          systemRoleSupported: null,
          effortLevels: provider.kind === 'openrouter' ? ['low', 'medium', 'high'] : [],
          error: null,
        },
      },
    ];
  }
  function select(selection: CloudSelection) {
    const provider = providers.find((value) => value.id === selection.providerId)!;
    const model = provider.models.find((value) => value.id === selection.modelId);
    if (!provider.saved || !model || !provider.shown.includes(model.id))
      throw new Error('Choose a configured cloud model.');
    stopLocal();
    active = {
      selection,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      kind: provider.kind,
      outputLimitSupported:
        provider.kind !== 'openrouter' ||
        localStorage.getItem('straggler-fixture-cloud-no-output-limit') !== 'true',
      model,
    };
  }
  if (scenario.startsWith('cloud-')) {
    const provider = providers[scenario === 'cloud-unknown' ? 0 : 1];
    provider.saved = true;
    provider.models = listed(provider);
    provider.shown = provider.models.map((model) => model.id);
    select({ providerId: provider.id, modelId: provider.shown[0] });
  }
  function status(): CloudStatus {
    return structuredClone({
      providers,
      active,
      error: null,
      generationParameters: generationParameters as Record<string, GenerationKey[]>,
    });
  }
  function request(providerId: string, method: string, path: string) {
    const calls = JSON.parse(localStorage.getItem('straggler-fixture-cloud-requests') || '[]');
    calls.push({ providerId, method, path });
    localStorage.setItem('straggler-fixture-cloud-requests', JSON.stringify(calls));
  }
  return {
    clear() {
      active = null;
    },
    generate(selection: CloudSelection) {
      if (JSON.stringify(selection) !== JSON.stringify(active?.selection))
        throw new Error('Choose this cloud model before sending.');
      const preferences = JSON.parse(
        localStorage.getItem('straggler-fixture-ui-preferences') || '{}',
      );
      if (preferences.cloudNoticeSeen?.[selection.providerId] !== active?.baseUrl)
        throw new Error('Review the first-send notice before sending.');
      request(selection.providerId, 'POST', '/chat/completions');
    },
    invoke(command: string, args: Record<string, unknown>): CloudStatus {
      if (command === 'cloud_status') return status();
      if (command === 'cloud_use_model') select(args.selection as CloudSelection);
      else if (command === 'cloud_add_provider') {
        const url = new URL(String(args.baseUrl));
        if (
          (url.protocol !== 'https:' &&
            !(
              url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            )) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error(
            'Use HTTPS, or HTTP on loopback, without URL credentials, query parameters or fragments.',
          );
        providers.push({
          id: `custom-${crypto.randomUUID()}`,
          name: String(args.name).trim(),
          baseUrl: url.href.replace(/\/$/, ''),
          kind: 'custom',
          models: [],
          shown: [],
          saved: false,
          keyError: null,
        });
      } else {
        const provider = providers.find((value) => value.id === args.providerId)!;
        if (command === 'cloud_key_save' && args.key === null) provider.saved = false;
        else if (command === 'cloud_key_save' || command === 'cloud_models_refresh') {
          request(provider.id, 'GET', '/models');
          if (String(args.key).includes('rejected'))
            throw new Error('The cloud service rejected the API key. The previous key was kept.');
          provider.saved = true;
          provider.models = listed(provider);
        } else if (command === 'cloud_models_show') provider.shown = args.shown as string[];
        else throw new Error(`Unexpected cloud fixture command: ${command}`);
      }
      localStorage.setItem(storage, JSON.stringify(providers));
      return status();
    },
  };
}
