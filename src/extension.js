'use strict';
const vscode = require('vscode');
const { repositoryRemote, fetchIssues, fetchPullRequests, assignIssueToMe, fetchIssueProjects, fetchInProgressIssues, startIssueProgress } = require('./github');

async function activate(context) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const git = (await gitExtension.activate()).getAPI(1);
  const changed = new vscode.EventEmitter();
  let rows = [], pulls = [], current, pinned, requestController, disposed = false;
  let state = context.workspaceState.get('issueState', 'open');
  if (!['open', 'closed', 'all'].includes(state)) state = 'open';
  let page = 1, hasMore = false, busy = false;
  const issueTargets = new WeakMap();
  const actions = new Map();
  const filters = { open: vscode.l10n.t("Open"), closed: vscode.l10n.t("Closed"), all: vscode.l10n.t("All") };
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: item => item,
    getChildren: item => item ? item.children : rows
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

  function issueItem(issue, repo, pull = false, inProgress = false) {
    const item = new vscode.TreeItem(`#${issue.number}  ${issue.title}`);
    item.id = `${repo.fullName}#${issue.number}`;
    if (!pull) issueTargets.set(item, { repo, number: issue.number });
    const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean).join(', ');
    inProgress = inProgress && !pull && issue.state !== 'closed';
    item.description = [inProgress && vscode.l10n.t("In progress"), labels].filter(Boolean).join(' · ');
    item.iconPath = pull ? new vscode.ThemeIcon(issue.draft ? 'git-pull-request-draft' : 'git-pull-request',
      new vscode.ThemeColor(issue.draft ? 'disabledForeground' : 'charts.green')) :
      new vscode.ThemeIcon(issue.state === 'closed' ? 'issue-closed' : inProgress ? 'wrench' : 'issues',
        new vscode.ThemeColor(issue.state === 'closed' ? 'charts.purple' : inProgress ? 'charts.yellow' : 'charts.green'));
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`#${issue.number} ${issue.title}\n\n${filters[issue.state] || issue.state}`);
    if (inProgress) tooltip.appendText(`\n${vscode.l10n.t("Project status: In progress")}`);
    if (labels) tooltip.appendText(`\n${vscode.l10n.t("Labels: {0}", labels)}`);
    if (issue.body) tooltip.appendText(`\n\n${String(issue.body).slice(0, 1500)}`);
    item.tooltip = tooltip;
    item.command = { command: 'projectIssues.openIssue', title: vscode.l10n.t("Open issue on GitHub"), arguments: [`https://github.com/${repo.fullName}/${pull ? 'pull' : 'issues'}/${issue.number}`] };
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
    let session;
    try {
      if (!repo) {
        message(vscode.l10n.t("Open a project with a GitHub remote."));
        return;
      }
      // Reuse granted scopes without prompting; initial sign-in only requests read:user.
      session = await vscode.authentication.getSession('github', ['repo', 'project'], { silent: true }) ||
        await vscode.authentication.getSession('github', ['repo', 'read:project'], { silent: true }) ||
        await vscode.authentication.getSession('github', ['repo'], { silent: true }) ||
        await vscode.authentication.getSession('github', ['read:user'], { silent: true });
      if (controller.signal.aborted) return;
      if (!session) {
        message(vscode.l10n.t("Sign in to GitHub"), 'projectIssues.signIn');
        return;
      }
      const [result, pullRequests] = await Promise.all([
        fetchIssues(repo, requestedState, targetPage, session.accessToken, controller.signal, fetch, vscode.l10n.t),
        more ? undefined : fetchPullRequests(repo, session.accessToken, controller.signal, fetch, vscode.l10n.t)
      ]);
      if (controller.signal.aborted) return;
      let inProgress = new Set(), statusNotice;
      if (result.issues.some(issue => issue.state !== 'closed')) {
        if (session.scopes?.some(scope => ['project', 'read:project'].includes(scope))) {
          try {
            inProgress = await fetchInProgressIssues(repo, result.issues, session.accessToken, controller.signal, fetch, vscode.l10n.t);
          } catch (error) {
            statusNotice = new vscode.TreeItem(vscode.l10n.t("Project status unavailable – Try again"));
            statusNotice.tooltip = error.message;
            statusNotice.command = { command: 'projectIssues.refresh', title: vscode.l10n.t("Load project status") };
          }
        } else {
          statusNotice = new vscode.TreeItem(vscode.l10n.t("Show project status – Grant access"));
          statusNotice.command = { command: 'projectIssues.signInProjects', title: vscode.l10n.t("Load project status") };
        }
      }
      if (controller.signal.aborted) return;
      if (pullRequests) pulls = pullRequests.map(pull => Object.assign(issueItem(pull, repo, true), { contextValue: 'pullRequest' }));
      page = targetPage;
      hasMore = result.hasMore;
      const existing = new Set(previousRows.map(item => item.id));
      rows = [...previousRows, ...result.issues.map(issue => issueItem(issue, repo, false, inProgress.has(issue.number))).filter(item => !existing.has(item.id))];
      for (const item of rows) item.contextValue = 'issue';
      if (hasMore) {
        const next = new vscode.TreeItem(vscode.l10n.t("Load more issues…"));
        next.command = { command: 'projectIssues.loadMore', title: vscode.l10n.t("Load more issues") };
        rows.push(next);
      }
      if (!rows.length) rows.push(new vscode.TreeItem(vscode.l10n.t("No issues for this status.")));
      if (statusNotice) rows.push(statusNotice);
      if (pulls.length) {
        const group = new vscode.TreeItem(vscode.l10n.t("Pull requests"), vscode.TreeItemCollapsibleState.Expanded);
        group.id = 'pullRequests';
        group.description = String(pulls.length);
        group.children = pulls;
        rows.push(group);
      }
      changed.fire();
    } catch (error) {
      if (!controller.signal.aborted && error.status === 404 && !session?.scopes?.includes('repo')) {
        message(vscode.l10n.t("Repository not found. Private repository? Grant access"), 'projectIssues.signInPrivate');
      } else if (!controller.signal.aborted) {
        const explanation = error.name === 'TimeoutError' ? vscode.l10n.t("The request to GitHub timed out.") :
          error.message === 'fetch failed' ? vscode.l10n.t("Cannot reach GitHub. Check your network connection.") : error.message;
        message(vscode.l10n.t("{0} – Try again", explanation), 'projectIssues.refresh');
      }
    } finally {
      if (requestController === controller) busy = false;
    }
  }

  async function signIn(scopes) {
    try {
      await vscode.authentication.getSession('github', scopes, { createIfNone: true });
      await refresh();
    } catch { vscode.window.showErrorMessage(vscode.l10n.t("GitHub sign-in was cancelled or failed.")); }
  }

  async function updateIssue(item, start) {
    const target = issueTargets.get(item);
    if (disposed || !target || actions.has(item.id)) return;
    const { repo, number } = target;
    const controller = new AbortController();
    actions.set(item.id, controller);
    try {
      const session = await vscode.authentication.getSession('github', ['repo', 'project'], { silent: true }) ||
        await vscode.authentication.getSession('github', start ? ['repo', 'project'] : ['repo'], { createIfNone: true });
      controller.signal.throwIfAborted();
      if (!session) return;
      if (start) {
        const projects = await fetchIssueProjects(repo, number, session.accessToken, controller.signal, fetch, vscode.l10n.t);
        if (!projects.length) throw new Error(vscode.l10n.t("This issue does not belong to an active GitHub Project. Add it to a project first."));
        const project = projects.length === 1 ? projects[0] : (await vscode.window.showQuickPick(
          projects.map(project => ({ label: project.title, description: project.url, project })),
          { title: vscode.l10n.t("Which project should be set to In progress?") }
        ))?.project;
        if (!project) return;
        controller.signal.throwIfAborted();
        await startIssueProgress(project, session.accessToken, controller.signal, fetch, vscode.l10n.t);
        vscode.window.showInformationMessage(vscode.l10n.t("Issue #{0}: status in {1} set to In progress.", number, project.title));
      } else {
        await assignIssueToMe(repo, number, session.accessToken, controller.signal, fetch, vscode.l10n.t);
        vscode.window.showInformationMessage(vscode.l10n.t("Issue #{0} is now assigned to you.", number));
      }
      if (selected()?.fullName === repo.fullName) await refresh();
    } catch (error) {
      if (!controller.signal.aborted) vscode.window.showErrorMessage(vscode.l10n.t("Could not update issue #{0}: {1}", number, error.message));
    } finally {
      actions.delete(item.id);
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
    vscode.commands.registerCommand('projectIssues.signIn', () => signIn(['read:user'])),
    vscode.commands.registerCommand('projectIssues.signInPrivate', () => signIn(['repo'])),
    vscode.commands.registerCommand('projectIssues.signInProjects', () => signIn(['repo', 'read:project'])),
    vscode.commands.registerCommand('projectIssues.takeIssue', item => updateIssue(item, false)),
    vscode.commands.registerCommand('projectIssues.startImplementation', item => updateIssue(item, true)),
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
      if (typeof url === 'string' && /^https:\/\/github\.com\/[a-z\d-]+\/[a-z\d_.-]+\/(?:issues|pull)\/\d+$/i.test(url)) {
        return vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    { dispose() { disposed = true; requestController?.abort(); for (const controller of actions.values()) controller.abort(); for (const listener of watchers.values()) listener.dispose(); } }
  );
  await refresh();
}

module.exports = { activate };
