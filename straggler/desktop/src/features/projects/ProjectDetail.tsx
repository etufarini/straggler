import RichComposer, { FormattingToggle, composerHint } from '../chat/composer/RichComposer';
import type { ComposerContext } from '../chat/composer/commands';
import useComposerDensity from '../chat/useComposerDensity';
import Select from '../../components/Select';
import { searchText } from '../../domain/chatSearch';
import { countLabel } from '../../domain/text';
import usePagePrimaryAction from '../../app/usePagePrimaryAction';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Star,
  Trash2,
  FileUp,
  RotateCcw,
  Pencil,
  Search,
  RefreshCw,
} from 'lucide-react';
import type { WorkspaceController } from '../../app/useWorkspace';
import type { Project } from '../../domain/projects';
import { documentTypesLabel } from '../../domain/attachments';
import { ProjectCapacity, ProjectLimitFeedback } from './ProjectCapacity';
import Feedback from '../../components/Feedback';
import AttachmentRow from '../attachments/AttachmentRow';
import ConversationMenu from '../../app/ConversationMenu';
import ProjectMenu from './ProjectMenu';
import { projectActions, relativeTime } from './ProjectsPage';
import { controlSlug } from '../../components/ActionMenu';
import { watchAttachmentDrop } from '../../services/desktop';

