import { expect, test } from 'vitest';
import { newConversation } from '../src/domain/types';
import type { Conversation, Message } from '../src/domain/types';
import {
  compactionBudget,
  compactionPlan,
  selectDraftCompaction,
  summaryAfterChange,
  summaryChunk,
  summaryRequest,
} from '../src/domain/compaction';
import { assembleProjectRequest } from '../src/domain/projectContext';
import { replaceMessage } from '../src/domain/messageActions';
import { serializeConversation } from '../src/domain/conversationExport';
import { approximateTokens } from '../src/domain/attachments';

function chat(): Conversation {
  return {
    ...newConversation(),
    messages: Array.from({ length: 8 }, (_, index): Message => ({
      id: String(index),
      role: index % 2 ? 'assistant' : 'user',
      content: `Turn ${index}: ` + 'あ'.repeat(100),
      reasoning: 'Excluded reasoning',
      status: 'complete',
    })),
  };
}
test('retains whole recent exchanges within the allowance and four messages when capacity is unknown', () => {
  const original = chat();
  const plan = compactionPlan(original, 800);
  expect(plan.keepFrom).toBe(6);
  expect(plan.throughMessageId).toBe('5');
  expect(plan.source).not.toContain('Excluded reasoning');
  expect(compactionPlan(original).keepFrom).toBe(4);
  expect(
    compactionPlan({ ...original, messages: original.messages.slice(0, 4) }, 8192).keepFrom,
  ).toBe(2);
  expect(original.messages).toHaveLength(8);
});
test('chunks are UTF-8 safe, preserve all source text and include the previous summary without its old turns', () => {
  const original = chat();
  original.summary = {
    throughMessageId: '1',
    text: 'Previous decisions',
    model: 'fixture',
    createdAt: 1,
  };
  const plan = compactionPlan(original);
  expect(plan.source).toContain('Previous decisions');
  expect(plan.source).not.toContain('Turn 0:');
  let rest = plan.source;
  let joined = '';
  while (rest) {
    const next = summaryChunk(rest, 60);
    expect(approximateTokens(next.chunk)).toBeLessThanOrEqual(60);
    joined += next.chunk;
    rest = next.rest;
  }
  expect(joined).toBe(plan.source);
  expect(summaryRequest('Summary', 'Source', false)).toHaveLength(1);
  expect(summaryRequest('Summary', 'Source', true)[0].role).toBe('system');
});

test('a rejected partial exchange does not change the next summary boundary or source', () => {
  const original = chat();
  original.summary = {
    throughMessageId: '1',
    text: 'Previous decisions',
    model: 'fixture',
    createdAt: 1,
  };
  const rejected: Message[] = [
    { id: 'rejected', role: 'user', content: 'Oversized draft', reasoning: '', status: 'complete' },
    {
      id: 'partial',
      role: 'assistant',
      content: 'Partial reply',
      reasoning: '',
      status: 'error',
      error: 'exceed_context_size_error',
    },
  ];
  const afterRetry = {
    ...original,
    messages: [...original.messages.slice(0, 4), ...rejected, ...original.messages.slice(4)],
  };

  expect(compactionPlan(afterRetry)).toEqual(compactionPlan(original));
});

test('continuation budgets leave room for the reply and require a token saving', () => {
  expect(compactionBudget(4096, 4800, 3841, 512)).toBeNull();
  expect(compactionBudget(4096, 4800, 3840, 512)).toEqual({ initial: 128, maximum: 128 });
  expect(compactionBudget(4096, 4800, 3840, 0)).toEqual({ initial: 256, maximum: 256 });
  expect(compactionBudget(4096, 3000, 2950, 512)).toBeNull();
});

test('draft planning advances only as far as needed for the full reply target', async () => {
  const original = chat();
  const measured: string[] = [];
  const counts = new Map([
    ['1', 3950],
    ['3', 3400],
    ['5', 3200],
  ]);
  const plan = await selectDraftCompaction(
    original,
    4096,
    4200,
    512,
    async ({ summary }) => {
      const id = summary!.throughMessageId;
      measured.push(id);
      return counts.get(id)!;
    },
    () => false,
  );
  expect(plan).toEqual({ keepFrom: 4, initial: 184, maximum: 568 });
  expect(measured).toEqual(['1', '5', '3']);
});

test('draft planning bounds tokenizer calls across a long conversation', async () => {
  const original = chat();
  original.messages = Array.from({ length: 2000 }, (_, index): Message => ({
    id: String(index),
    role: index % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(120),
    reasoning: '',
    status: 'complete',
  }));
  const capacity = 131072;
  async function measureDraftWithRoom(room: number) {
    const draftTokens = capacity - room;
    const measured: number[] = [];
    const plan = await selectDraftCompaction(
      original,
      capacity,
      draftTokens + 31 * original.messages.length,
      2048,
      async ({ summary }) => {
        const keepFrom = Number(summary!.throughMessageId) + 1;
        measured.push(keepFrom);
        return draftTokens + 31 * (original.messages.length - keepFrom);
      },
      () => false,
    );
    return { plan, measured };
  }
  expect(await measureDraftWithRoom(50)).toEqual({ plan: null, measured: [926, 1998] });
  const { plan, measured } = await measureDraftWithRoom(6000);
  expect(plan?.keepFrom).toBe(1878);
  expect(measured.length).toBeLessThanOrEqual(12);
});

