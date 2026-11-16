import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ERR_CHECKPOINT_NOT_FOUND, type TextContent } from '@animalabs/mcpl-core';
import { McplRpcError } from '../src/errors.js';
import { GithubState } from '../src/state.js';
import {
  COMMENT_TOOLS,
  commentsToolModule,
  recordCreated,
  recordEdited,
  rollbackComments,
  stickyBody,
  stickyMarker,
} from '../src/tools-comments.js';
import {
  COMMENTS_FEATURE_SET,
  READ_FEATURE_SET,
  TOOLS_BY_FEATURE_SET,
  TOOL_COMMENT,
  TOOL_DELETE_OWN_COMMENT,
  TOOL_EDIT_OWN_COMMENT,
  TOOL_REPLY_IN_THREAD,
  TOOL_UPSERT_STICKY_COMMENT,
  reviewThreadId,
  silentLogger,
  type Logger,
  type RepoRef,
  type ThreadRef,
  type ToolContext,
  type ToolResult,
} from '../src/types.js';
import { FakeGitHubApi, TEST_BOT, TEST_REPO } from './harness.js';

const ISSUE: ThreadRef = { repo: TEST_REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: TEST_REPO, number: 8, kind: 'pull' };
const OTHER_REPO: RepoRef = { owner: 'anima-research', name: 'not-allowed' };

interface Fixture {
  api: FakeGitHubApi;
  state: GithubState;
  ctx: ToolContext;
  logs: string[];
}

function fixture(repos: RepoRef[] = [TEST_REPO]): Fixture {
  const api = new FakeGitHubApi();
  const state = GithubState.empty();
  const logs: string[] = [];
  const logger: Logger = {
    ...silentLogger(),
    warn: (message) => {
      logs.push(message);
    },
  };
  const ctx: ToolContext = { api, state, botLogin: TEST_BOT.login, repos, prBaseAllow: ['dev'], logger };
  return { api, state, ctx, logs };
}

function text(result: ToolResult): string {
  return result.content.map((block) => (block as TextContent).text ?? '').join('\n');
}

async function call(f: Fixture, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await commentsToolModule.call(name, args, f.ctx);
  f.state.createCheckpoint();
  return result;
}

function bodies(api: FakeGitHubApi, thread: ThreadRef): Promise<string[]> {
  return api.listComments(thread).then((list) => list.map((c) => c.body));
}

test('the module declares exactly the contract\'s github.comments tools', () => {
  assert.equal(commentsToolModule.featureSet, COMMENTS_FEATURE_SET);
  assert.deepEqual(
    COMMENT_TOOLS.map((t) => t.name),
    [...TOOLS_BY_FEATURE_SET[COMMENTS_FEATURE_SET]],
  );
  for (const tool of COMMENT_TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 0);
  }
});

test('an unknown tool name is refused, not thrown', async () => {
  const f = fixture();
  const result = await commentsToolModule.call('merge_everything', {}, f.ctx);
  assert.equal(result.isError, true);
  assert.match(text(result), /unknown tool/);
});

test('comment posts and books the new comment under the current checkpoint', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const base = f.state.createCheckpoint();

  const result = await call(f, TOOL_COMMENT, { thread: 'anima-research/rayforce#7', body: 'hello' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(await bodies(f.api, ISSUE), ['hello']);

  const booked = f.state.snapshot().created[base.id];
  assert.equal(booked.length, 1);
  assert.equal(booked[0].repo, 'anima-research/rayforce');
  assert.equal(booked[0].review, false);
  assert.deepEqual(booked[0].thread, { number: 7, kind: 'issue' });
  assert.match(text(result), /commented on anima-research\/rayforce#7/);
});

test('comment accepts the short thread forms and refuses a foreign repository', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  f.state.createCheckpoint();

  assert.notEqual((await call(f, TOOL_COMMENT, { thread: 7, body: 'by number' })).isError, true);
  assert.notEqual((await call(f, TOOL_COMMENT, { thread: '#7', body: 'by hash' })).isError, true);
  assert.notEqual(
    (await call(f, TOOL_COMMENT, { thread: { number: 7, kind: 'issue' }, body: 'by object' })).isError,
    true,
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['by number', 'by hash', 'by object']);

  const refused = await call(f, TOOL_COMMENT, { thread: 'anima-research/not-allowed#7', body: 'nope' });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /not in GITHUB_REPOS/);
  assert.equal(f.api.callsTo('createComment').length, 3);
});

