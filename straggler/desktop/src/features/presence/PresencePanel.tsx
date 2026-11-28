import Sources from '../websearch/Sources';
import type { WebSource } from '../../domain/webSearch';
import AttachmentSection from '../attachments/AttachmentSection';
import type { AttachmentController } from '../attachments/useAttachments';
import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import AssistantPresence from './AssistantPresence';
import type { PresenceState } from '../../domain/presence';
import type { GenerationMetrics, ProjectPassage, UiPreferences } from '../../domain/types';

export default function PresencePanel({
  state,
  sources = [],
  projectSources,
  attachmentSources,
  onProjectSource,
  metrics,
  preferences,
  onPreferences,
  ready,
  attachments,
  cloudProvider,
  cloudModel = false,
}: {
  state: PresenceState;
  cloudProvider?: string;
  cloudModel?: boolean;
  sources?: WebSource[];
  projectSources?: ProjectPassage[];
  attachmentSources?: ProjectPassage[];
  onProjectSource: (source: ProjectPassage) => void;
  metrics?: GenerationMetrics;
  preferences: UiPreferences;
  onPreferences: (patch: Partial<UiPreferences>) => void;
  ready: boolean;
  attachments: AttachmentController;
}) {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 1100px)').matches);
  const expanded = preferences.presenceExpanded ?? !narrow;
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const query = matchMedia('(max-width: 1100px)');
    const update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    if (!expanded || !narrow) {
      const previous = returnFocus.current;
      returnFocus.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      return;
    }
    const trigger = button.current;
    const chat = panel.current?.closest('.chat-body')?.querySelector<HTMLElement>('.chat-main');
    const wasInert = chat?.inert ?? false;
    returnFocus.current ??=
      document.activeElement instanceof HTMLElement ? document.activeElement : trigger;
    if (chat) chat.inert = true;
    trigger?.focus({ preventScroll: true });
    function closeKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onPreferences({ presenceExpanded: false });
    }
    function outside(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node)) {
        event.preventDefault();
        onPreferences({ presenceExpanded: false });
      }
    }
    document.addEventListener('keydown', closeKey);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', closeKey);
      document.removeEventListener('pointerdown', outside);
      if (chat) chat.inert = wasInert;
    };
  }, [expanded, narrow, onPreferences]);
  return (
    <div className={`presence-slot ${expanded ? 'is-expanded' : ''} ${narrow ? 'is-narrow' : ''}`}>
      <aside
        ref={panel}
        className={`presence ${expanded ? 'is-expanded' : 'is-compact'}`}
        aria-label="Assistant"
      >
        <button
          ref={button}
          className="presence-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={expanded ? 'Collapse assistant panel' : 'Expand assistant panel'}
          title={expanded ? 'Collapse assistant panel' : 'Expand assistant panel'}
          disabled={!ready}
          onPointerDown={() => {
            if (narrow && !expanded && document.activeElement instanceof HTMLElement)
              returnFocus.current = document.activeElement;
          }}
          onClick={() => onPreferences({ presenceExpanded: !expanded })}
        >
          {expanded ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
        </button>
        <div id={id}>
          <AssistantPresence
            cloud={cloudModel}
            state={state}
            metrics={metrics}
            provider={cloudProvider}
            size={expanded ? 224 : 48}
          />
          <Sources
            sources={sources}
            projectSources={projectSources}
            attachmentSources={attachmentSources}
            onProjectSource={onProjectSource}
            compact
          />
          <AttachmentSection controller={attachments} />
        </div>
      </aside>
    </div>
  );
}
