import { useRef, useState } from 'react';
import type { Ref } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { WorkspaceController } from '../../app/useWorkspace';
import ActionMenu from '../../components/ActionMenu';
import Feedback from '../../components/Feedback';
import Markdown from './Markdown';
import { errorDetail } from '../../domain/errors';
import { summaryTextError } from '../../domain/compaction';

export default function ChatSummary({
  controller,
  detailsRef,
}: {
  controller: WorkspaceController;
  detailsRef: Ref<HTMLDetailsElement>;
}) {
  const section = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const summary = controller.chat.summary;
  if (!summary) return null;
  const editing = controller.editingSummary;
  const text = editing ? controller.editor!.text : summary.text;
  const busy = controller.generating || controller.editingBusy;
  const readOnly = !!controller.currentProject?.archived;
  function restoreFocus(remove = false) {
    requestAnimationFrame(() => {
      const button = remove
        ? document.querySelector<HTMLButtonElement>('button[aria-label="Context"]')
        : section.current?.querySelector<HTMLButtonElement>('[aria-label="Summary options"]');
      button?.focus();
    });
  }
  function closeEditor() {
    controller.setEditor(null);
    restoreFocus();
  }
  async function change(remove = false) {
    setError('');
    try {
      if (remove) await controller.changeSummary(null);
      else await controller.saveEdit();
      restoreFocus(remove);
    } catch (failure) {
      setError(errorDetail(failure).message);
    }
  }
  return (
    <section ref={section} className="chat-summary" aria-label="Earlier messages summarized">
      <details ref={detailsRef} className="reasoning" open={editing || undefined}>
        <summary>Earlier messages summarized</summary>
        {editing ? (
          <div
            className="message-editor"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !busy) {
                event.preventDefault();
                event.stopPropagation();
                closeEditor();
              }
            }}
          >
            <textarea
              autoFocus
              id="edit-summary"
              aria-label="Edit summary"
              rows={10}
              value={text}
              disabled={busy || readOnly}
              onChange={(event) =>
                controller.setEditor({ ...controller.editor!, text: event.target.value })
              }
            />
            <div className="message-editor-footer">
              <span>Markdown · {summary.model}</span>
              <button disabled={busy} onClick={closeEditor}>
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={busy || readOnly || !!summaryTextError(text)}
                onClick={() => void change()}
              >
                Save summary
              </button>
            </div>
            {summaryTextError(text) && (
              <p className="field-error" role="alert">
                {summaryTextError(text)}
              </p>
            )}
          </div>
        ) : (
          <>
            <p className="field-help">
              Used alongside recent messages in future replies. You can read the original messages
              above.
            </p>
            <Markdown>{summary.text}</Markdown>
          </>
        )}
      </details>
      <ActionMenu
        label="Summary options"
        title="Summary options"
        controlId="button-summary-options"
        className="message-action summary-options"
        disabled={busy || readOnly || editing}
        items={[
          {
            label: 'Edit summary',
            controlId: 'button-edit-summary',
            icon: <Pencil size={14} />,
            onSelect: controller.beginSummaryEdit,
          },
          {
            label: 'Remove summary',
            controlId: 'button-remove-summary',
            icon: <Trash2 size={14} />,
            onSelect: () => void change(true),
          },
        ]}
      />
      {error && (
        <Feedback
          title="Couldn’t update the summary"
          details={error}
          onDismiss={() => setError('')}
        >
          The previous summary was kept. Try again.
        </Feedback>
      )}
    </section>
  );
}
