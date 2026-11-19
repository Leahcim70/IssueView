'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

for (const locale of ['en', 'de']) test(`sidebar handles sign-in, stale requests and filters in ${locale}`, async () => {
  const translations = locale === 'de' ? require('../l10n/bundle.l10n.de.json') : {};
  const t = (message, ...args) => (translations[message] || message).replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
  const commands = new Map();
  const subscriptions = [];
  const events = {};
  const opened = [];
  const errors = [], notices = [], authRequests = [];
  const subscribe = name => listener => { events[name] = listener; return { dispose() {} }; };
  const repository = name => ({
    rootUri: { toString: () => `file:///${name}`, fsPath: `/${name}` },
    state: { remotes: [{ name: 'origin', fetchUrl: `git@github.com:owner/${name}.git` }], onDidChange: subscribe(name) }
  });
  const first = repository('first');
  const second = repository('second');
  let activeRepository = first, provider, picker, authFailure = false;
  const sessions = {};
  const git = { repositories: [first, second], getRepository: () => activeRepository,
    onDidOpenRepository: subscribe('openRepo'), onDidCloseRepository: subscribe('closeRepo') };
  const vscode = {
    l10n: { t },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => git }) }) },
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { Expanded: 2 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { value = ''; appendText(value) { this.value += value; } },
    Uri: { parse: value => value },
    env: { openExternal: async url => { opened.push(url); return true; } },
    window: {
      activeTextEditor: { document: { uri: 'active' } },
      createTreeView: (id, options) => {
        assert.equal(id, 'projectIssues.list'); provider = options.treeDataProvider;
        return { dispose() {} };
      },
      onDidChangeActiveTextEditor: subscribe('editor'),
      showErrorMessage: value => errors.push(value),
      showInformationMessage: value => notices.push(value),
      showQuickPick: async (choices, options) => typeof picker === 'function' ? picker(choices, options) : picker
    },
    authentication: {
      getSession: async (_provider, scopes, options) => {
        const key = scopes.join();
        assert.ok(['repo', 'read:user', 'repo,project', 'repo,read:project'].includes(key), key);
        authRequests.push({ key, ...options });
        if (authFailure) throw new Error('Sign-in cancelled');
        if (options.createIfNone) sessions[key] = { accessToken: `${key}-token`, scopes };
        return sessions[key];
      }, onDidChangeSessions: subscribe('auth')
    },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return { dispose() {} }; } }
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const pending = [];
  global.fetch = (url, options) => new URL(url).pathname.endsWith('/pulls')
    ? Promise.resolve(new Response('[{"number":7,"title":"Feature","state":"open","draft":true}]'))
    : new Promise(resolve => pending.push({ url, options, resolve }));
  Module._load = function (name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const reply = (request, number, title) => request.resolve(new Response(JSON.stringify([{ number, title, state: 'open', labels: [{ name: 'bug' }], body: '[unsafe](command:bad)' }])));
  try {
    delete require.cache[require.resolve('../src/extension')];
    const { activate } = require('../src/extension');
    await activate({ subscriptions, workspaceState: { get: (_name, fallback) => fallback, update: async () => {} } });
    assert.equal(provider.getChildren()[0].command.command, 'projectIssues.signIn');
    assert.equal(provider.getChildren()[0].label, locale === 'de' ? 'Bei GitHub anmelden' : 'Sign in to GitHub');
    const signIn = commands.get('projectIssues.signIn')();
    await flush();
    assert.equal(pending.length, 1);
    activeRepository = second;
    events.editor();
    await flush();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].options.signal.aborted, true);
    reply(pending[1], 22, 'Current project');
    await flush();
    reply(pending[0], 11, 'Old project');
    await signIn;
    assert.equal(provider.getChildren()[0].label, '#22  Current project');
    assert.equal(provider.getChildren()[0].description, 'bug');
    assert.ok(!provider.getChildren()[0].tooltip.value.includes(t('Assigned to: {0}', '')));
    const item = provider.getChildren()[0];
    await commands.get(item.command.command)(...item.command.arguments);
    assert.deepEqual(opened, ['https://github.com/owner/second/issues/22']);
    assert.equal(provider.getChildren()[1].command.command, 'projectIssues.signInProjects');
    const group = provider.getChildren().find(row => row.id === 'pullRequests');
    assert.equal(group.label, t('Pull requests'));
    assert.equal(group.command, undefined);
    assert.equal(group.collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    const [pull] = provider.getChildren(group);
    assert.equal(pull.label, '#7  Feature');
    await commands.get(pull.command.command)(...pull.command.arguments);
    assert.equal(opened.pop(), 'https://github.com/owner/second/pull/7');
    await commands.get('projectIssues.openIssue')('https://evil.test/secret');
    assert.equal(opened.length, 1);
    picker = { value: 'closed' };
    const filtered = commands.get('projectIssues.filter')();
    await flush();
    assert.equal(new URL(pending[2].url).searchParams.get('state'), 'closed');
    pending[2].resolve(new Response('[]'));
    await filtered;
    assert.equal(provider.getChildren()[0].label, t('No issues for this status.'));
    assert.equal(pending[2].options.headers.Authorization, 'Bearer read:user-token');
    const reload = commands.get('projectIssues.refresh')();
    await flush();
    pending[3].resolve(new Response('{}', { status: 404 }));
    await reload;
    assert.equal(provider.getChildren()[0].command.command, 'projectIssues.signInPrivate');
    const grant = commands.get('projectIssues.signInPrivate')();
    await flush();
    assert.equal(pending[4].options.headers.Authorization, 'Bearer repo-token');
    pending[4].resolve(new Response('[]'));
    await grant;
    assert.deepEqual(errors, []);

    const writes = [], queries = [];
    let projects = ['one'], missingStatus = false, denyWrite = false, releaseUser;
    let statusFixture = false, projectStatus = 'In progress', statusFailure = false, delayStatus = false;
    const pendingStatuses = [];
    const response = value => new Response(JSON.stringify(value));
    global.fetch = async (url, options) => {
      if (url.endsWith('/user')) return new Promise(resolve => { releaseUser = () => resolve(response({ login: 'me' })); });
      if (url.endsWith('/assignees')) {
        writes.push({ url, options });
        return denyWrite ? new Response('{}', { status: 403 }) : response({ assignees: [{ login: 'me' }] });
      }
      if (url.endsWith('/graphql')) {
        const body = JSON.parse(options.body);
        if (body.query.startsWith('mutation')) {
          writes.push({ url, options, body });
          projectStatus = 'In progress';
          return response({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: body.variables.input.itemId } } } });
        }
        if (body.query.includes('issue_')) {
          if (statusFailure) return response({ errors: [{ message: 'Forbidden' }] });
          const aliases = [...body.query.matchAll(/(issue_(\d+)):/g)];
          const result = { data: { repository: Object.fromEntries(aliases.map(([, alias, number]) => [alias, {
            projectItems: { nodes: [{ project: { closed: false }, isArchived: false,
              fieldValueByName: { name: number === '2' ? 'Todo' : projectStatus } }], pageInfo: { hasNextPage: false } }
          }])) } };
          if (delayStatus) return new Promise(resolve => pendingStatuses.push({ resolve: () => resolve(response(result)), options }));
          return response(result);
        }
        queries.push(body.variables);
        return response({ data: { repository: { issue: { projectItems: {
          nodes: projects.map(id => ({ id: `item-${id}`, project: { id, title: id, url: `https://github.com/users/owner/projects/${id}`,
            field: { id: `field-${id}`, options: missingStatus ? [] : [{ id: `progress-${id}`, name: 'In progress' }] } } })),
          pageInfo: { hasNextPage: false }
        } } } } });
      }
      if (statusFixture) {
        if (url.includes('/pulls?')) return response([{ number: 7, title: 'Feature', state: 'open', draft: true }]);
        const more = new URL(url).searchParams.get('page') === '2';
        return new Response(JSON.stringify((more ? [4] : [1, 2, 3]).map(number => ({
          number, title: `Issue ${number}`, state: number === 3 ? 'closed' : 'open', labels: [{ name: 'bug' }],
          assignees: number === 2 ? [] : number === 1 ? [{ login: 'alice' }, { login: 'bob' }] : [{ login: 'alice' }]
        }))), { headers: more ? {} : { link: '<https://api.github.com/next>; rel="next"' } });
      }
      return response([]);
    };
    const take = commands.get('projectIssues.takeIssue');
    const start = commands.get('projectIssues.startImplementation');
    for (const invalid of [undefined, group, pull, { id: item.id, contextValue: 'issue' }]) {
      await take(invalid); await start(invalid);
    }
    assert.equal(writes.length, 0);
    assert.equal(queries.length, 0);

    const taking = take(item);
    await flush();
    await take(item); await start(item); // Repeated clicks cannot submit a second write.
    activeRepository = first;
    events.editor();
    await flush();
    releaseUser();
    await taking;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, 'https://api.github.com/repos/owner/second/issues/22/assignees');
    assert.deepEqual(JSON.parse(writes[0].options.body), { assignees: ['me'] });
    assert.equal(notices.pop(), t('Issue #{0} is now assigned to you.', 22));

    await start(item);
    assert.equal(queries[0].name, 'second');
    assert.equal(queries[0].number, 22);
    assert.equal(writes[1].body.variables.input.projectId, 'one');
    assert.equal(writes[1].options.headers.Authorization, 'Bearer repo,project-token');
    assert.ok(authRequests.some(request => request.key === 'repo,project' && request.createIfNone));
    assert.equal(notices.pop(), t('Issue #{0}: status in {1} set to In progress.', 22, 'one'));

    projects = ['one', 'two'];
    picker = (choices, options) => {
      assert.equal(options.title, t('Which project should be set to In progress?'));
      return choices[1];
    };
    await start(item);
    assert.equal(writes[2].body.variables.input.projectId, 'two');
    picker = undefined;
    await start(item);
    assert.equal(writes.length, 3); // Dismissing project selection does not write.
    projects = [];
    await start(item);
    assert.equal(errors.pop(), t('Could not update issue #{0}: {1}', 22,
      t('This issue does not belong to an active GitHub Project. Add it to a project first.')));
    projects = ['one']; missingStatus = true;
    await start(item);
    assert.equal(errors.pop(), t('Could not update issue #{0}: {1}', 22,
      t('This project needs a Status field with an In progress option.')));
    assert.equal(writes.length, 3);

    denyWrite = true;
    const denied = take(item);
    await flush(); releaseUser(); await denied;
    assert.equal(errors.pop(), t('Could not update issue #{0}: {1}', 22,
      t('GitHub denied access (permissions, organization SSO, or API rate limit).')));
    authFailure = true;
    await take(item);
    assert.equal(errors.pop(), t('Could not update issue #{0}: {1}', 22, 'Sign-in cancelled'));
    assert.equal(writes.length, 4);
    authFailure = false;

    statusFixture = true;
    delete sessions['repo,project'];
    projects = ['one']; missingStatus = false; denyWrite = false;
    picker = { value: 'all' };
    await commands.get('projectIssues.filter')();
    assert.ok(provider.getChildren().some(row => row.command?.command === 'projectIssues.signInProjects'));
    await commands.get('projectIssues.signInProjects')();
    assert.ok(authRequests.some(request => request.key === 'repo,read:project' && request.createIfNone));
    let [working, waiting, closed] = provider.getChildren();
    assert.equal(working.iconPath.id, 'wrench');
    assert.equal(working.iconPath.color.id, 'charts.yellow');
    assert.equal(working.description, `${t('In progress')} · @alice, @bob · bug`);
    assert.ok(working.tooltip.value.includes(t('Assigned to: {0}', '@alice, @bob')));
    assert.ok(working.tooltip.value.includes(t('Project status: In progress')));
    assert.ok(working.tooltip.value.includes(t('Labels: {0}', 'bug')));
    assert.equal(waiting.iconPath.id, 'issues');
    assert.equal(waiting.iconPath.color.id, 'charts.green');
    assert.equal(waiting.description, 'bug');
    assert.ok(!waiting.tooltip.value.includes(t('Assigned to: {0}', '')));
    assert.equal(closed.iconPath.id, 'issue-closed');
    assert.equal(closed.iconPath.color.id, 'charts.purple');
    assert.equal(closed.description, '@alice · bug');
    assert.ok(closed.tooltip.value.includes(t('Assigned to: {0}', '@alice')));
    const draft = provider.getChildren(provider.getChildren().find(row => row.id === 'pullRequests'))[0];
    assert.equal(draft.iconPath.id, 'git-pull-request-draft');
    assert.equal(draft.iconPath.color.id, 'disabledForeground');

    await commands.get('projectIssues.loadMore')();
    const issueRows = provider.getChildren().filter(row => row.contextValue === 'issue');
    assert.equal(issueRows.length, 4);
    assert.equal(issueRows[0].iconPath.id, 'wrench');
    assert.equal(issueRows[3].iconPath.id, 'wrench');
    assert.equal(issueRows[3].description, `${t('In progress')} · @alice · bug`);
    projectStatus = 'Todo';
    await commands.get('projectIssues.refresh')();
    working = provider.getChildren()[0];
    assert.equal(working.iconPath.id, 'issues');
    await start(working);
    assert.equal(provider.getChildren()[0].iconPath.id, 'wrench');

    statusFailure = true;
    await commands.get('projectIssues.refresh')();
    assert.equal(provider.getChildren()[0].label, '#1  Issue 1');
    assert.equal(provider.getChildren()[0].iconPath.id, 'issues');
    assert.ok(provider.getChildren().some(row => row.label === t('Project status unavailable – Try again')));
    statusFailure = false;

    delayStatus = true;
    const oldStatus = commands.get('projectIssues.refresh')();
    await flush();
    projectStatus = 'Todo';
    activeRepository = second;
    events.editor();
    await flush();
    assert.equal(pendingStatuses.length, 2);
    assert.equal(pendingStatuses[0].options.signal.aborted, true);
    pendingStatuses[1].resolve();
    await flush();
    pendingStatuses[0].resolve();
    await oldStatus;
    assert.equal(provider.getChildren()[0].id, 'owner/second#1');
    assert.equal(provider.getChildren()[0].iconPath.id, 'issues');
    activeRepository = undefined;
    git.repositories = [];
    events.closeRepo(first); events.closeRepo(second);
    await flush();
    assert.equal(provider.getChildren()[0].label, t('Open a project with a GitHub remote.'));
  } finally {
    subscriptions.forEach(disposable => disposable.dispose());
    global.fetch = originalFetch;
    Module._load = originalLoad;
  }
});
