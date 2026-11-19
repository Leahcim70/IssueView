'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRemote, repositoryRemote, fetchIssues, fetchPullRequests, assignIssueToMe, fetchIssueProjects, fetchInProgressIssues, startIssueProgress } = require('../src/github');

test('HTTPS, SSH, SCP and Git remotes resolve to the same repository', () => {
  for (const remote of ['https://github.com/Owner/project.git', 'git@github.com:Owner/project.git', 'ssh://git@github.com/Owner/project', 'git://github.com/Owner/project.git', 'https://github.com/Owner/project/']) {
    assert.deepEqual(parseRemote(remote), { owner: 'Owner', name: 'project', fullName: 'Owner/project' });
  }
});

test('untrusted hosts, malformed paths and query injection are rejected', () => {
  for (const remote of [undefined, '', 'https://github.com.evil.test/o/r', 'https://github.com@evil.test/o/r', 'https://gitlab.com/o/r', 'https://github.com/o/r?x=y', 'https://github.com/o/r/extra', 'file:///o/r', 'git@github.com:o/r#bad', 'https://github.com/o/%2e%2e', 'https://github.com:8443/o/r']) {
    assert.equal(parseRemote(remote), undefined, String(remote));
  }
});

test('upstream takes precedence over origin; non-GitHub remotes are skipped', () => {
  const repo = { state: { HEAD: { upstream: { remote: 'work' } }, remotes: [
    { name: 'origin', fetchUrl: 'git@github.com:owner/origin.git' },
    { name: 'work', fetchUrl: 'git@github.com:owner/work.git' }
  ] } };
  assert.equal(repositoryRemote(repo).name, 'work');
  repo.state.remotes[1].fetchUrl = 'https://gitlab.com/owner/work';
  assert.equal(repositoryRemote(repo).name, 'origin');
});

const repo = parseRemote('https://github.com/owner/repo');
const signal = () => new AbortController().signal;
test('issues exclude PRs; server pagination and authentication are preserved', async () => {
  const result = await fetchIssues(repo, 'open', 2, 'test-token', signal(), async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.github.com');
    assert.equal(new URL(url).searchParams.get('page'), '2');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify([
      { number: 1, title: 'Issue' }, { number: 2, title: 'PR', pull_request: {} }, { title: 'invalid' }
    ]), { headers: { link: '<https://api.github.com/example?page=3>; rel="next"' } });
  });
  assert.deepEqual(result.issues, [{ number: 1, title: 'Issue' }]);
  assert.equal(result.hasMore, true);
});

test('a page containing only pull requests still offers the next page', async () => {
  const result = await fetchIssues(repo, 'all', 1, 'token', signal(), async () => new Response('[{"number":1,"title":"PR","pull_request":{}}]', { headers: { link: '<https://api.github.com/next>; rel="next"' } }));
  assert.equal(result.issues.length, 0);
  assert.equal(result.hasMore, true);
});

test('HTTP failures and malformed responses produce actionable errors', async () => {
  for (const [status, expected] of [[401, /sign-in/], [403, /SSO/], [404, /access denied/], [429, /rate limit/], [500, /HTTP 500/]]) {
    await assert.rejects(fetchIssues(repo, 'open', 1, 'token', signal(), async () => new Response('{}', { status })), expected);
  }
  await assert.rejects(fetchIssues(repo, 'open', 1, 'token', signal(), async () => new Response('{}')), /Unexpected/);
});

test('invalid request parameters never reach the network', async () => {
  await assert.rejects(fetchIssues({ fullName: 'owner/repo?token=bad' }, 'open', 1, 'secret', signal(), () => assert.fail('network called')), /Invalid/);
});

test('cancellation reaches the HTTP request', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchIssues(repo, 'open', 1, 'token', controller.signal, async (_url, options) => { options.signal.throwIfAborted(); }), { name: 'AbortError' });
});

test('open pull requests are requested from the pulls endpoint', async () => {
  const pulls = await fetchPullRequests(repo, 'token', signal(), async url => {
    assert.equal(new URL(url).pathname, '/repos/owner/repo/pulls');
    assert.equal(new URL(url).searchParams.get('state'), 'open');
    return new Response('[{"number":3,"title":"PR"},{"title":"invalid"}]');
  });
  assert.deepEqual(pulls, [{ number: 3, title: 'PR' }]);
});