test('comment refuses a missing body and a thread it cannot read', async () => {
  const f = fixture();
  const noBody = await commentsToolModule.call(TOOL_COMMENT, { thread: 7 }, f.ctx);
  assert.equal(noBody.isError, true);
  assert.match(text(noBody), /^body: required/);

  const noThread = await commentsToolModule.call(TOOL_COMMENT, { body: 'x' }, f.ctx);
  assert.equal(noThread.isError, true);
  assert.match(text(noThread), /^thread: required/);
  assert.equal(f.api.callsTo('createComment').length, 0);
});

test('reply_in_thread replies into a review conversation and books it as a review comment', async () => {
  const f = fixture();
  f.api.seedPullRequest({ number: 8 });
  const root = f.api.seedReviewThread(PULL);
  const base = f.state.createCheckpoint();

  const result = await call(f, TOOL_REPLY_IN_THREAD, {
    thread: 8,
    threadId: reviewThreadId(root.comments[0].id),
    body: 'fixed in the next push',
  });
  assert.notEqual(result.isError, true);

  const threads = await f.api.listReviewThreads(PULL);
  assert.deepEqual(
    threads[0].comments.map((c) => c.body),
    ['this line', 'fixed in the next push'],
  );
  const booked = f.state.snapshot().created[base.id];
  assert.equal(booked[0].review, true);
  assert.deepEqual(booked[0].thread, { number: 8, kind: 'pull' });

  const badId = await call(f, TOOL_REPLY_IN_THREAD, { thread: 8, threadId: 'review:3', body: 'x' });
  assert.equal(badId.isError, true);
  assert.match(text(badId), /expected a review conversation/);
});

test('edit_own_comment rewrites the bot\'s comment and books the previous body', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'first draft', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();

  const result = await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'second draft' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(await bodies(f.api, ISSUE), ['second draft']);
  assert.deepEqual(f.state.snapshot().edited[base.id], [
    { repo: 'anima-research/rayforce', commentId: own.id, previousBody: 'first draft', review: false, thread: { number: 7, kind: 'issue' } },
  ]);
});

test('edit_own_comment refuses a comment the bot did not write', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const foreign = f.api.seedComment(ISSUE, { body: 'a human wrote this' });
  f.state.createCheckpoint();

  const result = await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: foreign.id, body: 'hijacked' });
  assert.equal(result.isError, true);
  assert.match(text(result), /written by human-one, not rayforce-clone\[bot\]/);
  assert.deepEqual(await bodies(f.api, ISSUE), ['a human wrote this']);
  assert.equal(f.api.callsTo('updateComment').length, 0);
  assert.deepEqual(f.state.snapshot().edited, {});
});

test('edit_own_comment reaches a review comment and edits it through the review path', async () => {
  const f = fixture();
  f.api.seedPullRequest({ number: 8 });
  const rt = f.api.seedReviewThread(PULL, {
    comments: [{ id: 4242, author: { login: TEST_BOT.login, isBot: true }, body: 'nit', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  const base = f.state.createCheckpoint();

  const result = await call(f, TOOL_EDIT_OWN_COMMENT, {
    thread: { number: 8, kind: 'pull' },
    commentId: rt.comments[0].id,
    body: 'nit, resolved',
  });
  assert.notEqual(result.isError, true);
  const update = f.api.callsTo('updateComment')[0];
  assert.equal(update.args[3], true, 'the review path flag reaches the api');
  assert.equal(f.state.snapshot().edited[base.id][0].review, true);
});

test('edit_own_comment reports a comment that is not on the thread', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  f.state.createCheckpoint();
  const result = await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: 999, body: 'x' });
  assert.equal(result.isError, true);
  assert.match(text(result), /no comment 999 on anima-research\/rayforce#7/);
});

test('delete_own_comment deletes the bot\'s comment and books an undeletable record', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'never mind', author: { login: TEST_BOT.login, isBot: true } });
  const foreign = f.api.seedComment(ISSUE, { body: 'a human wrote this' });
  const base = f.state.createCheckpoint();

  const refused = await call(f, TOOL_DELETE_OWN_COMMENT, { thread: 7, commentId: foreign.id });
  assert.equal(refused.isError, true);
  assert.equal(f.api.callsTo('deleteComment').length, 0);
  assert.deepEqual(f.state.snapshot().deleted, {});

  const current = f.state.current();
  assert.notEqual(current, base.id);
  const result = await call(f, TOOL_DELETE_OWN_COMMENT, { thread: 7, commentId: own.id });
  assert.notEqual(result.isError, true);
  assert.deepEqual(await bodies(f.api, ISSUE), ['a human wrote this']);
  assert.deepEqual(f.state.snapshot().deleted[current as string], [
    { repo: 'anima-research/rayforce', commentId: own.id, previousBody: 'never mind', review: false, thread: { number: 7, kind: 'issue' } },
  ]);
});

