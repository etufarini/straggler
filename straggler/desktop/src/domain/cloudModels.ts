import type { GenerationKey } from './chatDefaults';
import type { ServerDetails } from './types';

export type CloudKind = 'deepseek' | 'openrouter' | 'mistral' | 'custom';
export interface CloudModel {
  id: string;
  name: string;
  details: ServerDetails;
}
export interface CloudSelection {
  providerId: string;
  modelId: string;
}
export interface CloudProvider {
  id: string;
  name: string;
  baseUrl: string;
  kind: CloudKind;
  models: CloudModel[];
  shown: string[];
  saved: boolean;
  keyError: string | null;
}
export interface ActiveCloud {
  selection: CloudSelection;
  providerName: string;
  baseUrl: string;
  kind: CloudKind;
  outputLimitSupported: boolean;
  model: CloudModel;
}
export interface CloudStatus {
  providers: CloudProvider[];
  active: ActiveCloud | null;
  error: string | null;
  generationParameters: Partial<Record<CloudKind, GenerationKey[]>>;
}

export function cloudCapabilities(model: CloudModel): string[] {
  const details = model.details;
  return [
    details.contextSize ? `${details.contextSize.toLocaleString('en-US')} context` : '',
    details.visionSupported === true ? 'Vision' : '',
    details.toolsSupported === true ? 'Tools' : '',
    details.reasoningSupported === true ? 'Reasoning' : '',
  ].filter(Boolean);
}

export function shownCloudModels(provider: Pick<CloudProvider, 'models' | 'shown'>): CloudModel[] {
  return provider.models.filter((model) => provider.shown.includes(model.id));
}

export type ModelSelection = { kind: 'local'; path: string } | ({ kind: 'cloud' } & CloudSelection);
