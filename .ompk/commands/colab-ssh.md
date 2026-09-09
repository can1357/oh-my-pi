# Colab-SSH Command

Bring up SSH on a fresh Google Colab VM and join it to the user's Tailscale
tailnet, so any tailnet member can `ssh` straight in. The VM is reached
through a Colab MCP proxy session (notebook cells); all VM-side work runs
through the proxy's notebook tools.

## Arguments

- `$ARGUMENTS` — `[tskey-auth-...] [hostname] [password] [gh-token] [repos...]`, all optional.
- **Bare `/colab-ssh` (no args):** check for a live session first (see
  step 0), then offer the user two options:
  1. **Launch existing** — if a warmed VM is still on the tailnet, hand
     over its `ssh` command. No notebook, no warm-up needed.
  2. **Warm up new** — needs a Tailscale auth key; ask the user for it,
     then run the full warm-up flow.
- **With args:** skips straight to warming up a new session.
  - Auth key: recommend an ephemeral, short-expiry key; single-purpose.
  - Hostname (optional, default `colab-pkherdr`): the stable handle — prefer
    it over the 100.x IP, which changes every Colab session.
  - Password (optional, default `P-K-Haxx1!`): root password to set.
  - GitHub token (optional): a PAT passed as `GH_TOKEN` — installs `gh`,
    runs `gh auth login` + `setup-git`. Recommend a fine-grained PAT with
    Contents read/write only on the repos you need.
  - Repos (optional): `owner/repo,...` passed as `GH_REPOS`, cloned into
    `~/work` during warm-up.

## Steps

### 0. Detect an existing session (bare invocation only)

Before starting any proxy, check whether a warmed VM is already alive:

1. Read the state file `~/.local/state/oh-my-pk/colab-ssh.json` (written by
   step 3) for the last known `{hostname, ip, warmed_at}`. No file → no
   existing session; skip to warm-up.
2. If the agent host is on the tailnet, probe liveness:
   `tailscale ping --c=1 <hostname>` (or `tailscale status` showing the node
   online). Reachable → session exists.
3. Optional stronger check: `ssh -p 2222 -o ConnectTimeout=5 root@<hostname>
   true` with the recorded password. Exit 0 → fully launchable.
4. Session alive → offer both options and let the user pick:
   - **Launch existing:** print `ssh -p 2222 root@<hostname>` plus the
     password reminder. Done — no notebook needed.
   - **Warm up new:** continue to step 1 (asks for an auth key).
5. Session dead or unknown → say so briefly and continue to step 1.
6. If the agent host itself is not on the tailnet, probes are impossible —
   ask the user whether the node shows online (admin console or
   `tailscale status` on their machine) instead of guessing.


### 1. Start the local Colab MCP proxy

Follow the `googlecolab/colab-mcp` pattern: start `ColabWebSocketServer`
bound to all interfaces, then build the connection URL as
`https://colab.research.google.com/notebooks/empty.ipynb#mcpProxyToken=<token>&mcpProxyPort=<port>`
(preserve the user's `?authuser=N` query if they gave one). Give the user
this link and wait for the tab to connect — confirm server-side
(`connection_live` set, client session established, tools listed) before
touching the notebook.

### 2. Push the warm-up script and run it

Read `.ompk/skills/colab-ssh/warmup.sh` (repo-local, canonical copy) and
install it into a notebook code cell, then execute the cell. The script:

1. Sets the root password, patches Colab's custom `sshd_config`
   (`PasswordAuthentication`/`PermitRootLogin yes`), restarts sshd, and
   prints the effective config as proof.
2. Installs pinned Tailscale and starts `tailscaled` in **userspace**
   networking mode (Colab has no `/dev/net/tun`).
3. Joins the tailnet with the user's auth key and hostname, then prints
   `TAILNET_IP` and the exact SSH command.
4. Installs oh-my-pk via the prebuilt binary
   (`curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh -s -- --binary`),
   symlinks `ompk` into `/usr/local/bin`, and removes any broken bun wrapper.
5. If `GH_TOKEN` was given: installs `gh`, runs `gh auth login` +
   `setup-git`, and clones `GH_REPOS` (`owner/repo,...`) into `~/work`.
6. Writes `/etc/motd` with the exact reconnect command and prints a final
   `CONNECT: ssh -p 2222 root@<hostname>` banner, so nobody has to remember
   the command.

Write the script into the cell with JSON-safe encoding (never shell-`printf`
the payload — escapes get mangled). If the cell result shows `TAILNET_IP`,
the VM is on the tailnet.

### 3. Verify, record, hand over

Confirm `tailscale status` shows the node, then record the session for
future bare invocations — write `~/.local/state/oh-my-pk/colab-ssh.json`:
`{hostname, ip, warmed_at (UTC), password_changed (bool)}`. Never store the
auth key or the password itself. Then tell the user:

```
ssh -p 2222 root@<hostname>   # e.g. ssh -p 2222 root@colab-pkherdr
```

Remind them of the password that was set. Optionally verify with a live
login if the agent host itself can reach the tailnet.

## Examples

```
/colab-ssh tskey-auth-k7vy9usHUs11CNTRL-abc123
```

Join a VM as `colab-pkherdr` with the default root password.

```
/colab-ssh tskey-auth-abc123 gpu-box MyPass123
```

Join as `gpu-box` with root password `MyPass123`.

```
/colab-ssh
```

Bare invocation: the agent checks for a live session and offers
**launch existing** vs **warm up new**. Warm-up asks for the auth key.

## Notes

- Colab's sshd listens on **port 2222**, not 22. Always include `-p 2222`.
- Colab's stock `sshd_config` ships `PasswordAuthentication no` (first match
  wins) — every `PasswordAuthentication` line must be flipped, then verified
  with `sshd -T`. The warm-up script does this.
- Google sign-in redirects strip the `#mcpProxyToken=…&mcpProxyPort=…`
  fragment. If the tab never connects, have the user sign in on the plain
  notebook URL first, then open the full fragment link.
- "Sign back in" loops are almost always blocked third-party cookies or
  multi-account (`authuser=N`) confusion — a single-account Chrome profile
  plus allowed `[*.]google.com` / `[*.]colab.research.google.com` cookies
  fixes it.
- The 100.x tailnet IP is **not** stable across Colab sessions (ephemeral
  node + fresh VM each time). The MagicDNS hostname is the stable handle as
  long as each session re-enrolls with the same `--hostname`.
- The auth key is secret material: ephemeral + short expiry, never commit it.
- Session memory lives in `~/.local/state/oh-my-pk/colab-ssh.json` (no
  secrets). Delete it if detection ever disagrees with reality.
- Canonical warm-up script: [warmup.sh](../skills/colab-ssh/warmup.sh).