const json = value => new Response(JSON.stringify(value));
test('take issue uses the authenticated login and adds it without replacing existing assignees', async () => {
  const calls = [];
  await assignIssueToMe(repo, 42, 'token', signal(), async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/user')) return json({ login: 'me' });
    assert.equal(url, 'https://api.github.com/repos/owner/repo/issues/42/assignees');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { assignees: ['me'] });
    return json({ assignees: [{ login: 'existing' }, { login: 'me' }] });
  });
  assert.equal(calls.length, 2);
});

test('assignment detects silently ignored writes and HTTP permission failures', async () => {
  await assert.rejects(assignIssueToMe(repo, 1, 'token', signal(), async url =>
    json(url.endsWith('/user') ? { login: 'me' } : { assignees: [] })), /did not assign/);
  await assert.rejects(assignIssueToMe(repo, 1, 'token', signal(), async url =>
    url.endsWith('/user') ? json({ login: 'me' }) : new Response('{}', { status: 403 })), /denied access/);
  await assert.rejects(assignIssueToMe(repo, 1, 'token', signal(), async () => json({})), /Unexpected/);
});

test('write targets are validated before sending credentials', async () => {
  for (const action of [assignIssueToMe, fetchIssueProjects]) {
    for (const [target, number] of [[{ fullName: 'owner/repo?bad' }, 1], [repo, -1], [repo, '1']]) {
      await assert.rejects(action(target, number, 'secret', signal(), () => assert.fail('network called')), /Invalid/);
    }
  }
});

const projectItem = (id, extra = {}) => ({ id: `item-${id}`, isArchived: false, project: {
  id, title: id, url: `https://github.com/users/owner/projects/${id}`, closed: false,
  field: { id: `field-${id}`, options: [{ id: 'todo', name: 'Todo' }, { id: `progress-${id}`, name: 'In Progress' }] }
}, ...extra });
const projectPage = (nodes, hasNextPage = false, endCursor = null) => ({ data: { repository: { issue: {
  projectItems: { nodes, pageInfo: { hasNextPage, endCursor } }
} } } });

test('project lookup paginates and excludes archived items and closed projects', async () => {
  let calls = 0;
  const closed = projectItem('closed'); closed.project.closed = true;
  const result = await fetchIssueProjects(repo, 42, 'token', signal(), async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.method, 'POST');
    const { variables } = JSON.parse(options.body);
    assert.deepEqual(variables, { owner: 'owner', name: 'repo', number: 42, cursor: calls ? 'next' : null });
    return json(calls++ ? projectPage([projectItem('two')]) :
      projectPage([projectItem('one'), projectItem('archived', { isArchived: true }), closed, null], true, 'next'));
  });
  assert.deepEqual(result.map(project => [project.projectId, project.itemId, project.fieldId, project.optionId]), [
    ['one', 'item-one', 'field-one', 'progress-one'], ['two', 'item-two', 'field-two', 'progress-two']
  ]);
  assert.equal(calls, 2);
});

test('start progress changes only the selected project item status', async () => {
  const project = { projectId: 'project', itemId: 'item', fieldId: 'status', optionId: 'progress' };
  await startIssueProgress(project, 'token', signal(), async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    const { query, variables } = JSON.parse(options.body);
    assert.match(query, /updateProjectV2ItemFieldValue/);
    assert.deepEqual(variables.input, { projectId: 'project', itemId: 'item', fieldId: 'status', value: { singleSelectOptionId: 'progress' } });
    return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } } });
  });
  await assert.rejects(startIssueProgress({ ...project, optionId: undefined }, 'token', signal(), () => assert.fail('network called')), /In progress option/);
  await assert.rejects(startIssueProgress(project, 'token', signal(), async () => json({ data: {} })), /Unexpected/);
  await assert.rejects(startIssueProgress(project, 'token', signal(), async () => json({ errors: [{ message: 'Forbidden' }] })), /project permissions/);
});

