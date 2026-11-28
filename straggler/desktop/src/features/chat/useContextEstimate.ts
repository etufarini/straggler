import type { ActiveCloud } from '../../domain/cloudModels';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { approximatePromptTokens, estimateImageTokens } from '../../domain/attachments';
import { contextWindowUsage, historyForDraft, replyTargetTokens } from '../../domain/chat';
import { selectDraftCompaction } from '../../domain/compaction';
import type { CompactionReport, CompactionResult, DraftCompaction } from '../../domain/compaction';
import { assembleProjectRequest } from '../../domain/projectContext';
import type { Project } from '../../domain/projects';
import { estimatePromptTokens } from '../../services/desktop';
import type { TokenEstimate } from '../../services/desktop';
import type { Conversation, ServerDetails, ServerStatus, Settings } from '../../domain/types';

interface ContextCompaction extends CompactionReport {
  chatId: string;
  summary: Conversation['summary'];
  backend: string | undefined;
  capacity: number | null;
}

function useLocalPromptCount(key: string | null, run: string | undefined, enabled: boolean) {
  const [measured, setMeasured] = useState<{
    key: string;
    run?: string;
    estimate: TokenEstimate;
  } | null>(null);
  useEffect(() => {
    if (!enabled || key === null) return;
    let disposed = false;
    const timer = setTimeout(() => {
      void estimatePromptTokens(JSON.parse(key)).then((estimate) => {
        if (!disposed) setMeasured({ key, run, estimate });
      });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, run, enabled]);
  return enabled && measured?.key === key && measured.run === run ? measured.estimate : undefined;
}

export function useContextEstimate(
  chat: Conversation,
  input: string,
  rejectedUserId: string | undefined,
  settings: Settings | undefined,
  server: ServerStatus,
  details: ServerDetails | null,
  contextSize: number | null | undefined,
  project: Project | undefined,
  searchFiles: boolean,
  cloud: ActiveCloud | null,
  searchWeb: boolean,
) {
  const unavailable = !!chat.projectId && project?.id !== chat.projectId;
  const available = !unavailable && (!!cloud || server.phase === 'ready');
  const backend = cloud
    ? JSON.stringify([cloud.selection.providerId, cloud.selection.modelId])
    : server.runId;
  const capacity = contextSize || null;
  const draft = input.trim();
  const defaultPrompt = settings?.chat_system_prompt ?? '';
  const draftChat = useMemo(() => {
    const messages = historyForDraft(chat.messages, rejectedUserId);
    return messages === chat.messages ? chat : { ...chat, messages };
  }, [chat, rejectedUserId]);
  const includeReasoning =
    searchWeb && cloud?.kind === 'deepseek' && details?.toolsSupported === true;
  const promptFor = useCallback(
    (conversation: Conversation) => {
      const history = historyForDraft(conversation.messages, rejectedUserId);
      return assembleProjectRequest(
        conversation,
        draft
          ? [
              ...history,
              { id: 'draft', role: 'user', content: draft, reasoning: '', status: 'complete' },
            ]
          : history,
        { chat_system_prompt: defaultPrompt },
        project,
        searchFiles ? [] : undefined,
        searchFiles ? [] : undefined,
        includeReasoning,
      );
    },
    [draft, rejectedUserId, defaultPrompt, project, searchFiles, includeReasoning],
  );
  const messages = unavailable ? [] : promptFor(draftChat);
  const key = JSON.stringify(messages);
  const canMeasureLocally = available && !cloud;
  const localCount = useLocalPromptCount(key, server.runId, canMeasureLocally);
  const estimate: TokenEstimate = localCount ?? {
    tokens: approximatePromptTokens(messages),
    source: 'approximate',
  };
  const imageTokens = details?.visionSupported === true ? estimateImageTokens(chat.attachments) : 0;
  const includesImages = imageTokens > 0;
  const tokens = estimate.tokens + imageTokens;
  const usage = available ? contextWindowUsage(tokens, capacity) : null;
  const outputLimitSupported = cloud?.outputLimitSupported !== false;
  const replyTarget = usage
    ? replyTargetTokens(
        usage.capacity,
        outputLimitSupported ? settings?.max_tokens : undefined,
        !!cloud,
      )
    : 0;
  const replyShortfall = usage ? Math.max(0, replyTarget - usage.remaining) : 0;
  const overflow = available && !!capacity && estimate.tokens + Math.min(1, replyTarget) > capacity;
  const atCompactionThreshold = usage?.atCompactionThreshold ?? false;
  const canPlanDraft = outputLimitSupported && !!(usage && draft && draftChat.messages.length >= 4);
  const shouldPlanDraft =
    canPlanDraft &&
    (replyShortfall > 0 || atCompactionThreshold) &&
    (!canMeasureLocally || !!localCount);
  const planDraft = useCallback(
    async (originalTokens: number, stopped: () => boolean) => {
      if (!capacity) return null;
      return selectDraftCompaction(
        draftChat,
        capacity,
        originalTokens + imageTokens,
        replyTarget,
        async (candidate) => {
          const prompt = promptFor(candidate);
          const tokens = canMeasureLocally
            ? (await estimatePromptTokens(prompt)).tokens
            : approximatePromptTokens(prompt);
          return tokens + imageTokens;
        },
        stopped,
      );
    },
    [draftChat, capacity, imageTokens, replyTarget, promptFor, canMeasureLocally],
  );
  const [measuredPlan, setMeasuredPlan] = useState<{
    planner: typeof planDraft;
    backend: typeof backend;
    originalTokens: number;
    plan: DraftCompaction | null;
  } | null>(null);
  const originalTokens = estimate.tokens;
  useEffect(() => {
    if (!shouldPlanDraft) return;
    let disposed = false;
    void planDraft(originalTokens, () => disposed).then((plan) => {
      if (!disposed) setMeasuredPlan({ planner: planDraft, backend, originalTokens, plan });
    });
    return () => {
      disposed = true;
    };
  }, [shouldPlanDraft, planDraft, originalTokens, backend]);
  const planned =
    shouldPlanDraft &&
    measuredPlan?.planner === planDraft &&
    measuredPlan.backend === backend &&
    measuredPlan.originalTokens === originalTokens
      ? measuredPlan.plan
      : undefined;
  const canMakeRoomByCompacting = !!planned;
  const shouldMeasureAutoCompaction =
    canPlanDraft &&
    ((atCompactionThreshold && planned !== null) || (canMeasureLocally && !localCount));

  async function measureDraftCompaction(automatic: boolean, stopped: () => boolean) {
    if (!canPlanDraft) return null;
    const original = canMeasureLocally
      ? (localCount ?? (await estimatePromptTokens(messages)))
      : estimate;
    if (stopped()) return null;
    if (
      automatic &&
      contextWindowUsage(original.tokens + imageTokens, capacity)?.atCompactionThreshold === false
    )
      return null;
    return planned === undefined ? planDraft(original.tokens, stopped) : planned;
  }
  const [lastCompaction, setLastCompaction] = useState<ContextCompaction | null>(null);
  const summary = chat.summary;
  const compaction =
    available &&
    lastCompaction?.chatId === chat.id &&
    lastCompaction.backend === backend &&
    lastCompaction.summary?.createdAt === summary?.createdAt &&
    lastCompaction.summary?.throughMessageId === summary?.throughMessageId &&
    lastCompaction.summary?.text === summary?.text
      ? lastCompaction
      : null;

  async function compareCompaction(
    before: Conversation,
    after: Conversation,
  ): Promise<CompactionResult> {
    const previous = promptFor(before);
    const next = promptFor(after);
    const priorCount = key === JSON.stringify(previous) ? localCount : undefined;
    const [beforeCount, afterCount] = canMeasureLocally
      ? await Promise.all([
          priorCount?.source === 'server' ? priorCount : estimatePromptTokens(previous),
          estimatePromptTokens(next),
        ])
      : [];
    // If only one prompt could be templated or tokenized, compare both with the same fallback.
    const sameMethod =
      beforeCount?.source === 'server' &&
      afterCount?.source === 'server' &&
      beforeCount.templated === afterCount.templated;
    return {
      before: (sameMethod ? beforeCount.tokens : approximatePromptTokens(previous)) + imageTokens,
      after: (sameMethod ? afterCount.tokens : approximatePromptTokens(next)) + imageTokens,
      approximate:
        !sameMethod || !beforeCount.templated || includesImages || searchFiles || searchWeb,
    };
  }

  function recordCompaction(conversation: Conversation, report: CompactionReport) {
    if (!available) return;
    setLastCompaction({
      ...report,
      chatId: conversation.id,
      summary: conversation.summary,
      backend,
      capacity,
    });
  }

  return {
    available,
    tokens,
    templated: estimate.templated === true,
    approximate: !estimate.templated || includesImages || searchFiles || searchWeb,
    includesImages,
    searchFiles,
    searchWeb,
    capacity,
    usage,
    overflow,
    replyTarget,
    replyShortfall,
    canMakeRoomByCompacting,
    atCompactionThreshold,
    shouldMeasureAutoCompaction,
    measureDraftCompaction,
    compaction,
    compareCompaction,
    recordCompaction,
  };
}