test('the sticky marker is an HTML comment, however it was passed', () => {
  assert.equal(stickyMarker('ci-status'), '<!-- ci-status -->');
  assert.equal(stickyMarker('<!-- ci-status -->'), '<!-- ci-status -->');
  assert.equal(stickyBody('ci-status', 'green'), '<!-- ci-status -->\ngreen');
  assert.equal(stickyBody('ci-status', 'green\n<!-- ci-status -->'), 'green\n<!-- ci-status -->');
});

test('upsert_sticky_comment creates once, then edits in place, keeping the marker', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  f.api.seedComment(ISSUE, { body: 'unrelated human comment' });
  f.state.createCheckpoint();

  const first = await call(f, TOOL_UPSERT_STICKY_COMMENT, { thread: 7, marker: 'ci-status', body: 'checks: red' });
  assert.notEqual(first.isError, true);
  const afterFirst = await f.api.listComments(ISSUE);
  assert.equal(afterFirst.length, 2);
  assert.equal(afterFirst[1].body, '<!-- ci-status -->\nchecks: red');

  const second = await call(f, TOOL_UPSERT_STICKY_COMMENT, { thread: 7, marker: 'ci-status', body: 'checks: green' });
  assert.notEqual(second.isError, true);
  const afterSecond = await f.api.listComments(ISSUE);
  assert.equal(afterSecond.length, 2, 'the second call edits rather than posts again');
  assert.equal(afterSecond[1].id, afterFirst[1].id);
  assert.equal(afterSecond[1].body, '<!-- ci-status -->\nchecks: green');
  assert.ok(afterSecond[1].body.includes('<!-- ci-status -->'), 'the marker survives the edit');
  assert.equal(f.api.callsTo('createComment').length, 1);
  assert.equal(f.api.callsTo('updateComment').length, 1);
  assert.match(text(second), /updated sticky <!-- ci-status -->/);

  const other = await call(f, TOOL_UPSERT_STICKY_COMMENT, { thread: 7, marker: 'plan', body: 'the plan' });
  assert.notEqual(other.isError, true);
  assert.equal((await f.api.listComments(ISSUE)).length, 3);
});

test('upsert_sticky_comment never edits a marker-carrying comment written by someone else', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  f.api.seedComment(ISSUE, { body: '<!-- ci-status -->\nimpersonation' });
  f.state.createCheckpoint();

  await call(f, TOOL_UPSERT_STICKY_COMMENT, { thread: 7, marker: 'ci-status', body: 'checks: green' });
  const comments = await f.api.listComments(ISSUE);
  assert.equal(comments.length, 2);
  assert.equal(comments[0].body, '<!-- ci-status -->\nimpersonation');
  assert.equal(f.api.callsTo('updateComment').length, 0);
});

