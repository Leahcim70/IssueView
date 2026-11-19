# IssueView

English | [Deutsch](README.de.md)

GitHub issues for your current project, directly in Visual Studio Code's **secondary sidebar (right by default)**.

## Features

- Detects the current GitHub repository from Git remotes.
- Shows issue numbers, titles, assigned accounts, labels and a description preview.
- Opens issues on GitHub with one click.
- Right-click an issue to assign yourself or set its GitHub Project status to **In progress**.
- Highlights open issues that are **In progress** with a yellow wrench icon and a status label.
- Filters open, closed or all issues.
- Lists open pull requests below the issues in a collapsible "Pull requests" group.
- Follows the active file's repository or pins a selected repository.
- Supports public and private GitHub.com repositories through VS Code's built-in sign-in.
- **English and German UI**, following VS Code's display language.
- No runtime dependencies, separate GitHub CLI, telemetry, or background polling.

## Install

Requires **VS Code 1.106+** on Windows, macOS or Linux.

1. Download `issueview-0.4.1.vsix` from the [latest release](https://github.com/Leahcim70/IssueView/releases/latest).
2. In VS Code, open **Extensions → … → Install from VSIX…** and select it.
3. Open a trusted project folder with a GitHub remote.
4. In **IssueView**, select **Sign in to GitHub**.

If the sidebar is hidden, enable **View → Appearance → Secondary Side Bar**, or use **View: Open View… → IssueView**. Placement follows your VS Code layout.

```sh
code --install-extension issueview-0.4.1.vsix
```

The prototype used the extension name `project-issues-sidebar`. Uninstall it before installing IssueView to avoid duplicate views.

## Language

Use **Configure Display Language** in the command palette to change VS Code's display language. IssueView uses German for the German locale and English as its default fallback. Commands, filters, empty states and errors are localized. Issue titles and bodies stay in their original language.

## Behavior

The toolbar provides **Refresh**, **Filter by status**, and **Select repository**. Automatic mode uses the active editor's repository, falling back to the first detected Git repository. Remote selection prefers the current branch's upstream, then `origin`, then another recognized GitHub remote.

**Load more issues** fetches the next API page. Pages may contain fewer than 100 issues because pull requests are excluded. Use Refresh for updates; there is no periodic polling.

Assigned accounts appear as **@username** in the issue row and in the tooltip. All assignees are shown; unassigned issues have no assignment label.

Right-click an issue and choose **Assign to me** to add your signed-in GitHub account as an assignee, keeping existing assignees. **Start implementation** sets the issue's **Status** field to **In progress** in its GitHub Project. If it belongs to several active projects, choose the project to update. The issue must already belong to a project with that field and option; closed projects and archived items are excluded. Missing project setup or permissions produces an error message. These actions are separate: starting implementation does not assign the issue.

Open issues with **In progress** in at least one active GitHub Project appear with a yellow wrench icon and an **In progress** label. Closed issues keep their purple closed icon. Project status is read in batches when loading or refreshing issues, including after **Start implementation**. If access is missing, click **Show project status – Grant access** in the list. If the status lookup fails, the issue list remains available with a retry entry.

## Authentication and privacy

IssueView uses VS Code's built-in GitHub authentication provider. Tokens are never written to settings or logs. API requests go only to `https://api.github.com`; issue links open only on `https://github.com`.

Sign-in requests only the `read:user` scope, which is enough to read public repositories. Reading private repositories and assigning issues require GitHub's `repo` scope. Displaying Project status requests `repo` and `read:project`; an existing session with `repo` and `project` is also reused. Updating Project status requires the `project` scope. IssueView requests these permissions when needed; private repository access can also be granted via **IssueView: Grant access to private repositories**. Write requests run only when you use an issue's context menu action. Your account also needs permission to edit the issue or project. Organization SSO may require additional authorization. Manage sign-in and extension access through VS Code's account menu.

GitLab, Azure DevOps, self-hosted GitHub Enterprise, virtual browser-only workspaces and custom SSH host aliases are not supported.

## Development

Requires Node.js 22+ for tests and Python 3 for packaging. No `npm install` is needed.

```sh
npm test
npm run package
```

Packaging writes `dist/issueview-0.4.1.vsix`. The VSIX includes source code, translations, documentation, tests and packaging script. Attach the tested build to a GitHub release; publishing the release uploads that VSIX to the VS Code Marketplace. See [PUBLISHING.md](PUBLISHING.md) (German).

Tests cover repository detection, safe API targets, authentication headers, pagination, errors, cancellation, project switches during requests, both UI languages and translation completeness. The actual GitHub OAuth flow requires a manual check with an authorized account.

## References

- [VS Code secondary sidebar](https://code.visualstudio.com/updates/v1_106)
- [VS Code localization](https://github.com/microsoft/vscode-l10n)
- [GitHub issues API](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10)
- [GitHub Projects API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects)

## License

[MIT](LICENSE) · Michael Lantzen
