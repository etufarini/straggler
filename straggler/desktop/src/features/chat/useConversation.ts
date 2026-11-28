import {
  minimumCompactionReply,
  compactionPlan,
  summaryAfterChange,
  summaryChunk,
  summaryRequest,
  summaryTextError,
} from '../../domain/compaction';
import type { CompactionReport, CompactionResult, DraftCompaction } from '../../domain/compaction';
import {
  approximatePromptTokens,
  approximateTokens,
  estimateImageTokens,
} from '../../domain/attachments';
import type { ActiveCloud } from '../../domain/cloudModels';
import type { Project } from '../../domain/projects';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Channel,
  invoke,
  isTauri,
  saveConversationExport,
  chooseConversationImport,
  estimatePromptTokens,
  estimateTextTokens,
  measureResourceContext,
  projectService,
} from '../../services/desktop';
import { fileName, newConversation } from '../../domain/types';
import {
  historyForDraft,
  inheritedChatOptions,
  replyTargetTokens,
  resolveChatOptions,
} from '../../domain/chat';
import { replaceMessage, regenerationHistory } from '../../domain/messageActions';
import { materializeImport } from '../../domain/conversationImport';
import type { ImportedConversation } from '../../domain/conversationImport';
import {
  assembleProjectRequest,
  resourceContextState,
  resourceRequestText,
  passageContext,
  passageBudgets,
  resolveProjectSystemPrompt,
  shrinkPassages,
} from '../../domain/projectContext';
import { flushStorage, serializeStorage } from '../../domain/storageQueue';
import type { StorageQueue } from '../../domain/storageQueue';
import type { ProjectsController } from '../projects/useProjects';
import { exportFileName, serializeConversation } from '../../domain/conversationExport';
import { errorDetail, isContextRejection } from '../../domain/errors';
import type {
  Conversation,
  Delta,
  Message,
  Response,
  ServerDetails,
  ServerStatus,
  Settings,
  ChatOptions,
  ProjectPassage,
} from '../../domain/types';

const summaryCanceled = 'Summary canceled.';
type CompactionContext = {
  compareCompaction: (before: Conversation, after: Conversation) => Promise<CompactionResult>;
  recordCompaction: (conversation: Conversation, report: CompactionReport) => void;
  measureDraftCompaction: (
    automatic: boolean,
    stopped: () => boolean,
  ) => Promise<DraftCompaction | null>;
};
type CompactionContinuation = 'draft' | 'automatic';
type CompactedDraft = {
  chat: Conversation;
  recordCompaction: CompactionContext['recordCompaction'];
  report: CompactionReport;
};