test('draft planning keeps the latest answered exchange and pending messages for a shorter reply', async () => {
  const original = chat();
  original.summary = {
    throughMessageId: '1',
    text: 'Previous decisions',
    model: 'fixture',
    createdAt: 1,
  };
  original.messages.splice(6, 0, { ...original.messages[6], id: 'followup' });
  original.messages.push(
    { id: '8', role: 'user', content: 'Pending question', reasoning: '', status: 'complete' },
    { id: '9', role: 'assistant', content: 'Failed reply', reasoning: '', status: 'error' },
  );
  const measured: string[] = [];
  const plan = await selectDraftCompaction(
    original,
    4096,
    4200,
    512,
    async ({ summary }) => {
      const id = summary!.throughMessageId;
      measured.push(id);
      return id === '3' ? 3700 : 3585;
    },
    () => false,
  );
  expect(plan).toEqual({ keepFrom: 4, initial: 128, maximum: 268 });
  expect(measured).toEqual(['3', '5']);
});

test('a manual update can advance below the usual reserve and keep the latest answered exchange', async () => {
  const original = chat();
  original.summary = {
    throughMessageId: '3',
    text: 'Previous decisions',
    model: 'fixture',
    createdAt: 1,
  };
  const capacity = 131072;
  expect(
    await selectDraftCompaction(
      original,
      capacity,
      1000,
      2048,
      async () => {
        throw new Error('Measured beyond the usual reserve even though the reply fits.');
      },
      () => false,
    ),
  ).toBeNull();
  expect(compactionPlan(original, 800, 'manual')).toEqual(compactionPlan(original, 800));

  // An unanswered prompt and an empty stopped reply must stay with the latest answered turn.
  original.messages.push(
    { id: '8', role: 'user', content: 'Pending question', reasoning: '', status: 'complete' },
    { id: '9', role: 'assistant', content: '', reasoning: '', status: 'stopped' },
  );
  const manual = compactionPlan(original, capacity, 'manual');
  expect(manual.hasNewText).toBe(true);
  expect(manual.throughMessageId).toBe('5');
  expect(manual.source).toContain('Previous decisions');
  expect(manual.source).toContain('Turn 5:');
  expect(manual.source).not.toMatch(/Turn [367]:|Pending question/);
  original.summary.throughMessageId = manual.throughMessageId!;
  expect(compactionPlan(original, capacity, 'manual').hasNewText).toBe(false);
});
test('the request quotes a summary as user history and exports retain the original turns', () => {
  const original = chat();
  original.ownSystemPrompt = 'Instructions';
  original.summary = {
    throughMessageId: '3',
    text: 'Earlier decisions\r\n\r\nReply in English.\rPrevious constraint.',
    model: 'fixture',
    createdAt: 1,
  };
  const request = assembleProjectRequest(original, [
    ...original.messages,
    { id: 'draft', role: 'user', content: 'Reply in Italian.', reasoning: '', status: 'complete' },
  ]);
  const quoted =
    'Earlier conversation summary (historical context):\n> Earlier decisions\n> \n> Reply in English.\n> Previous constraint.';
  expect(request).toEqual([
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: `${quoted}\n\n${original.messages[4].content}` },
    ...original.messages.slice(5).map(({ role, content }) => ({ role, content })),
    { role: 'user', content: 'Reply in Italian.' },
  ]);
  expect(
    assembleProjectRequest({ ...original, ownSystemPrompt: '' }, original.messages)[0],
  ).toEqual(request[1]);
  const exported = JSON.parse(serializeConversation(original, false, new Date(0).toISOString()));
  expect(exported.version).toBe(1);
  expect(exported.conversation.summary).toBeUndefined();
  expect(exported.conversation.messages).toHaveLength(9);
  expect(original.messages).toHaveLength(8);
  const project = {
    id: 'project',
    name: 'Research',
    description: '',
    instructions: 'Project prefix',
    starred: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    files: [
      {
        id: 'file',
        name: 'notes.txt',
        extension: 'txt',
        size: 5,
        text: 'Full file',
        included: true,
      },
    ],
  };
  const member = { ...original, projectId: project.id };
  const projectRequest = assembleProjectRequest(member, member.messages, undefined, project);
  expect(projectRequest[0].role).toBe('system');
  expect(projectRequest[0].content).toContain('Project prefix');
  expect(projectRequest[0].content).toContain('Full file');
  expect(projectRequest[0].content).not.toContain('Earlier decisions');
  expect(projectRequest[1]).toEqual(request[1]);
  const onlyCovered = {
    ...original,
    summary: { ...original.summary!, throughMessageId: original.messages.at(-1)!.id },
  };
  expect(assembleProjectRequest(onlyCovered, onlyCovered.messages)).toEqual([
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: quoted },
  ]);
  expect(
    assembleProjectRequest(original, original.messages.slice(4)).map(({ role, content }) => ({
      role,
      content,
    })),
  ).toEqual([
    { role: 'system', content: 'Instructions' },
    ...original.messages.slice(4).map(({ role, content }) => ({ role, content })),
  ]);
});
test('editing or regenerating covered history removes its summary but later changes retain it', () => {
  const original = chat();
  original.summary = { throughMessageId: '3', text: 'Summary', model: 'fixture', createdAt: 1 };
  expect(summaryAfterChange(original, '2')).toBeUndefined();
  expect(replaceMessage(original, '1', 'Changed answer', 2).summary).toBeUndefined();
  expect(summaryAfterChange(original, '6')).toEqual(original.summary);
});