test('rollback after two comments and one edit deletes two and restores one', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'original body', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();

  await call(f, TOOL_COMMENT, { thread: 7, body: 'first' });
  await call(f, TOOL_COMMENT, { thread: 7, body: 'second' });
  await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'edited body' });

  const before = await f.api.listComments(ISSUE);
  assert.deepEqual(before.map((c) => c.body), ['edited body', 'first', 'second']);
  const [firstId, secondId] = [before[1].id, before[2].id];

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(result.success, true);
  assert.equal(result.checkpoint, base.id);
  assert.equal(result.reason, undefined);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId]),
    [
      ['delete', secondId],
      ['delete', firstId],
      ['restore', own.id],
    ],
  );
  assert.deepEqual(result.notUndone, []);
  assert.deepEqual(await bodies(f.api, ISSUE), ['original body']);
  assert.equal(f.state.current(), base.id, 'the next write branches from the checkpoint');
  assert.equal(f.logs.length, 0, 'a complete rollback has nothing to warn about');
});

test('rollback across a comment someone else removed reports what it could not undo', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const base = f.state.createCheckpoint();
  await call(f, TOOL_COMMENT, { thread: 7, body: 'first' });
  await call(f, TOOL_COMMENT, { thread: 7, body: 'second' });

  const gone = (await f.api.listComments(ISSUE))[0];
  await f.api.deleteComment(TEST_REPO, gone.id);

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(result.success, false);
  assert.equal(result.undone.length, 1);
  assert.deepEqual(
    result.notUndone.map((i) => [i.action, i.commentId]),
    [['delete', gone.id]],
  );
  assert.match(result.notUndone[0].reason ?? '', /no such comment/);
  assert.match(result.reason ?? '', /undid 1 of 2 actions; could not undo anima-research\/rayforce comment/);
  assert.deepEqual(await bodies(f.api, ISSUE), []);
  assert.equal(f.logs.length, 1, 'the receipt also goes to stderr');
});

test('rollback reports a delete it can never undo, and skips an edit of a comment it deletes', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'bot wrote this', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();

  await call(f, TOOL_DELETE_OWN_COMMENT, { thread: 7, commentId: own.id });
  await call(f, TOOL_COMMENT, { thread: 7, body: 'created then edited' });
  const created = (await f.api.listComments(ISSUE))[0];
  await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: created.id, body: 'edited after creation' });

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(result.success, false);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId]),
    [['delete', created.id]],
  );
  assert.deepEqual(
    result.notUndone.map((i) => [i.action, i.commentId]),
    [['none', own.id]],
  );
  assert.match(result.notUndone[0].reason ?? '', /GitHub cannot restore a deleted comment/);
  assert.deepEqual(await bodies(f.api, ISSUE), []);

  const retry = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(retry.success, false);
  assert.deepEqual(retry.undone, []);
  assert.deepEqual(
    retry.notUndone.map((i) => [i.action, i.commentId]),
    [['none', own.id]],
  );
});

test('rollback of a feature set that is not rollback-capable answers success false', async () => {
  const f = fixture();
  const result = await rollbackComments({ featureSet: READ_FEATURE_SET, checkpoint: 'chk_any' }, f.ctx);
  assert.equal(result.success, false);
  assert.match(result.reason ?? '', /github\.read' does not support rollback/);
  assert.deepEqual(result.undone, []);
});

test('rollback of an unknown checkpoint raises -32005', async () => {
  const f = fixture();
  f.state.createCheckpoint();
  await assert.rejects(
    () => rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: 'chk_pruned' }, f.ctx),
    (err: unknown) => {
      assert.ok(err instanceof McplRpcError);
      assert.equal(err.code, ERR_CHECKPOINT_NOT_FOUND);
      assert.deepEqual(err.data, { checkpoint: 'chk_pruned', reason: 'no such checkpoint' });
      return true;
    },
  );
});