export default function ProjectDetail({
  controller,
  project,
  onPrimaryActionChange,
}: {
  controller: WorkspaceController;
  project: Project;
  onPrimaryActionChange: (active: boolean) => void;
}) {
  const { projects } = controller;
  const [chatQuery, setChatQuery] = useState('');
  const [chatSort, setChatSort] = useState('recent');
  const composerRef = useComposerDensity();
  const [composerMode, setComposerMode] = useState<ComposerContext>('text');
  const toolbarVisible = controller.preferences.formattingToolbarVisible !== false;
  const draft = controller.projectDrafts[project.id] ?? '';
  const setDraft = (text: string) =>
    controller.setProjectDrafts((values) => ({ ...values, [project.id]: text }));
  const filesHeading = useRef<HTMLHeadingElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const context = projects.context(project);
  const chats = controller.conversations
    .filter(
      (chat) =>
        chat.projectId === project.id &&
        searchText(chat.title).includes(searchText(chatQuery.trim())),
    )
    .sort(
      chatSort === 'name'
        ? (a, b) => a.title.localeCompare(b.title)
        : (a, b) => b.updatedAt - a.updatedAt,
    );
  const actions = projectActions(controller, project);
  const generatingHere = controller.generating && controller.chat.projectId === project.id;
  const included = project.files.filter((file) => file.included).length;
  const pendingFiles = projects.pendingFiles[project.id] ?? [];
  useEffect(() => {
    if (controller.reviewFiles) {
      filesHeading.current?.focus();
      filesHeading.current?.scrollIntoView({ block: 'start' });
      controller.setReviewFiles(false);
    } else pageHeading.current?.focus();
  }, [project.id, controller.reviewFiles, controller.setReviewFiles]);
  const onDrop = useRef((paths: string[]) => {
    void projects.addFiles(project.id, paths).catch(() => {});
  });
  onDrop.current = (paths) => {
    if (!project.archived) void projects.addFiles(project.id, paths).catch(() => {});
  };
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void watchAttachmentDrop((event) => {
      if (event.type === 'drop') onDrop.current(event.paths);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch((error) => projects.setError(String(error)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [projects.setError]);
  const canStartChat =
    !!draft.trim() &&
    !project.archived &&
    (context.level !== 'over' || context.search) &&
    !controller.generating &&
    controller.modelReady &&
    controller.historyReady &&
    !controller.storageError &&
    !projects.error;
  usePagePrimaryAction(canStartChat, onPrimaryActionChange);
  function reviewFiles() {
    filesHeading.current?.focus();
    filesHeading.current?.scrollIntoView({ block: 'start' });
  }
  return (
    <section className="settings-page project-page project-detail" aria-labelledby="project-title">
      <button
        className="text-button"
        data-control-id="button-back-to-projects"
        onClick={controller.openProjects}
      >
        <ArrowLeft size={15} />
        All projects
      </button>
      <div className="project-detail-head">
        <div>
          <h1 id="project-title" ref={pageHeading} tabIndex={-1}>
            {project.name}
          </h1>
          <p>{project.description || 'No description.'}</p>
        </div>
        <div className="project-head-actions">
          {project.archived ? (
            <button data-control-id="button-restore-project" onClick={actions.onRestore}>
              <RotateCcw size={15} />
              Restore project
            </button>
          ) : (
            <button
              className="project-icon-button project-star"
              data-control-id="button-star-current-project"
              aria-label={`Star ${project.name}`}
              aria-pressed={project.starred}
              onClick={actions.onStar}
            >
              <Star size={18} />
            </button>
          )}
          <ProjectMenu {...actions} controlId="button-options-for-current-project" />
        </div>
      </div>
      {project.archived && (
        <Feedback severity="warning" title="This project is archived">
          Its chats stay readable. Restore it to start chats or change its instructions and files.
        </Feedback>
      )}
      <div className="project-detail-layout">
        <div className="project-detail-main">
          {!project.archived && !context.search && (
            <ProjectLimitFeedback
              context={context}
              onReviewFiles={reviewFiles}
              onChangeContext={() => controller.reviewSettings('model', 'context-size')}
            />
          )}
          <form
            className="composer project-start"
            ref={composerRef}
            onSubmit={(event) => {
              event.preventDefault();
              if (canStartChat) controller.startProjectChat(project.id, draft);
            }}
          >
            <RichComposer
              key={project.id}
              label="Message"
              placeholder={
                project.archived
                  ? 'Restore the project to start a chat'
                  : `Start a chat in ${project.name}…`
              }
              controlId="textarea-start-chat"
              value={draft}
              disabled={project.archived || !controller.modelReady}
              toolbarVisible={toolbarVisible}
              onChange={setDraft}
              onContextChange={setComposerMode}
              onSubmit={() => composerRef.current?.requestSubmit()}
            />
            <div className="composer-footer">
              <div className="composer-tools">
                <FormattingToggle
                  visible={toolbarVisible}
                  disabled={!controller.preferencesReady}
                  onChange={(visible) =>
                    controller.changePreferences({ formattingToolbarVisible: visible })
                  }
                />
                <span className="project-start-note">
                  {project.instructions.trim()
                    ? 'Uses the project instructions'
                    : 'No instructions yet · uses the system prompt from Settings'}
                  {context.search ? ' and searches ' : ' and '}
                  {included} of {countLabel(project.files.length, 'file')}
                </span>
              </div>
              <div className="composer-send">
                <span className="keyboard-hint">{composerHint(composerMode)}</span>
                <button
                  className="send-button"
                  type="submit"
                  data-control-id="button-start-chat"
                  disabled={!canStartChat}
                >
                  <ArrowUp size={15} />
                  Start chat
                </button>
              </div>
            </div>
          </form>
          {controller.generating && <p className="field-help">Available when the response ends.</p>}
          {!controller.modelReady && <p className="field-help">Load a model to start chatting.</p>}
          <div className="project-section-head">
            <h2 id="project-chats-title">Chats</h2>
            <span className="project-meta">{countLabel(chats.length, 'chat')}</span>
          </div>
          <div className="project-toolbar">
            <label className="project-search">
              <Search size={15} />
              <input
                type="search"
                aria-label="Search project chats"
                placeholder="Search chats"
                value={chatQuery}
                onChange={(event) => setChatQuery(event.target.value)}
              />
            </label>
            <label className="project-sort">
              <span>Sort</span>
              <Select
                aria-label="Sort chats"
                value={chatSort}
                onChange={setChatSort}
                options={[
                  { value: 'recent', label: 'Recent' },
                  { value: 'name', label: 'Name' },
                ]}
              />
            </label>
          </div>
          {chats.length ? (
            <ul className="project-chat-list" aria-labelledby="project-chats-title">
              {chats.map((chat) => (
                <li key={chat.id}>
                  <button
                    data-control-id={`button-open-${controlSlug(chat.title)}`}
                    disabled={
                      (controller.generating || !!controller.storageError) &&
                      chat.id !== controller.chat.id
                    }
                    onClick={() => controller.openChat(chat)}
                  >
                    <span>{chat.title}</span>
                    <small>{relativeTime(chat.updatedAt)}</small>
                  </button>
                  <ConversationMenu
                    conversation={chat}
                    onCompact={() => void controller.compact(chat)}
                    compactReason={controller.compactReason(chat)}
                    metadataBusyReason={
                      controller.generating || controller.editingBusy
                        ? 'Available when the response ends.'
                        : undefined
                    }
                    onStar={() =>
                      void controller
                        .updateChatMetadata(chat, { starred: !chat.starred })
                        .catch(() => {})
                    }
                    onRename={() => controller.renameChat(chat.id)}
                    controlId={`button-options-in-project-${controlSlug(chat.title)}`}
                    readOnly={project.archived}
                    actionBusyReason={
                      controller.generating && controller.chat.id === chat.id
                        ? 'Available when the response ends.'
                        : undefined
                    }
                    onMove={() =>
                      controller.setProjectDialog({ kind: 'move', conversationId: chat.id })
                    }
                    onRemove={() => void controller.moveChat(chat, null).catch(() => {})}
                    onDelete={() => controller.requestDeleteChat(chat)}
                    onExport={(reasoning) => void controller.exportChat(chat, reasoning)}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="project-no-results">
              {chatQuery.trim()
                ? `No chats match ‘${chatQuery}’`
                : 'No chats yet. Start one above or move one here from its menu.'}
            </p>
          )}
        </div>
        <div className="project-side">
          <section className="project-side-section" aria-labelledby="project-instructions-title">
            <div className="project-section-head">
              <h2 id="project-instructions-title">Instructions</h2>
              {!project.archived && (
                <button
                  className="text-button"
                  data-control-id="button-edit-instructions"
                  onClick={() =>
                    controller.setProjectDialog({ kind: 'instructions', id: project.id })
                  }
                >
                  <Pencil size={13} />
                  {project.instructions.trim() ? 'Edit' : 'Add'}
                </button>
              )}
            </div>
            <p
              className={`project-instructions-preview${project.instructions.trim() ? '' : ' is-empty'}`}
            >
              {project.instructions.trim()
                ? project.instructions
                : 'No instructions. Chats in this project use the system prompt from Settings.'}
            </p>
            <p className="field-help">
              {project.instructions.trim()
                ? 'The system prompt for every chat in this project.'
                : 'Instructions you add become the system prompt for every chat in this project.'}
            </p>
            {generatingHere && <p className="field-help">Changes apply from the next message.</p>}
          </section>
          <section className="project-side-section" aria-labelledby="project-files-title">
            <div className="project-section-head">
              <h2 id="project-files-title" ref={filesHeading} tabIndex={-1}>
                Files
              </h2>
              {!project.archived && (
                <button
                  className="text-button"
                  data-control-id="button-add-project-files"
                  onClick={() => void projects.addFiles(project.id).catch(() => {})}
                >
                  <FileUp size={13} />
                  Add
                </button>
              )}
            </div>
            <ProjectCapacity context={context} serverRunning={controller.modelReady} />
            {context.search && !project.archived && (
              <ProjectLimitFeedback
                context={context}
                onReviewFiles={reviewFiles}
                onChangeContext={() => controller.reviewSettings('model', 'context-size')}
              />
            )}
            {context.level === 'high' && !project.archived && (
              <Feedback severity="warning" title="Close to the limit">
                Long chats in this project will run out of room sooner. Exclude files you do not
                need right now.
              </Feedback>
            )}
            {generatingHere && <p className="field-help">Changes apply from the next message.</p>}
            {project.files.length || pendingFiles.length ? (
              <ul className="file-list" aria-label="Project files">
                {project.files.map((file) => (
                  <AttachmentRow
                    key={file.id}
                    row={{ ...file, state: 'ready', attachment: file }}
                    project
                    projectSearch={context.search}
                    estimate={projects.estimate(file.text)}
                    excluded={!file.included}
                  >
                    <button
                      type="button"
                      className="toggle-switch"
                      role="switch"
                      aria-checked={file.included}
                      aria-label={`Include ${file.name} in ${context.search ? 'project search' : 'context'}`}
                      data-control-id={`switch-include-${controlSlug(file.name)}`}
                      disabled={project.archived}
                      onClick={() =>
                        void projects
                          .update(project.id, (current) => ({
                            ...current,
                            files: current.files.map((value) =>
                              value.id === file.id
                                ? { ...value, included: !value.included }
                                : value,
                            ),
                          }))
                          .catch(() => {})
                      }
                    />
                    <button
                      className="project-icon-button"
                      aria-label={`Replace ${file.name}…`}
                      title="Replace file…"
                      disabled={project.archived || projects.busy}
                      onClick={() => void projects.replaceFile(project.id, file.id).catch(() => {})}
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      className="project-icon-button"
                      aria-label={`Remove ${file.name} from the project`}
                      data-control-id={`button-remove-file-${controlSlug(file.name)}`}
                      disabled={project.archived}
                      onClick={() =>
                        void projects
                          .removeFile(project.id, file.id)
                          .then((result) =>
                            projects.setNotice({
                              message: `Removed ${file.name} from ${project.name}.`,
                              undoToken: result.undoToken,
                            }),
                          )
                          .catch(() => {})
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </AttachmentRow>
                ))}
                {pendingFiles.map((row) => (
                  <AttachmentRow key={row.id} row={row} project>
                    <button
                      className="project-icon-button"
                      aria-label={`Remove ${row.name} from the project`}
                      disabled={row.state === 'reading'}
                      onClick={() => projects.removePendingFile(project.id, row.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </AttachmentRow>
                ))}
              </ul>
            ) : (
              <p className="field-help">
                No files yet. Their text is added to every chat in this project.
              </p>
            )}
            {!project.archived && (
              <button
                className="dropzone is-compact"
                data-control-id="button-choose-project-files"
                aria-describedby="project-file-types"
                onClick={() => void projects.addFiles(project.id).catch(() => {})}
              >
                <span className="dropzone-icon">
                  <FileUp size={15} />
                </span>
                <span className="dropzone-text">
                  <strong>Add files</strong>
                  <small className="dropzone-types" id="project-file-types">
                    {documentTypesLabel}
                  </small>
                </span>
              </button>
            )}
            {projects.busy && (
              <p role="status" className="field-help">
                Saving project…
              </p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
