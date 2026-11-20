# Portable Gerrit beta

Use only a fork archive explicitly built with the `gerrit-beta` profile. A folder
name, `T3CODE_HOME`, or setting `T3CODE_BUILD_PROFILE` when starting an existing
binary does **not** make an official binary safe for this procedure. The profile
is compiled into the server and its executable bootstrap. Maintainers select it
with `T3CODE_BUILD_PROFILE=gerrit-beta` during server bundle and executable builds;
the default remains `standard`. No beta releases or update endpoints are configured.

## Start in WSL2

Use the Linux x64 archive inside WSL2. Keep its executable and state in the Linux
filesystem. Install Git 2.45 or newer and your provider tooling in that distro.
After extracting the complete archive, run its executable by path, not `t3` from
`PATH`:

```sh
"$HOME/Gerrit Beta/t3" serve --base-dir "$HOME/.t3-gerrit-beta" --host 127.0.0.1 --port 4773
```

Keep that terminal open. Open the printed pairing URL in your Windows browser.
Stop the server with Ctrl-C. If the port is occupied, choose another port; do not
stop an unrelated server. The beta always serves on loopback, with no background
service or automatic browser launch.

## Native Windows: validation pending

The equivalent command for a separate Windows x64 archive is:

```powershell
& "$HOME\Gerrit Beta\t3.exe" serve --base-dir "$HOME\.t3-gerrit-beta" --host 127.0.0.1 --port 4773
```

Native Windows execution, junction detection, path-case handling, and credential-file
ACLs must be verified before that archive is distributed. The path check currently
requires an exact canonical path match and can reject Windows path aliases; native
Windows is not a verified beta target. Trusted signed Gerrit push/amend is Linux-only. Optional
terminal credential copying requires Linux libsecret; saved HTTP authentication
in T3 Code is separate. Do not bypass TLS verification to work around clone proxy
or CA configuration problems.

## State and updates

`--base-dir` is required. It must name an absolute directory below your user home,
with no `.t3` path component or linked directories. Use a new or empty directory
on first launch. The beta marks that directory for later launches and stores
state under `userdata`. It will not adopt an existing unmarked directory. Do not
copy official state, credentials, or symlinks into it. There is no automatic data
migration from the official app, and no default fallback to its home.

Before initialization or terminal credential copying, the beta checks existing
owned state recursively, including database sidecars, settings, secrets, logs,
caches, runtime metadata, attachments, and browser artifacts. It rejects links
without removing them. Checkout directories are checked at their boundaries;
repository contents are not scanned. This startup check is not a sandbox against a
local process that changes files after validation. Do not alter state paths while
the beta runs.

The optional Linux-only `gerrit copy-terminal-credential` command remains available.
Run it with the beta executable's full path, as described in
[Source control](source-control.md). Keep its explicit `--base-dir` pointed at the same beta home;
`T3CODE_HOME` and the official default home are not accepted as substitutes. Home
validation completes before the credential service runs. This command still
requires the configured system libsecret helper and does not support native Windows.

Install, update, uninstall, desktop launch, and background-service CLI commands
are unavailable. Server release checks, update downloads, and desktop update
handoffs are refused. Connected clients show updates as disabled for this beta;
no machine-wide policy file is installed, and the official app is not disabled.
Use only the browser client shipped with the archive. Hosted clients, Electron,
SSH-managed installation, remote deployment, and official installers are not part
of this beta procedure. Provider updates are separate from T3 Code updates.

To replace the beta, stop it and use a separately supplied, matching fork archive.
Do not use `npx t3`, the official install scripts, or `t3 update`. Keep the previous
archive and back up beta state before a replacement that changes the database.