test('rollback survives a restart: the bookkeeping is on the state file', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'github-mcpl-tools-')), 'state.json');
  const api = new FakeGitHubApi();
  api.seedIssue({ number: 7 });
  const own = api.seedComment(ISSUE, { body: 'original body', author: { login: TEST_BOT.login, isBot: true } });

  const first: Fixture = { ...fixture(), api, state: GithubState.load(file) };
  first.ctx = { ...first.ctx, api, state: first.state };
  const base = first.state.createCheckpoint();
  await call(first, TOOL_COMMENT, { thread: 7, body: 'before the restart' });
  await call(first, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'edited before the restart' });
  const createdId = (await api.listComments(ISSUE))[1].id;

  const restarted = GithubState.load(file);
  assert.deepEqual(restarted.lineage().map((c) => c.id).slice(0, 1), [base.id]);
  const ctx: ToolContext = { ...first.ctx, state: restarted };

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, ctx);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId]),
    [
      ['delete', createdId],
      ['restore', own.id],
    ],
  );
  assert.deepEqual(await bodies(api, ISSUE), ['original body']);
  assert.deepEqual(GithubState.load(file).rollback(base.id), { created: [], edited: [], deleted: [] });
});

test('recordCreated and recordEdited are the entry points .5 shares with these tools', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'original body', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();

  const published = await f.api.createComment(ISSUE, 'published through a channel');
  await recordCreated(published, ISSUE, false, f.ctx);
  await f.api.updateComment(TEST_REPO, own.id, 'rewritten through a channel');
  await recordEdited(own.id, 'original body', ISSUE, false, f.ctx);

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId]),
    [
      ['delete', published.id],
      ['restore', own.id],
    ],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['original body']);
});

test('a write outside the allow-list never reaches the api or the state', async () => {
  const f = fixture([TEST_REPO]);
  const base = f.state.createCheckpoint();
  const result = await call(f, TOOL_COMMENT, { thread: { ...OTHER_REPO, number: 7 }, body: 'x' });
  assert.equal(result.isError, true);
  assert.deepEqual(f.api.callLog(), []);
  assert.equal(f.state.snapshot().created[base.id], undefined);
});

test('rollback refuses to touch a repository outside the allow-list, and keeps the record', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const base = f.state.createCheckpoint();
  await call(f, TOOL_COMMENT, { thread: 7, body: 'written while rayforce was allowed' });
  const created = (await f.api.listComments(ISSUE))[0];
  f.api.clearCalls();

  const narrowed: ToolContext = { ...f.ctx, repos: [OTHER_REPO] };
  const refused = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, narrowed);
  assert.equal(refused.success, false);
  assert.deepEqual(
    refused.notUndone.map((i) => [i.action, i.commentId]),
    [['delete', created.id]],
  );
  assert.match(refused.notUndone[0].reason ?? '', /anima-research\/rayforce is not in GITHUB_REPOS/);
  assert.deepEqual(f.api.callLog(), [], 'no api call is made for a refused repository');
  assert.deepEqual(await bodies(f.api, ISSUE), ['written while rayforce was allowed']);

  const retry = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(retry.success, true);
  assert.deepEqual(retry.undone.map((i) => i.commentId), [created.id]);
  assert.deepEqual(await bodies(f.api, ISSUE), []);
});

test('a checkpoint abandoned by an earlier rollback raises -32005 instead of reporting success', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'A', author: { login: TEST_BOT.login, isBot: true } });
  const a = f.state.createCheckpoint();

  await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'B' });
  const b = f.state.current() as string;
  assert.deepEqual(await bodies(f.api, ISSUE), ['B']);

  const toA = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: a.id }, f.ctx);
  assert.equal(toA.success, true);
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);

  await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'C' });
  assert.deepEqual(await bodies(f.api, ISSUE), ['C']);

  await assert.rejects(
    () => rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: b }, f.ctx),
    (err: unknown) => {
      assert.ok(err instanceof McplRpcError);
      assert.equal(err.code, ERR_CHECKPOINT_NOT_FOUND);
      assert.deepEqual(err.data, {
        checkpoint: b,
        reason: 'an earlier rollback left this checkpoint behind; the state it named can no longer be restored',
      });
      return true;
    },
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['C'], 'nothing was touched by the refused rollback');
  const again = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: a.id }, f.ctx);
  assert.equal(again.success, true);
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);
});

