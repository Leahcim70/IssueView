'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRemote, repositoryRemote, fetchIssues, fetchPullRequests } = require('../src/github');

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