test('project lookup rejects GraphQL errors, malformed results and broken pagination', async () => {
  for (const response of [{ errors: [{ message: 'Forbidden' }], data: {} }, { data: { repository: null } }, projectPage([], true)]) {
    await assert.rejects(fetchIssueProjects(repo, 1, 'token', signal(), async () => json(response)), /project permissions|Unexpected/);
  }
  assert.deepEqual(await fetchIssueProjects(repo, 1, 'token', signal(), async () => json(projectPage([]))), []);
});

const statusItem = (name, extra = {}) => ({ isArchived: false, project: { closed: false }, fieldValueByName: { name }, ...extra });
const statusItems = (nodes, hasNextPage = false) => ({ projectItems: { nodes, pageInfo: { hasNextPage } } });

test('progress statuses are batched and match any active project, not archived or closed ones', async () => {
  const issues = [1, 2, 3, 4, 5].map(number => ({ number, state: number === 5 ? 'closed' : 'open' }));
  let calls = 0;
  const result = await fetchInProgressIssues(repo, issues, 'token', signal(), async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/graphql');
    const { query, variables } = JSON.parse(options.body);
    assert.deepEqual(variables, { owner: 'owner', name: 'repo' });
    assert.match(query, /fieldValueByName\(name: "Status"\)/);
    assert.doesNotMatch(query, /issue_5/);
    return json({ data: { repository: {
      issue_1: statusItems([statusItem('Todo'), statusItem(' IN PROGRESS ')]),
      issue_2: statusItems([statusItem('In progress', { isArchived: true }), statusItem('In progress', { project: { closed: true } })]),
      issue_3: statusItems([null, statusItem('Done'), statusItem(null)]),
      issue_4: statusItems([])
    } } });
  });
  assert.deepEqual([...result], [1]);
  assert.equal(calls, 1);
});

test('progress lookup follows project pagination beyond the first hundred items', async () => {
  let calls = 0;
  const result = await fetchInProgressIssues(repo, [{ number: 42, state: 'open' }], 'token', signal(), async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    calls++;
    if (calls === 1) return json({ data: { repository: { issue_42: statusItems([], true) } } });
    if (calls === 2) {
      assert.equal(variables.cursor, null);
      return json(projectPage([projectItem('todo', { fieldValueByName: { name: 'Todo' } })], true, 'next'));
    }
    assert.equal(variables.cursor, 'next');
    return json(projectPage([projectItem('active', { fieldValueByName: { name: 'In progress' } })]));
  });
  assert.deepEqual([...result], [42]);
  assert.equal(calls, 3);
});

test('progress lookup limits batches to 100 and avoids requests for closed or empty lists', async () => {
  const issues = Array.from({ length: 101 }, (_, index) => ({ number: index + 1, state: 'open' }));
  const batchSizes = [];
  await fetchInProgressIssues(repo, issues, 'token', signal(), async (_url, options) => {
    const aliases = [...JSON.parse(options.body).query.matchAll(/(issue_\d+):/g)].map(match => match[1]);
    batchSizes.push(aliases.length);
    return json({ data: { repository: Object.fromEntries(aliases.map(alias => [alias, statusItems([])])) } });
  });
  assert.deepEqual(batchSizes, [100, 1]);
  for (const issues of [[], [{ number: 1, state: 'closed' }]]) {
    assert.equal((await fetchInProgressIssues(repo, issues, 'token', signal(), () => assert.fail('network called'))).size, 0);
  }
});

test('progress lookup rejects invalid inputs and distinguishes unavailable status from no progress', async () => {
  await assert.rejects(fetchInProgressIssues(repo, [{ number: '1) { bad }' }], 'token', signal(), () => assert.fail('network called')), /Invalid/);
  await assert.rejects(fetchInProgressIssues({ fullName: 'owner/repo?bad' }, [], 'token', signal(), () => assert.fail('network called')), /Invalid/);
  for (const value of [{ errors: [{ message: 'Forbidden' }] }, { data: { repository: null } }]) {
    await assert.rejects(fetchInProgressIssues(repo, [{ number: 1 }], 'token', signal(), async () => json(value)), /permissions|Unexpected/);
  }
});