export function useConversation(
  server: ServerStatus,
  settings: Settings | undefined,
  contextSize: number | null | undefined,
  projects: ProjectsController,
  saveQueue: StorageQueue,
  cloud: ActiveCloud | null,
  ensureCloudConsent: () => Promise<boolean>,
  serverDetails: ServerDetails | null,
) {
  const systemRoleSupported = serverDetails?.systemRoleSupported ?? null;
  const visionSupported = serverDetails?.visionSupported === true;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chat, setChat] = useState<Conversation>(newConversation);
  const resourceProject = projects.projects.find((project) => project.id === chat.projectId);
  const resourcesAvailable = !chat.projectId || !!resourceProject;
  const resourceInstructions = resourcesAvailable
    ? resolveProjectSystemPrompt(chat, settings, resourceProject)
    : '';
  const inferredSearch = useMemo(
    () =>
      resourcesAvailable &&
      resourceContextState(chat, settings, resourceProject, contextSize).search,
    [
      chat.attachments,
      chat.projectId,
      resourceInstructions,
      resourceProject,
      resourcesAvailable,
      contextSize,
    ],
  );
  const [fileDecision, setFileDecision] = useState<{
    id: string;
    attachments: Conversation['attachments'];
    project?: Project;
    instructions: string;
    capacity: number | null | undefined;
    search: boolean;
  } | null>(null);
  useEffect(() => {
    if (
      !contextSize ||
      !resourcesAvailable ||
      (!resourceProject && !chat.attachments?.some((file) => !file.image))
    )
      return;
    let active = true;
    void measureResourceContext(
      resourceRequestText(chat, settings, resourceProject),
      resourceInstructions,
      contextSize,
    ).then(({ context }) => {
      if (active)
        setFileDecision({
          id: chat.id,
          attachments: chat.attachments,
          project: resourceProject,
          instructions: resourceInstructions,
          capacity: contextSize,
          search: context.search,
        });
    });
    return () => {
      active = false;
    };
  }, [
    chat.id,
    chat.attachments,
    resourceProject,
    resourceInstructions,
    resourcesAvailable,
    contextSize,
    server.runId,
    server.phase,
  ]);
  const resourceSearch =
    fileDecision?.id === chat.id &&
    fileDecision.attachments === chat.attachments &&
    fileDecision.project === resourceProject &&
    fileDecision.instructions === resourceInstructions &&
    fileDecision.capacity === contextSize
      ? fileDecision.search
      : inferredSearch;
  const attachmentSearch = resourceSearch && (chat.attachments ?? []).some((file) => !file.image);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<{ message: string; details?: string } | null>(
    null,
  );
  useEffect(() => setSummaryError(null), [chat.id]);
  const [webSearchOn, setWebSearchOn] = useState(false);
  const [input, updateInput] = useState('');
  const inputRevision = useRef(0);
  const [temporaryId, setTemporaryId] = useState<string | null>(null);
  const temporaryRef = useRef<string | null>(null);
  const [contextError, setContextError] = useState<{
    message: string;
    kind: 'space' | 'space-after-compaction' | 'other';
  } | null>(null);
  const [branchError, setBranchError] = useState<{
    chatId: string;
    messageId: string;
    detail: string;
  } | null>(null);
  const [editor, setEditor] = useState<{ messageId: string; text: string } | null>(null);
  const [editingBusy, setEditingBusy] = useState(false);
  const mutation = useRef(false);
  const [storageError, setStorageError] = useState('');
  const [fileError, setFileError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<{ fileName: string; details: string } | null>(
    null,
  );
  const [fileNotice, setFileNotice] = useState('');
  useEffect(() => {
    if (!fileNotice) return;
    const timer = setTimeout(() => setFileNotice(''), 3500);
    return () => clearTimeout(timer);
  }, [fileNotice]);
  const [historyReady, setHistoryReady] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationPhase, setGenerationPhase] = useState<'waiting' | 'reasoning' | 'generating'>(
    'waiting',
  );
  const chatRef = useRef(chat);
  const requestRef = useRef<string | null>(null);
  const cancelledRef = useRef<string | null>(null);
  const sendPromise = useRef<Promise<void> | null>(null);
  const streamFrame = useRef<number | null>(null);
  const rejectedDraft = useRef<{ chatId: string; userId: string } | null>(null);
  const mounted = useRef(true);
  const messageList = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const composerInput = useRef<{ focus: () => void }>(null);
  const manualSummaryPlan = useMemo(
    () => (chat.summary && !generating ? compactionPlan(chat, contextSize, 'manual') : undefined),
    [chat, contextSize, generating],
  );
  useEffect(() => {
    setContextError(null);
  }, [chat.attachments, contextSize]);

  function setInput(value: string) {
    inputRevision.current += 1;
    setContextError(null);
    updateInput(value);
  }

  function projectFor(value: Conversation) {
    return projects.current.current.find((project) => project.id === value.projectId);
  }

  async function flushSaves() {
    await projects.flush();
    await flushStorage(saveQueue);
    if (storageError && (chatRef.current.messages.length || chatRef.current.attachments?.length))
      throw new Error(storageError);
  }
  function updateChat(value: Conversation) {
    if (chatRef.current.id !== value.id) setWebSearchOn(false);
    chatRef.current = value;
    setChat(value);
  }
  function updateConversations(value: Conversation) {
    setConversations((values) =>
      [value, ...values.filter((item) => item.id !== value.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    );
  }
  const loadHistory = useCallback(async () => {
    try {
      const values = await invoke<Conversation[]>('history_list');
      if (!mounted.current) return;
      setConversations(values);
      setHistoryReady(true);
      setStorageError('');
    } catch (e) {
      if (mounted.current) setStorageError(errorDetail(e).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (isTauri()) void loadHistory();
    return () => {
      mounted.current = false;
      if (streamFrame.current !== null) cancelAnimationFrame(streamFrame.current);
      streamFrame.current = null;
    };
  }, [loadHistory]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = messageList.current;
      if (!follow.current || !list) return;
      list.scrollTo({
        top: list.scrollHeight,
        behavior:
          generating || matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [chat, generating]);
  function save(value: Conversation, create = false): Promise<void> {
    if (value.id === temporaryRef.current) return Promise.resolve();
    const snapshot = structuredClone(value);
    const pending = serializeStorage(saveQueue, async () => {
      await invoke(create ? 'history_create' : 'history_save', { conversation: snapshot });
      if (mounted.current) {
        if (historyReady) setStorageError('');
        updateConversations(snapshot);
      }
    });
    void pending.catch((e) => {
      if (mounted.current && !create) setStorageError(errorDetail(e).message);
    });
    return pending;
  }

  async function cancel() {
    if (requestRef.current) {
      cancelledRef.current = requestRef.current;
      await invoke('cancel_generation', { requestId: requestRef.current });
    }
  }

  async function send(
    replacement?: Message[],
    submittedText?: string,
    { compacted, triedCompacting }: { compacted?: CompactedDraft; triedCompacting?: boolean } = {},
  ) {
    const text = (submittedText ?? input).trim();
    const draftRevision = inputRevision.current;
    if (
      (!replacement && (!text || (editor && submittedText === undefined))) ||
      requestRef.current ||
      mutation.current ||
      (!cloud && server.phase !== 'ready') ||
      (!temporaryRef.current && (!historyReady || storageError))
    )
      return;
    if (cloud && !compacted && !(await ensureCloudConsent())) return;
    if (requestRef.current || (compacted && compacted.chat.id !== chatRef.current.id)) return;
    const project = projectFor(chatRef.current);
    if (chatRef.current.projectId && (!projects.ready || projects.error || !project)) {
      setContextError({
        message: 'Project data is unavailable. Retry loading projects before sending.',
        kind: 'other',
      });
      return;
    }
    if (project?.archived) {
      setContextError({ message: 'Restore this project to continue the chat.', kind: 'other' });
      return;
    }
    const useWebSearch = webSearchOn;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setGenerating(true);
    setGenerationPhase('waiting');
    follow.current = true;
    if (!replacement && !compacted) setInput('');
    let submittedInputRevision = inputRevision.current;
    function restoreSubmittedInput() {
      // A late rejection must not replace a draft edited while this request was pending.
      if (
        !replacement &&
        (!compacted || submittedInputRevision !== draftRevision) &&
        inputRevision.current === submittedInputRevision
      ) {
        setInput(text);
        return true;
      }
      return false;
    }
    const user: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      reasoning: '',
      status: 'complete',
    };
    const assistant: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      ...(cloud
        ? {
            cloud: { providerId: cloud.selection.providerId, name: cloud.providerName },
            model: cloud.model.id,
          }
        : { serverRunId: server.runId, ...(server.model ? { model: server.model } : {}) }),
      content: '',
      reasoning: '',
      status: 'streaming',
    };
    const previous = chatRef.current;
    const original = compacted?.chat ?? previous;
    const previousRejection = rejectedDraft.current;
    const rejectedUserId =
      previousRejection?.chatId === original.id ? previousRejection.userId : undefined;
    let current: Conversation = {
      ...original,
      updatedAt: Date.now(),
      model: cloud?.model.id ?? server.model,
      summary: replacement
        ? summaryAfterChange(original, replacement.at(-1)!.id)
        : original.summary,
      title:
        original.messages.length || original.titleCustomized ? original.title : text.slice(0, 80),
      messages: [
        ...(replacement ?? [...historyForDraft(original.messages, rejectedUserId), user]),
        // Incoming deltas must not mutate a snapshot React is still rendering.
        { ...assistant },
      ],
    };
    const options = resolveChatOptions(current.options, settings, !!cloud);
    const replyTarget = contextSize
      ? replyTargetTokens(contextSize, settings?.max_tokens, !!cloud)
      : 0;
    const replyReserve = compacted ? minimumCompactionReply(replyTarget) : Math.min(1, replyTarget);
    // Keep automatic continuation conservative. An ordinary send lets the server decide
    // whether its model-specific image encoding actually leaves room for a reply.
    const imageAllowance =
      compacted && visionSupported ? estimateImageTokens(current.attachments) : 0;
    const inputLimit = contextSize ? contextSize - replyReserve - imageAllowance : null;
    const includeReasoning =
      cloud?.kind === 'deepseek' && useWebSearch && cloud.model.details.toolsSupported === true;
    const history = current.messages.slice(0, -1);
    let messages = assembleProjectRequest(
      current,
      history,
      settings,
      project,
      undefined,
      undefined,
      includeReasoning,
    );
    const query = replacement
      ? ([...history].reverse().find((message) => message.role === 'user')?.content ?? '')
      : text;
    const documents = (current.attachments ?? []).filter((file) => !file.image);
    if ((project || documents.length) && contextSize && inputLimit !== null) {
      const instructions = resolveProjectSystemPrompt(current, settings, project);
      const { context: capacity, instructionTokens } = await measureResourceContext(
        resourceRequestText(current, settings, project),
        instructions,
        contextSize,
      );
      setFileDecision({
        id: current.id,
        attachments: current.attachments,
        project,
        instructions,
        capacity: contextSize,
        search: capacity.search,
      });
      if (project && capacity.level === 'over' && !capacity.search) {
        restoreSubmittedInput();
        setContextError({
          message: `This project does not fit in the context window. It needs ${capacity.shortfall.toLocaleString('en-US')} more tokens than are available.`,
          kind: 'space',
        });
        requestRef.current = null;
        setGenerating(false);
        return;
      }
      if (capacity.search) {
        try {
          const base = assembleProjectRequest(
            current,
            history,
            settings,
            project,
            [],
            [],
            includeReasoning,
          );
          const baseCount = await estimatePromptTokens(base);
          const budgets = passageBudgets(
            Math.min(capacity.available! - instructionTokens, inputLimit - baseCount.tokens),
            !!project?.files.some((file) => file.included),
            documents.length > 0,
          );
          let [projectPassages, attachmentPassages] = await Promise.all([
            project
              ? projectService.search(project.id, query, budgets.project)
              : Promise.resolve([]),
            documents.length
              ? invoke<ProjectPassage[]>('attachment_search', {
                  id: current.id,
                  temporary: !!temporaryRef.current,
                  query,
                  budget: budgets.attachments,
                })
              : Promise.resolve([]),
          ]);
          // Remeasure the actual request, retaining the highest ranked excerpts first.
          messages = base;
          while (projectPassages.length || attachmentPassages.length) {
            const candidate = assembleProjectRequest(
              current,
              history,
              settings,
              project,
              projectPassages,
              attachmentPassages,
              includeReasoning,
            );
            const [resourceTokens, promptCount] = await Promise.all([
              estimateTextTokens(
                [instructions, passageContext(projectPassages, attachmentPassages)]
                  .filter(Boolean)
                  .join('\n\n'),
              ),
              estimatePromptTokens(candidate),
            ]);
            if (resourceTokens.tokens <= capacity.available! && promptCount.tokens <= inputLimit) {
              messages = candidate;
              break;
            }
            projectPassages = shrinkPassages(projectPassages);
            attachmentPassages = shrinkPassages(attachmentPassages);
          }
          if (project) assistant.projectSources = projectPassages;
          if (documents.length) assistant.attachmentSources = attachmentPassages;
          current.messages[current.messages.length - 1] = { ...assistant };
        } catch (error) {
          restoreSubmittedInput();
          setContextError({
            message: `Couldn’t search ${project ? (documents.length ? 'project files or attachments' : 'project files') : 'attachments'}. ${errorDetail(error).message}`,
            kind: 'other',
          });
          requestRef.current = null;
          setGenerating(false);
          return;
        }
      }
    }
    const estimate =
      cloud && compacted
        ? { tokens: approximatePromptTokens(messages), source: 'approximate' }
        : await estimatePromptTokens(messages);
    if (
      compacted &&
      (cancelledRef.current === requestId || inputRevision.current !== draftRevision)
    ) {
      requestRef.current = null;
      setGenerating(false);
      setFileNotice(
        cancelledRef.current === requestId
          ? summaryCanceled
          : 'Your draft changed. Review it before sending.',
      );
      return;
    }
    if (contextSize && inputLimit !== null && estimate.tokens > inputLimit) {
      const estimateLabel = imageAllowance || estimate.source === 'approximate' ? 'about ' : '';
      const shortfall = estimateLabel + (estimate.tokens - inputLimit).toLocaleString('en-US');
      restoreSubmittedInput();
      setContextError({
        message: compacted
          ? `Free ${shortfall} more tokens to make room for a reply.`
          : estimate.tokens > contextSize
            ? `The prompt and attachments exceed the ${contextSize.toLocaleString('en-US')}-token context. Free ${shortfall} tokens to send.`
            : 'The prompt fills the entire context window. Free space for a reply.',
        kind: compacted || triedCompacting ? 'space-after-compaction' : 'space',
      });
      requestRef.current = null;
      setGenerating(false);
      return;
    }
    const replyRoom = contextSize ? contextSize - estimate.tokens - imageAllowance : null;
    const shorterReply =
      compacted && replyRoom !== null && replyRoom < replyTarget ? replyRoom : undefined;
    if (compacted) {
      setInput('');
      submittedInputRevision = inputRevision.current;
    }
    setWebSearchOn(false);
    setContextError(null);
    rejectedDraft.current = null;
    const proposedSummary = compacted ? current.summary : undefined;
    // Keep the saved summary in the initial and partial snapshots until the backend responds.
    if (proposedSummary) current = { ...current, summary: previous.summary };
    if (!replacement && !compacted) updateChat(current);
    const onDelta = new Channel<Delta>();
    const summaryRemoved = !!chatRef.current.summary && !current.summary;
    let generationStarted = false;
    let lastSave = Date.now();
    let phase: 'waiting' | 'reasoning' | 'generating' = 'waiting';
    function snapshotResponse() {
      current = {
        ...current,
        messages: [...current.messages.slice(0, -1), { ...assistant }],
        updatedAt: Date.now(),
      };
    }
    function publishResponse() {
      streamFrame.current = null;
      if (!mounted.current || requestRef.current !== requestId) return;
      snapshotResponse();
      setGenerationPhase(phase);
      updateChat(current);
    }
    onDelta.onmessage = (delta) => {
      if (requestRef.current !== requestId) return;
      assistant.content += delta.content;
      assistant.reasoning += delta.reasoning;
      if (delta.sources) assistant.sources = delta.sources;
      if (delta.webSearch) assistant.webSearch = delta.webSearch;
      if (delta.metrics)
        assistant.metrics = {
          ...assistant.metrics,
          ...delta.metrics,
          ...(cloud ? {} : { runId: server.runId }),
        };
      if (delta.content) phase = 'generating';
      else if (delta.reasoning) phase = 'reasoning';
      if (streamFrame.current === null && mounted.current)
        streamFrame.current = requestAnimationFrame(publishResponse);
      if (Date.now() - lastSave > 2000) {
        lastSave = Date.now();
        // Persistence must keep receiving partial text even when hidden windows
        // suspend animation callbacks. Visual updates can wait for the next frame.
        snapshotResponse();
        void save(current).catch(() => {});
      }
    };
    try {
      // Persist the user's message before asking the server to generate.
      await save(current);
      updateChat(current);
      setEditor(null);
      generationStarted = true;
      if (replacement && summaryRemoved)
        setFileNotice('Summary removed because earlier messages changed.');
      const response: Response =
        cancelledRef.current === requestId
          ? { status: 'stopped', content: '', reasoning: '', error: null }
          : await invoke<Response>('generate', {
              request: {
                requestId,
                cloud: cloud?.selection,
                imageIds: visionSupported
                  ? (current.attachments ?? [])
                      .filter((attachment) => attachment.image)
                      .map((attachment) => attachment.id)
                  : [],
                webSearch: useWebSearch,
                webSearchQuery: query,
                conversationId: temporaryRef.current ? undefined : current.id,
                temporaryId: temporaryRef.current ?? undefined,
                messages,
                maxOutputTokens: shorterReply,
                options: { reasoning: options.reasoning, effort: options.effort },
              },
              onDelta,
            });
      assistant.sources = response.sources ?? assistant.sources;
      assistant.webSearch = response.webSearch ?? assistant.webSearch;
      assistant.status = response.status;
      assistant.content = response.content;
      assistant.reasoning = response.reasoning;
      if (response.metrics)
        assistant.metrics = {
          ...assistant.metrics,
          ...response.metrics,
          ...(cloud ? {} : { runId: server.runId }),
        };
      if (response.error) assistant.error = response.error;
    } catch (e) {
      assistant.status = 'error';
      if (generationStarted) assistant.error = errorDetail(e).message;
      if (compacted && !generationStarted) {
        rejectedDraft.current = previousRejection;
        restoreSubmittedInput();
      }
    } finally {
      // Ignore any queued IPC deltas once the final snapshot has arrived.
      onDelta.onmessage = () => {};
      if (streamFrame.current !== null) cancelAnimationFrame(streamFrame.current);
      streamFrame.current = null;
      snapshotResponse();
      const hasPartial = !!(assistant.content || assistant.reasoning);
      const contextRejected = !!assistant.error && isContextRejection(assistant.error);
      if (contextRejected && !replacement) {
        const restored = restoreSubmittedInput();
        if (compacted) {
          if (!hasPartial) {
            current = previous;
            rejectedDraft.current = previousRejection;
          }
          if (restored)
            setContextError({
              message:
                'The model ran out of context. Shorten your draft or review included files to make room for a reply.',
              kind: 'space-after-compaction',
            });
        } else if (!hasPartial) {
          rejectedDraft.current = { chatId: current.id, userId: user.id };
        }
      }
      if ((!replacement && !compacted) || generationStarted) {
        updateChat(current);
        if (
          compacted &&
          proposedSummary &&
          !contextRejected &&
          (hasPartial || assistant.status === 'complete' || assistant.status === 'length')
        ) {
          const accepted = { ...current, summary: proposedSummary };
          try {
            await save(accepted);
            updateChat(accepted);
            compacted.recordCompaction(accepted, compacted.report);
          } catch (error) {
            // The reply can still be saved independently of the proposed summary.
            await save(current).catch(() => {});
            setSummaryError({
              message: 'Couldn’t save the updated summary. The previous context stays in use.',
              details: errorDetail(error).message,
            });
          }
        } else {
          await save(current).catch(() => {});
        }
      }
      requestRef.current = null;
      setGenerating(false);
    }
  }

  function compactReason(value = chatRef.current): string | undefined {
    if (editor) return 'Finish or cancel the current edit to summarize earlier messages.';
    const active = chatRef.current;
    if (value.id !== active.id) return 'Open this chat to summarize earlier messages.';
    if (summarizing) return 'Available after the summary is ready.';
    if (generating) return 'Available after the current reply.';
    if (requestRef.current || mutation.current || editingBusy || importBusy)
      return 'Available when the current operation ends.';
    if (!cloud && server.phase !== 'ready')
      return server.phase === 'loading'
        ? 'Available when the model is ready.'
        : 'Start the local server or choose a cloud model.';
    if (cloud?.outputLimitSupported === false)
      return 'Choose a model that supports a response token limit to summarize earlier messages.';
    if (active.messages.length < 4)
      return 'A chat needs at least four messages to create a summary.';
    if (!contextSize && active.messages.length <= 4 && !active.summary)
      return 'The most recent four messages stay in context. Send another message to summarize earlier ones.';
    if (temporaryRef.current && temporaryRef.current !== value.id)
      return 'Leave the temporary chat to summarize another chat.';
    if (!temporaryRef.current && (!historyReady || storageError))
      return 'Resolve the chat storage error to create a summary.';
    if (active.projectId) {
      const project = projectFor(active);
      if (!project || !projects.ready || projects.error)
        return 'Reload the project to create a summary.';
      if (project.archived) return 'Restore the project to summarize this chat.';
    }
    if (active.summary) {
      const plan =
        active === chat && manualSummaryPlan
          ? manualSummaryPlan
          : compactionPlan(active, contextSize, 'manual');
      if (!plan.hasNewText) return 'No older messages to summarize yet.';
    }
  }

  async function generateCompactionSummary(
    original: Conversation,
    plan: ReturnType<typeof compactionPlan>,
    initialLimit: number,
    maximumLimit: number,
  ): Promise<{ text: string } | { message: string } | { stopped: true } | { needsRoom: true }> {
    let remaining = plan.source;
    let summary = '';
    let outputLimit = initialLimit;
    let chunkLimit = plan.inputLimit;
    let retriesLeft = 2;
    while (remaining) {
      if (cancelledRef.current === requestRef.current) return { stopped: true } as const;
      const requestId = crypto.randomUUID();
      requestRef.current = requestId;
      const inputLimit = contextSize
        ? Math.min(plan.inputLimit, contextSize - outputLimit - 1)
        : plan.inputLimit;
      const instructionsLimit = Number.isFinite(maximumLimit) ? outputLimit : undefined;
      const prompt = (chunk: string) =>
        summaryRequest(summary, chunk, systemRoleSupported === true, instructionsLimit);
      let budget = Math.min(chunkLimit, inputLimit - approximatePromptTokens(prompt('')) - 32);
      let piece = summaryChunk(remaining, budget);
      let messages = prompt(piece.chunk);
      while ((await estimatePromptTokens(messages)).tokens > inputLimit) {
        if (cancelledRef.current === requestId) return { stopped: true } as const;
        budget = Math.floor(budget / 2);
        piece = summaryChunk(remaining, budget);
        messages = prompt(piece.chunk);
      }
      if (cancelledRef.current === requestId) return { stopped: true } as const;
      const response = await invoke<Response>('generate', {
        request: {
          requestId,
          messages,
          cloud: cloud?.selection,
          maxOutputTokens: outputLimit,
          conversationId: temporaryRef.current ? undefined : original.id,
          temporaryId: temporaryRef.current ?? undefined,
          webSearch: false,
          imageIds: [],
          options: !cloud && serverDetails?.reasoningSupported === true ? { reasoning: 'off' } : {},
        },
        onDelta: new Channel<Delta>(),
      });
      if (response.status === 'stopped' || cancelledRef.current === requestId)
        return { stopped: true } as const;
      const reachedLimit = response.status === 'length';
      const contextRejected = !!response.error && isContextRejection(response.error);
      if (!cloud && (reachedLimit || contextRejected) && retriesLeft > 0) {
        const smallerChunk = Math.floor(approximateTokens(piece.chunk) / 2);
        const largerOutput =
          reachedLimit && contextSize
            ? Math.max(
                outputLimit,
                Math.min(maximumLimit, 4096, Math.floor(contextSize / 2), outputLimit * 2),
              )
            : outputLimit;
        if (smallerChunk > 0 || largerOutput > outputLimit) {
          // Advance only after a complete summary so the rest of a rejected block is retried.
          if (smallerChunk > 0) chunkLimit = smallerChunk;
          outputLimit = largerOutput;
          retriesLeft--;
          continue;
        }
      }
      if (response.error) throw new Error(response.error);
      if (reachedLimit) {
        if (outputLimit >= maximumLimit) return { needsRoom: true };
        return {
          message:
            'The model reached its generation limit before finishing the summary. Try another model.',
        };
      }
      if (response.status !== 'complete' || !response.content.trim()) {
        return {
          message:
            response.status === 'complete'
              ? 'The model returned an empty summary. Try another model.'
              : 'The summary response was interrupted. Try again.',
        };
      }
      const error = summaryTextError(response.content);
      if (error) throw new Error(error);
      summary = response.content;
      remaining = piece.rest;
    }
    return { text: summary };
  }

  async function performCompaction(
    target: Conversation,
    { compareCompaction, recordCompaction, measureDraftCompaction }: CompactionContext,
    continuation?: CompactionContinuation,
  ) {
    if (compactReason(target)) return;
    const draft = input;
    const revision = inputRevision.current;
    if (cloud && !(await ensureCloudConsent())) return;
    if (compactReason(target) || (continuation && revision !== inputRevision.current)) return;
    const original = structuredClone(chatRef.current);
    const automatic = continuation === 'automatic';
    requestRef.current = crypto.randomUUID();
    setSummaryError(null);
    setGenerating(true);
    setGenerationPhase('waiting');
    let compacted: CompactedDraft | undefined;
    let committing = false;
    let useOriginal = false;
    let triedCompacting = false;
    function reportCompactionStopped() {
      setFileNotice(summaryCanceled);
    }
    function reportDraftNeedsRoom() {
      setContextError({
        message: 'Shorten your message or review included files to make room for a reply.',
        kind: 'space-after-compaction',
      });
    }
    function draftChanged() {
      if (!continuation || revision === inputRevision.current) return false;
      setFileNotice('Your draft changed. Review it before sending.');
      return true;
    }
    try {
      const draftPlan = continuation
        ? await measureDraftCompaction(
            automatic,
            () => cancelledRef.current === requestRef.current || revision !== inputRevision.current,
          )
        : null;
      if (requestRef.current && cancelledRef.current === requestRef.current)
        return reportCompactionStopped();
      if (draftChanged()) return;
      if (continuation && !draftPlan) {
        if (!automatic) {
          reportDraftNeedsRoom();
          return;
        }
        useOriginal = true;
      } else {
        const plan = compactionPlan(original, contextSize, draftPlan?.keepFrom ?? 'manual');
        if (!plan.hasNewText || !plan.throughMessageId) {
          setSummaryError({
            message: 'There are no earlier messages to summarize while keeping the recent chat.',
          });
          return;
        }
        setSummarizing(true);
        await flushSaves();
        const result = await generateCompactionSummary(
          original,
          plan,
          draftPlan?.initial ?? plan.outputLimit,
          draftPlan?.maximum ?? Infinity,
        );
        if ('stopped' in result || cancelledRef.current === requestRef.current)
          return reportCompactionStopped();
        if (draftChanged()) return;
        if ('needsRoom' in result) return reportDraftNeedsRoom();
        if ('message' in result) {
          setSummaryError({ message: result.message });
          useOriginal = automatic;
        } else {
          const next: Conversation = {
            ...original,
            updatedAt: Date.now(),
            summary: {
              throughMessageId: plan.throughMessageId,
              text: result.text,
              model: cloud?.model.id ?? server.model ?? original.model ?? 'Unknown model',
              createdAt: Date.now(),
            },
          };
          const comparison = await compareCompaction(original, next);
          if (cancelledRef.current === requestRef.current) return reportCompactionStopped();
          if (draftChanged()) return;
          if (comparison.after >= comparison.before) {
            recordCompaction(original, { result: comparison, applied: false });
            useOriginal = !!continuation;
            triedCompacting = true;
          } else {
            if (!continuation) {
              // For a submitted draft, send checks the complete request before saving.
              requestRef.current = null;
              setSummarizing(false);
              setGenerating(false);
              mutation.current = true;
              committing = true;
              setEditingBusy(true);
              await save(next);
              updateChat(next);
              setContextError(null);
            }
            compacted = {
              chat: next,
              recordCompaction,
              report: { result: comparison, applied: true },
            };
          }
        }
      }
    } catch (failure) {
      if (requestRef.current && cancelledRef.current === requestRef.current)
        return reportCompactionStopped();
      setSummaryError({
        message: 'Check the technical details and try again.',
        details: errorDetail(failure).message,
      });
      useOriginal = automatic;
    } finally {
      requestRef.current = null;
      setSummarizing(false);
      setGenerating(false);
      if (committing) {
        mutation.current = false;
        setEditingBusy(false);
      }
    }
    if (!continuation) {
      if (compacted) recordCompaction(compacted.chat, compacted.report);
      return;
    }
    if (draftChanged()) return;
    if (compacted) await send(undefined, draft, { compacted });
    else if (useOriginal) await send(undefined, draft, { triedCompacting });
  }
  function compact(
    target: Conversation,
    context: CompactionContext,
    continuation?: CompactionContinuation,
  ) {
    const pending = performCompaction(target, context, continuation);
    sendPromise.current = pending;
    return pending;
  }
  async function changeSummary(text: string | null) {
    if (requestRef.current || mutation.current || editingBusy) return;
    const original = chatRef.current;
    if (!original.summary || projectFor(original)?.archived) return;
    if (text !== null) {
      const error = summaryTextError(text);
      if (error) throw new Error(error);
    }
    const next = {
      ...original,
      updatedAt: Date.now(),
      summary: text === null ? undefined : { ...original.summary, text },
    };
    mutation.current = true;
    setEditingBusy(true);
    try {
      await save(next);
      updateChat(next);
      setFileNotice(
        text === null ? 'Summary removed. Original messages are used again.' : 'Summary updated.',
      );
    } finally {
      mutation.current = false;
      setEditingBusy(false);
    }
  }

  async function updateChatMetadata(
    value: Conversation,
    patch: Partial<Pick<Conversation, 'title' | 'starred'>>,
  ) {
    if (
      patch.title !== undefined &&
      (!patch.title.trim() || Array.from(patch.title.trim()).length > 80)
    ) {
      throw new Error('Chat titles must contain between 1 and 80 characters.');
    }
    if (
      storageError &&
      chatRef.current.id !== value.id &&
      (chatRef.current.messages.length || chatRef.current.attachments?.length)
    ) {
      throw new Error('Save the current chat before changing another chat.');
    }
    await runConversationMutation(async () => {
      const current =
        chatRef.current.id === value.id
          ? chatRef.current
          : conversations.find((chat) => chat.id === value.id);
      if (!current) throw new Error('This chat no longer exists.');
      const updated = {
        ...current,
        ...patch,
        ...(patch.title !== undefined ? { titleCustomized: true } : {}),
      };
      await save(updated);
      acceptStoredConversation(updated);
    }, false).catch((failure) => {
      setStorageError(errorDetail(failure).message);
      throw failure;
    });
  }

  function acceptStoredConversation(value: Conversation) {
    if (chatRef.current.id === value.id) updateChat(value);
    updateConversations(value);
  }

  async function runConversationMutation(operation: () => Promise<void>, persistCurrent = true) {
    if (requestRef.current || mutation.current)
      throw new Error('Wait for the current chat operation to finish.');
    mutation.current = true;
    setEditingBusy(true);
    try {
      if (persistCurrent) await saveQueue.current;
      else await saveQueue.current.catch(() => {});
      if (persistCurrent) await save(chatRef.current);
      const pending = operation();
      saveQueue.current = pending;
      await pending;
    } finally {
      mutation.current = false;
      setEditingBusy(false);
    }
  }

  async function branchChat(messageId: string) {
    const id = chatRef.current.id;
    if (!historyReady || storageError || temporaryRef.current) return;
    setBranchError(null);
    try {
      await runConversationMutation(async () => {
        try {
          const branch = await invoke<Conversation>('history_branch', { id, messageId });
          follow.current = false;
          updateConversations(branch);
          updateChat(branch);
          setEditor(null);
        } catch (e) {
          setBranchError({ chatId: id, messageId, detail: errorDetail(e).message });
        }
      }, false);
    } catch (e) {
      setBranchError({ chatId: id, messageId, detail: errorDetail(e).message });
    }
  }

  async function importChat() {
    if (mutation.current || importBusy) return;
    let path: string | null = null;
    mutation.current = true;
    setImportBusy(true);
    try {
      path = await chooseConversationImport();
      if (!path) return;
      setImportError(null);
      const imported = await invoke<ImportedConversation>('read_conversation_import', { path });
      // Validate before disturbing an active response or writing any conversation.
      await cancel();
      await sendPromise.current;
      await saveQueue.current;
      const value = materializeImport(
        imported,
        conversations.reduce((latest, item) => Math.max(latest, item.updatedAt + 1), Date.now()),
      );
      await save(value, true);
      setEditor(null);
      updateChat(value);
      setInput('');
      follow.current = true;
      return value;
    } catch (error) {
      setImportError({
        fileName: path ? fileName(path) : 'File selection',
        details: errorDetail(error).message,
      });
    } finally {
      mutation.current = false;
      setImportBusy(false);
    }
  }

  async function exportChat(value: Conversation, includesReasoning: boolean) {
    setFileError('');
    try {
      if (temporaryRef.current === value.id) throw new Error('Save this chat before exporting it.');
      const snapshot = value.id === chatRef.current.id ? chatRef.current : value;
      const contents = serializeConversation(
        snapshot,
        includesReasoning,
        new Date().toISOString(),
        settings,
        projectFor(snapshot),
      );
      if (await saveConversationExport(exportFileName(snapshot.title), contents))
        setFileNotice('Chat exported.');
    } catch (error) {
      setFileError(errorDetail(error).message);
    }
  }

  function beginEdit(message: Message) {
    if (requestRef.current || mutation.current || projectFor(chatRef.current)?.archived) return;
    setEditor({ messageId: message.id, text: message.content });
  }

  async function regenerate(messageId: string, text?: string) {
    const original = chatRef.current;
    const value =
      text === undefined ? original : replaceMessage(original, messageId, text, Date.now());
    const pending = send(regenerationHistory(value, messageId));
    sendPromise.current = pending;
    await pending;
  }

  async function saveEdit() {
    if (!editor || mutation.current || requestRef.current) return;
    if (projectFor(chatRef.current)?.archived) return;
    if (editor.messageId === 'summary') {
      await changeSummary(editor.text);
      setEditor(null);
      return;
    }
    const original = chatRef.current;
    const message = original.messages.find((value) => value.id === editor.messageId);
    if (!message) return;
    if (message.role === 'user') {
      await regenerate(message.id, editor.text);
      return;
    }
    mutation.current = true;
    setEditingBusy(true);
    try {
      const value = replaceMessage(original, message.id, editor.text, Date.now());
      await save(value);
      if (original.summary && !value.summary)
        setFileNotice('Summary removed because earlier messages changed.');
      updateChat(value);
      setEditor(null);
    } finally {
      mutation.current = false;
      setEditingBusy(false);
    }
  }

  function setChatOptions(patch: Partial<ChatOptions>) {
    if (requestRef.current || mutation.current || projectFor(chatRef.current)?.archived) return;
    const value = {
      ...chatRef.current,
      options: { ...inheritedChatOptions, ...chatRef.current.options, ...patch },
      ...(Object.hasOwn(patch, 'systemPrompt')
        ? { ownSystemPrompt: patch.systemPrompt ?? null }
        : {}),
      updatedAt: Date.now(),
    };
    updateChat(value);
    if (value.messages.length || value.attachments?.length) void save(value).catch(() => {});
  }

  function openConversation(value: Conversation) {
    if (requestRef.current || mutation.current) return;
    setWebSearchOn(false);
    setEditor(null);
    updateChat(structuredClone(value));
    setInput('');
    follow.current = true;
  }

  function enterTemporary(value: Conversation) {
    temporaryRef.current = value.id;
    setTemporaryId(value.id);
    openConversation(value);
  }

  async function finishTemporary(store: boolean, restart = true) {
    const id = temporaryRef.current;
    if (!id) return;
    await cancel();
    await sendPromise.current;
    await saveQueue.current;
    const snapshot = structuredClone(chatRef.current);
    const warning = await invoke<string | null>('temporary_finish', {
      id,
      conversation: store ? snapshot : null,
      restart,
    });
    temporaryRef.current = null;
    setTemporaryId(null);
    if (store) {
      updateConversations(snapshot);
      if (warning) setFileNotice(`Chat saved. ${warning}`);
    } else {
      updateChat(newConversation());
      setInput('');
      setEditor(null);
    }
    if (warning && !store) setFileNotice(warning);
  }

  return {
    summarizing,
    summaryError,
    setSummaryError,
    compact,
    compactReason,
    changeSummary,
    editingSummary: editor?.messageId === 'summary',
    beginSummaryEdit: () => {
      if (
        requestRef.current ||
        mutation.current ||
        !chatRef.current.summary ||
        projectFor(chatRef.current)?.archived
      )
        return;
      // Native message identifiers are UUIDs, so this editor key cannot collide.
      setEditor({ messageId: 'summary', text: chatRef.current.summary.text });
    },
    resourceSearch,
    attachmentSearch,
    webSearchOn,
    setWebSearchOn,
    temporaryId,
    temporaryRef,
    enterTemporary,
    finishTemporary,
    chatOptionsDisabled: generating || editingBusy || importBusy,
    flushSaves,
    runConversationMutation,
    acceptStoredConversation,
    updateChatMetadata,
    contextError,
    rejectedUserId:
      rejectedDraft.current?.chatId === chat.id ? rejectedDraft.current.userId : undefined,
    branchChat,
    branchError,
    importChat,
    importBusy,
    importError,
    setImportError,
    exportChat,
    fileError,
    setFileError,
    fileNotice,
    editor,
    setEditor,
    editingBusy,
    beginEdit,
    saveEdit,
    regenerate,
    generationPhase,
    setChatOptions,
    conversations,
    setConversations,
    chat,
    input,
    setInput,
    storageError,
    historyReady,
    generating,
    chatRef,
    sendPromise,
    messageList,
    follow,
    composerInput,
    updateChat,
    loadHistory,
    save,
    cancel,
    send,
    openConversation,
  };
}

export type ConversationController = ReturnType<typeof useConversation>;
