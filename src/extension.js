'use strict';
const vscode = require('vscode');
const { repositoryRemote, fetchIssues } = require('./github');

async function activate(context) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const git = (await gitExtension.activate()).getAPI(1);
  const changed = new vscode.EventEmitter();
  let rows = [], current, pinned, requestController, disposed = false;
  let state = context.workspaceState.get('issueState', 'open');
  if (!['open', 'closed', 'all'].includes(state)) state = 'open';
  let page = 1, hasMore = false, busy = false;
  const filters = { open: vscode.l10n.t("Open"), closed: vscode.l10n.t("Closed"), all: vscode.l10n.t("All") };
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: item => item,
    getChildren: () => rows
  };
  const view = vscode.window.createTreeView('projectIssues.list', { treeDataProvider: provider, showCollapseAll: false });
  context.subscriptions.push(changed, view);

  function message(text, command, title) {
    const item = new vscode.TreeItem(text);
    if (command) item.command = { command, title: title || text };
    rows = [item];
    changed.fire();
  }

  function selected() {
    const editor = vscode.window.activeTextEditor;
    const repository = (pinned && git.repositories.includes(pinned) && pinned) ||
      (editor && git.getRepository(editor.document.uri)) || git.repositories[0];
    const remote = repository && repositoryRemote(repository);
    return remote && { ...remote, root: repository.rootUri.toString() };
  }

  function issueItem(issue, repo) {
    const item = new vscode.TreeItem(`#${issue.number}  ${issue.title}`);
    item.id = `${repo.fullName}#${issue.number}`;
    item.description = (issue.labels || []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean).join(', ');
    item.iconPath = new vscode.ThemeIcon(issue.state === 'closed' ? 'issue-closed' : 'issues',
      new vscode.ThemeColor(issue.state === 'closed' ? 'charts.purple' : 'charts.green'));
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`#${issue.number} ${issue.title}\n\n${filters[issue.state] || issue.state}`);
    if (item.description) tooltip.appendText(`\n${vscode.l10n.t("Labels: {0}", item.description)}`);
    if (issue.body) tooltip.appendText(`\n\n${String(issue.body).slice(0, 1500)}`);
    item.tooltip = tooltip;
    item.command = { command: 'projectIssues.openIssue', title: vscode.l10n.t("Open issue on GitHub"), arguments: [`https://github.com/${repo.fullName}/issues/${issue.number}`] };
    return item;
  }

  async function refresh(more = false) {
    if (disposed || (more && (busy || !hasMore))) return;
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const repo = selected();
    current = repo;
    const requestedState = state;
    const targetPage = more ? page + 1 : 1;
    const previousRows = more ? rows.filter(item => item.contextValue === 'issue') : [];
    busy = true;
    hasMore = false;
    view.description = repo ? `${repo.fullName} · ${filters[state]}` : undefined;
    message(vscode.l10n.t("Loading issues…"));
    try {
      if (!repo) {
        message(vscode.l10n.t("Open a project with a GitHub remote."));
        return;
      }
      const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
      if (controller.signal.aborted) return;
      if (!session) {
        message(vscode.l10n.t("Sign in to GitHub"), 'projectIssues.signIn');
        return;
      }
      const result = await fetchIssues(repo, requestedState, targetPage, session.accessToken, controller.signal, fetch, vscode.l10n.t);
      if (controller.signal.aborted) return;
      page = targetPage;
      hasMore = result.hasMore;
      const existing = new Set(previousRows.map(item => item.id));
      rows = [...previousRows, ...result.issues.map(issue => issueItem(issue, repo)).filter(item => !existing.has(item.id))];
      for (const item of rows) item.contextValue = 'issue';
      if (hasMore) {
        const next = new vscode.TreeItem(vscode.l10n.t("Load more issues…"));
        next.command = { command: 'projectIssues.loadMore', title: vscode.l10n.t("Load more issues") };
        rows.push(next);
      }
      if (!rows.length) message(vscode.l10n.t("No issues for this status."));
      else changed.fire();
    } catch (error) {
      if (!controller.signal.aborted) {
        const explanation = error.name === 'TimeoutError' ? vscode.l10n.t("The request to GitHub timed out.") :
          error.message === 'fetch failed' ? vscode.l10n.t("Cannot reach GitHub. Check your network connection.") : error.message;
        message(vscode.l10n.t("{0} – Try again", explanation), 'projectIssues.refresh');
      }
    } finally {
      if (requestController === controller) busy = false;
    }
  }

  function syncRepository() {
    const next = selected();
    if (next?.root !== current?.root || next?.fullName !== current?.fullName) void refresh();
  }
  const watchers = new Map();
  function watch(repository) {
    if (!watchers.has(repository)) watchers.set(repository, repository.state.onDidChange(syncRepository));
    syncRepository();
  }
  for (const repository of git.repositories) watch(repository);
  context.subscriptions.push(
    git.onDidOpenRepository(watch),
    git.onDidCloseRepository(repository => {
      watchers.get(repository)?.dispose();
      watchers.delete(repository);
      if (pinned === repository) pinned = undefined;
      syncRepository();
    }),
    vscode.window.onDidChangeActiveTextEditor(syncRepository),
    vscode.authentication.onDidChangeSessions(event => { if (event.provider.id === 'github') void refresh(); }),
    vscode.commands.registerCommand('projectIssues.refresh', () => refresh()),
    vscode.commands.registerCommand('projectIssues.loadMore', () => refresh(true)),
    vscode.commands.registerCommand('projectIssues.signIn', async () => {
      try {
        await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
        await refresh();
      } catch { vscode.window.showErrorMessage(vscode.l10n.t("GitHub sign-in was cancelled or failed.")); }
    }),
    vscode.commands.registerCommand('projectIssues.filter', async () => {
      const choice = await vscode.window.showQuickPick(Object.entries(filters).map(([value, label]) => ({ label, value })), { title: vscode.l10n.t("Which issues should be shown?") });
      if (choice) {
        state = choice.value;
        await context.workspaceState.update('issueState', state);
        await refresh();
      }
    }),
    vscode.commands.registerCommand('projectIssues.selectRepository', async () => {
      const choices = [{ label: vscode.l10n.t("Automatic: project of the active file"), repository: undefined },
        ...git.repositories.filter(repo => repositoryRemote(repo)).map(repo => ({ label: repositoryRemote(repo).fullName, description: repo.rootUri.fsPath, repository: repo }))];
      const choice = await vscode.window.showQuickPick(choices, { title: vscode.l10n.t("Select repository") });
      if (choice) { pinned = choice.repository; await refresh(); }
    }),
    vscode.commands.registerCommand('projectIssues.openIssue', url => {
      if (typeof url === 'string' && /^https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+\/issues\/\d+$/i.test(url)) {
        return vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    { dispose() { disposed = true; requestController?.abort(); for (const listener of watchers.values()) listener.dispose(); } }
  );
  await refresh();
}

module.exports = { activate };