test('an issue comment and a review comment sharing an id are two different comments', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  f.api.seedPullRequest({ number: 8 });
  // GitHub numbers issue comments and review comments from separate
  // sequences, so one id can name both.
  const shared = 500;
  const issueComment = f.api.seedComment(ISSUE, {
    id: shared,
    body: 'created issue comment',
    author: { login: TEST_BOT.login, isBot: true },
  });
  f.api.seedReviewThread(PULL, {
    comments: [
      {
        id: shared,
        author: { login: TEST_BOT.login, isBot: true },
        body: 'current review body',
        createdAt: '2026-10-01T00:00:00.000Z',
      },
    ],
  });

  const base = f.state.createCheckpoint();
  await recordCreated(issueComment, ISSUE, false, f.ctx);
  await recordEdited(shared, 'original review body', PULL, true, f.ctx);
  f.api.clearCalls();

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(result.success, true);
  assert.deepEqual(f.api.callsTo('deleteComment')[0].args, [TEST_REPO, shared, false]);
  assert.deepEqual(f.api.callsTo('updateComment')[0].args, [TEST_REPO, shared, 'original review body', true]);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId, i.review]),
    [
      ['delete', shared, false],
      ['restore', shared, true],
    ],
  );
});

test('a transient failure keeps its record, so a retry cannot claim a completed rollback', async () => {
  const f = fixture();
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'original body', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();
  await call(f, TOOL_COMMENT, { thread: 7, body: 'created' });
  await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body: 'edited' });
  const created = (await f.api.listComments(ISSUE))[1];

  const realDelete = f.api.deleteComment.bind(f.api);
  const realUpdate = f.api.updateComment.bind(f.api);
  let failures = 2;
  f.api.deleteComment = async (repo, commentId, review) => {
    if (failures-- > 0) throw new Error('503 Service Unavailable');
    return realDelete(repo, commentId, review);
  };
  f.api.updateComment = async (repo, commentId, body, review) => {
    if (failures-- > 0) throw new Error('503 Service Unavailable');
    return realUpdate(repo, commentId, body, review);
  };

  const first = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(first.success, false);
  assert.deepEqual(first.undone, []);
  assert.deepEqual(
    first.notUndone.map((i) => [i.action, i.commentId]),
    [
      ['delete', created.id],
      ['restore', own.id],
    ],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['edited', 'created']);

  const snapshot = f.state.snapshot();
  assert.deepEqual(snapshot.created[base.id].map((c) => c.commentId), [created.id]);
  assert.deepEqual(snapshot.edited[base.id].map((e) => e.previousBody), ['original body']);

  const retry = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base.id }, f.ctx);
  assert.equal(retry.success, true);
  assert.deepEqual(
    retry.undone.map((i) => [i.action, i.commentId]),
    [
      ['delete', created.id],
      ['restore', own.id],
    ],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['original body']);
});

async function threeEdits(f: Fixture): Promise<{ base: string; own: number }> {
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'A', author: { login: TEST_BOT.login, isBot: true } });
  const base = f.state.createCheckpoint();
  for (const body of ['B', 'C', 'D']) {
    const result = await call(f, TOOL_EDIT_OWN_COMMENT, { thread: 7, commentId: own.id, body });
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(await bodies(f.api, ISSUE), ['D']);
  f.api.clearCalls();
  return { base: base.id, own: own.id };
}

test('rollback restores the body the checkpoint named, never an intermediate one', async () => {
  const f = fixture();
  const { base, own } = await threeEdits(f);

  const result = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base }, f.ctx);
  assert.equal(result.success, true);
  assert.deepEqual(
    result.undone.map((i) => [i.action, i.commentId]),
    [['restore', own]],
  );
  assert.deepEqual(
    f.api.callsTo('updateComment').map((c) => c.args[2]),
    ['A'],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);

  assert.deepEqual(f.state.snapshot().edited, {});
  f.api.clearCalls();
  const retry = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base }, f.ctx);
  assert.equal(retry.success, true);
  assert.deepEqual(retry.undone, []);
  assert.deepEqual(f.api.callLog(), []);
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);
});

