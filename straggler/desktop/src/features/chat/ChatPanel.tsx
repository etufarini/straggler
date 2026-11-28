import ChatSummary from './ChatSummary';
import CloudNotice from '../cloud/CloudNotice';
import { Paperclip } from 'lucide-react';
import { approximateTokens, attachmentTypesLabel } from '../../domain/attachments';
import RichComposer, { FormattingToggle, composerHint } from './composer/RichComposer';
import type { ComposerContext } from './composer/commands';
import WebSearchMenu from '../websearch/WebSearchMenu';
import WebSearchActivity from '../websearch/WebSearchActivity';
import Sources from '../websearch/Sources';
import ReasoningMenu from './ReasoningMenu';
import SystemPromptMenu from './SystemPromptMenu';
import ContextCounter, { compactionResultLabel } from './ContextCounter';
import useComposerDensity from './useComposerDensity';
import Markdown from './Markdown';
import {
  ArrowUp,
  HardDrive,
  Check,
  Copy,
  Square,
  Pencil,
  RotateCcw,
  Folder,
  GitBranch,
  Cloud,
  LoaderCircle,
} from 'lucide-react';
import { fileName } from '../../domain/types';
import type { ProjectPassage } from '../../domain/types';
import { messageStatusLabel } from '../../components/statusLabels';
import Feedback from '../../components/Feedback';
import StorageFeedback from './StorageFeedback';
import type { WorkspaceController } from '../../app/useWorkspace';
import { useEffect, useRef, useState } from 'react';
import { errorDetail } from '../../domain/errors';
import { isContextRejection } from '../../domain/errors';
import { ProjectLimitFeedback } from '../projects/ProjectCapacity';
import brandMark from '../../assets/brand-mark.svg';
export default function ChatPanel({
  controller,
  onProjectSource,
}: {
  controller: WorkspaceController;
  onProjectSource: (source: ProjectPassage) => void;
}) {
  const [copied, setCopied] = useState('');
  const [composerMode, setComposerMode] = useState<ComposerContext>('text');
  const summaryDetails = useRef<HTMLDetailsElement>(null);
  const compaction = controller.contextEstimate.compaction;
  const [previousCompaction, setPreviousCompaction] = useState<typeof compaction>(null);
  useEffect(() => {
    if (controller.summarizing) setPreviousCompaction(compaction);
  }, [controller.summarizing, compaction]);
  const showSummaryResult =
    !controller.summarizing && compaction && compaction !== previousCompaction;
  function viewSummary() {
    // Close the popover and let its focus restoration finish before moving to the summary.
    requestAnimationFrame(() => {
      const details = summaryDetails.current;
      if (!details) return;
      controller.follow.current = false;
      details.open = true;
      const heading = details.querySelector('summary');
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  }
  const toolbarVisible = controller.preferences.formattingToolbarVisible !== false;
  const toggleFormatting = (visible: boolean) =>
    controller.changePreferences({ formattingToolbarVisible: visible });
  const lastEditor = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastEditor.current;
    lastEditor.current = controller.editor?.messageId ?? null;
    if (controller.editor && !controller.generating) {
      const field = document.getElementById(`edit-${controller.editor.messageId}`);
      field?.focus();
      field?.closest('.message-editor')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    } else if (previous && !controller.editor) document.getElementById(`edit-${previous}`)?.focus();
  }, [controller.editor?.messageId, controller.generating]);
  const composerRef = useComposerDensity();
  const [copyError, setCopyError] = useState<{ messageId: string; detail: string } | null>(null);
  const {
    editor,
    setEditor,
    editingBusy,
    beginEdit,
    saveEdit,
    regenerate,
    follow,
    chat,
    setInput,
    composerInput,
    active,
    setPanel,
    setError,
    messageList,
    canSend,
    send,
    sendPromise,
    server,
    input,
    generating,
    cancel,
    reviewSettings,
  } = controller;
  useEffect(() => {
    if (generating) composerInput.current?.focus();
  }, [generating, composerInput]);
  const project = controller.currentProject;
  const archived = !!project?.archived;
  const projectContext = project && controller.projects.context(project);
  const branchDisabledReason = controller.temporary
    ? 'Branching is unavailable in temporary chats.'
    : archived
      ? 'Restore this project to branch its chats.'
      : !controller.historyReady || !!controller.storageError
        ? 'Chat storage must be available to create a branch.'
        : generating || editingBusy || controller.importBusy
          ? 'Wait for the current chat operation to finish.'
          : '';
  const branchOrigin = chat.branchedFrom;
  const original =
    branchOrigin &&
    controller.conversations.find((value) => value.id === branchOrigin.conversationId);
  const branchDivider = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!branchOrigin) return;
    const divider = branchDivider.current;
    divider?.focus({ preventScroll: true });
    divider?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [chat.id, branchOrigin?.messageId]);
  const divider = branchOrigin ? (
    <aside className="branch-divider" aria-label="Branch origin" tabIndex={-1} ref={branchDivider}>
      <GitBranch size={15} aria-hidden="true" />
      <span role="status">
        {original ? `Branched from ‘${original.title}’` : 'Original chat deleted'}
      </span>
      {original && (
        <button
          type="button"
          className="text-button"
          disabled={generating || editingBusy || controller.importBusy}
          onClick={() => {
            controller.openChat(original, true);
            follow.current = false;
            requestAnimationFrame(() => {
              document.getElementById(`edit-${branchOrigin.messageId}`)?.focus();
            });
          }}
        >
          Open original
        </button>
      )}
    </aside>
  ) : null;
  const hasBranchPoint =
    branchOrigin && chat.messages.some((message) => message.id === branchOrigin.messageId);
  const attachmentCount = controller.attachments.rows.filter((row) => !!row.attachment).length;
  const context = controller.contextEstimate;
  const hasFiles = attachmentCount > 0 || !!project?.files.some((file) => file.included);
  const reviewFiles = hasFiles
    ? () => {
        if (!attachmentCount && project) {
          controller.openProject(project.id, true);
          return;
        }
        controller.changePreferences({ presenceExpanded: true });
        requestAnimationFrame(() => {
          const attachments = document.getElementById('chat-attachments');
          attachments?.focus({ preventScroll: true });
          attachments?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
      }
    : undefined;
  const hasDraft = !!input.trim();
  const recoveryActions = [];
  if (reviewFiles) recoveryActions.push({ label: 'Review files', run: reviewFiles });
  if (hasDraft)
    recoveryActions.push({
      label: 'Shorten draft',
      run: () => requestAnimationFrame(() => composerInput.current?.focus()),
    });
  if (
    reviewFiles &&
    context.replyShortfall &&
    context.usage &&
    approximateTokens(input.trim()) + context.replyTarget > context.usage.capacity
  ) {
    recoveryActions.reverse();
  }
  if (!controller.cloud.active)
    recoveryActions.push({
      label: controller.largerContextPending ? 'Review and restart' : 'Context settings',
      run: () => reviewSettings('model', 'context-size'),
    });
  const contextError = controller.contextError;
  const recoveryError = contextError?.kind === 'other' ? null : contextError;
  const needsContextRecovery = context.overflow || !!recoveryError;
  const contextBlocked = context.overflow || recoveryError?.kind === 'space';
  const showContextRecovery =
    !generating &&
    !controller.compactOnSend &&
    (needsContextRecovery ||
      (!contextError && !controller.summaryError && context.replyShortfall > 0));
  const contextRecoveryActions =
    hasDraft && controller.canCompactDraft && !controller.summaryError
      ? [{ label: 'Summarize and send', run: () => void controller.compact(chat, true) }]
      : recoveryActions;
  return (
    <>
      {project && (
        <nav className="project-crumb" aria-label="Breadcrumb">
          <button
            data-control-id="button-crumb-project"
            onClick={() => controller.openProject(project.id)}
          >
            <Folder size={14} />
            {project.name}
          </button>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{chat.title}</span>
        </nav>
      )}
      <div
        className="messages"
        ref={messageList}
        onScroll={(event) => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {chat.messages.length === 0 ? (
          <div className="welcome">
            <h1>{controller.temporary ? 'Temporary chat' : 'What’s on your mind?'}</h1>
            {controller.temporary ? (
              <p>
                {controller.cloud.active
                  ? `Not saved on this computer. Messages are still sent to ${controller.cloud.active.providerName}.`
                  : 'Not saved. Leaving erases this chat unless you save it.'}
              </p>
            ) : (
              <p>
                {controller.cloud.active
                  ? `Messages are sent to ${controller.cloud.active.providerName}.`
                  : 'Powered by a model on this computer.'}
              </p>
            )}
            <div className="suggestions">
              {[
                [
                  'Explore an idea',
                  'Help me explore an idea by asking me a few thoughtful questions.',
                ],
                [
                  'Make something clear',
                  'Help me understand a topic. Ask me what I would like to learn.',
                ],
                [
                  'Start writing',
                  'Help me get started on a piece of writing. Ask me about its purpose and audience.',
                ],
              ].map(([label, prompt]) => (
                <button
                  key={label}
                  onClick={() => {
                    setInput(prompt);
                    composerInput.current?.focus();
                  }}
                >
                  <span>{label}</span>
                  <ArrowUp size={15} />
                </button>
              ))}
            </div>
            {!active && !controller.modelReady && (
              <button
                className="welcome-load"
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setPanel('models');
                }}
              >
                <HardDrive size={15} />
                Choose a model to get started <span>→</span>
              </button>
            )}
          </div>
        ) : (
          <div className="message-column">
            {!hasBranchPoint && divider}
            {chat.messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === 'user' ? (
                    'Y'
                  ) : (
                    <img src={brandMark} width={22} height={22} alt="" />
                  )}
                </div>
                <div className="message-body">
                  <div className="message-heading">
                    {message.role === 'user' ? 'You' : 'Straggler'}
                    {message.role === 'assistant' && (
                      <span>
                        <span
                          className="response-destination"
                          role="img"
                          aria-label={
                            message.cloud
                              ? `Generated by ${message.cloud.name}`
                              : 'Generated on this computer'
                          }
                          title={
                            message.cloud
                              ? `Generated by ${message.cloud.name}`
                              : 'Generated on this computer'
                          }
                        >
                          {message.cloud ? (
                            <Cloud size={14} aria-hidden="true" />
                          ) : (
                            <HardDrive size={14} aria-hidden="true" />
                          )}
                        </span>
                        {message.model || chat.model
                          ? message.cloud
                            ? message.model || chat.model!
                            : fileName(message.model || chat.model!)
                          : 'Local model'}
                      </span>
                    )}
                  </div>
                  {message.role === 'assistant' && (
                    <WebSearchActivity
                      message={message}
                      search={controller.webSearch}
                      onSettings={() => reviewSettings('websearch', 'web-search-key')}
                    />
                  )}
                  {message.projectSources && (
                    <ProjectSearchActivity sources={message.projectSources} />
                  )}
                  {message.attachmentSources && (
                    <ProjectSearchActivity sources={message.attachmentSources} attachments />
                  )}
                  {message.reasoning && (
                    <details className="reasoning">
                      <summary>Reasoning</summary>
                      <Markdown>{message.reasoning}</Markdown>
                    </details>
                  )}
                  {editor?.messageId === message.id ? (
                    <div
                      className="message-editor"
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !editingBusy && !generating) {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditor(null);
                        }
                      }}
                    >
                      {message.role === 'user' ? (
                        <RichComposer
                          key={message.id}
                          id={`edit-${message.id}`}
                          label="Edit message"
                          describedBy={`edit-note-${message.id}`}
                          value={editor.text}
                          disabled={editingBusy || generating}
                          editing
                          toolbarVisible={toolbarVisible}
                          onChange={(text) => setEditor({ ...editor, text })}
                          onSubmit={() => {
                            if (!editingBusy && !generating) void saveEdit().catch(() => {});
                          }}
                        />
                      ) : (
                        <textarea
                          autoFocus
                          id={`edit-${message.id}`}
                          aria-label="Edit response"
                          aria-describedby={`edit-note-${message.id}`}
                          rows={10}
                          value={editor.text}
                          disabled={editingBusy || generating}
                          onChange={(event) => setEditor({ ...editor, text: event.target.value })}
                        />
                      )}
                      <div className="message-editor-footer">
                        {message.role === 'user' && (
                          <FormattingToggle
                            visible={toolbarVisible}
                            onChange={toggleFormatting}
                            disabled={!controller.preferencesReady}
                          />
                        )}
                        <p className="message-editor-note" id={`edit-note-${message.id}`}>
                          {message.role === 'user'
                            ? chat.messages.findIndex((value) => value.id === message.id) <
                              chat.messages.length - 2
                              ? 'Saving replaces the response below and removes later messages.'
                              : 'Saving replaces the response below with a new response.'
                            : chat.messages.at(-1)?.id !== message.id
                              ? 'Saving replaces this response and removes later messages. The model is not run again.'
                              : 'Your text replaces this response and is used as context for later messages. The model is not run again.'}
                        </p>
                        <div className="message-editor-actions">
                          <button
                            className="message-editor-cancel"
                            type="button"
                            disabled={editingBusy || generating}
                            onClick={() => setEditor(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            disabled={
                              editingBusy ||
                              generating ||
                              !editor.text.trim() ||
                              (message.role === 'user' && !controller.modelReady)
                            }
                            onClick={() => void saveEdit().catch(() => {})}
                          >
                            {message.role === 'user' ? 'Save and regenerate' : 'Save response'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="markdown">
                      <Markdown
                        user={message.role === 'user'}
                        sources={message.sources}
                        projectSources={message.projectSources}
                        attachmentSources={message.attachmentSources}
                        onProjectSource={onProjectSource}
                      >
                        {message.content}
                      </Markdown>
                    </div>
                  )}
                  {!!(
                    message.sources?.length ||
                    message.projectSources?.length ||
                    message.attachmentSources?.length
                  ) && (
                    <Sources
                      sources={message.sources}
                      projectSources={message.projectSources}
                      attachmentSources={message.attachmentSources}
                      onProjectSource={onProjectSource}
                    />
                  )}
                  {message.status === 'streaming' && (
                    <span className="typing-indicator">
                      {message.content ? 'Generating' : 'Thinking'}
                    </span>
                  )}
                  {messageStatusLabel[message.status] &&
                    !(message.error && (!server.issue || !!message.cloud)) && (
                      <div className="message-status">{messageStatusLabel[message.status]}</div>
                    )}
                  {message.error && (!server.issue || !!message.cloud) && (
                    <Feedback
                      title={
                        message.status === 'interrupted'
                          ? 'Response interrupted'
                          : 'Response failed'
                      }
                      details={message.error}
                      actions={
                        project && isContextRejection(message.error) ? (
                          <>
                            <button
                              className="text-button"
                              data-control-id="button-review-files"
                              onClick={() => controller.openProject(project.id, true)}
                            >
                              Review files
                            </button>
                            <button
                              className="text-button"
                              data-control-id="button-change-context-size"
                              onClick={() => reviewSettings('model', 'context-size')}
                            >
                              Change context size in Settings
                            </button>
                          </>
                        ) : (
                          <button className="text-button" onClick={() => reviewSettings('model')}>
                            Review settings
                          </button>
                        )
                      }
                    >
                      {message.content
                        ? 'The partial response is kept.'
                        : 'The server couldn’t complete this request. Check the details and try again.'}
                    </Feedback>
                  )}
                  {editor?.messageId !== message.id &&
                    (message.role === 'user' ||
                      (message.status !== 'streaming' && message.status !== 'error')) && (
                      <div className="message-actions" role="group" aria-label="Message actions">
                        <button
                          type="button"
                          className="message-action"
                          aria-label={message.role === 'user' ? 'Copy message' : 'Copy response'}
                          title={message.role === 'user' ? 'Copy message' : 'Copy response'}
                          onClick={async () => {
                            setCopyError(null);
                            try {
                              await navigator.clipboard.writeText(message.content);
                              setCopied(message.id);
                              setTimeout(() => setCopied(''), 1600);
                            } catch (e) {
                              setCopyError({
                                messageId: message.id,
                                detail: errorDetail(e).message,
                              });
                            }
                          }}
                        >
                          {copied === message.id ? <Check size={14} /> : <Copy size={14} />}
                        </button>
                        <button
                          type="button"
                          className="message-action"
                          id={`edit-${message.id}`}
                          aria-label={message.role === 'user' ? 'Edit message' : 'Edit response'}
                          title={message.role === 'user' ? 'Edit message' : 'Edit response'}
                          disabled={generating || editingBusy || archived}
                          onClick={() => beginEdit(message)}
                        >
                          <Pencil size={14} />
                        </button>
                        {message.role === 'assistant' && (
                          <span title={branchDisabledReason || undefined}>
                            <button
                              type="button"
                              className="message-action"
                              aria-label="Branch in new chat"
                              title={branchDisabledReason || 'Branch in new chat'}
                              disabled={!!branchDisabledReason}
                              onClick={() => void controller.branchChat(message.id)}
                            >
                              <GitBranch size={14} />
                            </button>
                          </span>
                        )}
                        {message.role === 'user' && (
                          <button
                            type="button"
                            className="message-action"
                            aria-label="Regenerate response"
                            title="Regenerate response"
                            disabled={
                              generating ||
                              editingBusy ||
                              !controller.modelReady ||
                              !!controller.storageError ||
                              archived
                            }
                            onClick={() => void regenerate(message.id).catch(() => {})}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                    )}
                  {controller.branchError?.chatId === chat.id &&
                    controller.branchError.messageId === message.id && (
                      <Feedback
                        title="Couldn’t create the branch"
                        details={controller.branchError.detail}
                      >
                        Try again.
                      </Feedback>
                    )}
                  {copyError?.messageId === message.id && (
                    <Feedback
                      title="Couldn’t copy the text"
                      details={copyError.detail}
                      onDismiss={() => setCopyError(null)}
                    >
                      Select the text and copy it manually.
                    </Feedback>
                  )}
                  {message.id === branchOrigin?.messageId && divider}
                  {message.id === chat.summary?.throughMessageId && (
                    <ChatSummary
                      key={chat.id + chat.summary.createdAt}
                      controller={controller}
                      detailsRef={summaryDetails}
                    />
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <StorageFeedback controller={controller} />
        {chat.projectId && !project && (
          <Feedback
            title="Project data is unavailable"
            actions={
              <button onClick={() => void controller.projects.load()}>
                Retry loading projects
              </button>
            }
          >
            Reload projects to continue this chat.
          </Feedback>
        )}
        {project &&
          (archived ? (
            <Feedback
              severity="warning"
              title="This project is archived"
              actions={
                <button
                  className="text-button"
                  data-control-id="button-restore-from-chat"
                  onClick={() =>
                    void controller.projects
                      .update(project.id, { archived: false })
                      .then((result) =>
                        controller.projects.setNotice({
                          message: `Restored “${project.name}”.`,
                          undoToken: result.undoToken,
                        }),
                      )
                      .catch(() => {})
                  }
                >
                  Restore project
                </button>
              }
            >
              You can read this chat. Restore the project to continue it.
            </Feedback>
          ) : projectContext?.search ? (
            <p className="project-search-status" role="status">
              Search mode · Project files
              <button
                type="button"
                className="text-button"
                onClick={() => controller.openProject(project.id, true)}
              >
                Review files
              </button>
            </p>
          ) : (
            projectContext && (
              <ProjectLimitFeedback
                chat
                context={projectContext}
                onReviewFiles={() => controller.openProject(project.id, true)}
                onChangeContext={() => reviewSettings('model', 'context-size')}
              />
            )
          ))}
        {controller.summaryError && (
          <Feedback
            title="Couldn’t summarize earlier messages"
            details={controller.summaryError.details}
            onDismiss={() => controller.setSummaryError(null)}
          >
            {controller.summaryError.message} Original messages are kept.
          </Feedback>
        )}
        {contextError?.kind === 'other' && (
          <Feedback title="Couldn’t send the message">{contextError.message}</Feedback>
        )}
        {!controller.attachments.visionSupported &&
          controller.attachments.rows.some((row) => row.attachment?.image) && (
            <Feedback
              severity="warning"
              title="This model can’t read images. It won’t be sent."
              actions={
                <>
                  <button onClick={() => controller.setPanel('models')}>Choose model</button>
                  <button
                    disabled={controller.attachments.disabled}
                    onClick={() => {
                      const row = controller.attachments.rows.find((row) => row.attachment?.image);
                      if (row) void controller.attachments.removeFile(row);
                    }}
                  >
                    Remove image
                  </button>
                </>
              }
            >
              <span>Choose a model that supports images, or remove the image.</span>
            </Feedback>
          )}
        {controller.cloud.notice && <CloudNotice controller={controller.cloud} />}
        <div className="compaction-status">
          <span role="status">
            {controller.summarizing ? (
              <>
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                {chat.summary ? 'Summarizing more messages…' : 'Summarizing earlier messages…'}
              </>
            ) : showSummaryResult ? (
              compactionResultLabel(compaction.result, compaction.applied)
            ) : null}
          </span>
          {showSummaryResult && chat.summary && (
            <button type="button" className="text-button" onClick={viewSummary}>
              View summary
            </button>
          )}
        </div>
        {showContextRecovery && contextBlocked && (
          <div className="context-recovery" role="alert">
            <p>
              <strong>This message needs more room.</strong>{' '}
              {recoveryError?.message ??
                (context.usage?.remaining === 0
                  ? 'The prompt fills the entire context window. Free space for a reply.'
                  : `The prompt and attachments exceed the ${context.capacity?.toLocaleString('en-US')}-token context.`)}
            </p>
            {contextRecoveryActions.map(({ label, run }) => (
              <button key={label} type="button" className="text-button" onClick={run}>
                {label}
              </button>
            ))}
          </div>
        )}
        <form
          ref={composerRef}
          className={`composer${controller.attachments.dragged.length > 0 ? ' is-dragover' : ''}`}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) {
              setPreviousCompaction(compaction);
              const pending = send();
              sendPromise.current = pending;
              void pending;
            }
          }}
        >
          {controller.attachments.dragged.length > 0 && (
            <div className="composer-drop-overlay" aria-hidden="true">
              <Paperclip size={24} />
              <span>Drop to attach</span>
            </div>
          )}
          <RichComposer
            key={chat.id}
            focusRef={composerInput}
            label="Message"
            controlId="textarea-message"
            placeholder={
              controller.cloud.active
                ? `Message ${controller.cloud.active.model.name}…`
                : controller.modelReady
                  ? 'Message your local model…'
                  : server.issue
                    ? 'Review settings and restart the server to continue…'
                    : 'Load a model to start chatting…'
            }
            value={input}
            disabled={archived || !controller.modelReady}
            toolbarVisible={toolbarVisible}
            onChange={setInput}
            onContextChange={setComposerMode}
            onSubmit={() => composerRef.current?.requestSubmit()}
          />
          <div className="composer-footer">
            <div className="composer-tools" role="group" aria-label="Message options">
              <FormattingToggle
                visible={toolbarVisible}
                onChange={toggleFormatting}
                disabled={!controller.preferencesReady}
              />
              <button
                type="button"
                className={`composer-chip attach-chip${attachmentCount ? ' has-attachments' : ''}`}
                aria-label={
                  attachmentCount ? `Attach files, ${attachmentCount} attached` : 'Attach files'
                }
                title={attachmentTypesLabel}
                disabled={controller.attachments.disabled}
                onClick={() => void controller.attachments.chooseFiles()}
              >
                <Paperclip size={15} />
                <span>Attach{attachmentCount ? ` · ${attachmentCount}` : ''}</span>
              </button>
              <SystemPromptMenu controller={controller} />
              <ReasoningMenu controller={controller} />
              <WebSearchMenu controller={controller} />
            </div>
            <div className="composer-send">
              <span className="keyboard-hint">{composerHint(composerMode)}</span>
              <ContextCounter
                controller={controller}
                onViewSummary={viewSummary}
                blocked={contextBlocked}
                recoveryActions={showContextRecovery ? contextRecoveryActions : []}
                recoveryMessage={showContextRecovery ? recoveryError?.message : undefined}
              />
              {generating ? (
                <button
                  type="button"
                  className="send-button stop"
                  aria-label={controller.summarizing ? 'Stop summarizing' : 'Stop response'}
                  onClick={(event) => {
                    // Stop can become Send before this click's default action runs.
                    event.preventDefault();
                    void cancel().catch((e) => setError(String(e)));
                  }}
                >
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="Send message"
                  data-control-id="button-send-message"
                  disabled={!canSend || !input.trim()}
                >
                  <ArrowUp size={19} />
                </button>
              )}
            </div>
          </div>
        </form>
        <p className="composer-note">
          {controller.cloud.active
            ? `Sent to ${controller.cloud.active.providerName} · ${controller.temporary ? 'Not saved on this computer · Models can make mistakes.' : 'Models can make mistakes. Check important information.'}`
            : 'Models can make mistakes. Check important information.'}
        </p>
      </div>
    </>
  );
}

function ProjectSearchActivity({
  sources,
  attachments = false,
}: {
  sources: ProjectPassage[];
  attachments?: boolean;
}) {
  const files = new Set(sources.map((source) => source.fileId)).size;
  const label = attachments ? 'Searched attachments' : 'Searched project files';
  return (
    <p className="web-search-activity reasoning" role="status">
      {sources.length
        ? `${label} · ${sources.length} ${sources.length === 1 ? 'passage' : 'passages'} from ${files} ${files === 1 ? 'file' : 'files'}`
        : `${label} · No passages fit or matched this message.`}
    </p>
  );
}
