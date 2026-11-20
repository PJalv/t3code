# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe, and Cursor
Origin to clone and publish repositories, create pull requests, and review changes.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

On web and desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.

A commit link from a supported code host opens in the Diff pane when the thread's repository has
that commit locally, on any branch. Otherwise a pull request commit link opens the pull request. Other
commit links follow your **Open links in** setting; on web, when that opens a new tab, T3 Code first
shows an **Open link** button. Command/Ctrl+Click always opens the link in your browser. Commit links follow the **Open pull requests in T3 Code**
setting in **Settings → Diffs**.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source control & issues**
and choose **Rescan**.

### GitHub

T3 Code talks to GitHub's API directly and only needs a token. Any of these works, in this
order of precedence:

1. A token saved in **Settings → Source control & issues → GitHub**. It is kept in the server's secret
   store, and works without the GitHub CLI.
2. `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` with `GH_HOST` for GitHub Enterprise Server) in the
   server's environment.
3. [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, signed in with `gh auth login`.

If `gh` is signed in to several accounts or hosts, expand **GitHub** in the same place to pick
the account each host uses or turn a host off. A saved token or `GH_TOKEN` takes precedence
over that choice; a host turned off stays off either way.

For GitHub Enterprise, sign in with `gh auth login --hostname YOUR_HOST`. T3 Code treats a
custom server name as GitHub once it has a credential for that host.

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source control & issues**, expand **Bitbucket**, and enter one of:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **Atlassian account email** and **API token**: an Atlassian API token for your account. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`) and workspace read access (`read:workspace:bitbucket`).

A field saves when you leave it, and applies right away. The access token wins when both are saved.
Credentials are saved on the environment's server, so select a remote environment to configure
it. Saved tokens can't be viewed again; enter a new one to replace it, or choose **Remove** to clear
everything saved for Bitbucket.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

For a background service, put these `KEY=VALUE` entries in
[`service.env`](./background-service.md#configure-the-service-environment)
under T3 home, then run `t3 service restart`. Service installation and updates
preserve that file.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

### GitCafe

Install the GitCafe CLI and sign in:

```bash
bun install -g @gitcafe/cli
cafe auth login --host https://git.cafe/api
```

Alternatively, open **Settings → Source control & issues**, expand **GitCafe**, and enter a token. It is
kept in the server's secret store, applies right away, and is used before `CAFE_TOKEN` and the
`cafe` login. Or set `CAFE_TOKEN` in the server's environment and restart it. Both tokens are only
sent to `git.cafe`; `CAFE_TOKEN` follows `CAFE_HOST` if you set it. Repositories on
`staging.git.cafe` need their own login with `--host https://staging.git.cafe/api`.

Line comments are not available for GitCafe pull requests yet.
Merging a stack lands it through GitCafe, and updating a branch restacks the layers above it.

### Cursor Origin

Install the [Origin CLI](https://cursor.com/docs/origin/cli) and sign in. Signing in also sets up Git
credentials for `origin.cursor.com`:

```bash
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
origin auth login
```

If cloning or pushing asks for a username, run `origin auth setup-git` to point Git at the CLI's
credentials again. Origin repositories use HTTPS and are published privately. Repositories mirrored
from GitHub keep their pull requests on GitHub; open those from the GitHub remote.

### Gerrit

Open **Settings → Source Control → Gerrit** in the environment that owns your repository.
Save the Gerrit server URL and an HTTP username and password or token, then test the connection.
When editing a saved connection, leave both HTTP credential fields blank to keep its saved credentials.
Use HTTPS when available: HTTP does not encrypt credentials or protect the downloaded commit hook.
When you select a Gerrit project and clone it over HTTP, T3 Code uses the saved HTTP credentials.
This clone does not use the server machine's Git proxy or custom CA configuration, or proxy and CA
environment variables. It uses Git's default certificate trust. If your network requires a proxy or a
custom CA, use SSH for the clone or configure the default trust and a direct connection. Later Git fetches
use the server machine's existing Git and SSH configuration separately.
To select a project for SSH cloning, configure the SSH host, port, and SSH username on the
connection. The SSH username is separate from the HTTP username. Selected Gerrit clones use a private
sibling directory before publication. If the destination already exists or publication fails, the clone
reports the private checkout path. Inspect both paths before moving the checkout manually. The clone
installs the server's `commit-msg` hook. Git runs that hook when you commit,
so use a server you trust; HTTP does not protect the hook from changes in transit. An SSH checkout
needs a configured SSH host associated with the Gerrit server. If the remote is ambiguous, T3 Code
cannot safely infer its project.

#### Copy a saved credential to configured terminal Git

Saving HTTP credentials does not sync them to terminal Git. On the saved connection, choose
**Copy saved credential to configured Git → Copy command template**. This is not a ready-to-run
command: replace the launcher and home placeholders first. Run it inside the HTTPS checkout on the
**T3 server machine**, as the server's OS user, not on a remote client. It targets `origin`; use
`--remote <name>` for another remote. It copies only this repository/account credential through stdin
to an already configured secure helper. It does not contact Gerrit or change Git configuration or remotes.

Identify the launcher and home from the server's launch command or service configuration:

- **Packaged/custom install:** use the absolute CLI path belonging to that installation. `command -v t3`
  on the server can locate a candidate, but verify it against the installation you launched. Check
  `'/absolute/path/to/t3' gerrit copy-terminal-credential --help`; if unavailable, that binary is too old.
  Use its configured `--base-dir` or `T3CODE_HOME`. Only the default install uses `$HOME/.t3`.
- **Dev worktree:** replace `'<T3-LAUNCHER>'` with
  `node '/absolute/server-checkout/apps/server/src/bin.ts'`. Use
  `--base-dir '/absolute/server-checkout/.t3'`, unless the dev runner was started with another
  `--home-dir`. The dev runner's home flag is `--home-dir`; this CLI command's flag is `--base-dir`.
  Use the same Node installation as the dev server. Keep the working directory in the target Git
  checkout, not the T3 source checkout.

The home is the **parent of `userdata`**, not `userdata` itself. Verify the selected home by comparing
`userdata/environment-id` with the template's `--environment-id`; this ID is not a secret. Do not
inspect the secrets directory to locate the home. Quote paths with spaces; in POSIX single-quoted
arguments, spell an embedded apostrophe as `'\''`. The command rejects a different environment ID.

Linux requires an existing system-installed `git-credential-libsecret` and an unlocked Secret Service
keyring. Native Windows, macOS, Git Credential Manager, shell helpers, and plaintext `store` are not
supported. WSL uses the Linux implementation only when T3, Git, libsecret, and Secret Service run inside
one distribution; no credential moves to Windows or another distribution.

Before copying, inspect locally (never post output from custom helpers that may contain secrets):

```sh
git remote get-url --all origin
git remote get-url --push --all origin
git config --show-origin --get-regexp '^credential\.'
git config --global --get credential.useHttpPath
```

The prerequisites are one absolute libsecret executable without arguments, global
`credential.useHttpPath=true` without a matching false override, and an exact repository-scoped HTTP
username. Find the helper path using your system's package tooling; no path is assumed. The following
is **configuration syntax to review**, not a command to run or a block to append blindly:

```gitconfig
[credential]
    helper = /absolute/package-provided/path/git-credential-libsecret
    useHttpPath = true
[credential "https://review.example/gerrit/a/team/repo"]
    username = your-http-username
```

Replace the example URL with the exact remote, including any reverse-proxy path. Review helper entries
from every config origin first: Git sends successful credentials to all matching helpers. Do not
silently clear a chain, append another helper, or delete unrelated host/account rules. Global path
matching affects other repositories, which may need their own path-scoped credentials. It is required
because pathless lookups can retrieve credentials saved for another path. No setting is changed by the
copy command. Conflicting rules require manual review, not a plaintext fallback.

The command rejects trailing/repeated path slashes, encoded paths, URL rewrites, other URL-scoped
credential rules, and differing fetch/push URLs instead of guessing. It never fixes or converts SSH
remotes. The template contains no password. Re-run it for each repository after password rotation.
Removing the T3 connection does not remove the keyring copy or revoke the Gerrit password. Remove the
repository/account entry in your keyring application when no longer needed; revoke or rotate the HTTP
password in Gerrit if required. No RPC or agent MCP tool exports this credential.

Gerrit changes appear in **Pull requests** like reviews from any other host. A change shows its
votes, submit requirements, topic, and work-in-progress and private state. You can vote, set the
topic, mark it ready or work in progress, and make it private or public. The regular review actions
submit, abandon, restore, and rebase the change, and comments on the whole change post as
patch-set-level comments. On web and desktop, choose a patch set and a comparison base to read an
earlier revision; mobile shows the current patch set.

To upload, open **Upload commit for review** from the command palette or the thread's Git actions
(Git sheet on mobile). It pushes HEAD to `refs/for/<branch>` as a new change or as a new patch set of
an existing one, with an optional topic, reviewers, CC, work in progress, or private flag. Like
`git push origin HEAD:refs/for/<branch>`, this also uploads any parent commits Gerrit does not
have yet. The commit needs a Change-Id footer. The uploaded change is linked to the thread.

The `commit-msg` hook adds the Change-Id when you commit. If a checkout is missing it, choose
**Install hook** in **Settings → Source Control → Gerrit** (in the upload sheet on mobile). T3 Code
installs the pinned official hook and never replaces an existing one. Installing it does not fix
existing commits; amend them to add a Change-Id.

If your server asks for signed pushes, save your GPG key passphrase in **Settings → Source Control →
Gerrit**. It is stored on the environment's server and is never shown again; use **Clear
passphrase** to remove it. Uploads sign the push with the checkout's Git signing key. Only OpenPGP
(`gpg`) signing is supported.

Agents use Gerrit through the `read_gerrit`, `act_gerrit`, and `upload_gerrit` tools. They can do
everything you can, including votes, reviewers, comments, submit, and abandon, with the saved
account; the thread's access mode is the only limit. `link_pull_request` and `watch_pull_request`
accept a Gerrit change number. Watched changes wake the thread like any other pull request.

Unavailable checks from the legacy checks integration (Gerrit 3.10.x only) do not mean that checks
passed. You can turn the integration off in the server settings.

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. Until the project has a thread, new
threads work in its folder, even when your default is a new worktree. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. Only GitHub is listed at first. To list
another provider here and in **Publish Repository**, turn on its switch under
**Settings → Source control & issues**. A branch or file page copied from GitHub,
GitLab, GitCafe, Codeberg or Bitbucket also works: T3 Code clones that repository's default branch.
On other hosts, paste the repository's clone URL. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer. When the host refuses the machine's SSH key, T3 Code
clones over HTTPS with Git's credentials for that host instead, and the project's remote uses the
HTTPS URL.

To lay clones out like [ghq](https://github.com/x-motemen/ghq), turn on **Clone into host folders**
under **Settings → Threads** (or **Source control** on mobile). Clones then default to
`<host>/<owner>/<repo>` under **Add project starts in**, so set that to `~/ghq` to share ghq's
folders. You can still change the destination before cloning.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes. Descriptions also draw on the work in
the thread, including the checks it ran.

An existing fork PR can appear beside the branch even if you pushed without setting an upstream.
If its badge is missing because several remotes hold that branch, set the branch's upstream to
the intended remote with `git branch --set-upstream-to=<remote>/<branch>`.

Choose how commit messages and pull request titles and descriptions are written in
**Settings → Source control & issues → Commits & pull requests**. **Repository conventions** uses the
project's instructions and recent commit subjects. **Custom instructions** applies your own
instructions to commits and pull requests.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
Where you can edit a description, you can also tick its checkboxes from the Summary tab
(the Overview tab on mobile).
GitLab calls these merge requests.

Save a filter setup with **Views → Save current view** on the Pull Requests page. For example, choose
**Reviewing** (**Your review** on mobile) and save it as "PRs Requesting My Review". Choose a saved view to restore its search,
filters, sort order, and server/project scope. After changing filters, use **Update saved view** to
keep the changes, or save another view. You can also rename or delete views from the same menu.
Saved views stay in the browser or app where you created them and do not sync across devices.

A link to part of a pull request opens that part: a comment or review is marked in the activity, a
changed-line link opens the file at those lines, a checks link opens the checks, and a commit link
opens that commit's changes. On web and desktop, hovering a comment or commit link previews it.

On mobile, **Pull requests** lists reviews across your connected environments. Open a review
to read its description, activity, commits, and changed files. Line comments stay as drafts
until you submit the review. **Work on PR** opens a chat with the review attached; sending
the first message prepares a worktree from the review's branch.

Previously loaded lists, review details, guides, and diff pages remain readable on mobile
without a connection, including after restarting the app. Saved content refreshes when the
environment reconnects; submitting changes requires a connection.

Enable **Remove agent credits when merging** in Settings → Source control & issues to remove recognized
agent co-author and generated-by lines from GitHub merge and squash commit messages. Human
co-authors stay credited. The setting is off by default and projects can override it. It also
applies to auto-merge, but not merge queues or native stack merges. Original commits keep their
messages, so merge and rebase can still retain agent credits in those commits.

On web and desktop, hold **Shift** in the GitHub pull request list for quick actions.
To close several, press **Close**, drag across the rows in the same group, and release.
Press **Escape** before releasing to cancel. Failed closes stay in the list so you can retry them.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

Pull request sharing is off by default. In Settings → Environments → Pull request sharing (Pull
request routing under Environments on mobile), choose **Read PRs** or **Read and act** for each
environment you trust to share its source control access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

Review details, linked PR status, and permitted review actions can then use another connected
environment signed in to the same account on the same host. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Review guides

Review guides are in beta. Turn on **Review guides** in Settings → Source control & issues to add the
**Guide** tab to pull requests on that server. On mobile, move between stops with **Next**
and the back button; a stale guide offers a rewrite and hides excerpts that no longer match
the current change.

The **Guide** tab gives you a tour of a pull request without reading it line by line: stops
through the change in reading order. Each stop points at the lines worth reading, and a stop marked
**Look closely** has a call only a maintainer can make. Mechanical changes such as renames and
snapshots are grouped at the end, and every changed file appears somewhere on the tour.
Conversations already resolved in review are left out. For a pull request in a stack, the guide
covers that layer only, and may point out what a lower layer introduced or what a higher one uses.

Choose **Write guide** to have the review guide model from Settings → Source control & issues read the
change in a temporary checkout; without one set, the source control writer model is used. Nothing
in the checkout is changed, and a large pull request takes a few minutes; you can go elsewhere in
the app. On web, you are told when the guide is ready; on mobile, return to the guide to check
its progress. Claude and Codex can write guides. The guide is
kept for everyone using this server. To write it again, for example after a push or after changing
the model or instructions, choose **Rewrite guide** from the pull request's **⋯** menu.

On web, while reading a stop, select lines in an excerpt to add a comment to your review or ask an agent
about them; comments wait with the ones from the **Code** tab until you send the review. Choose a
suggested question, or **Ask about this stop**, to open a thread that already knows which stop you
are on. **Finish review** on the last stop opens the review with everything you collected.

Agents can write guides too: ask one to prepare guides for a set of pull requests, and it starts
them for you. Each is read through the project whose checkout has that repository.

To shape guides to your taste, write **Review guide instructions** in Settings → Source control & issues,
such as what to show first or what to skip; projects can override them. They change emphasis and
ordering, not the guide's layout or which files it covers.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, Azure DevOps, and Cursor Origin expose no record
T3 Code can read, so the server you are connected to keeps them instead: they follow you across the
apps connected to that server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

On mobile, open a changed file and mark it viewed from its header. Viewed files collapse,
and their marks follow the same rules as on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source control & issues, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0, or save a token in Settings → Source control & issues.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked items** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically,
and so does an agent creating one with `gh pr create` or `glab mr create`. Agents can link other
pull requests with the `link_pull_request` tool.

Agents can also read, open, update, reply on, and merge pull requests in the thread's repository
through T3 Code's own tools, which use the same sign-in as the Pull requests page. An agent merges
only the commit it last read: if someone pushed since, the merge is refused. On github.com an
agent can also land a GitHub stack in one merge, like **Merge stack** below.

Use **Link pull request to thread** in the command palette to keep a pull request with the thread. From a review
on the Pull requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked items** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked items** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. Settling a thread refreshes its open and closed reviews once; after that they stop refreshing until you unsettle it. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every two minutes and wakes the agent when a
check fails or waits for a maintainer's approval, the required checks pass, someone else comments or reviews, or the branch starts to
conflict. On github.com it also wakes the agent, with GitHub's reason, when the merge queue drops
the pull request without merging it. Threads in a project that watch the same pull request share one check. On GitHub, a check
first asks whether anything changed and reads the pull request only when it did, which keeps
watching inside GitHub's rate limit. Comments from your own account do not wake it. When the pull
request merges or closes, watching ends, and the agent is woken once unless it merged or closed the
pull request itself with the host's CLI. A reopened pull request needs a new watch. Watching also ends after 10 wakes in a row that bring only comments, after 8
failed reads in a row, or when you press Stop on the thread. A rate limit only pauses watching.
Settling or archiving a thread also ends all its watches. Unsettle the thread before starting a new
watch. Watching a pull request again does not repeat check or conflict news its last
watch already reported; unlinking the pull request clears that. Subagents cannot watch pull requests; the thread that delegated to them does. To start or stop
it yourself, use the row menu in the **Linked items** panel. In the thread details card, a
watched pull request shows an eye; click it to stop watching.

A watched thread counts as working while the pull request still has checks running, so it stays in
the **Working** section, including after the agent pushes a fix. Once every check has finished,
including review bots that report as checks, the thread returns to your inbox: what happens next is
up to a person. That includes a workflow waiting for a maintainer to approve it, which runs only
once someone does. If you ask the agent to act on the pull request itself, such as merging it once
a teammate approves, the thread stays in **Working** until the pull request merges or closes. The
watch stays on and still wakes the agent on new comments, failed checks or conflicts, and a watched
thread never auto-settles.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## Issues

The Issues page lists the issues of every project whose remote is on GitHub, GitLab, Azure
DevOps or Forgejo, grouped per tracker account. Open it from the sidebar's utility row or with
**Open issues** in the command palette. Filter by open or closed, by your involvement
(assigned, opened by you, mentioning you), by project, and by tracker; the search box asks the tracker
itself where it can search. Press **Load more** at the end of a group to read further back.
The **Views** menu saves and restores a search, filter, and sort setup, as it does for pull
requests.

To list a Linear team's issues beside a project's, connect Linear with an API key under
Settings → Source control & issues, then choose the team for that project there.

Select an issue to open it beside the list: description, comments, state changes, linked pull
requests, labels, assignees, and reactions. Linked pull requests open in the same panel. You can
comment, edit the title and description, change labels and assignees, react, and close or
reopen (with a close reason where the tracker records one) when the tracker and your account
allow it. An issue read through a project that does not own its repository is shown read-only.

An issue can be kept with a thread the way a pull request can: open it beside the thread (issue
links in the conversation open there) and use **Link to this thread** in its header; **Unlink**
undoes it. Click the issue badge in the thread sidebar to see its issues and pull requests in
**Linked items**. Select an issue there to open it beside the thread. Agents link the issues they
work on with the `link_issue` tool.

Writing to a tracker over a remote connection requires the `source-control:write` scope.

## GitHub stacks

The Pull requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
