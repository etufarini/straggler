import { Download, FileUp, X, TextSearch } from 'lucide-react';
import { useId } from 'react';
import AttachmentRow from './AttachmentRow';
import Feedback from '../../components/Feedback';
import { attachmentTypesLabel } from '../../domain/attachments';
import { fileName } from '../../domain/types';
import type { AttachmentController } from './useAttachments';

export default function AttachmentSection({ controller }: { controller: AttachmentController }) {
  const id = useId();
  const ready = controller.rows.filter((row) => row.state === 'ready').length;
  return (
    <section
      id="chat-attachments"
      tabIndex={-1}
      className="presence-section attachments-section"
      aria-labelledby={`${id}-title`}
    >
      <div className="presence-section-heading">
        <h2 id={`${id}-title`}>Attachments</h2>
        <span className="attachments-summary">
          {controller.searchMode
            ? 'Search mode'
            : ready
              ? `${ready} ready · ${controller.approximate ? '~' : ''}${controller.tokens.toLocaleString('en-US')} tokens`
              : 'None'}
        </span>
      </div>
      {controller.searchMode && (
        <p className="presence-note" role="status">
          <TextSearch size={14} /> Too large for this chat’s context: Straggler searches these files
          for each message.
        </p>
      )}
      {!!controller.rows.length && (
        <ul className="file-list">
          {controller.rows.map((row) => {
            const tokens = row.attachment ? controller.estimate(row.attachment) : null;
            return (
              <AttachmentRow
                key={row.id}
                row={row}
                estimate={tokens}
                visionSupported={controller.visionSupported}
                searched={controller.searchMode}
              >
                {row.state !== 'error' && (
                  <button
                    type="button"
                    className="file-action"
                    aria-label={`Download ${row.name}`}
                    title={
                      controller.temporary
                        ? 'Save this chat before downloading its attachments.'
                        : `Download ${row.name}`
                    }
                    disabled={row.state === 'reading' || controller.temporary}
                    onClick={() => row.attachment && void controller.downloadFile(row.attachment)}
                  >
                    <Download size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className="file-action"
                  aria-label={`Remove ${row.name}`}
                  title={`Remove ${row.name}`}
                  disabled={controller.disabled}
                  onClick={() => void controller.removeFile(row)}
                >
                  <X size={14} />
                </button>
              </AttachmentRow>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className={`dropzone ${controller.rows.length ? 'is-compact' : ''} ${controller.dragged.length ? 'is-dragover' : ''}`}
        aria-label="Choose files"
        aria-describedby={`${id}-hint${controller.disabled ? ` ${id}-busy` : ''}`}
        disabled={controller.disabled}
        onClick={() => void controller.chooseFiles()}
      >
        <span className="dropzone-icon">
          <FileUp size={18} aria-hidden="true" />
        </span>
        <span className="dropzone-text">
          <strong>
            {controller.dragged.length
              ? `Attach ${controller.dragged.length} ${controller.dragged.length === 1 ? 'file' : 'files'}`
              : controller.rows.length
                ? 'Add files'
                : 'Drop files here'}
          </strong>
          <span id={`${id}-hint`}>
            {controller.dragged.length
              ? controller.dragged.map(fileName).join(', ')
              : controller.rows.length
                ? 'Drop here or choose'
                : 'or choose files'}
          </span>
          {!controller.rows.length && (
            <small className="dropzone-types">{attachmentTypesLabel}</small>
          )}
        </span>
      </button>
      {controller.disabled && (
        <p className="presence-note" id={`${id}-busy`}>
          {controller.generating
            ? 'Attachments can be changed when the response finishes.'
            : 'Wait for the current operation to finish.'}
        </p>
      )}
      {controller.error && (
        <Feedback
          title="Couldn’t update the attachments"
          details={controller.error}
          onDismiss={() => controller.setError('')}
        >
          {controller.error}
        </Feedback>
      )}
      {controller.notice && (
        <p className="success-message" role="status">
          {controller.notice}
        </p>
      )}
    </section>
  );
}
