import { fileName, requestMessages } from './types';
import type { Attachment, Message } from './types';

export const documentTypes = [
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'log',
  'toml',
  'ini',
  'sql',
  'py',
  'js',
  'ts',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
] as const;
export const imageTypes = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
export const attachmentTypes = [...documentTypes, ...imageTypes] as const;
export const documentTypesLabel = '.txt · .md · .csv · .json · code · .docx · .xlsx · .pptx · .pdf';
export const attachmentTypesLabel = `${documentTypesLabel} · images`;
export type AttachmentRow = {
  id: string;
  name: string;
  extension: string;
  size: number | null;
  state: 'ready' | 'reading' | 'error';
  error?: string;
  attachment?: Attachment;
};

export function pendingAttachmentRow(path: string): AttachmentRow {
  const name = fileName(path);
  return {
    id: crypto.randomUUID(),
    name,
    extension: name.split('.').at(-1)?.toLowerCase() ?? '',
    size: null,
    state: 'reading',
  };
}

export function sortAttachmentRows(rows: AttachmentRow[]): AttachmentRow[] {
  return [...rows].sort((a, b) => {
    if (a.state === 'error' && b.state !== 'error') return 1;
    if (b.state === 'error' && a.state !== 'error') return -1;
    const typeOrder = (extension: string) => {
      const index = (attachmentTypes as readonly string[]).indexOf(extension);
      return index < 0 ? attachmentTypes.length : index;
    };
    return typeOrder(a.extension) - typeOrder(b.extension) || a.name.localeCompare(b.name);
  });
}

export function attachmentBlocks(attachments: Attachment[]): string {
  return attachments
    .map(
      (attachment) =>
        `--- BEGIN ATTACHMENT ${JSON.stringify(attachment.name)} ---\n${attachment.text}\n--- END ATTACHMENT ${JSON.stringify(attachment.name)} ---`,
    )
    .join('\n\n');
}

export function composeRequest(
  messages: Message[],
  systemPrompt: string,
  attachments: Attachment[],
  includeReasoning = false,
) {
  const turns: {
    role: 'system' | 'user' | 'assistant';
    content: string;
    reasoning_content?: string;
  }[] = requestMessages(messages, includeReasoning);
  const documents = attachments.filter((attachment) => !attachment.image);
  if (documents.length) {
    const blocks = attachmentBlocks(documents);
    const firstUser = turns.find((message) => message.role === 'user');
    if (firstUser) firstUser.content = `${blocks}\n\n${firstUser.content}`;
    else turns.unshift({ role: 'user', content: blocks });
  }
  if (systemPrompt) turns.unshift({ role: 'system', content: systemPrompt });
  return turns;
}

export function approximateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

export function estimateImageTokens(attachments: Attachment[] = []): number {
  // This patch count is a rough estimate because the loaded model encodes the image.
  return attachments.reduce(
    (count, { image }) =>
      count + (image ? Math.ceil(image.width / 32) * Math.ceil(image.height / 32) : 0),
    0,
  );
}

export function approximatePromptTokens(
  messages: { content: string; reasoning_content?: string }[],
): number {
  return approximateTokens(
    messages
      .map((message) => [message.content, message.reasoning_content].filter(Boolean).join('\n\n'))
      .join('\n\n'),
  );
}