test('a failed restore retains only the oldest body, and the retry lands on it', async () => {
  const f = fixture();
  const { base, own } = await threeEdits(f);

  const realUpdate = f.api.updateComment.bind(f.api);
  let failures = 1;
  f.api.updateComment = async (repo, commentId, body, review) => {
    if (failures-- > 0) throw new Error('503 Service Unavailable');
    return realUpdate(repo, commentId, body, review);
  };

  const first = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base }, f.ctx);
  assert.equal(first.success, false);
  assert.deepEqual(first.undone, []);
  assert.deepEqual(
    first.notUndone.map((i) => [i.action, i.commentId]),
    [['restore', own]],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['D'], 'the failed restore changed nothing');

  const pending = f.state.snapshot().edited[base];
  assert.equal(pending.length, 1);
  assert.equal(pending[0].previousBody, 'A');

  const retry = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base }, f.ctx);
  assert.equal(retry.success, true);
  assert.deepEqual(
    retry.undone.map((i) => [i.action, i.commentId]),
    [['restore', own]],
  );
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);
  assert.deepEqual([...new Set(f.api.callsTo('updateComment').map((c) => c.args[2]))], ['A']);

  const again = await rollbackComments({ featureSet: COMMENTS_FEATURE_SET, checkpoint: base }, f.ctx);
  assert.equal(again.success, true);
  assert.deepEqual(again.undone, []);
  assert.deepEqual(await bodies(f.api, ISSUE), ['A']);
});

/**
 * GitHub numbers issue comments and review comments separately, so a pull
 * request can carry one of each with the same id.
 */
function colliding(): { f: Fixture; shared: number } {
  const f = fixture();
  const bot = { login: TEST_BOT.login, isBot: true };
  const shared = 500;
  f.api.seedPullRequest({ number: 8 });
  f.api.seedComment(PULL, { id: shared, body: 'top-level comment', author: bot });
  f.api.seedReviewThread(PULL, {
    comments: [{ id: shared, author: bot, body: 'review comment', createdAt: '2026-10-01T00:00:00.000Z' }],
  });
  return { f, shared };
}

test('a failed review-comment lookup refuses the write instead of picking the issue comment', async () => {
  for (const [tool, extra] of [
    [TOOL_EDIT_OWN_COMMENT, { body: 'oops' }],
    [TOOL_DELETE_OWN_COMMENT, {}],
  ] as const) {
    const { f, shared } = colliding();
    f.state.createCheckpoint();
    f.api.listReviewThreads = async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    };
    const result = await call(f, tool, { thread: { number: 8, kind: 'pull' }, commentId: shared, ...extra });
    assert.equal(result.isError, true, tool);
    assert.match(text(result), /could not establish whether 500 .* is a review comment/);
    assert.equal(f.api.callsTo('updateComment').length, 0, `${tool}: no edit`);
    assert.equal(f.api.callsTo('deleteComment').length, 0, `${tool}: no delete`);
    assert.deepEqual(f.state.snapshot().edited, {});
    assert.deepEqual(f.state.snapshot().created, {});
  }
});

test('an issue thread never asks for review conversations', async () => {
  const f = fixture();
  const bot = { login: TEST_BOT.login, isBot: true };
  f.api.seedIssue({ number: 7 });
  const own = f.api.seedComment(ISSUE, { body: 'mine', author: bot });
  f.state.createCheckpoint();
  const result = await call(f, TOOL_EDIT_OWN_COMMENT, { thread: { number: 7, kind: 'issue' }, commentId: own.id, body: 'edited' });
  assert.equal(result.isError, undefined, text(result));
  assert.equal(f.api.callsTo('listReviewThreads').length, 0);
});

