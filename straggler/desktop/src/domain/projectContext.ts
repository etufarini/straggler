import { summarizedMessages } from './compaction';
import { attachmentBlocks, composeRequest } from './attachments';
import { withoutRejectedPartialExchanges } from './chat';
import { ownSystemPrompt } from './projects';
import type { Project } from './projects';
import type { Conversation, Message, ProjectPassage, Settings } from './types';

type PromptSettings = Pick<Settings, 'chat_system_prompt'>;

export const projectContextThresholds = { close: 0.75, over: 1 } as const;
export const projectTokenEstimateCharacters = 4;

export function projectConversationReserve(nCtx: number): number {
  return Math.ceil(nCtx * 0.25);
}

export function estimateProjectTokens(text: string): number {
  return Math.ceil(Array.from(text).length / projectTokenEstimateCharacters);
}

export interface ProjectContextState {
  used: number;
  available: number | null;
  reserve: number | null;
  capacity: number | null;
  ratio: number | null;
  level: 'unknown' | 'ok' | 'high' | 'over';
  shortfall: number;
  approximate: boolean;
  search: boolean;
}

export function projectContextState(
  used: number,
  capacity: number | null | undefined,
  approximate: boolean,
  instructionTokens = used,
): ProjectContextState {
  if (!capacity || !Number.isFinite(capacity) || capacity < 0) {
    return {
      used,
      available: null,
      reserve: null,
      capacity: null,
      ratio: null,
      level: 'unknown',
      shortfall: 0,
      approximate,
      search: false,
    };
  }
  const reserve = projectConversationReserve(capacity);
  const available = Math.max(0, capacity - reserve);
  const ratio = available ? used / available : used > 0 ? Infinity : 0;
  return {
    used,
    available,
    reserve,
    capacity,
    ratio,
    level:
      ratio > projectContextThresholds.over
        ? 'over'
        : ratio >= projectContextThresholds.close
          ? 'high'
          : 'ok',
    shortfall: Math.max(0, used - available),
    approximate,
    search: used > available && instructionTokens < available,
  };
}

export function resolveProjectSystemPrompt(
  conversation: Conversation,
  settings?: PromptSettings,
  project?: Project,
): string {
  if (conversation.projectId) {
    if (project?.id !== conversation.projectId)
      throw new Error('This chat’s project is unavailable. Reload projects to continue.');
    return projectInstructions(project, settings);
  }
  return ownSystemPrompt(conversation) ?? settings?.chat_system_prompt ?? '';
}

export function projectSystemPrefix(project: Project, settings?: PromptSettings): string {
  const instructions = projectInstructions(project, settings);
  const files = attachmentBlocks(project.files.filter((file) => file.included));
  return [instructions, files].filter((part) => part.length > 0).join('\n\n');
}

export function projectInstructions(project: Project, settings?: PromptSettings): string {
  return project.instructions.trim() ? project.instructions : (settings?.chat_system_prompt ?? '');
}

export function passageContext(
  projectPassages: ProjectPassage[] = [],
  attachmentPassages: ProjectPassage[] = [],
): string {
  return (
    [
      ['P', 'project', projectPassages],
      ['A', 'attachment', attachmentPassages],
    ] as const
  )
    .flatMap(([marker, kind, sources]) =>
      sources.length
        ? [
            `Use the following ${kind} excerpts as reference material. Cite relevant passages as [${marker}1], [${marker}2], and so on.`,
            ...sources.map(
              (source) =>
                `[${marker}${source.n}] ${source.name} · section ${source.section}\n${source.text}`,
            ),
          ]
        : [],
    )
    .join('\n\n');
}

export function resourceRequestText(
  conversation: Conversation,
  settings?: Settings,
  project?: Project,
): string {
  return assembleProjectRequest(conversation, [], settings, project)
    .map((message) => message.content)
    .join('\n\n');
}

export function resourceContextState(
  conversation: Conversation,
  settings: Settings | undefined,
  project: Project | undefined,
  capacity: number | null | undefined,
) {
  const instructions = resolveProjectSystemPrompt(conversation, settings, project);
  return projectContextState(
    estimateProjectTokens(resourceRequestText(conversation, settings, project)),
    capacity,
    true,
    estimateProjectTokens(instructions),
  );
}

export function passageBudgets(available: number, project: boolean, attachments: boolean) {
  const budget = Math.max(0, Math.floor(available));
  const projectBudget = project ? (attachments ? Math.floor(budget / 2) : budget) : 0;
  return { project: projectBudget, attachments: attachments ? budget - projectBudget : 0 };
}

export function shrinkPassages(sources: ProjectPassage[]): ProjectPassage[] {
  if (sources.length > 1) return sources.slice(0, Math.floor(sources.length / 2));
  if (!sources.length) return sources;
  const [best] = sources;
  const text = Array.from(best.text);
  const shorter = text.slice(0, Math.floor(text.length / 2)).join('');
  return shorter ? [{ ...best, text: shorter }] : [];
}

export function assembleProjectRequest(
  conversation: Conversation,
  messages: Message[],
  settings?: PromptSettings,
  project?: Project,
  passages?: ProjectPassage[],
  attachmentPassages?: ProjectPassage[],
  includeReasoning = false,
) {
  const systemPrompt = resolveProjectSystemPrompt(conversation, settings, project);
  const prefix =
    conversation.projectId && project && passages === undefined
      ? projectSystemPrefix(project, settings)
      : systemPrompt;
  const retained = summarizedMessages(conversation, messages);
  const turns = composeRequest(
    withoutRejectedPartialExchanges(retained),
    prefix,
    attachmentPassages === undefined ? (conversation.attachments ?? []) : [],
    includeReasoning,
  );
  if (conversation.summary && retained !== messages) {
    const quoted = conversation.summary.text
      .split(/\r\n?|\n/)
      .map((line) => `> ${line}`)
      .join('\n');
    const summary = `Earlier conversation summary (historical context):\n${quoted}`;
    const firstUser = turns.find((message) => message.role === 'user');
    if (firstUser) firstUser.content = `${summary}\n\n${firstUser.content}`;
    else turns.splice(turns[0]?.role === 'system' ? 1 : 0, 0, { role: 'user', content: summary });
  }
  const context = passageContext(passages, attachmentPassages);
  if (context) {
    const lastUser = [...turns].reverse().find((message) => message.role === 'user');
    if (lastUser) lastUser.content += `\n\n${context}`;
  }
  return turns;
}
