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
  const subscribe = name => listener => { events[name] = listener; return { dispose() {} }; };
  const repository = name => ({
    rootUri: { toString: () => `file:///${name}`, fsPath: `/${name}` },
    state: { remotes: [{ name: 'origin', fetchUrl: `git@github.com:owner/${name}.git` }], onDidChange: subscribe(name) }
  });
  const first = repository('first');
  const second = repository('second');
  let activeRepository = first, provider, picker;
  const sessions = {};
  const git = { repositories: [first, second], getRepository: () => activeRepository,
    onDidOpenRepository: subscribe('openRepo'), onDidCloseRepository: subscribe('closeRepo') };
  const vscode = {
    l10n: { t },
    extensions: { getExtension: () => ({ activate: async () => ({ getAPI: () => git }) }) },
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class {}, ThemeColor: class {},
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
      showErrorMessage: value => assert.fail(value),
      showQuickPick: async () => picker
    },
    authentication: {
      getSession: async (_provider, scopes, options) => {
        const key = scopes.join();
        assert.ok(['repo', 'read:user'].includes(key), key);
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
    const item = provider.getChildren()[0];
    await commands.get(item.command.command)(...item.command.arguments);
    assert.deepEqual(opened, ['https://github.com/owner/second/issues/22']);
    const [, separator, pull] = provider.getChildren();
    assert.equal(separator.label, t('Pull requests'));
    assert.equal(separator.command, undefined);
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