test('edit_own_comment refuses a colliding id until the caller names the endpoint', async () => {
  const ambiguousCase = colliding();
  ambiguousCase.f.state.createCheckpoint();
  // `kind: "pull"` cannot decide this: a pull request carries comments of both
  // kinds, so the thread's kind says nothing about which endpoint owns the id.
  const ambiguous = await call(ambiguousCase.f, TOOL_EDIT_OWN_COMMENT, {
    thread: { number: 8, kind: 'pull' },
    commentId: ambiguousCase.shared,
    body: 'which one?',
  });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /names both an issue comment and a review comment/);
  assert.equal(ambiguousCase.f.api.callsTo('updateComment').length, 0, 'nothing is modified while it is unclear');
  assert.deepEqual(ambiguousCase.f.state.snapshot().edited, {});

  const badFlag = await commentsToolModule.call(
    TOOL_EDIT_OWN_COMMENT,
    { thread: 8, commentId: ambiguousCase.shared, body: 'x', review: 'yes' },
    ambiguousCase.f.ctx,
  );
  assert.equal(badFlag.isError, true);
  assert.match(text(badFlag), /^review: true for a review comment/);

  const reviewCase = colliding();
  const reviewCp = reviewCase.f.state.createCheckpoint();
  const edited = await call(reviewCase.f, TOOL_EDIT_OWN_COMMENT, {
    thread: { number: 8, kind: 'pull' },
    commentId: reviewCase.shared,
    body: 'review edited',
    review: true,
  });
  assert.notEqual(edited.isError, true);
  assert.deepEqual(reviewCase.f.api.callsTo('updateComment')[0].args, [
    TEST_REPO,
    reviewCase.shared,
    'review edited',
    true,
  ]);
  assert.deepEqual(reviewCase.f.state.snapshot().edited[reviewCp.id], [
    {
      repo: 'anima-research/rayforce',
      commentId: reviewCase.shared,
      previousBody: 'review comment',
      review: true,
      thread: { number: 8, kind: 'pull' },
    },
  ]);

  const issueCase = colliding();
  const issueCp = issueCase.f.state.createCheckpoint();
  const issueEdited = await call(issueCase.f, TOOL_EDIT_OWN_COMMENT, {
    thread: 8,
    commentId: issueCase.shared,
    body: 'top-level edited',
    review: false,
  });
  assert.notEqual(issueEdited.isError, true);
  assert.deepEqual(issueCase.f.api.callsTo('updateComment')[0].args, [
    TEST_REPO,
    issueCase.shared,
    'top-level edited',
    false,
  ]);
  const booked = issueCase.f.state.snapshot().edited[issueCp.id][0];
  assert.equal(booked.previousBody, 'top-level comment');
  assert.equal(booked.review, false);
});

test('delete_own_comment refuses a colliding id until the caller names the endpoint', async () => {
  const ambiguousCase = colliding();
  ambiguousCase.f.state.createCheckpoint();
  const ambiguous = await call(ambiguousCase.f, TOOL_DELETE_OWN_COMMENT, {
    thread: { number: 8, kind: 'pull' },
    commentId: ambiguousCase.shared,
  });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /names both an issue comment and a review comment/);
  assert.equal(ambiguousCase.f.api.callsTo('deleteComment').length, 0, 'nothing is deleted while it is unclear');
  assert.deepEqual(ambiguousCase.f.state.snapshot().deleted, {});

  const reviewCase = colliding();
  const reviewCp = reviewCase.f.state.createCheckpoint();
  const deleted = await call(reviewCase.f, TOOL_DELETE_OWN_COMMENT, {
    thread: 8,
    commentId: reviewCase.shared,
    review: true,
  });
  assert.notEqual(deleted.isError, true);
  assert.deepEqual(reviewCase.f.api.callsTo('deleteComment')[0].args, [TEST_REPO, reviewCase.shared, true]);
  assert.deepEqual(reviewCase.f.state.snapshot().deleted[reviewCp.id], [
    {
      repo: 'anima-research/rayforce',
      commentId: reviewCase.shared,
      previousBody: 'review comment',
      review: true,
      thread: { number: 8, kind: 'issue' },
    },
  ]);

  const issueCase = colliding();
  const issueCp = issueCase.f.state.createCheckpoint();
  const issueDeleted = await call(issueCase.f, TOOL_DELETE_OWN_COMMENT, {
    thread: 8,
    commentId: issueCase.shared,
    review: false,
  });
  assert.notEqual(issueDeleted.isError, true);
  assert.deepEqual(issueCase.f.api.callsTo('deleteComment')[0].args, [TEST_REPO, issueCase.shared, false]);
  const booked = issueCase.f.state.snapshot().deleted[issueCp.id][0];
  assert.equal(booked.previousBody, 'top-level comment');
  assert.equal(booked.review, false);
});
