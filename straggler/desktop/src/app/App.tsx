import { useLayoutEffect, useState } from 'react';
import PresencePanel from '../features/presence/PresencePanel';
import { assistantState } from '../domain/presence';
import { HardDrive, ChevronDown, Square, Terminal, Eclipse, Cloud } from 'lucide-react';
import { fileName, equalSettings, sameServerConfiguration } from '../domain/types';
import { statusLabel } from '../components/statusLabels';
import { isFixture } from '../services/desktop';
import SettingsPage from '../features/settings/Settings';
import Sidebar from './Sidebar';
import ConfirmationDialog from './ConfirmationDialog';
import ChatPanel from '../features/chat/ChatPanel';
import ServerPanel from '../features/server/ServerPanel';
import ServerFeedback from '../features/server/ServerFeedback';
import StorageFeedback from '../features/chat/StorageFeedback';
import Feedback from '../components/Feedback';
import { useWorkspace } from './useWorkspace';
import ProjectsPage from '../features/projects/ProjectsPage';
import ProjectDetail from '../features/projects/ProjectDetail';
import ProjectDialogs from '../features/projects/ProjectDialogs';
import ProjectSourceDialog from '../features/projects/ProjectSourceDialog';
import type { ProjectPassage } from '../domain/types';
import useTopbarDensity from './useTopbarDensity';
export default function App() {
  const controller = useWorkspace();
  const topbar = useTopbarDensity();
  const [projectSource, setProjectSource] = useState<ProjectPassage | null>(null);
  const [pageHasPrimaryAction, setPageHasPrimaryAction] = useState(false);
  const {
    setPanel,
    displayModel,
    server,
    active,
    busy,
    setConfirmation,
    native,
    selected,
    config,
    start,
    error,
    setError,
    storageError,
    draft,
    panel,
    setDraft,
    acceptConfiguration,
    confirmation,
    requestStop,
    settingsSection,
    setSettingsSection,
    settingsFailure,
    setSettingsFailure,
    reportSettingsError,
  } = controller;
  const area =
    panel === 'settings' && config && draft
      ? 'settings'
      : controller.view !== 'chat'
        ? 'project'
        : controller.temporary
          ? 'temporary'
          : 'chat';
  const cloudPalette = !!controller.cloud.active && area !== 'settings';
  useLayoutEffect(() => {
    document.body.dataset.area = area;
    if (cloudPalette) document.body.dataset.model = 'cloud';
    else delete document.body.dataset.model;
    return () => {
      delete document.body.dataset.area;
      delete document.body.dataset.model;
    };
  }, [area, cloudPalette]);
  const restartRequired = !!(
    active &&
    draft &&
    server.runningSettings &&
    !sameServerConfiguration(draft, server.runningSettings)
  );
  const lastResponse = controller.chat.messages
    .filter((message) => message.role === 'assistant')
    .at(-1);
  const cloudActive = controller.cloud.active;
  const cloudIdentity = cloudActive
    ? `${cloudActive.selection.providerId}:${cloudActive.selection.modelId}`
    : undefined;
  const presence = assistantState({
    serverPhase: cloudActive ? 'ready' : server.phase,
    generating: controller.generating,
    generationPhase: controller.generationPhase,
    serverRunId: cloudIdentity ?? server.runId,
    responseRunId:
      lastResponse?.cloud &&
      cloudActive &&
      lastResponse.cloud.providerId === cloudActive.selection.providerId &&
      lastResponse.model === cloudActive.selection.modelId
        ? cloudIdentity
        : lastResponse?.serverRunId,
    responseStatus: lastResponse?.status,
  });
  const modified = !!(
    draft &&
    config?.savedSettings &&
    !equalSettings(draft, config.savedSettings)
  );
  const modelName =
    cloudActive?.model.name ?? (displayModel ? fileName(displayModel) : 'Choose a local model');
  const workspaceFeedback = (
    <>
      {!cloudActive && <ServerFeedback controller={controller} />}
      {controller.preferenceError && (
        <div className="workspace-feedback">
          <Feedback title="Couldn’t save preferences" details={controller.preferenceError}>
            Changes last until you close the app.
          </Feedback>
        </div>
      )}

      {error && (
        <div className="workspace-feedback">
          <Feedback
            title="Couldn’t complete the action"
            details={error}
            onDismiss={() => setError('')}
          >
            Check the details and try again.
          </Feedback>
        </div>
      )}
      {controller.projects.error && (
        <div className="workspace-feedback">
          <Feedback
            title="Couldn’t load or save project data"
            details={controller.projects.error}
            actions={
              <button className="text-button" onClick={() => void controller.projects.load()}>
                Retry loading projects
              </button>
            }
          >
            Project changes remain available for review. Retry the action or reload the saved
            projects.
          </Feedback>
        </div>
      )}
    </>
  );
  return (
    <div className="app-shell">
      <Sidebar controller={controller} />
      <span role="status" className="visually-hidden">
        {controller.attachments.announcement}
      </span>

      <main
        className={`workspace${area === 'temporary' ? ' is-temporary' : ''} ${error || controller.preferenceError || storageError || server.issue || server.error || settingsFailure || lastResponse?.error ? 'has-feedback' : ''}`}
      >
        <header ref={topbar} className={`topbar${pageHasPrimaryAction ? ' has-page-primary' : ''}`}>
          <button
            className="model-switch"
            aria-label={`Choose model · ${modelName}`}
            title={modelName}
            aria-expanded={panel === 'models'}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setPanel('models');
            }}
          >
            <span className="model-icon">
              {cloudActive ? <Cloud size={17} /> : <HardDrive size={17} />}
            </span>
            <span className="model-label">
              <span className="model-name">{modelName}</span>
              <small
                title={
                  cloudActive
                    ? 'Cloud model'
                    : `On this computer · ${config?.currentProfile || 'Custom settings'}${modified ? ' · Modified' : ''}`
                }
              >
                {cloudActive
                  ? 'Cloud model'
                  : `On this computer · ${config?.currentProfile || 'Custom settings'}${modified ? ' · Modified' : ''}`}
              </small>
            </span>
            {controller.visionSupported ? (
              <span className="vision-badge">Vision</span>
            ) : !cloudActive &&
              config?.models.find((model) => model.path === controller.draft?.model)?.projector ? (
              <span className="vision-badge">Vision · restart to enable</span>
            ) : null}
            <ChevronDown size={15} />
          </button>
          <div className="header-controls">
            {controller.view === 'chat' &&
              panel !== 'settings' &&
              (controller.temporary ? (
                <>
                  <button
                    className="temp-status"
                    aria-label="Temporary"
                    aria-pressed="true"
                    aria-disabled="true"
                    title="Temporary · not saved (Ctrl/⌘ + Shift + N)"
                  >
                    <Eclipse aria-hidden="true" />
                    <span className="temporary-label">Temporary · not saved</span>
                  </button>
                  <button
                    disabled={busy || controller.chatOptionsDisabled}
                    onClick={() => void controller.saveTemporary()}
                  >
                    Save chat
                  </button>
                </>
              ) : !controller.chat.messages.length &&
                !controller.chat.attachments?.length &&
                !controller.chat.projectId ? (
                <button
                  className="temp-toggle"
                  title="Open temporary chat (Ctrl/⌘ + Shift + N)"
                  aria-label="Temporary"
                  aria-pressed="false"
                  disabled={!native || busy || controller.chatOptionsDisabled}
                  onClick={() => void controller.beginTemporary()}
                >
                  <Eclipse aria-hidden="true" />
                  <span className="temporary-label">Temporary</span>
                </button>
              ) : null)}
            {cloudActive ? (
              <span className="local-badge cloud-badge">
                <Cloud size={14} />
                Cloud · {cloudActive.providerName}
              </span>
            ) : (
              <>
                <button
                  className="local-badge"
                  aria-label={
                    config?.portStatus.includes('IN USE') && !active
                      ? `Port ${config.port} is in use · Review server settings`
                      : `Server log · ${statusLabel[server.phase]}${restartRequired ? ' · Restart required' : ''}`
                  }
                  aria-expanded={panel === 'logs'}
                  onClick={() => {
                    if (config?.portStatus.includes('IN USE') && !active)
                      controller.reviewSettings('server');
                    else setPanel('logs');
                  }}
                >
                  <span className={`status-dot ${server.phase}`} />
                  {statusLabel[server.phase]}
                  {restartRequired && server.phase !== 'needs-restart' && (
                    <span className="restart-label">Restart required</span>
                  )}
                  <Terminal size={14} />
                </button>
                {active ? (
                  <button disabled={busy || server.phase === 'stopping'} onClick={requestStop}>
                    <Square size={14} />
                    Stop server
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    disabled={!native || !selected || busy || !config?.serverAvailable}
                    onClick={(event) => {
                      event.currentTarget.focus({ preventScroll: true });
                      void start();
                    }}
                  >
                    Launch server
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        {isFixture() && (
          <div className="notice">
            Development scenario · simulated services and responses · no inference
          </div>
        )}
        {!native && (
          <div className="notice">
            This is the interface preview. Open the Straggler desktop app to use local models.
          </div>
        )}
        {(panel === 'settings' || controller.view !== 'chat') && workspaceFeedback}

        {(storageError ||
          controller.fileError ||
          controller.fileNotice ||
          controller.importError) &&
          (panel === 'settings' || controller.view !== 'chat') && (
            <div className="workspace-feedback">
              <StorageFeedback controller={controller} />
            </div>
          )}

        {panel === 'settings' && config && draft ? (
          <SettingsPage
            onPrimaryActionChange={setPageHasPrimaryAction}
            webSearch={controller.webSearch}
            cloud={controller.cloud}
            serverDetails={controller.localServerDetails}
            config={config}
            draft={draft}
            setDraft={setDraft}
            server={server}
            accept={acceptConfiguration}
            acceptChatDefaults={controller.acceptChatDefaults}
            confirm={setConfirmation}
            onError={reportSettingsError}
            onClearError={() => setSettingsFailure(null)}
            failure={settingsFailure}
            section={settingsSection}
            target={controller.settingsTarget}
            setSection={setSettingsSection}
            onBack={() => setPanel(null)}
          />
        ) : controller.view === 'projects' ? (
          <ProjectsPage controller={controller} onPrimaryActionChange={setPageHasPrimaryAction} />
        ) : controller.view === 'project' ? (
          (() => {
            const project = controller.projects.projects.find(
              (value) => value.id === controller.projectId,
            );
            return project ? (
              <ProjectDetail
                key={project.id}
                controller={controller}
                project={project}
                onPrimaryActionChange={setPageHasPrimaryAction}
              />
            ) : (
              <div className="workspace-feedback">
                <Feedback
                  title="Project unavailable"
                  actions={<button onClick={controller.openProjects}>All projects</button>}
                >
                  Reload projects to continue.
                </Feedback>
              </div>
            );
          })()
        ) : (
          <div className="chat-body">
            <div className="chat-main">
              {workspaceFeedback}
              <ChatPanel controller={controller} onProjectSource={setProjectSource} />
            </div>
            <PresencePanel
              sources={lastResponse?.sources}
              projectSources={lastResponse?.projectSources}
              attachmentSources={lastResponse?.attachmentSources}
              onProjectSource={setProjectSource}
              attachments={controller.attachments}
              state={presence}
              caption={controller.summarizing ? 'Summarizing earlier messages…' : undefined}
              cloudModel={!!controller.cloud.active}
              cloudProvider={lastResponse?.cloud?.name}
              metrics={lastResponse?.metrics}
              preferences={controller.preferences}
              onPreferences={controller.changePreferences}
              ready={controller.preferencesReady}
            />
          </div>
        )}
      </main>

      {panel && panel !== 'settings' && <ServerPanel controller={controller} />}

      <ProjectDialogs controller={controller} />
      {projectSource && (
        <ProjectSourceDialog
          source={projectSource}
          attachmentText={
            controller.chat.attachments?.find((file) => file.id === projectSource.fileId)?.text
          }
          onClose={() => setProjectSource(null)}
        />
      )}

      {controller.projects.notice && (
        <div className="project-toast" role="status">
          <span>{controller.projects.notice.message}</span>
          {controller.projects.notice.undoToken && (
            <button
              data-control-id="button-undo"
              onClick={() =>
                void controller
                  .undoProjectAction(controller.projects.notice!.undoToken!)
                  .catch(() => {})
              }
            >
              Undo
            </button>
          )}
          <button
            data-control-id="button-dismiss-message"
            aria-label="Dismiss message"
            onClick={() => controller.projects.setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {confirmation && <ConfirmationDialog controller={controller} />}
    </div>
  );
}
