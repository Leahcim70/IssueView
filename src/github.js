'use strict';

function parseRemote(remote) {
  if (typeof remote !== 'string') return undefined;
  const value = remote.trim();
  let path;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(value);
  if (scp) path = scp[1];
  else {
    try {
      const url = new URL(value);
      if (!['https:', 'ssh:', 'git:'].includes(url.protocol) ||
          url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash ||
          (url.port && !(url.protocol === 'ssh:' && url.port === '22'))) return undefined;
      path = url.pathname.slice(1);
    } catch { return undefined; }
  }
  path = path.replace(/\/$/, '').replace(/\.git$/, '');
  const match = /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)$/i.exec(path);
  if (!match || ['.', '..'].includes(match[2])) return undefined;
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

function repositoryRemote(repository) {
  const remotes = repository.state.remotes;
  const preferred = [
    remotes.find(r => r.name === repository.state.HEAD?.upstream?.remote),
    remotes.find(r => r.name === 'origin'),
    ...remotes
  ];
  for (const remote of preferred) {
    const parsed = parseRemote(remote?.fetchUrl || remote?.pushUrl);
    if (parsed) return parsed;
  }
}

async function fetchIssues(repo, state, page, token, signal, request = fetch, t = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => String(args[index]))) {
  if (!parseRemote(`https://github.com/${repo.fullName}`) ||
      !['open', 'closed', 'all'].includes(state) || !Number.isSafeInteger(page) || page < 1) {
    throw new Error(t("Invalid repository query."));
  }
  const url = `https://api.github.com/repos/${repo.fullName}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`;
  const response = await request(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'project-issues-sidebar'
    },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)])
  });
  if (!response.ok) {
    const errors = {
      401: t("GitHub sign-in expired. Please sign in again."),
      403: t("GitHub denied access (permissions, organization SSO, or API rate limit)."),
      404: t("Repository not found or access denied."),
      429: t("GitHub API rate limit reached. Please refresh later.")
    };
    throw new Error(errors[response.status] || t("GitHub request failed (HTTP {0}).", response.status));
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(t("Unexpected response from GitHub."));
  return {
    issues: data.filter(issue => issue && !issue.pull_request && Number.isSafeInteger(issue.number) && issue.number > 0 && typeof issue.title === 'string'),
    hasMore: /rel="next"/.test(response.headers.get('link') || '')
  };
}

module.exports = { parseRemote, repositoryRemote, fetchIssues };
