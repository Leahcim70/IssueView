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

const format = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => String(args[index]));
const isItem = item => item && Number.isSafeInteger(item.number) && item.number > 0 && typeof item.title === 'string';

async function api(url, token, signal, request, t, body) {
  const response = await request(url, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'IssueView'
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
    throw Object.assign(new Error(errors[response.status] || t("GitHub request failed (HTTP {0}).", response.status)), { status: response.status });
  }
  return { data: await response.json(), hasMore: /rel="next"/.test(response.headers.get('link') || '') };
}

async function get(url, token, signal, request, t) {
  const { data, hasMore } = await api(url, token, signal, request, t);
  if (!Array.isArray(data)) throw new Error(t("Unexpected response from GitHub."));
  return { data, hasMore };
}

async function fetchIssues(repo, state, page, token, signal, request = fetch, t = format) {
  if (!parseRemote(`https://github.com/${repo.fullName}`) ||
      !['open', 'closed', 'all'].includes(state) || !Number.isSafeInteger(page) || page < 1) {
    throw new Error(t("Invalid repository query."));
  }
  const { data, hasMore } = await get(`https://api.github.com/repos/${repo.fullName}/issues?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`, token, signal, request, t);
  return { issues: data.filter(issue => isItem(issue) && !issue.pull_request), hasMore };
}

// ponytail: only the 100 most recently updated open PRs; paginate if a repository needs more.
async function fetchPullRequests(repo, token, signal, request = fetch, t = format) {
  if (!parseRemote(`https://github.com/${repo.fullName}`)) throw new Error(t("Invalid repository query."));
  const { data } = await get(`https://api.github.com/repos/${repo.fullName}/pulls?state=open&sort=updated&direction=desc&per_page=100`, token, signal, request, t);
  return data.filter(isItem);
}

function issueRepository(repo, number, t) {
  const parsed = parseRemote(`https://github.com/${repo?.fullName}`);
  if (!parsed || !Number.isSafeInteger(number) || number < 1) throw new Error(t("Invalid repository query."));
  return parsed;
}

async function assignIssueToMe(repo, number, token, signal, request = fetch, t = format) {
  const { fullName } = issueRepository(repo, number, t);
  const { data: user } = await api('https://api.github.com/user', token, signal, request, t);
  if (typeof user?.login !== 'string' || !user.login) throw new Error(t("Unexpected response from GitHub."));
  const { data: issue } = await api(`https://api.github.com/repos/${fullName}/issues/${number}/assignees`, token, signal, request, t, { assignees: [user.login] });
  // GitHub can silently ignore assignees when permissions are insufficient.
  if (!issue?.assignees?.some(assignee => assignee.login === user.login)) {
    throw new Error(t("GitHub did not assign you to this issue. Check your repository permissions."));
  }
}

async function graphql(query, variables, token, signal, request, t) {
  const { data: result } = await api('https://api.github.com/graphql', token, signal, request, t, { query, variables });
  if (result?.errors?.length) throw new Error(t("GitHub could not access or update the project. Check your project permissions."));
  if (!result?.data) throw new Error(t("Unexpected response from GitHub."));
  return result.data;
}

async function fetchIssueProjects(repo, number, token, signal, request = fetch, t = format) {
  const { owner, name } = issueRepository(repo, number, t);
  const projects = [];
  let cursor = null;
  do {
    const data = await graphql(`query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        issue(number: $number) {
          projectItems(first: 100, after: $cursor) {
            nodes { id isArchived
              fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
              project { id title url closed
              field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
            } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { owner, name, number, cursor }, token, signal, request, t);
    const items = data.repository?.issue?.projectItems;
    if (!Array.isArray(items?.nodes) || !items.pageInfo) throw new Error(t("Unexpected response from GitHub."));
    for (const item of items.nodes) {
      if (!item?.project || item.isArchived || item.project.closed) continue;
      const project = item.project;
      projects.push({ itemId: item.id, projectId: project.id, title: project.title, url: project.url,
        status: item.fieldValueByName?.name,
        fieldId: project.field?.id,
        optionId: project.field?.options?.find(option => option.name.trim().toLowerCase() === 'in progress')?.id });
    }
    const next = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
    if (items.pageInfo.hasNextPage && (!next || next === cursor)) throw new Error(t("Unexpected response from GitHub."));
    cursor = next;
  } while (cursor);
  return projects;
}

async function fetchInProgressIssues(repo, issues, token, signal, request = fetch, t = format) {
  const parsed = parseRemote(`https://github.com/${repo?.fullName}`);
  if (!parsed) throw new Error(t("Invalid repository query."));
  const { owner, name } = parsed;
  const numbers = issues.filter(issue => issue.state !== 'closed').map(issue => {
    issueRepository(repo, issue.number, t);
    return issue.number;
  });
  const inProgress = new Set();
  for (let offset = 0; offset < numbers.length; offset += 100) {
    const batch = numbers.slice(offset, offset + 100);
    const fields = batch.map(number => `issue_${number}: issue(number: ${number}) {
      projectItems(first: 100) {
        nodes { isArchived project { closed }
          fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        }
        pageInfo { hasNextPage }
      }
    }`).join('\n');
    const data = await graphql(`query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { ${fields} }
    }`, { owner, name }, token, signal, request, t);
    for (const number of batch) {
      const items = data.repository?.[`issue_${number}`]?.projectItems;
      if (!Array.isArray(items?.nodes) || !items.pageInfo) throw new Error(t("Unexpected response from GitHub."));
      if (items.nodes.some(item => item?.project && !item.isArchived && !item.project.closed &&
          item.fieldValueByName?.name?.trim().toLowerCase() === 'in progress')) {
        inProgress.add(number);
      } else if (items.pageInfo.hasNextPage) {
        const projects = await fetchIssueProjects(repo, number, token, signal, request, t);
        if (projects.some(project => project.status?.trim().toLowerCase() === 'in progress')) inProgress.add(number);
      }
    }
  }
  return inProgress;
}

async function startIssueProgress(project, token, signal, request = fetch, t = format) {
  if (!project?.fieldId || !project.optionId) throw new Error(t("This project needs a Status field with an In progress option."));
  if (!project.projectId || !project.itemId) throw new Error(t("Unexpected response from GitHub."));
  const data = await graphql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) {
    updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } }
  }`, { input: { projectId: project.projectId, itemId: project.itemId, fieldId: project.fieldId,
    value: { singleSelectOptionId: project.optionId } } }, token, signal, request, t);
  if (data.updateProjectV2ItemFieldValue?.projectV2Item?.id !== project.itemId) throw new Error(t("Unexpected response from GitHub."));
}

module.exports = { parseRemote, repositoryRemote, fetchIssues, fetchPullRequests, assignIssueToMe, fetchIssueProjects, fetchInProgressIssues, startIssueProgress };
