# Changelog

## [Unreleased]

### Added

- Added `/jobs kill <id>|all` to cancel a running background job (or every one this session owns) from the command line, even while the agent is busy ([#14160](https://github.com/can1357/oh-my-pi/pull/14160) by [@KanwarGill](https://github.com/KanwarGill))
- Added `omp anonymize [session] [-o dir]` to write a shareable copy of a session and its subagent transcripts: only an explicit allowlist of omp metadata (ids, timestamps, models, usage, built-in tool names and options) is kept; message, thinking, and tool-output text become size-annotated `[redacted …]` markers; tool-call paths become mock paths (`/home/seg3/seg4/src/seg9.ts:10-20`), shell commands keep known programs and flags, other literals such as a grep pattern become `PLACEHOLDER_N`, and extension or MCP payloads are redacted whole, with the same original always mapping to the same token across files ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added `/dump anon`, which writes the same anonymized session and subagent JSONL to a zip in the temp directory and copies its path ([#15077](https://github.com/can1357/oh-my-pi/pull/15077) by [@H4vC](https://github.com/H4vC))
- Added `autoRedeem: false` for `auth.accountPolicies` entries: automatic saved-reset spending (expiry salvage, last-chance and blocked-turn restore) skips that account while `/usage reset` still spends it on request; `omp usage` shows `auto-redeem off` on its policy line and says its expiring resets will not be spent

### Changed

- A `/models` compaction limit set past a model's standard context window now runs that model on its extended window instead of being silently clamped; the hub warns (noting long-context pricing) and saves on a second Enter, in the terminal and in Tern, and rejects limits past the model's largest window ([#15048](https://github.com/can1357/oh-my-pi/pull/15048) by [@H4vC](https://github.com/H4vC))
- A token compaction limit set in `/models` (or `compaction.modelThresholds`) is now the base omp scales with its usual policy, as if it were the model's window (85% of it by default for bases above ~109k, or `compaction.thresholdPercent` of it), instead of the exact point. Plain numbers saved since 18.8.5 therefore compact earlier; rewrite one as `"f<tokens>"` (or type `f400k` in the hub) to keep it an exact trigger. The `/models` limit field shows where the model would compact as you type (`compacts at 340K · 85% of 400K base`), the preview's **Compacts at** row says why, and the saved message repeats it ([#15065](https://github.com/can1357/oh-my-pi/pull/15065) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the custom-tool examples' full-documentation link opening a missing page ([#15076](https://github.com/can1357/oh-my-pi/pull/15076) by [@qingshungLI](https://github.com/qingshungLI))
- Fixed the `/models` compaction limit preview and **Compacts at** row rounding fractional percentages (`12.5%` showed as `13%`) ([#15074](https://github.com/can1357/oh-my-pi/pull/15074) by [@H4vC](https://github.com/H4vC))
- Fixed `/omfg` save, overwrite, and validation prompts in Tern opening as a sheet over the candidate rule; they now sit in the composer slot like `ask`, so the rule stays readable while you choose ([#15058](https://github.com/can1357/oh-my-pi/pull/15058) by [@H4vC](https://github.com/H4vC))
- Fixed hotkeys pressed in Tern while omp is still starting (such as Alt+P for the model selector) being ignored; like in other terminals, they now take effect once startup finishes ([#15120](https://github.com/can1357/oh-my-pi/pull/15120) by [@H4vC](https://github.com/H4vC))

## [18.8.7] - 2026-10-09

### Added

- Added automated release binary publication to build.stencil.so
- Added OSC 7501 program status reporting: terminals and agent inboxes that support it now show whether omp is working, waiting on your answer or approval (with the question), done, or failed (with the error), without parsing the window title. Turn it off with `terminal.programStatus`.
- Added title cards (icon and short code) to `/rename`: the title model picks one for a title you type, or for a generated title when the session has no card yet; `title.icons: boring` keeps renamed titles plain.
- Grammars for less common languages (Kotlin, Swift, Ruby, PHP, Haskell, Verilog, and others) are now downloaded on first use for code summaries, block context, `ast_grep`, `ast_edit`, and TTSR rules; offline, files in those languages are skipped with a note instead of failing. `PI_GRAMMARS_URL` overrides the download location.
- Added `bash.gitGuard` (default off) for checkouts shared by concurrent agents: the bash tool refuses `git stash`, `git reset --hard` or to another commit, and `git checkout`/`switch`/`restore` that would overwrite working-tree files unless a merge or rebase conflict is being resolved; unstaging stays allowed, and commands are judged as they actually run, including inside substitutions, functions, and after `cd`.

### Changed

- Updated `write` tool error message to mention local:// scratch support
- Web search now tells the agent about its X post operators (`site:x.com`, `from:<handle>`) when you are logged in to xAI, so questions about reactions on X reach X search.
- Reduced memory retained after merging unchanged discovered and cached models ([#14252](https://github.com/can1357/oh-my-pi/pull/14252) by [@iliaal](https://github.com/iliaal)).
- The default `smol` model now prefers Claude Haiku 5.5 when it is available.
- Automatic session titles now start when the agent's reply begins rather than when you submit, so a slow-thinking first reply gets a card title (icon and code) instead of a plain fallback title.
- `read file.jsonl?q=…` keeps the other lines' results when a line before the last fails and shows jq's error ahead of them, instead of failing the read; anything else the query wrote to stderr, such as `debug` output, now leads the result too ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Title card icons now picture each session's specific subject instead of a generic bug, flask, speedometer, gear, or terminal, or the project's language logo, so sessions in the same project are easier to tell apart.
- Agents whose tool list omits `write` but still get it to run `xd://` tools can now also write `local://` files (reports, notes) outside plan mode; working-tree writes stay blocked.
- Added `worktree.onStart` and `worktree.onExit` settings to start each session in its own worktree and clean it up on exit ([#14908](https://github.com/can1357/oh-my-pi/pull/14908) by [@gitpushoriginmaster](https://github.com/gitpushoriginmaster))
- Added `speech.speed` and `tts.localSpeed` settings (0.5–2.5, default 1) to speed up or slow down local Kokoro speech for live vocalization and the `tts` tool / `omp say`, plus an `omp say --speed` flag; ACP voice clients find both settings and their presets in `speech.models.list` ([#5868](https://github.com/can1357/oh-my-pi/issues/5868))
- `omp update` and the startup update notice leave an omp installed by another app (Tern) to that app instead of replacing its files.
- The startup update notice no longer appears when omp runs from a source checkout.

### Fixed

- Reduced memory growth after one-shot side requests without interrupting ongoing conversations ([#14334](https://github.com/can1357/oh-my-pi/pull/14334) by [@iliaal](https://github.com/iliaal)).
- Fixed sessions staying untitled when you interrupted the first reply to send a queued steer message.
- Fixed browser downloads saving into another tab's `downloads` folder, and `tab.waitForDownload()` saving into the system Downloads folder once another tab closed; each tab in a Chromium omp launched or spawned now saves into its own, iframe downloads included. In those browsers a download no tab tracks (started by a page omp did not open, or finishing after its tab closed) now keeps Chromium's GUID file name instead of its suggested name; connected and relay browsers keep real file names ([#14544](https://github.com/can1357/oh-my-pi/pull/14544) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode failing with "The browser relay … is out of date" after an omp upgrade until the old relay was killed by hand; omp now restarts a relay it started itself under an older version ([#14416](https://github.com/can1357/oh-my-pi/pull/14416) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/rename` without a title dropping the session's title card (icon and short code) ([#14980](https://github.com/can1357/oh-my-pi/issues/14980))
- Fixed title cards showing the emoji instead of the Nerd Font icon when the model misremembered the icon's name: dashes for underscores (`nf-md-text-box`), the wrong icon set (`nf-md-spinner` for `nf-fa-spinner`), or reordered, missing, or extra words (`nf-md-test` for `nf-md-test_tube`).
- Fixed `omp update` ignoring the `update.channel` setting: canary users were checked against stable releases, and `--canary`/`--stable` were never remembered.
- Fixed interrupting a reply to send a queued steer message briefly showing omp as idle (title, progress, working indicator) before the steer ran; RPC and SDK clients also no longer see a final `agent_end` for that interrupt.
- Fixed browser tab recordings and video frame/contact-sheet extraction creating `omp-browser-recording-*` and `omp-video-*` scratch directories in your working directory instead of the system temp directory.
- Fixed edit snapshots retaining excess history when metadata or displayed-line provenance grows; the 64 MiB snapshot budget now counts UTF-8 bytes, so CJK- and emoji-heavy files keep fewer versions ([#14975](https://github.com/can1357/oh-my-pi/pull/14975) by [@iliaal](https://github.com/iliaal)).

## [18.8.6] - 2026-10-08

### Added

- Added per-session Git worktree support with `worktree.onStart` and `worktree.onExit` settings to create an isolated worktree for each session and clean it up when the session ends.
- Expanded xAI web search with X post search, including X-only and author-specific queries, author exclusions, date and recency filters, and automatic xAI routing when credentials are available.
- Added xAI-powered reading of X posts, threads and replies, profiles, searches, and hashtags when logged in, replacing the unavailable Nitter mirrors.

### Changed

- Web search now prefers an authenticated `xai-oauth` login over an `xai` API key when both are available, unless `modelProviderOrder` specifies a different order.

### Fixed

- Fixed judge-gated features continuing to use a stale model chain after switching judge roles.
- Improved Anthropic prompt-cache reuse when pruning tool results from long conversations.
- Fixed resumed Claude sessions losing earlier thinking context and prompt-cache reuse when extensions or MCP tools were registered before the first message.
- Fixed subagent advisors configured with `@advisor` using the built-in `slow` model instead of the configured advisor role.
- Fixed the `/switch` command and alternate model picker crashing when stored model speed statistics contained an unnamed model.
- Fixed `lsp` and `generate_image` attempting to read FIFO, terminal, or unbounded device paths, which could hang or exhaust memory.
- Fixed aside messages from extensions being blocked behind a running wait operation.
- Fixed extensions importing `@oh-my-pi/pi-tui/native/*` failing to load in compiled `omp` binaries.
- Fixed raw token markers appearing instead of Nerd Font icons in Anthropic idle recaps, `/btw` and `/omfg` replies, and streaming previews.
- Fixed sessions moved with `/wt` disappearing from resume lists; sessions in Git worktrees now remain discoverable and can be resumed or relocated if their worktree was removed.
- Fixed live config reload ignoring edits made during startup or right after a config symlink was retargeted, until the next unrelated edit.

## [18.8.5] - 2026-10-08

### Added

- Added per-model auto-compaction points: the `/models` preview shows where each model compacts, and in the Roles view `k` (or the **Compaction limit** button) sets it for the selected role's or fallback's model (`90000`, `90k`, `1M`, `80%`; empty resets). Also configurable as `compaction.modelThresholds` with `provider/model-id` or `provider/*` keys ([#14952](https://github.com/can1357/oh-my-pi/pull/14952) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed `omp usage` reporting an account exactly at its reserve (e.g. 30% left with a 30% reserve) as eligible instead of inside reserve ([#14765](https://github.com/can1357/oh-my-pi/pull/14765) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the todo reminder pushing the agent to keep working after it offered options and asked the user to choose ([#14800](https://github.com/can1357/oh-my-pi/pull/14800) by [@mrmans0n](https://github.com/mrmans0n))
- Fixed the todo reminder telling the model to keep working right after it asked the user a bolded or italicised question ([#12051](https://github.com/can1357/oh-my-pi/issues/12051), [#14353](https://github.com/can1357/oh-my-pi/pull/14353) by [@F0Rextasy](https://github.com/F0Rextasy))
- Fixed short model selectors such as `p/a:max` or `a:max` dropping their explicit thinking level when a role was reassigned or used for image questions; a model whose ID literally ends in `:max` or `:auto` is still treated as that model ([#14554](https://github.com/can1357/oh-my-pi/pull/14554) by [@xiangnan0811](https://github.com/xiangnan0811))
- Fixed starting a subagent switching the parent session's later language servers from shared to private ([#14628](https://github.com/can1357/oh-my-pi/pull/14628) by [@jorgoose](https://github.com/jorgoose))
- Fixed a finishing subagent cancelling local tiny-model requests (titles, task labels, judgments) still running for the parent or other subagents ([#14629](https://github.com/can1357/oh-my-pi/pull/14629) by [@jorgoose](https://github.com/jorgoose))
- Fixed rust-analyzer on Windows not running through a running lspmux server, as it already did on Linux and macOS ([#14630](https://github.com/can1357/oh-my-pi/pull/14630) by [@jorgoose](https://github.com/jorgoose))
- Fixed a malformed or unreadable project `plugin-overrides.json` being ignored silently, which re-enabled project-disabled plugins without a trace; omp now logs a warning naming the file ([#14518](https://github.com/can1357/oh-my-pi/issues/14518), [#14573](https://github.com/can1357/oh-my-pi/pull/14573) by [@oleg494](https://github.com/oleg494))
- Fixed Claude Opus 5.5 and Sonnet 5.5 disappearing with mixed-access Google Antigravity accounts; models now route to accounts that serve them, and revoked accounts no longer block catalog refresh ([#14924](https://github.com/can1357/oh-my-pi/issues/14924)).
- Fixed clipboard-pasted image chips opening a nonexistent file instead of the image, including after `/move` ([#14927](https://github.com/can1357/oh-my-pi/issues/14927)).
- Fixed clipboard-pasted image chips opening the auto-resized copy sent to the model instead of the image as pasted ([#14929](https://github.com/can1357/oh-my-pi/pull/14929))
- Fixed `omp token <provider> --account N --force-refresh` printing the stored token unchanged while it was still valid; it now re-mints that account. Security scans pinned to one account, including Codex Security cloud requests, refresh it after a 401 and may reuse a still-usable token minted in the previous five minutes, as `omp auth-broker serve` now also may for its clients' 401 recovery ([#14752](https://github.com/can1357/oh-my-pi/pull/14752) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed revived subagents moving to the parent's automatically chosen account and re-writing their whole prompt cache instead of staying on the account that served their earlier turns; a parent's explicit `/session pin` still moves them ([#14749](https://github.com/can1357/oh-my-pi/pull/14749) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a fallback chain switching back to a usage-limited primary model every 30 minutes, failing a request each time, when the provider's usage report showed a later reset; the session now stays on the fallback until that reset ([#14757](https://github.com/can1357/oh-my-pi/pull/14757) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/usage`, the status line usage segment and `/logout` treating every Google Antigravity account (and every Codex Team seat in one workspace) as the session's account, and `omp usage` not listing such an account when its usage fetch failed ([#14900](https://github.com/can1357/oh-my-pi/pull/14900) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Tern showing an agent as finished when automatic context maintenance ends partway through a turn; omp now keeps reporting the turn's working state until the turn actually ends ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed the terminal title and Tern busy state staying in the working state after an interrupt cancels a scheduled retry or continuation before it starts ([#14917](https://github.com/can1357/oh-my-pi/pull/14917) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Anthropic web search through a custom `anthropic-messages` provider sending a plain API-key request even though the provider's conversations use Claude Code request shaping; search now honors the model's `isOAuth` like the main conversation, so keys that only work with that shaping no longer fail with HTTP 429 `rate_limit_error` ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))
- Fixed Anthropic web search spreading the model's configured headers under its own without the main conversation's case-insensitive merge and enforced-header filtering, so a configured `authorization` header could replace the credential or join it comma-separated on the wire ([#14919](https://github.com/can1357/oh-my-pi/pull/14919) by [@farnoy](https://github.com/farnoy))

### Removed

- Removed the `PI_SUBPROCESS_CMD` environment variable; subagents run in-process and never read it ([#14632](https://github.com/can1357/oh-my-pi/pull/14632) by [@jorgoose](https://github.com/jorgoose))

## [18.8.4] - 2026-10-08

### Changed

- Agent Hub keeps existing agents in place while open; new agents appear first in the flat roster or within their tree sibling group ([#13066](https://github.com/can1357/oh-my-pi/pull/13066) by [@kmccleary3301](https://github.com/kmccleary3301))

### Fixed

- Fixed `omp auth-broker serve` logging every client as `unknown` (or as whatever a caller put in `X-Forwarded-For`); it now logs the socket address, with `--trust-proxy-headers` for brokers behind a reverse proxy ([#14762](https://github.com/can1357/oh-my-pi/pull/14762) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed relative file links in Tern assistant replies opening against the folder omp was started in after `/wt` or `/move`; they now open the file in the session's working directory ([#14879](https://github.com/can1357/oh-my-pi/pull/14879) by [@H4vC](https://github.com/H4vC))
- Fixed the BTW history, git shortcuts, and autoresearch sheets in Tern having no Close button, and the plan review sheet having no Cancel button ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the agent transcript viewer and `/annotate` review in Tern having no clickable way out; both now show a clickable `esc` at the top right ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed the `/move` folder picker in Tern having only key hints; Accept (Tab), Cancel (Esc) and Confirm (Enter) are now clickable buttons ([#14894](https://github.com/can1357/oh-my-pi/pull/14894) by [@H4vC](https://github.com/H4vC))
- Fixed `omp usage` listing a second "7 days … not reported" row for a Codex account that reports only a weekly window, and misaligning its rows against accounts that report a 5-hour window too ([#14760](https://github.com/can1357/oh-my-pi/pull/14760) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` showing the usage and credential health of providers listed in `disabledProviders`, account emails included, on `/v1/usage` and `/v1/credentials/check` ([#14755](https://github.com/can1357/oh-my-pi/pull/14755) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` on auth-broker clients always reporting no recorded history; it now reads the broker host's history, as `omp usage clients` already does ([#14758](https://github.com/can1357/oh-my-pi/pull/14758) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --history` and `omp usage clients` dying with a stack dump when the auth broker is unreachable or lacks the endpoint; they now print a one-line error and exit nonzero
- Fixed `omp usage --history` showing two Codex accounts that share an email under the same name; they now carry the same qualifier as `omp usage` ([#14767](https://github.com/can1357/oh-my-pi/pull/14767) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `--model`, `/model` and `/switch` with a bare id that several logged-in providers carry ignoring `modelProviderOrder` and recent use; they now pick the same provider as `modelRoles`, and `omp bench`, compress, cleanse and the stdio auth gateway follow the same ranking ([#14517](https://github.com/can1357/oh-my-pi/pull/14517) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage --provider <id>` blaming a missing usage endpoint when no credentials are stored for that provider, and `omp usage invalidate --provider <id>` reporting success for it; both now list the providers that have credentials ([#14763](https://github.com/can1357/oh-my-pi/pull/14763) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp usage` labelling an exhausted account "inside reserve" on its account-policy line; it now says "exhausted" ([#14764](https://github.com/can1357/oh-my-pi/pull/14764) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/new` keeping plan mode (and its plan-role model) or goal mode active in the new session ([#14653](https://github.com/can1357/oh-my-pi/issues/14653))
- Fixed parallel first bash calls each spawning an rc-sourcing shell ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed the todo list's auto-clear never firing while subagents were streaming progress ([#14692](https://github.com/can1357/oh-my-pi/pull/14692) by [@H4vC](https://github.com/H4vC))
- Fixed memory growth while ACP client-terminal commands run ([#14680](https://github.com/can1357/oh-my-pi/pull/14680) by [@H4vC](https://github.com/H4vC))
- Fixed ephemeral side-channel replies (idle recap, completion probe, `runEphemeralTurn`) truncating in quadratic time ([#14695](https://github.com/can1357/oh-my-pi/pull/14695) by [@H4vC](https://github.com/H4vC))
- Sped up `omp compress` by tokenizing each draft once per round ([#14702](https://github.com/can1357/oh-my-pi/pull/14702) by [@H4vC](https://github.com/H4vC))
- Fixed the agent slowing down while streaming long eval cells ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown reading large Python kernel output (big reprs, base64 images) ([#14704](https://github.com/can1357/oh-my-pi/pull/14704) by [@H4vC](https://github.com/H4vC))
- Sped up TUI repaints of live stream and `/record` rows ([#14705](https://github.com/can1357/oh-my-pi/pull/14705) by [@H4vC](https://github.com/H4vC))
- Fixed quadratic slowdown in `omp cleanse` on large tsc/clippy/golangci output ([#14706](https://github.com/can1357/oh-my-pi/pull/14706) by [@H4vC](https://github.com/H4vC))
- Fixed documents served as `application/octet-stream` being downloaded twice ([#14708](https://github.com/can1357/oh-my-pi/pull/14708) by [@H4vC](https://github.com/H4vC))
- Fixed collab TUI guests rebuilding the transcript per token ([#14715](https://github.com/can1357/oh-my-pi/pull/14715) by [@H4vC](https://github.com/H4vC))

## [18.8.3] - 2026-10-07

### Fixed

- Fixed repeat opens of the model picker, model hub, or agents views stacking duplicates; the open one is brought forward instead ([#14846](https://github.com/can1357/oh-my-pi/pull/14846) by [@H4vC](https://github.com/H4vC))

## [18.8.2] - 2026-10-07

### Fixed

- Fixed long Anthropic sessions with repeated tool screenshots exceeding the request-size limit; live images are now trimmed by bytes, recoverable 413s may compact older history, and terminal subagent failures reach the parent ([#14453](https://github.com/can1357/oh-my-pi/issues/14453)).
- Fixed Tern browser tabs opened with a `url` returning before the page loaded, which made the first `observe()` or `title()` read the blank page.

### Removed

- Removed per-call `model` overrides from `task`, eval `agent()`, and `workpool()`; subagents use configured agent models and settings.

## [18.8.1] - 2026-10-07

### Added

- Added account pools for task agents, allowing an agent and its related work—including advisors, title generation, subagents, and resumed sessions—to use only specified OAuth accounts and fail rather than fall back to another account or an API key.
- Added `omp usage accounts` to list OAuth account provider and identity keys without exposing tokens, making account-pool configuration easier.

### Changed

- Generated session titles now include their card icon and short code, so the `/resume` picker and session listings show this context; `title.icons` applies to newly generated titles.
- Symlinked routing configurations now reload when an intermediate file or profile-directory link is replaced, without requiring a session restart.

### Fixed

- Improved Tern `ask` questions so the question no longer obscures the transcript and can be answered while reviewing and scrolling through the relevant context.
- Added warnings for unrecognized `compat` keys in `models.yml` while continuing to load the configuration; warnings identify the file and key path.
- Fixed `/new` so new sessions reset plan and goal modes, todo state, and related planning configuration instead of carrying stale state forward; fresh prewalk behavior is also restored after handoffs, cancellations, or automatic recovery.
- Fixed OAuth alias login and logout flows so they refresh the underlying provider's models, report authentication state correctly, and list and remove the accounts associated with that provider.
- Fixed model speed statistics so throughput from non-default OpenAI or Codex service tiers is kept separate and displayed for the tier used by the session.
- Fixed stale model catalogs remaining in memory after provider or catalog refreshes.
- Fixed `write` and `edit` from hanging or exhausting memory when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations from losing user and tool-result images when the conversation also contained assistant-generated images.
- Fixed `local://` session paths from escaping their intended storage directory when given `.` or `..` session identifiers.
- Fixed `omp gc --archive --apply` from leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted reopened `ask` prompt when an extension had registered a context handler.
- Fixed browser relay sessions from missing cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on invisible native radio and checkbox inputs, including controls commonly used by GOV.UK forms.
- Fixed `/model` so selecting the model already assigned to a project's default role still switches to that model correctly.
- Fixed `wait` and background task state when a completion has already been consumed elsewhere, preventing premature interruption and incorrect idle detection.
- Fixed repeated coding-plan fallback confirmations after declining a fallback in cases involving changing thinking settings, unavailable quota data, or account recovery.
- Fixed Python evaluation when the shared runner temporary directory was created by another user.
- Added RPC support for completing multi-select `ask` questions without relying on TUI keyboard navigation.
- Corrected tool behavior and configuration documentation for `read`, background `bash`, Python evaluation, replace editing, goal removal, and `advisor.immuneTurns`.
- Fixed custom glob backends from hanging indefinitely; scans now respect the tool deadline and report incomplete results when necessary.
- Fixed `--resume <path>` from silently creating a new session for a missing path; it now reports the missing path, consistent with `--fork <path>` and `--resume <id>`.

## [18.8.0] - 2026-10-07

### Added

- Write-tool previews now render as files stream: SVG files appear as images, and Mermaid files (`.mmd` and `.mermaid`) appear as diagrams. Tern also previews supported 3D model formats (`.obj`, `.ply`, `.wrl`, `.x3dv`, `.stl`, `.gltf`, and `.usda`) and renders SVG writes as SVG figures.
- Added the `title.icons` setting to show session title cards with a Nerd Font glyph and emoji fallback (`nf+emoji`, default), always the emoji (`emoji`), or as plain titles (`boring`).
- Added the `title.generator` setting to name sessions from a fork of the reply (`fork`, default) or with the title model only (`tiny`).

### Changed

- Session titles are generated using the session's model when possible, with a fallback to the lightweight title model; `TITLE_SYSTEM.md` continues to override the title prompt.
- Session titles now include a card index, icon, and short code, with appropriate Nerd Font rendering in Tern panes.
- When Nerd Font symbols are unavailable, session titling requests only an emoji.
- Subagent completion indicators now advance to 99% when the subagent submits its result.
- In Tern panes, headed and headless browser opens are shown in Tern picture-in-picture by default; set `app.tern: false`, `browser.tern`, or `PI_BROWSER_TERN=0` to open Chromium instead.
- In Tern panes, `/fork` opens the fork in a neighboring pane while preserving the original session.
- Tern's empty composer now shows the session title, or “What are we cooking?” when no title is available.
- Tern todo cards now display their checklist by default and can be collapsed by clicking the card header.
- Improved performance across browser extraction, web and document fetching, file tools, search, session handling, LSP/DAP, MCP, subagents, SSH file operations, image processing, voice and dictation, collaboration, and large-output or large-file workflows.
- Prompt history search now updates shortly after typing stops while Enter and mouse selections use the latest query.
- Improved responsiveness and reduced resource usage for long sessions, large files and documents, streaming evaluations, terminal graphics, live voice calls, and other high-volume workflows.
- Hosts that are not supported Mastodon, Lemmy, or Discourse instances are no longer repeatedly probed for those services, improving URL-fetch performance.

### Fixed

- Fixed a message sent while an earlier title request was still running never getting its own try at naming the session when that request came back empty.
- Fixed `/new` incorrectly carrying plan mode, its plan-specific model, or goal mode into the new session.
- Fixed todo lists failing to auto-clear while subagents streamed progress.
- Fixed memory growth during ACP client-terminal commands.
- Fixed freezes after large pastes containing unclosed tags.
- Fixed slowdowns when processing long evaluation output, large Python kernel results, compiler/linter output, and ephemeral side-channel replies.
- Fixed documents served as `application/octet-stream` being downloaded twice.
- Fixed collaboration guests rebuilding the transcript excessively during streaming.

## [18.7.0] - 2026-10-06

### Added

- Added last-chance consumption of eligible banked Codex and Claude resets expiring within five minutes when auto-redeem is enabled, even with low usage or reserved credits.
- Added inline rendering of agent-generated SVG diagrams, charts, and mockups, with theme-aware colors and a `tui.renderSvg` setting to disable it.
- Added automatic chart generation for numeric tables, configurable with `tui.autoGraph` (`always`, `smart`, or `off`). The agent now chooses suitable visual formats—including charts, Mermaid, SVG, tables, or prose—based on the content. Charts and this guidance apply to the main TUI session only, not to subagents, print, RPC, or ACP.
- Added first-class JSON and JSONL querying to the `read` tool with `?q=<jq-filter>`, including in-process filtering, raw or compact output, and offset/limit pagination for efficient large-file access.
- Added `/prewalk off` to cancel a pending model handoff without changing the active model, saved prewalk setting, or continuation history.
- Added logout support to RPC clients through `get_logout_accounts` and `logout`, with matching methods in the TypeScript, Python, Go, and Rust SDKs.
- Added custom model-kind declarations for providers and extensions, allowing image, speech, embedding, judge, and other supported model roles to be registered and routed correctly.
- Added working-directory reporting for Tern terminal sessions so the native composer bar can display the current folder.

### Changed

- Improved JSON and JSONL query streaming and pagination to reduce resource usage, support partial results, and provide clearer continuation between result pages.
- Clarified the `read` tool documentation with complete examples for requesting line ranges.

### Fixed

- Fixed model-preset tests failing when provider credentials are configured in the environment.
- Fixed unauthenticated Macs auto-selecting the on-device Apple model when the default prompt exceeds its context window; Apple remains selectable explicitly.
- Fixed replay and compaction tests failing after bundled model roster changes.
- Fixed standalone builds failing when the native addon archive could not be resolved.
- Fixed JSON query parsing and parameter decoding for filters beginning with hyphens and other encoded query values.
- Fixed task execution after settings could not be saved; subagents now use the current in-memory settings while the save failure is reported as a warning.
- Fixed prewalk and model-recovery state across `/new`, handoffs, cancellations, and automatic recovery.
- Fixed login, logout, model refresh, and provider-status reporting for aliased providers such as `openai-codex-device`.
- Fixed model speed statistics mixing fast service-tier results into standard-tier averages; `/models` now reports the applicable tier separately.
- Fixed the `write` and `edit` tools hanging or consuming excessive resources when given FIFOs, terminals, device files, or other non-regular targets; unsupported targets are now rejected safely.
- Fixed long conversations losing user or tool-result images because assistant-generated images were counted against provider image limits.
- Fixed local session paths for special session IDs such as `.` and `..` so they cannot escape the intended storage directory.
- Fixed `omp gc --archive --apply` leaving orphaned session-title records behind.
- Fixed `/retry` after an interrupted process exit while an extension-driven prompt was reopening.
- Fixed browser relay sessions failing to discover or interact with cross-origin iframe content that loaded before the tab was opened.
- Fixed browser clicks on visually styled radios and checkboxes whose underlying inputs are hidden.
- Fixed `/model` failing to switch when selecting the model already assigned to a project's default role.
- Fixed `wait` returning early when a background completion had already been consumed by another operation.
- Fixed symlinked routing configurations failing to reload after their target links were replaced.
- Fixed repeated coding-plan fallback confirmations in cases involving changing thinking settings, unavailable quota information, or account recovery.
- Fixed Python evaluation failing when a shared runner temporary directory was created by another user.
- Fixed RPC clients being unable to complete multi-select questions in multi-question `ask` prompts.
- Corrected inaccurate tool and setting descriptions, including `read` ranges, background `bash` behavior, Python evaluation capabilities, edit replacement guidance, goal removal behavior, and `advisor.immuneTurns`.
- Fixed custom glob backends hanging indefinitely; scans now honor tool deadlines and cancellation.
- Fixed `--resume <path>` silently creating a new session when the specified path did not exist; it now reports the missing path.
- Fixed `/settings` opening duplicate menus when invoked while the settings menu was already open.
- Fixed native Git operations resolving repositories incorrectly when run through symbolic links.

## [18.6.3] - 2026-10-06

### Breaking Changes

- `createAgentSession` now throws `Could not restore model <provider/id>` when a resumed session's saved models cannot be restored, and `AgentSession.switchSession` throws it, keeping the current session, when it opens such a session; both still fall back with a warning when `hasUI` is set and `retry.modelFallback` is on, and hosts that cannot show that warning can opt out with `allowSessionModelFallback: false` ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).

### Added

- Added an agents HUD pill counting running subagents, opening the agent hub on click
- In Tern the thinking level shows as the composer model chip's icon instead of a separate chip, still cycling on click, while `statusLine.compactThinkingLevel` (Compact Thinking Level, on by default) is on
- Added `computer.zoom()` and window-local `zoom()` in JavaScript and Python Eval, with native-detail region captures that preserve full-screenshot click coordinates.
- Added window menus, combined `observe()`, native application discovery/launch, live display handles, bounded input holds, human-approved task control, and macOS Space helpers in both Eval languages.
- RPC `open_session` and `switch_session` accept an optional `provider`/`modelId` pair that binds the session to that model instead of its saved one, as `--model` does at startup; `RpcClient.openSession()`/`switchSession()` and the Python client's `open_session()`/`switch_session()` take it too ([#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm))
- Added `compat.statefulResponses` to `models.yml`, so a provider or model can opt into or out of stored Responses chaining without the process-wide `PI_OPENAI_STATEFUL` ([#13686](https://github.com/can1357/oh-my-pi/pull/13686) by [@alphastorm](https://github.com/alphastorm)).
- Added the `app.stt.pushToTalk` keybinding, defaulting to `Space`, so push-to-talk can be remapped or disabled independently from speech-to-text and `app.stt.toggle` ([#6592](https://github.com/can1357/oh-my-pi/pull/6592) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added an `expandThinkingBlocks` setting that keeps finished thinking blocks expanded in Tern instead of collapsing them at turn end ([#14519](https://github.com/can1357/oh-my-pi/pull/14519) by [@H4vC](https://github.com/H4vC))
- RPC clients can show and toggle `/slow`: `get_state` reports `slowModeSupported`, `slowModeEnabled`, and a provider-neutral `usageLimit` (wrap-up or low-priority stage, with reset times for the client's timezone), and the new `set_slow_mode` command turns it on or off; the TypeScript client and the generated Python, Go, and Rust SDKs gain a matching `setSlowMode`/`set_slow_mode`/`SetSlowMode` method ([#14153](https://github.com/can1357/oh-my-pi/pull/14153) by [@andrebrait](https://github.com/andrebrait))
- RPC clients can now stop a turn the way Esc does in the TUI with `abort_and_restore_queue`: queued steering and follow-up messages are taken back and returned for the editor instead of running in a new turn after the abort ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- RPC `remove_queued_message` now returns the removed message's images, so clients can put an edited queued message back in the editor with its attachments ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Added `/btw` side questions for RPC hosts: `btw` asks one (or a follow-up in an earlier topic) while the main turn keeps running, the answer streams as `btw_delta` / `btw_record` frames, `btw_cancel` stops it, and `get_btw_history` lists the session's BTW history shared with the TUI ([#14110](https://github.com/can1357/oh-my-pi/pull/14110) by [@andrebrait](https://github.com/andrebrait))
- Added the `providers.muse-code.storeResponses` setting (off by default; `PI_MUSE_STORE_RESPONSES` overrides it) to store Muse Code results on Meta's servers, so a turn whose connection drops is recovered instead of re-run ([#14534](https://github.com/can1357/oh-my-pi/pull/14534) by [@abilliontokens](https://github.com/abilliontokens)).

### Changed

- In Tern the spinner, elapsed time and intent share one activity line with the todo, which stays in place between turns, and the tok/s readout moves into the composer bar after the thinking level
- Computer-use desktop captures now default to the focused window's monitor, with primary-monitor fallback; `computer.display: all` remains available explicitly.
- Computer-use guidance selects AX for semantic controls and screenshots for custom-drawn surfaces, with grouped actions and explicit state verification.
- Bash commands that print binary or other non-UTF-8 output no longer stall while their output is decoded ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Edit previews stay responsive while long edits stream, and `read` parses large files for block context off the main thread ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- While a `sloppy`-mode edit streams, its preview no longer guesses an edit for a `*** Find` whose `*** Replace` has not arrived yet; the preview of an earlier file section that ends in a bare `*** Find` still matches what will be applied ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- `@` file mentions autocomplete faster in large repositories ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Large mermaid flowcharts and state diagrams render much faster while a response streams ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Diff hunk headers now name the enclosing function the way git does: the nearest earlier line starting with a letter, `_` or `$`, cut to 80 bytes; `#`-prefixed and indented lines are no longer picked ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Made browser `tab.observe()` much faster on element-heavy pages, especially over the relay: listed elements are resolved to handles only when `tab.id(n)` uses them ([#14431](https://github.com/can1357/oh-my-pi/pull/14431) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed Tern tooltips naming keys with Nerd Font icons Tern's UI font lacks (a box after "Thinking effort"); they show keycaps (`⇧⇥`) whatever the symbol preset
- Fixed `/new`, session switches, and Esc aborts hanging for up to 30 seconds while an extension's `message_end` hook was still running; they now wait only for end-of-turn maintenance.
- Fixed Tern's per-turn usage row showing a 24-hour time while the user message above it showed a 12-hour time; both now follow the terminal's clock ([#14565](https://github.com/can1357/oh-my-pi/pull/14565) by [@wolfiesch](https://github.com/wolfiesch))
- Fixed Tern's agents pill missing while a finished subagent runs again after an IRC message woke or revived it; it now counts running agents as the status-line badge does
- Fixed browser `tab.goto`, `back`, `forward` and `reload` timing out on pages whose ad, chat or other iframe never finishes loading, although the page itself had loaded ([#14421](https://github.com/can1357/oh-my-pi/pull/14421) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the token count after a snapcompact compaction (divider and RPC result) disagreeing with the context count right after it ([#14291](https://github.com/can1357/oh-my-pi/pull/14291) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact archives stopping at 17 frames on models that read 1568px frames (OpenAI, Codex, and Claude before Opus 4.7); they now keep 26 under the same 3 MB image payload cap, and an archive whose frames run heavier than estimated is re-rendered with fewer frames instead of being rejected ([#14277](https://github.com/can1357/oh-my-pi/pull/14277) by [@will-bogusz](https://github.com/will-bogusz)).
- Preserved original-detail image pixels through both Eval runtimes instead of resizing screenshots again and requiring model-side coordinate conversion.
- Retired queued and in-flight native input on computer-run cancellation and teardown, including unawaited operations, without canceling later runs.
- Fixed the `/usage` sheet in Tern missing the Close button the other report sheets have ([#14455](https://github.com/can1357/oh-my-pi/pull/14455) by [@H4vC](https://github.com/H4vC)).
- Fixed a browser page load abandoned by cancelling a run still replacing the page afterwards; the cancelled load is now stopped, so a run that had taken over request interception also returns at once instead of failing with "Failed to restore browser request interception". Cancelling a run that is not navigating leaves the page's in-flight requests alone ([#14425](https://github.com/can1357/oh-my-pi/pull/14425) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cancelling a bash command on Windows sometimes terminating an unrelated program ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `umask` in a bash command changing the umask of omp itself ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a mermaid `xychart` whose axis range is finer than floating-point precision freezing the terminal ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session whose saved model cannot be restored silently sending its transcript to another model. At startup, `--continue`/`--resume` in print, JSON, RPC, and `rpc-ui` modes (and in the TUI with `retry.modelFallback: false`) now exits with an error naming the model instead of using the settings-default or first available model. At runtime, RPC `open_session` and `switch_session`, ACP session load and fork, and extension session switches fail with `Could not restore model <provider/id>` and keep the current session instead of continuing on the current model; TUI `/resume` warns `Could not restore model <provider/id>. Using <provider/id>`, or fails with the error when `retry.modelFallback` is off. `/resume` also restores models from discovery-backed providers the way startup does ([#12274](https://github.com/can1357/oh-my-pi/issues/12274), [#13689](https://github.com/can1357/oh-my-pi/pull/13689) by [@alphastorm](https://github.com/alphastorm)).
- Auto-retry no longer switches to the fallback chain when Codex's native turn lane rejects live steering after the response streamed reasoning; the turn retries on the same model with the steering message as ordinary input, and the chain is consulted only once no same-model retry is left ([#14242](https://github.com/can1357/oh-my-pi/pull/14242) by [@alphastorm](https://github.com/alphastorm))
- Fixed bash commands re-running a direnv `.envrc` (and devenv setup) on every call; an unchanged direnv environment is now reused ([#14310](https://github.com/can1357/oh-my-pi/pull/14310) by [@n3oney](https://github.com/n3oney)).
- Fixed the `computer` guide telling the model that refs from its earlier `ax()` reads expire; it now says an element keeps its `[ref=eN]` across reads until its role or label changes ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed snapcompact inline imaging judging savings by the gateway's frame cost instead of the reading model's ([#14286](https://github.com/can1357/oh-my-pi/pull/14286) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed a session running past local midnight losing its earlier Claude reasoning (or failing with a 400 under strict thinking binding) because a message you sent mid-turn was rewritten with the new date ([#14339](https://github.com/can1357/oh-my-pi/pull/14339) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed OpenAI and Codex Remote Compaction V2 dropping a `/skill:` or collab prompt you sent from the kept history, and kept screenshots inflating the post-compaction token count and discarding speculative compactions ([#14247](https://github.com/can1357/oh-my-pi/pull/14247) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed cold-resumed subagents losing signed thinking because their system prompt blocks were joined ([#14338](https://github.com/can1357/oh-my-pi/pull/14338) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the first kept assistant turn losing its thinking after Anthropic native compaction, including after a date or working-directory change and on later compactions ([#14251](https://github.com/can1357/oh-my-pi/pull/14251) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed Claude rejecting or dropping the thinking kept after a compaction when the date or working directory had changed during a tool call in the kept turns; the date/cwd reminder those turns were sent with is no longer removed ([#14502](https://github.com/can1357/oh-my-pi/pull/14502) by [@H4vC](https://github.com/H4vC))
- Fixed browser `tab.waitForDownload()` and `tab.downloads()` reporting a path that does not exist when another open tab set a different `downloads` directory ([#14434](https://github.com/can1357/oh-my-pi/pull/14434) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed subagents keeping the MCP tools they started with after `/mcp reload` or adding or removing an MCP server; running and revived subagents now follow the main session's MCP tools ([#14441](https://github.com/can1357/oh-my-pi/pull/14441) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed the browser relay failing its first command on a tab that DevTools or another debugger extension already had open ([#14224](https://github.com/can1357/oh-my-pi/pull/14224) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs through the relay hanging and failing on pages with cross-origin iframes (embedded sign-in, payment or help widgets) ([#14228](https://github.com/can1357/oh-my-pi/pull/14228) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser clicks on Chromium and Tern tabs landing on the surrounding paragraph, without following the link, when the link wraps across two lines ([#14229](https://github.com/can1357/oh-my-pi/pull/14229) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab and element-handle clicks and `check`/`uncheck` on an element that never becomes clickable timing out with no reason; the timeout now names the last failed check, such as `display:none` ([#14230](https://github.com/can1357/oh-my-pi/pull/14230) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `check()`, `uncheck()` and `click()` refusing or timing out on custom-styled checkboxes and radios whose real input is transparent or drawn over by its label ([#14231](https://github.com/can1357/oh-my-pi/pull/14231) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp auth-gateway serve` advertising and routing models from providers listed in `disabledProviders`; `omp auth-gateway check` now skips those providers' credentials too ([#14234](https://github.com/can1357/oh-my-pi/pull/14234) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser calls in relay mode each waiting 35 seconds after Chrome quit and then reporting that the extension "never connected"; they now fail at once and say it disconnected ([#14236](https://github.com/can1357/oh-my-pi/pull/14236) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/shake` and other history rewrites during a running tool call leaving the context meter stale and dropping that tool call from the agent's history ([#14261](https://github.com/can1357/oh-my-pi/pull/14261) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed a session using a custom `browser.relayUrl` port stopping the browser relay that other sessions were using on a different port ([#14407](https://github.com/can1357/oh-my-pi/pull/14407) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.click(selector)` failing at once with "matched no visible element" when the page renders the target a moment later; it now waits like `tab.fill`, `tab.type` and `tab.dblclick` ([#14408](https://github.com/can1357/oh-my-pi/pull/14408) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill()` and `tab.type()` on a disabled or read-only field wiping it and typing into whichever field had focus while reporting success; they now fail with the reason ([#14412](https://github.com/can1357/oh-my-pi/pull/14412) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.fill(selector, "")` clearing a field without telling the page, so React and Vue forms kept and submitted the old value; the clear now fires `input` and `change` ([#14413](https://github.com/can1357/oh-my-pi/pull/14413) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.waitForDownload()` missing a download started by the next tab action on tabs opened without a `downloads` directory; the file landed in the browser's default folder and the wait timed out ([#14417](https://github.com/can1357/oh-my-pi/pull/14417) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` failing with a bare `[object ErrorEvent]` when the browser's debugger websocket refuses the connection; the error now names the endpoint and why it failed ([#14418](https://github.com/can1357/oh-my-pi/pull/14418) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser tab evaluations hanging when the page redirected again while the tab was being read; they now run on the page the redirect landed on ([#14423](https://github.com/can1357/oh-my-pi/pull/14423) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser dropdown selection resetting to the first option when given an option's visible label instead of its value, on Chrome and cmux tabs and element handles; `select()` now fails and leaves the dropdown unchanged when a value matches no option, on every backend ([#14226](https://github.com/can1357/oh-my-pi/pull/14226) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser key combos such as `Control+a` failing on Chrome tabs, frames and elements, and macOS editing shortcuts and clipboard copy/paste doing nothing ([#14225](https://github.com/can1357/oh-my-pi/pull/14225) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.extract("text")` running headings, paragraphs, list items and table cells together on one line, and leaking `<script>`/`<style>` text with a `selector` ([#14227](https://github.com/can1357/oh-my-pi/pull/14227) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` saving a 30-day session pin to `agent.db` for every sampled session id ([#14512](https://github.com/can1357/oh-my-pi/pull/14512) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` rejecting `--config`; it now applies the overlay like `PI_CONFIG_FILES`, so account-policy experiments route as configured ([#14513](https://github.com/can1357/oh-my-pi/pull/14513) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `omp dry-balance` failing to resolve credential-scoped dynamic models, such as Factory Droid's, that `omp models` lists ([#14514](https://github.com/can1357/oh-my-pi/pull/14514) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser element right and double clicks (`click({ button, count })`) becoming one left click on Tern and cmux tabs; cmux now refuses the buttons and counts it cannot press ([#14232](https://github.com/can1357/oh-my-pi/pull/14232) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `open` and `tab.observe()` reporting a fixed 1365x768 viewport on relay, attached and visible browsers instead of the tab's real window size and pixel ratio ([#14409](https://github.com/can1357/oh-my-pi/pull/14409) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser runs and helper calls failing with "Failed to restore browser request interception" after their work had finished, including every call on pages with a hung cross-site iframe ([#14410](https://github.com/can1357/oh-my-pi/pull/14410) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `browser.open` on a page that outlasts its `timeout` closing the tab with a bare "Browser open timed out"; the tab now stays on what loaded and the error names the navigation and `browser.tab(name)`. A new tab whose navigation fails outright, or whose open is cancelled, is still closed ([#14420](https://github.com/can1357/oh-my-pi/pull/14420) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed browser `tab.observe()` leaving out every control inside iframes (embedded sign-in, payment and checkout forms), including iframes inside a web component's shadow root under `selector`, so they got no ids to act on. An iframe that does not answer within 5 seconds is left out and skipped by later observations until it navigates ([#14415](https://github.com/can1357/oh-my-pi/pull/14415) by [@will-bogusz](https://github.com/will-bogusz))
- Pressing Esc while a queued message is about to be sent now restores it to the editor instead of the stopped turn recording it ([#14179](https://github.com/can1357/oh-my-pi/pull/14179) by [@andrebrait](https://github.com/andrebrait))
- Fixed `edit` silently dropping late LSP diagnostics from slow servers such as tsserver; they now arrive like they do for `write` ([#14214](https://github.com/can1357/oh-my-pi/issues/14214))
- Fixed multi-question `ask` dropping the ticked options of a multi-select question when the user also typed an "Other" answer; the model now receives both ([#14369](https://github.com/can1357/oh-my-pi/issues/14369))
- Focused subagents can now recall queued steering messages with Alt+Up or Shift+Up without restoring a message from the main session ([#14464](https://github.com/can1357/oh-my-pi/issues/14464)).
- Fixed results that a focused subagent submits after you prompt it in the TUI never reaching the parent agent: the subagent's `agent://<id>` artifact is now updated and the parent receives the completion ([#14428](https://github.com/can1357/oh-my-pi/issues/14428))
- Computer use on KDE Plasma Wayland now types printable characters through the keymap KWin announces instead of failing with "no usable XKB keymap was announced", and `type("…\n")` presses Enter ([#13848](https://github.com/can1357/oh-my-pi/issues/13848))
- Budget-stopped subagents no longer issue automatic retry requests after being reported cancelled; they remain available for explicit resumption ([#13892](https://github.com/can1357/oh-my-pi/issues/13892)).
- Fixed switching models mid-session keeping the previous model's `inlineToolDescriptors: auto` decision, which sent empty tool descriptions to the new model and failed with `function.description is required` ([#14200](https://github.com/can1357/oh-my-pi/issues/14200))
- Fixed advisors staying quota-paused when another account's temporary auth block ends at the retry wait limit ([#14551](https://github.com/can1357/oh-my-pi/issues/14551)).
- Fixed `omp worktree add` and other git operations failing with `git open: … does not appear to be a git repository` when the checkout directory name ends in `.git` ([#14553](https://github.com/can1357/oh-my-pi/issues/14553))
- Fixed Mnemopi embedding workers (and other local-model workers) staying alive and holding gigabytes of RAM after the omp process that started them exited mid-embedding ([#14340](https://github.com/can1357/oh-my-pi/issues/14340))
- Fixed a supervised PTY service on Windows hanging when it asks the terminal for the cursor position; the launch broker now answers the query as it does on Linux and macOS

## [18.6.2] - 2026-10-04

### Fixed

- Fixed snapcompact's short final frames preventing vision-backed sessions from continuing on backends that reject 32px-or-smaller images ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).
- Fixed the agent's `goal` calls asking for approval under `--approval-mode write`, which paused goal-mode loops at `complete`; `always-ask` still prompts for goal changes but not `get` ([#14368](https://github.com/can1357/oh-my-pi/issues/14368))
- Fixed MCP server connection progress popping up a toast for every server that connects or fails in native terminals such as Tern; it now shows only in the classic terminal transcript

## [18.6.1] - 2026-10-04

### Fixed

- Fixed waiting for subagent follow-up messages: responses now appear as background jobs that can be waited on or canceled, and are delivered only once.
- Improved `/switch` autocomplete so model and role suggestions use the same relevance ordering as the model picker, including support for `@role` aliases.
- Fixed concurrent `skill://` searches blocking other filesystem operations and delaying subagent artifact publication.
- Fixed compatibility checks for browser relays from other OMP versions and added guidance for resolving stale connection-refused errors.
- Fixed follow-up hashline edits being incorrectly rejected after earlier edits shifted anchored lines, while continuing to reject genuinely stale line references.
- Fixed `pi.exec()` reporting exit code `0` when a process was terminated by a timeout or signal; terminated processes now report code `-1`.
- Fixed `/collab` guests being unable to respond to setting-change approval and tool-issue report consent prompts.
- Fixed follow-up hashline edits being rejected as anchored on lines "never displayed" after an earlier edit shifted those lines, when the replacement carries the anchored content; genuinely stale line numbers are still rejected ([#14254](https://github.com/can1357/oh-my-pi/pull/14254) by [@abilliontokens](https://github.com/abilliontokens)).
- Fixed long `/btw` answers in Tern being clipped with no way to scroll: `/btw` now answers in the scrollable BTW history sheet ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- Fixed `/btw` answers longer than 4 KiB being cut off with `[…truncated]` once they finished ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))
- In Tern, Esc puts the BTW history sheet away while an answer keeps streaming (`/btw` reopens it); `x` cancels the answer ([#14331](https://github.com/can1357/oh-my-pi/pull/14331) by [@H4vC](https://github.com/H4vC))

## [18.6.0] - 2026-10-03

### Added

- The `/models` Roles view shows which saved model preset is in effect, and Ctrl+←/→ (or `p`/`P` on the role rows, for macOS where Ctrl+←/→ switches Spaces) switches to the next or previous one, in Tern and text mode ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))

### Changed

- Picking a model for a role in `/models` now puts the cursor on the model list, so ↑/↓ choose a model and Enter assigns it right away instead of moving through the sidebar and dropping the role selection; ← still reaches the providers ([#14210](https://github.com/can1357/oh-my-pi/pull/14210) by [@H4vC](https://github.com/H4vC))
- Sped up secret redaction on long conversations: it no longer slows down as history grows ([#14213](https://github.com/can1357/oh-my-pi/pull/14213) by [@H4vC](https://github.com/H4vC))
- Startup is faster with plugins that bundle large dependency trees: the extension loader no longer re-reads and re-checks the same files while loading them (e.g. ~280 ms → ~185 ms with the IDA MCP plugin) ([#14219](https://github.com/can1357/oh-my-pi/pull/14219) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed an `EPIPE: broken pipe` unhandled rejection crashing the session when a debug adapter, eval kernel, IDA worker, or RPC server exits mid-write (seen on Windows) ([#14196](https://github.com/can1357/oh-my-pi/pull/14196) by [@andrebrait](https://github.com/andrebrait))

## [18.5.1] - 2026-10-03

### Added

- Added RPC support for GPT live voice sessions bound to the RPC session, including live start, stop, mute, phase, level, transcript, and end events; closing stdin also stops an active live session.
- Published a machine-readable RPC wire schema and added generated-client support for Python, Rust, and Go RPC clients, including protocol v2 negotiation, prompt-result handling, host tools, and host URIs. The Python client is now distributed from the SDK package location.
- Added the read-only `archive` eval global for browsing projects and past sessions, viewing idle recaps and recap journals, opening session prompts, and searching prompt history. It is enabled by default with `archive.enabled`.

### Changed

- `wait` now waits only for background jobs and services started by the calling agent and reports an error when there is no such work to wait for; messages can still end the wait.
- Improved automatic session titles for image-only requests and mid-session refreshes so titles better reflect the user's actual goal and no longer echo placeholder text.
- In focused subagent views, submitting `.` or `c` now continues the subagent just as it does in the main session.
- Reduced memory use and loading time when forking sessions or when session history references the same image multiple times.
- The `computer` tool's `clipboard.write` now updates only the desktop clipboard and no longer sends text to the terminal clipboard via OSC 52.
- Improved terminal layout stability in Rebuild mode when resizing or zooming tmux panes.
- Advisor concerns and notes now reach an active same-run continuation after a terminal answer instead of being retained unnecessarily.

### Fixed

- Fixed background-job completions being lost when IRC-woken subagents finished while owned asynchronous work was still settling.
- Fixed session reset leaving stale hashline edit snapshots available for later mismatch diagnostics.
- Fixed multi-subagent `task` calls reporting success when one subagent failed.
- Fixed RPC clients waiting indefinitely for prompt results after automatic compaction handoffs.
- Fixed the retry prompt layout after interrupted tool calls and eliminated several TUI display issues, including flickering, duplicate streamed tool cards, blank space, and stray escape-code fragments during streaming, resizing, zooming, and clipboard or notification output.
- Fixed shared headless browsers remaining resident after a failed close; unresponsive browser instances are now replaced automatically.
- Fixed `eval` calls to extension and custom tools with strict schemas so they receive the same arguments as direct tool calls.
- Skill URI reads now expose the selected skill path, allowing nested skills to locate sibling helpers.
- Fixed strict subagent output schemas rejecting nested optional fields represented as `null`.
- Fixed reasoning-only stops and user-uninterrupted aborts leaving sessions idle instead of continuing their configured retries.
- OTLP exports now include chat request costs in spans, metrics, and completion logs, including provider charges when available and an explicit unavailable status when pricing cannot be determined.
- Fixed background Bash jobs and automatically backgrounded eval cells being terminated at their default deadlines without clear guidance; async and timeout behavior is now documented and background-start messages show the applicable deadline.
- Fixed user plugins being detected as project plugins when `HOME` has a trailing slash or resolves through a symlink.
- Fixed `collab.autoStart` failing to host a session after a transient relay connection failure; failed room creation is retried with backoff.
- Fixed the default advisor remaining at `no model` when its model becomes available after background discovery.
- Disposed SDK sessions now release spilled tool output and reject further artifact writes.
- Fixed Python Eval corrupting quoted source containing shell or magic syntax, including multiline strings.
- Fixed explicit GitHub Copilot model selections and `enabledModels` entries being replaced by similarly named bundled models when the requested model came from the cached Copilot catalog.
- Fixed copied text, Warp agent notifications, and terminal notifications occasionally corrupting the display while output streamed.
- Advisors now receive the file path for pasted or dragged images so they can open the image with `read`.
- Fixed collaboration guests queueing host-only prompts locally instead of receiving the appropriate refusal.
- `git worktree add` and `omp worktree add` now run the new worktree's `post-checkout` hook, including fallback checkouts.
- Added a warning when submitted prompts cannot be saved to persistent history until saving recovers.
- Compiled extensions can now import root-level `@oh-my-pi/pi-catalog` modules.
- Fixed idle compaction hiding the final assistant answer when advisor notes followed it.
- `omp render` and resumed sessions now preserve token counts when imported assistant messages lack cost data.
- Fixed cross-agent messages and background-job output from incorrectly closing or forging harness blocks.
- `openai-codex` model discovery now uses the configured compatible gateway for model listing without sending ChatGPT OAuth credentials to that gateway.
- Plan mode and device-only `write` sessions can now cancel their own background jobs and subagents with `write proc://<id>/kill`.
- Fixed browser relay opens stalling on discarded tabs.
- Fixed GitHub web scraping entries with deleted authors failing to render; they now display as `@ghost`.
- Fixed stale-read pruning incorrectly discarding code that had already been read after a later summarized, partial, or failed read.
- Session usage and cost totals now include Mnemopi memory completions, including billed failures before a fallback succeeds.
- Fixed Hindsight banks with more than 100 mental models losing models from context, seed setup, or listings.
- Prompts submitted during `/handoff` generation now wait for compaction to complete before starting.
- Fixed supervised PTY services receiving an unintended startup keypress.
- Fixed `bash` commands using `pty: true` missing shell environment variables, and ensured extension-provided environment changes follow session switches correctly.
- Fixed notes-backed context rollover restoring an outdated parent assignment when reviving a subagent.
- Advisor tool calls now report the advisor as the calling agent to extension tool-call and tool-result handlers.
- Fixed the IDA integration on Windows: the IDA worker crashed after its first response, and timing out or aborting an IDA request killed the worker instead of interrupting it ([#14186](https://github.com/can1357/oh-my-pi/pull/14186) by [@H4vC](https://github.com/H4vC))

## [18.5.0] - 2026-10-03

### Breaking Changes

- `task.completionProbeMs` is replaced by the on/off setting `task.completionProbe`; an existing `task.completionProbeMs` migrates automatically (`0` → off, any period → on).
- `SessionStorage.claimSessionFile(sessionPath)` is replaced by `claimSession(sessionId, sessionPath)` (which also refuses when the path now holds a different session), and `sessionOwnerLeasePath()` by `tryAcquireSessionLease(sessionId)`: custom storage backends that implemented `claimSessionFile` must implement `claimSession` to keep cross-process ownership ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))

### Added

- `/dump all` writes a zip to the temp directory with the main transcript, the LLM request JSON, and one file per subagent transcript (nested subagents included, killed ones marked aborted); the TUI copies the archive path to the clipboard. Plain `/dump` is unchanged ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Added `/effort [level]` to set the thinking level without switching models: bare `/effort` opens a picker, and completions offer only the current model's levels within the session effort ceiling. Its description includes thinking and intelligence so either term finds it; `Shift+Tab` still cycles levels ([#12222](https://github.com/can1357/oh-my-pi/pull/12222) by [@Xytronix](https://github.com/Xytronix), [#14113](https://github.com/can1357/oh-my-pi/pull/14113) by [@andrebrait](https://github.com/andrebrait)).
- Added a per-call `model` selector to task items, eval `agent()`, and `workpool()`: a `provider/model[:level]` pattern or role alias, or an ordered array of them, that takes precedence over `task.agentModelOverrides` and the agent definition. Selection is an ordered preference — requested candidates are tried before configured fallbacks — and the spawn fails at preflight instead of silently routing elsewhere when the selector is the ambiguous literal `default`/`inherit` with or without a `:level` suffix (use `@default`), is blank or comma-only, carries an invalid thinking suffix, matches no available model, or sits on the batch container instead of a `tasks[]` item. A requested model without working credentials fails the spawn instead of running on the parent's model, and the error tells the caller to report the unavailable model rather than substitute another. A pool applies its selector to each worker's first turn and reuses that worker's session afterwards ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- Subagent completion estimates are asked after 2, 5, 10 and 30 more minutes, then hourly, instead of at a fixed interval, and only for subagents the main agent spawns in an interactive session; print (`-p`), RPC, ACP and SDK runs and nested subagents never request them.
- `/changelog`, `/context`, `/tools`, `/hotkeys`, `/advisor status`, `/memory view|queue|stats|diagnostics`, and the mental-model views no longer add their report to the transcript. In text mode a report that fits shows above the editor like `/btw` and Esc dismisses it; a taller one (such as `/changelog full`) opens as a full-screen page on the alternate screen, scrolled with the arrow/page/Home/End keys and the wheel, and Esc returns to the screen exactly as it was. In the native terminal it opens as a sheet like `/usage` whose long reports scroll, closed with Esc or Close ([#14136](https://github.com/can1357/oh-my-pi/pull/14136) by [@H4vC](https://github.com/H4vC)).
- `/jobs`, `/mcp help|list|resources|prompts|notifications` and `/ssh help|list` no longer add their report to the transcript either: they show the same way, and natively `/jobs` opens the live background-jobs sheet the jobs pill opens (`/jobs full` keeps the full command lines in a report sheet) ([#14138](https://github.com/can1357/oh-my-pi/pull/14138) by [@H4vC](https://github.com/H4vC)).
- The welcome banner (in the terminal and as Tern's native card) is now the `omp` logo and wordmark with the version and a tip. It no longer shows the "Welcome back!" greeting, the model (the status line does), LSP servers or recent sessions (`/resume`), and the `#` `/` `!` `$` prompt prefixes moved into the rotating tips.

### Fixed

- Auto-retry now retries the same model once after a mid-stream socket drop that had already streamed reasoning or tool calls, instead of switching to the fallback chain on the first attempt; the fallback chain is consulted only if that retry also fails. This applies to every provider, since a dropped socket says nothing about the model ([#13747](https://github.com/can1357/oh-my-pi/pull/13747) by [@abilliontokens](https://github.com/abilliontokens))
- Fixed native git patch apply, checkout, stash, cherry-pick, and worktree removal on Windows ignoring `core.autocrlf`: LF patches failed to apply to CRLF checkouts and clean CRLF files were treated as modified
- Fixed the `command` image-URL uploader stripping backslashes from Windows paths in its command template (`C:\tools\upload.exe {file}` ran `C:toolsupload.exe`)
- Fixed reading a SQLite database (local or by URL) and closing prompt history leaving the database file locked on Windows
- Fixed RPC mode on Windows freezing when the client stopped reading stdout: the worker blocked on the full stdout pipe and stopped reading stdin, so a client writing a batch of commands before reading replies deadlocked. Output now goes through a non-blocking stdout stream that spools to disk under backpressure, as on Linux and macOS
- Fixed HTML export hanging when a session's subagent directory held a transcript named `..jsonl`; discovery now only descends into real child directories ([#13908](https://github.com/can1357/oh-my-pi/pull/13908) by [@H4vC](https://github.com/H4vC))
- Fixed resuming a session through a symlink or hard link to a file another omp process is writing: the resumed session no longer mixes its turns into that file and continues in a new file next to it ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Fixed moving a session to another directory replacing a session file there that another omp process is writing, or moving a session another process is writing; the move now stops with an error and leaves both files untouched ([#14095](https://github.com/can1357/oh-my-pi/pull/14095) by [@andrebrait](https://github.com/andrebrait))
- Preserve the parent’s upstream route and live reasoning effort for inherited task/eval/workpool selectors and restored workers; caller `effort`, a requested `@default:<level>`, and the agent definition's own `thinking-level` still take precedence over the inherited effort ([#12229](https://github.com/can1357/oh-my-pi/pull/12229) by [@Xytronix](https://github.com/Xytronix), [#13669](https://github.com/can1357/oh-my-pi/pull/13669) by [@andrebrait](https://github.com/andrebrait)).
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol omp was built against; it now speaks Tern's protobuf session protocol (level 12), which Tern serves across builds, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.
- Fixed reloading a legacy Pi extension on Windows serving the previously loaded source instead of the edited files
- Fixed Redis-, SQL-, and in-memory session storage listing no sessions on Windows: directory listing now matches `\`-separated session paths, so `/resume` and the session picker find them
- Fixed an MCP stdio server whose configured command path does not exist failing on Windows with "MCP subprocess closed stdout before responding" instead of a not-found error naming the path
- Fixed `omp commit` never closing its credential store, leaving `agent.db` open (and a broker-backed store's sync loop running) after the commit finished
- Fixed every new session (including subagents) staying in memory for 5 seconds after creation, held by an uncancelled workspace-scan deadline timer; a parked or disposed subagent's session and settings are now released immediately
- Fixed autoresearch `run_experiment` on Windows running `autoresearch.sh` through the WSL `bash.exe` launcher found on PATH (a separate Linux environment that fails when WSL is unavailable); it now uses Git Bash or the configured `shellPath`
- Fixed sessions started in a temp-directory cwd on Windows landing under a home-relative `-AppData-Local-Temp-…` session directory instead of the `-tmp-…` one; existing directories under the old name are migrated forward
- Fixed the `write` tool claiming "Made executable via chmod +x" for shebang files on Windows, where chmod keeps no execute bits
- Fixed `readlink` in the bash tool printing a provider-backed path (e.g. `local://file`) with a `\\?\` prefix on Windows
- Fixed the daemon broker on Windows dying with the omp process that started it, which stopped the shared browser relay (and every other broker daemon) while other omp sessions were still using it
- Fixed the `browser` tool's Tern backend being refused by any Tern newer than the protocol omp was built against; it now speaks Tern's JSON script protocol, which no Tern build ties it to, and a Tern from before it reports as unavailable (update Tern) so the Chromium fallback takes over.

## [18.4.12] - 2026-10-02

### Added

- Added `omp auth-gateway stdio`: a long-lived inference server for other programs speaking JSON lines on stdin/stdout (`{"id", "path": "/v1/chat/completions", "body"}` in, `{"id", "status", "body"}` out) with your own sign-ins; a request's `model` takes any `--model` selector (`@smol`, `sonnet`, `@commit,@smol`) and falls back along `retry.fallbackChains` when an attempt fails.

### Changed

- Reduced CPU use while streaming with several agents active: extension `message_update` handlers are delivered through a lighter queue, and RPC no longer processes subagent events unless a client subscribed to them ([#13244](https://github.com/can1357/oh-my-pi/pull/13244) by [@iliaal](https://github.com/iliaal)).

### Fixed

- Fixed web search stopping at Perplexity's anonymous signup wall instead of falling back to the next configured provider ([#12756](https://github.com/can1357/oh-my-pi/issues/12756)).
- Fixed imported Claude Code sessions on Windows reporting the encoded `C--…` directory name instead of the registered project path when the transcript records no cwd ([#13363](https://github.com/can1357/oh-my-pi/pull/13363) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed JavaScript eval `wait()`/`handle.wait()` ignoring a positional timeout; `h.wait(30)` now waits up to 30 seconds like `{ timeout: 30 }`, and mixing an options object with positional arguments throws a `TypeError` ([#12720](https://github.com/can1357/oh-my-pi/pull/12720) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Fixed Herdr and other lifecycle-tracking extensions showing a collab guest (`omp join`) as idle while the host is working; extension-initiated turns (`pi.sendMessage` with `triggerTurn`, `pi.sendUserMessage`) are refused as host-only while joined instead of running on the guest's local model ([#13156](https://github.com/can1357/oh-my-pi/pull/13156) by [@Fruitseller](https://github.com/Fruitseller)).
- Fixed `omp update` failing with "Malformed npm registry response … missing version" on registries such as Sonatype Nexus that answer the `/<pkg>/latest` lookup with the full package document or a non-manifest body; the updater now reads the version from the package's dist-tags ([#14115](https://github.com/can1357/oh-my-pi/pull/14115)).
- Fixed `wait` and `proc://` failing with "Daemon list request timed out" when the project daemon broker hangs; background jobs and agents are still reported, and `proc://` shows that services are unavailable ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `agent://<id>` showing an agent's previous published output as current while that agent runs a follow-up or wake turn; the read now says the output is from the previous run ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Fixed `proc://` listing agents as running when they have no turn in flight; their rows now say the run is stale or already finished, as the `jobs` tool does ([#14120](https://github.com/can1357/oh-my-pi/pull/14120) by [@H4vC](https://github.com/H4vC)).
- Changed subagents to skip their own builds, tests, and smoke runs and leave verification to the main agent, avoiding CPU spikes from many subagents verifying at once.

## [18.4.11] - 2026-10-02

### Added

- Added goal management for RPC hosts and optional automatic goal continuation via `goal.continuationModes: ["rpc"]`. RPC clients can create, inspect, pause, resume, and remove goals, and view the current goal in `get_state`.
- Added `--goal <objective>` for interactive launches to begin a new session in goal mode without requiring the `/goal` command.
- Added periodic completion estimates for running subagents, with configurable polling through `task.completionProbeMs` and progress displayed in wait and task views.
- Added the RPC `fork` command (`RpcClient.fork(entryId?)`, Python `fork(entry_id=None)`): it moves an RPC session onto a new session file holding the history up to and including any message entry (and the tool results answering a cut tool-call batch), together with the session's artifacts, or a copy of the whole session when `entryId` is omitted ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).
- Added `reason` (`"branch"`, `"fork"` or `"btw"`) to the `session_before_branch` and `session_branch` extension and hook events, so handlers can tell whether `entryId` is dropped (`branch`) or kept ([#14077](https://github.com/can1357/oh-my-pi/pull/14077) by [@andrebrait](https://github.com/andrebrait)).

### Fixed

- Fixed skill-description and text-prediction data not respecting XDG directories; existing data is now migrated to `$XDG_DATA_HOME/omp` when applicable.
- Fixed subagent MCP calls ignoring the parent transport timeout, including configured `OMP_MCP_TIMEOUT_MS` and unlimited (`timeout: 0`) settings.
- Fixed fresh setups failing on the first turn when the automatically selected model did not support the configured thinking level.
- Fixed the `read` tool hanging and the TUI becoming unresponsive when asked to read standard input, FIFOs, or other non-regular files; these paths are now rejected.
- Fixed project configuration from `~/.omp` being incorrectly applied to unrelated working directories under the user's home directory.
- Fixed `omp update` failing on standalone-binary installs when npm advertised a version whose GitHub release was never published; the updater now installs the newest published release instead ([#12913](https://github.com/can1357/oh-my-pi/issues/12913)).

## [18.4.10] - 2026-10-02

### Added

- Added global and per-advisor review cadence, including final-yield reviews and intervals that accumulate skipped transcript updates ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added per-advisor catch-up policy and cancellable `strict` waiting, so asynchronous turn reviewers can run beside synchronous final reviewers ([#12385](https://github.com/can1357/oh-my-pi/pull/12385) by [@olegpulatov](https://github.com/olegpulatov)).
- Added `/jobs full` to show each background bash job's full command line; plain `/jobs` still shortens it to fit the terminal ([#13980](https://github.com/can1357/oh-my-pi/pull/13980) by [@rickythefox](https://github.com/rickythefox))

### Changed

- Advisor notes merge at final boundaries with age markers and at most one permitted continuation per batch; advisor continuations no longer trigger recursive reviews ([#12387](https://github.com/can1357/oh-my-pi/pull/12387) by [@olegpulatov](https://github.com/olegpulatov)).

### Fixed

- Fixed `read` of an executable and `ida` hanging indefinitely while IDA's initial analysis of a large binary runs; they now give up after two minutes with an error naming the still-analyzing host, which keeps analyzing for later calls
- Fixed `await completion(...)`, `await agent(...)` and `asyncio.gather(*handles)` in Python eval cells failing with `Missing session/run/name` ([#13999](https://github.com/can1357/oh-my-pi/pull/13999))
- Fixed isolated tasks picking up edits that other agents or merges made in the parent checkout while the task was starting, which put unrelated changes on task branches
- Fixed releasing a kept-alive isolated agent creating a duplicate `omp/task/*` branch for work that had already been merged
- Fixed isolated task branch capture leaving full-checkout temporary worktrees and empty `omp/task/*` branches behind when interrupted
- Fixed merging isolated task branches stashing the entire working tree, which rewrote every Git LFS file and left `omp-task-merge` stash entries; merges now touch only the picked files and combine them with your unstaged edits
- Fixed `openai-models-list` discovery to honor nested OpenAI model-list input/output token limits while preserving explicit top-level context precedence ([#13988](https://github.com/can1357/oh-my-pi/pull/13988) by [@github-nicolas-stadler](https://github.com/github-nicolas-stadler))
- Fixed importing `@oh-my-pi/pi-coding-agent` source from an installed package (SDK, extension loader, bun-global `omp`) failing with `Export named 'createRatchetPrelude' not found` ([#14027](https://github.com/can1357/oh-my-pi/issues/14027))
- Fixed finished subagent runs staying in memory for as long as the session that spawned them, through an abort listener left on the session's signal ([#14038](https://github.com/can1357/oh-my-pi/pull/14038) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed print, RPC and ACP runs recording startup timing spans for their whole lifetime, which grew memory with every session and subagent they started ([#14039](https://github.com/can1357/oh-my-pi/pull/14039) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked subagents keeping their spawn-time run state and settings in memory until the process exits, which grew memory with every subagent a long session spawned ([#14040](https://github.com/can1357/oh-my-pi/pull/14040) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed parked and disposed agent sessions keeping their persistent shell (about 70 KB of native memory each) for the life of the process; a revived subagent now starts with a fresh shell ([#14042](https://github.com/can1357/oh-my-pi/pull/14042) by [@theolundqvist](https://github.com/theolundqvist)).
- Fixed discovered models' request headers nesting one level deeper on every model refresh, which grew memory and per-request work in long sessions with many subagents ([#14041](https://github.com/can1357/oh-my-pi/pull/14041))
- RPC `prompt`, `steer`, and `follow_up` run native `input` handlers in submission order and acknowledge `prompt` only after admission, so a later prompt cannot overtake an idle image skill during vision description, an abort accepted during an earlier hook cancels that frame instead of letting it start a new turn, and a skill failure after the acknowledgement rejects `RpcClient.promptAndWait` instead of being dropped ([#13027](https://github.com/can1357/oh-my-pi/pull/13027) by [@andrebrait](https://github.com/andrebrait)).
- Fixed test suite failures on non-FHS hosts and under ambient terminal and Git configuration ([#12358](https://github.com/can1357/oh-my-pi/pull/12358) by [@olegpulatov](https://github.com/olegpulatov)).
- Fixed late TTSR matches on short tool calls ending a run before the rule interrupt reaches the model ([#14018](https://github.com/can1357/oh-my-pi/issues/14018)).
- Fixed `omp gc --apply` holding `history.db` and `stats.db` open until exit, which left an empty `history.db-wal` behind after a WAL checkpoint ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed coding-agent session and gc tests failing on Windows ([#14043](https://github.com/can1357/oh-my-pi/issues/14043)).
- Fixed background skill-description compression requests emitting no OTLP chat span or token usage ([#14056](https://github.com/can1357/oh-my-pi/pull/14056) by [@xaviergmail](https://github.com/xaviergmail)).
- Fixed same-ID runtime API replacements carrying a prior route's prompt-cache lifetime into a route without a cache policy ([#13966](https://github.com/can1357/oh-my-pi/pull/13966) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Hashline edits no longer reject fully read lines below an earlier same-file edit as "never displayed" when that edit left them at the same line number ([#13983](https://github.com/can1357/oh-my-pi/issues/13983))
- Fixed `read agent://<id>` returning `Not found` for a running agent (dotted child ids and agents that only submitted non-terminal `yield` sections included) while `write agent://<id>` reached it; the read now shows the agent's status, its yields so far, and its latest text, an unknown id suggests at most five near ids instead of listing every output, and bare `read history://` refreshes the caller's persisted roster like `history://<id>` does ([#14000](https://github.com/can1357/oh-my-pi/pull/14000) by [@radkawar](https://github.com/radkawar))
- Fixed `enabledModels`/`--models` entries naming a judge, search, image, or speech model logging `No models match pattern` on every startup ([#14016](https://github.com/can1357/oh-my-pi/issues/14016))
- Fixed local-memory startup consolidation rebuilding the system prompt of a conversation that had already sent requests, which invalidated its signed thinking blocks; the new summary now applies from the next session ([#14019](https://github.com/can1357/oh-my-pi/pull/14019) by [@nick-maderight](https://github.com/nick-maderight))
- Fixed the Darwin Nix flake / NixOS module build producing an `omp` that fails to start after `nix-collect-garbage` with `Library not loaded: /nix/store/…-libiconv-…` by repointing the embedded native addon's `libiconv` install name at the system library and failing the build if the addon references any `/nix/store` path ([#13992](https://github.com/can1357/oh-my-pi/pull/13992) by [@krzysztofkusmierczyk](https://github.com/krzysztofkusmierczyk)).
- Fixed `/context` and clicks on the status-line context meter stacking a new Context Usage card every time; the existing card is refreshed in place, or moved to the bottom if newer blocks follow it
- Fixed the jevify keyword notice teaching the removed `judge()` handle API, so agents following it failed on the first judge cell; it now uses `judge_batch()` ([#13588](https://github.com/can1357/oh-my-pi/issues/13588), [#13698](https://github.com/can1357/oh-my-pi/pull/13698) by [@holny](https://github.com/holny))

## [18.4.9] - 2026-10-01

### Added

- Added opt-in stale-session garbage collection with `omp gc --stale` or `gc.stale`, removing orphaned session markers and terminal breadcrumbs and expiring old debug reports and collaboration replicas according to configurable retention limits.
- Added RPC controls to cancel or steer individual foreground and background subagents without aborting the session.
- Added RPC word-completion commands so web and IDE hosts can provide the same ghost-text completion available in the terminal editor.
- Added an opt-in RPC ask-dialog mode that lets hosts render all questions together with checkbox or radio-button controls and submit their answers in one response.
- Added SDK notifications when a session moves to a new persistence file, including the previous and new paths.
- Added SDK APIs to inspect and cancel background jobs, including their command, working directory, process IDs, exit status, and captured output.

### Changed

- Improved the `omp predict` comparison view with an interactive native interface, table rows, action controls, and clearer status information.
- Improved MCP authorization prompts with clickable links, native copy/open context menus, and a clearer URL layout.
- RPC hosts are now notified when omp cancels an expired `select`, `confirm`, `input`, or `ask` dialog, allowing stale UI prompts to be closed.
- Limited saved bash, Python, and JavaScript evaluation output artifacts to 16 MB by default while preserving both the beginning and latest output; configure the limit with `tools.artifactMaxBytes`, or set it to `0` for unlimited output.

### Fixed

- Fixed `/wt` on filesystems without copy-on-write cloning, including NTFS, so unchanged files are not incorrectly marked modified and staged edits, additions, and deletions retain the correct contents.
- Fixed Windows Ctrl+V taking about a second to paste by avoiding unnecessary PowerShell clipboard checks.
- Fixed `local://` paths being misinterpreted as local filesystem paths by the `read`, `write`, and search tools.
- Fixed `read` handling of semicolon-separated URLs, local paths, and line selectors so each entry is processed independently.
- Fixed session persistence conflicts between multiple omp processes, preventing lost or interleaved turns and continuing in a new session file when necessary.
- Fixed session image handling to avoid unnecessary rewrites, preserve images after interrupted writes, and prevent garbage collection from removing images that are referenced again.
- Reduced unnecessary disk writes and improved persistence efficiency across sessions, model data, configuration, and background jobs.
- Fixed the native composer showing the main session's effort level instead of the selected subagent's level.
- Fixed the `omp predict` comparison view and MCP authorization prompt rendering with their full native interfaces, including clickable link actions.

## [18.4.6] - 2026-10-01

### Added

- Added a live Background Jobs view that lets you monitor running background jobs without interrupting the transcript.
- Added agent lineage navigation, making it easy to move between subagents and the main session from the composer header.
- Added queued-message controls to the RPC clients and session API, including promotion of queued follow-ups to steering messages without duplicating text or losing attachments, plus explicit steering or follow-up behavior for prompts sent while the agent is busy.
- Added support for keeping Claude prompt caches warm on Amazon Bedrock and Bedrock Mantle according to configured model cache lifetimes and retention settings.
- In Tern terminals, the effort indicator now visualizes the selected thinking level and becomes a fireball at the maximum level.

### Changed

- RPC prompt requests now acknowledge only after the message has been accepted for processing, queued, or routed to an extension command, so subsequent queue-management operations can act on the admitted message reliably.
- Idle recaps now appear as structured notices in the transcript rather than status-line messages.
- Attached-image descriptions for text-only models now time out after 20 seconds and stop when aborted, while preserving the image and informing the model when a description is unavailable.
- The status line now separates the session's own cost from total subagent spend, including nested, background, and resumed subagents, and matches the Agent Hub total.
- Tool-use reminders are now delivered as separate developer messages, keeping them distinct from tool output.
- Reworked Tern transcript navigation and presentation: Esc-Esc rewind now uses the transcript with turn-by-turn and branch navigation, attached images open in Tern's image viewer, idle recaps remain unobtrusively in the transcript, and the background-jobs pill opens the live jobs view.
- Tern now reports agent activity through terminal progress consistently, and its progress and agent indicators update smoothly during subagent work.

### Fixed

- Fixed Tern commands issued while the agent is working so they appear immediately in the transcript instead of being clipped above the prompt.
- Added a dismiss action for Tern's prompt-area error notifications.
- Fixed dollar signs in prompts being mistaken for Python mode until a following space confirms the mode.
- Fixed turns getting stuck in a working state when post-turn maintenance, such as saving the session, fails; the session now becomes idle and reports a warning.
- Fixed failed tool-output pruning from leaving live context out of sync with saved history.
- Fixed oversized or undersized attached images being distorted when resized to fit display limits.
- Fixed interrupted tool calls disappearing from the model's context after resuming a stopped session.
- Fixed aborted prompts with images still being prepared from starting or entering the queue afterward.
- Fixed aside messages containing pasted image or video paths so the source path is preserved when sent to the model.
- Fixed extension-registered prompt-cache settings, including explicit opt-outs, not taking precedence over matching models.yml definitions.
- Fixed prompt-cache warming to honor cache-retention settings, including disabling replay for no-retention caches and using the lifetime written by long-retention requests.

## [18.4.5] - 2026-09-30

### Added

- Added Factory Droid login and model selection with base credit badges and account-matched regional discovery ([#8577](https://github.com/can1357/oh-my-pi/pull/8577) by [@will-bogusz](https://github.com/will-bogusz), continued in [#13276](https://github.com/can1357/oh-my-pi/pull/13276) by [@DusKing1](https://github.com/DusKing1)).
- Added `HELMCODE_API_KEY` to the environment variables listed in `omp --help` ([#13630](https://github.com/can1357/oh-my-pi/pull/13630) by [@alexcerezo](https://github.com/alexcerezo)).
- RPC hosts can send `messageUpdates: "delta"` with `set_event_filter` to receive `message_update` frames without the accumulated message snapshots (`message` shrinks to `{ role }` and `assistantMessageEvent.partial` is omitted); the response echoes the active mode ([#13716](https://github.com/can1357/oh-my-pi/pull/13716) by [@alphastorm](https://github.com/alphastorm))
- RPC hosts can follow each cache-warming refresh through `cache_warming_start` and `cache_warming_end` events (also written by `--mode json`), which report the outcome and the recorded usage, and can set the session's warming mode with `set_cache_warming` without changing `config.yml`; the Python client gains `set_cache_warming()` ([#13717](https://github.com/can1357/oh-my-pi/pull/13717) by [@alphastorm](https://github.com/alphastorm))
- The `/review` and `/annotate code-review` menus have a "Review a specific PR" option that lists the repository's open pull requests, with server-side search and a `#123` shortcut ([#12399](https://github.com/can1357/oh-my-pi/pull/12399) by [@abilliontokens](https://github.com/abilliontokens))
- Pinned Subagents rows can show each agent's current (or most recent) tool call with a one-line detail and an elapsed marker; enable with `display.subagentLivePreview` (off by default) ([#3821](https://github.com/can1357/oh-my-pi/pull/3821) by [@abilliontokens](https://github.com/abilliontokens))
- Model presets: save every role assignment plus the default thinking level under a name and switch between them with `/modelpreset save|switch|delete|list`, pick one interactively with `/modelpreset`, or press `s` in the `/models` Roles view to save the current setup ([#5253](https://github.com/can1357/oh-my-pi/pull/5253) by [@abilliontokens](https://github.com/abilliontokens))
- Subagent tool previews name the files a freeform edit (`apply_patch`, sloppy, hashline) touches ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).

### Changed

- `omp auth-gateway serve` now attributes peers to the socket address by default; deployments behind a trusted reverse proxy can restore forwarded peer headers with `--trust-proxy-headers` ([#13827](https://github.com/can1357/oh-my-pi/pull/13827) by [@shawnkoh](https://github.com/shawnkoh))
- `--no-ui` now also works with `--mode rpc-ui`: extensions run headless while tool UI such as the `ask` tool still reaches the host ([#13718](https://github.com/can1357/oh-my-pi/pull/13718) by [@alphastorm](https://github.com/alphastorm))
- `omp models --json` reports each model's `pricingStatus` (`fixed`, `free`, `included`, `variable`, or `unknown`) ([#11613](https://github.com/can1357/oh-my-pi/pull/11613) by [@will-bogusz](https://github.com/will-bogusz)).

### Fixed

- Fixed the subagent live preview blanking or mislabelling a running call when a sibling call finishes: concurrent calls are tracked by call id and keep their own intent, and the row keeps the last completed call with its success or error mark until the next one starts ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed subagent tool previews rewriting a search pattern that names a home directory: path arguments are now shortened by argument key, so the pattern still shows what was searched ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Fixed background task job progress dropping the current tool's arguments and start time ([#11210](https://github.com/can1357/oh-my-pi/pull/11210) by [@DarkPhilosophy](https://github.com/DarkPhilosophy)).
- Replying `c` during a `/guided-goal` interview now sends `c` as your answer instead of triggering the continue shortcut ([#13819](https://github.com/can1357/oh-my-pi/pull/13819) by [@H4vC](https://github.com/H4vC))
- Cache-warming refreshes cancelled or superseded after the provider accepted them now count toward session usage and cost instead of being dropped ([#13717](https://github.com/can1357/oh-my-pi/pull/13717))
- Fixed Cursor turns that fail with "Cursor stream ended before turnEnded" stopping instead of continuing with their completed tool results kept ([#13684](https://github.com/can1357/oh-my-pi/pull/13684) by [@eggpeat](https://github.com/eggpeat))
- `omp plugin upgrade <name>` now upgrades npm- and git-installed plugins (e.g. `ida-mcp` installed from `github:HexRaysSA/ida-mcp#latest`, which `hcli mcp install` relies on) and resolves a bare marketplace plugin name, instead of failing with "Invalid plugin ID"; the plugin's enabled state and feature selection are kept ([#13812](https://github.com/can1357/oh-my-pi/pull/13812) by [@H4vC](https://github.com/H4vC))
- Extension providers that offer `/login` and also name an env var as their `apiKey` (e.g. the Nexos provider's `NEXOS_API_KEY`) now use the key saved by `/login` when that env var is unset, instead of sending the env var's name as the key, which made their models fail to load or disappear ([#13815](https://github.com/can1357/oh-my-pi/pull/13815) by [@H4vC](https://github.com/H4vC))
- Reduced memory held by finished subagents during long sessions ([#13624](https://github.com/can1357/oh-my-pi/pull/13624) by [@iliaal](https://github.com/iliaal)).
- Fixed role and subagent `retry.fallbackChains` being skipped once the session's thinking level differed from the role's configured one (e.g. `task: grok-4.7:high` running at `:xhigh`), and cold-revived subagents losing the fallback chain they were spawned with ([#13789](https://github.com/can1357/oh-my-pi/issues/13789))
- Fixed compiled OMP extensions importing `@oh-my-pi/pi-catalog` and its provider-model subpaths ([#13731](https://github.com/can1357/oh-my-pi/issues/13731)).
- Explicit `symbolPreset: unicode` now stays Unicode after a Glyph Protocol handshake instead of switching the status bar to Nerd Font icons ([#13865](https://github.com/can1357/oh-my-pi/issues/13865)).
- Fixed rewinding (`/rewind`, `/tree`) during a running turn hiding the queued-prompt bar, making the still-pending queue look deleted and uneditable ([#13680](https://github.com/can1357/oh-my-pi/issues/13680))

## [18.4.4] - 2026-09-29

### Added

- Added `compat.bedrockMessagesApi` to `models.yml`, so Claude reached through a proxy or an `ANTHROPIC_BASE_URL` reroute to Bedrock's `/anthropic` API gets Bedrock request shaping and on-demand compaction; `false` opts a Bedrock URL out ([#13311](https://github.com/can1357/oh-my-pi/pull/13311)).
- Submitting exactly `exit`, `quit`, or `q` (any case, no leading `/`, nothing else in the input) in a session with no messages now quits; turn off with `input.bareExitOnEmptySession` ([#13755](https://github.com/can1357/oh-my-pi/pull/13755) by [@H4vC](https://github.com/H4vC))
- Added the opt-in `input.bareSlashCommands` setting (Interaction > Input): submitting exactly a command name without the leading `/` (e.g. `model`, `compact`, a skill or extension command) runs that slash command. Before the first message it runs at once; after that, the first Enter asks for confirmation and a second Enter runs it (a leading space sends the word as a message) ([#13780](https://github.com/can1357/oh-my-pi/pull/13780) by [@H4vC](https://github.com/H4vC))
- Extensions can now rewrite finalized assistant-message text through the awaited `assistant_message` hook before it reaches context, history, and `message_end` ([#13769](https://github.com/can1357/oh-my-pi/pull/13769) by [@NaC-L](https://github.com/nac-l))
- In Tern (`TERM_PROGRAM=tern`), omp reports its session file to the terminal (OSC 1337 user variable `omp_session_file`) at start and whenever the session changes, so an agent pane Tern's daemon restores after a crash or restart resumes the same session with `--resume`
- Added `additionalContext` to extension and hook `tool_result` results, so success- and failure-specific post-tool guidance reaches the model through the trusted developer channel instead of altering tool output ([#13267](https://github.com/can1357/oh-my-pi/pull/13267) by [@andrebrait](https://github.com/andrebrait)).
- The `ask` tool's custom-answer and note prompts accept pasted images, which reach the model with the answer ([#13774](https://github.com/can1357/oh-my-pi/pull/13774) by [@DrFaustus-vic](https://github.com/DrFaustus-vic))
- Added `/fast ultra` to select OpenAI's Ultrafast service tier on models that offer it (OpenAI API with preview access, or Codex models that advertise it, such as GPT-6.1 Sol once Ultrafast rolls out); `/fast off` clears it and `/fast status` reports `ultra`. `ultrafast` is also accepted by `tier.openai`, `tier.subagent`, `tier.advisor`, and `--service-tier` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- RPC clients can now cancel one pending steering or follow-up message with `remove_queued_message`, including its hidden attachment context, without aborting the turn or changing other queued work ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Added typed queued-message removal to the official Python RPC client, including validated success and refusal results ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- RPC clients can now render the actual pending-message queue instead of tracking it themselves: `get_state` reports a `queuedMessages` snapshot and a new `queue_update` event reports it live as steering/follow-up messages are queued, delivered, removed, or cleared ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).

### Changed

- `omp stats --summary` now labels costs as API-equivalent estimates and shows subscription usage that has no reference price as `N/A` instead of `$0.0000`, matching `omp-stats`.

### Fixed

- Fixed the `mnemopi.polyphonicRecall` and `mnemopi.enhancedRecall` settings (and `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL`) having no effect: polyphonic recall now surfaces graph- and fact-linked memories, enhanced recall caches repeated recalls until the next memory write, and both apply per session instead of through process-wide defaults ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))
- Fixed `computer.window(74)` matching every open window and `computer.window({ id: 74 })` matching none; a numeric id now resolves the same window as `"74"` ([#13649](https://github.com/can1357/oh-my-pi/pull/13649) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed `/fast on` showing fast mode as active on Codex models whose discovered service tiers list others but not priority; it now reports that fast mode is unavailable for the current model. Models whose tier list is empty keep `/fast` ([#13782](https://github.com/can1357/oh-my-pi/pull/13782) by [@H4vC](https://github.com/H4vC)).
- Cancelling a concurrently queued prompt now preserves the other prompt's hidden keyword context instead of removing it with the cancelled message ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Hidden attachment context and its queued prompt are now claimed together in `one-at-a-time` mode, preventing successful cancellation after only the companion has been delivered ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Queued RPC skill commands retain their original invocation for cancellation, and queue editing no longer treats agent-attributed user-role messages as user input ([#11872](https://github.com/can1357/oh-my-pi/pull/11872) by [@andrebrait](https://github.com/andrebrait)).
- Builtin slash commands (including `/record` and `/skills`) no longer erase a draft typed after Ctrl+Enter detached its submission from the editor ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Failed detached submissions, including Ctrl+Enter `/queue`, and failed Enter `/plan`, `/vibe`, `/goal`, or `/guided-goal` commands now restore their text and attachments beside newer typing, with image markers remapped ([#13026](https://github.com/can1357/oh-my-pi/pull/13026) by [@andrebrait](https://github.com/andrebrait))
- Native extension input handlers now intercept main-session Ctrl+Enter, including queued input, with consistent transformations ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- `/plan`, `/vibe`, `/goal`, or `/guided-goal` with attachments that starts no turn (for example `/plan` while goal mode is active) now restores its text and attachments beside newer typing instead of re-attaching only its images ahead of the newer draft's own ([#11834](https://github.com/can1357/oh-my-pi/pull/11834) by [@andrebrait](https://github.com/andrebrait))
- Same-named skills from different sources are no longer silently discarded. A duplicate with identical content still collapses without a warning; otherwise the higher-precedence skill (an authored skill over an installed package, a custom-directory skill over a provider skill, else whichever loaded first) keeps its bare name and the other stays reachable as `<namespace>/<name>` via `skill://<namespace>/<name>` and `/skill:<namespace>/<name>`, with a collision warning naming both files. Skill names containing `/` or `\` are now rejected for every provider and custom directory, since `/` is reserved for that addressing ([#12151](https://github.com/can1357/oh-my-pi/pull/12151) by [@andrebrait](https://github.com/andrebrait))
- Added native HUD and UI elements (status, tool cards, usage heatmap) for TSP terminals
- Added support for native-only session info and job dashboard views in TSP terminals
- Inside a Tern pane, the browser tool opens tabs as browser picture-in-pictures over omp's pane and drives their native web view (trusted input, ARIA snapshots, screenshots, PDF, dialogs, downloads, cookies, console, fetch/XHR routes and HAR, recording); it falls back to Chromium when no Tern window can host them. Opt out with `browser.tern`, `PI_BROWSER_TERN=0` or `app.tern: false`; `app.tern: true` requires it
- Fixed the startup "what's new" notice dropping the last unseen release when it was the final section of a changelog ending in a newline.
- xAI web search honors `XAI_BASE_URL` again when the selected model uses the bundled `https://api.x.ai/v1` endpoint; a custom `baseUrl` from models.yml still wins, and official `xai-oauth` OAuth credentials always stay on the bundled endpoint (API keys, including command-backed ones, follow the override as in chat and image generation).

### Removed

- Removed the bash tool's `env` parameter; services inherit the configured shell environment

## [18.4.3] - 2026-09-28

### Added

- Batch `task` calls now start each subagent as soon as its `tasks[]` item finishes streaming instead of waiting for the whole call; launched agents are aborted if the finished call is invalid, blocked, or changed. Controlled by `task.speculativeLaunch` (default on; requires auto-allowed task approval and no extension tool lifecycle handlers)
- Set `PI_SMART_GIT=1` to have every `git worktree add` in the bash tool — including inside compound commands, functions, and loops — copy-on-write clone the checkout (APFS, btrfs/XFS reflink, ReFS) instead of checking out every file, so new worktrees start with ignored build caches (`target/`, `node_modules/`) already in place; every `worktree add` option except `--orphan`, `--no-checkout`, `--track`, and `--relative-paths` is handled, and anything else still runs real git.
- In terminals that speak the Tern Surface Protocol, the working row, todo HUD, subagent HUD, judge/download progress rows, retry hint and stream console are native: the working spinner, message shimmer, elapsed timer and tok/s are terminal-clocked, todos are a phase tree with a progress bar, and clicking a subagent row focuses that agent
- `/usage` refreshes its reports with `r`. In terminals that speak the Tern Surface Protocol it is a glass sheet: provider frames with per-window meters, reset times and banked-reset badges, and a year of activity as a native heatmap with per-day tooltips; `/context` is one frame with a block grid, a legend and a bar marked at the compaction threshold; `/session` info gains a context meter; `/jobs` shows task jobs as live agent rows; `/stats` adds an Open dashboard button
- In terminals that speak the Tern Surface Protocol, MCP tool calls are native cards (an argument grid while running, then a collapsed Args section over highlighted JSON or markdown results) instead of the generic tool card; custom tools can supply their own `describeCall`/`describeResult` hooks for native views
- In terminals that speak the Tern Surface Protocol, a sent prompt's bubble shows its attached images above the text (click one to open the file) and keeps its attachment, skill and model-mention tokens highlighted as the composer drew them
- In terminals that speak the Tern Surface Protocol there is no status bar: the session name (and the branch's PR) is the tab title, Tern's pane header shows the path and branch, each finished turn ends with its time, tokens and cost, the composer carries a model chip (click to switch), an effort meter (click to cycle), a context hairline along its top edge and the context share and session cost, and other configured status segments sit as small facts in the composer; background jobs get a HUD pill
- Added the `/ratchet [flow and goal]` command: the agent asks one batched round of setup questions, builds (or reuses) an eval for the flow you name, gets three approvals (inputs, grader, plan), then hillclimbs it unattended, keeping a change only when it beats the best round on both train and held-out cases. It enables a new `ratchet(flow)` eval global for the session (docs at `xd://eval/ratchet`; persist with `ratchet.enabled`) that stores state in `.omp/ratchet/<flow>/`, invalidates approvals when the approved files change, and prices runs from the model catalog ([#13672](https://github.com/can1357/oh-my-pi/pull/13672) by [@H4vC](https://github.com/H4vC))

### Changed

- Running `omp "prompt"` without a terminal on stdin (scripts, CI, `</dev/null`) now runs the prompt headless like `-p`; a bare `omp` without a terminal exits 2 with an error instead of exiting silently ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Invalid `--thinking`, `--approval-mode`, and `--mode` values are now rejected with a usage error (exit 2) listing the valid values, instead of being silently ignored ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- The default web search chain is now free-only: Parallel, the session's own model (new `web/hosted`), Exa, Firecrawl, SearXNG, and the credential-free scrapers. Paid engines (Perplexity, Tavily, Brave, Kagi, …) and other providers' chat models run only when you set them on the `web` role or its fallback chain.
- Parallel, Exa, and Firecrawl now run their keyless endpoints in the automatic chain instead of only when explicitly selected.
- Perplexity search no longer falls back to your OpenRouter key; select `openrouter/perplexity/…` explicitly to search through OpenRouter.
- Hosted web search now follows the model rather than the host: GPT-5+ over any Responses API, Claude 4+ over any Messages API, and Gemini 2+ (including Gemini CLI), so `web/hosted` works through proxies and gateways. A model-backed search that returns no sources now counts as a failure, so the chain moves on to the next engine instead of showing an unsourced answer.
- `web/hosted` first tries a cheaper model on the session's own provider (e.g. Opus → Haiku, GPT-5.x → GPT-5.6 Luna, Gemini Pro → Flash) and falls back to the session model itself when the host does not offer it or the call fails.
- Image generation now tries the session provider's own image model first (e.g. GPT-5.x → `gpt-image-2`, Gemini → `gemini-3-pro-image`, Grok → `grok-imagine-image`), and a GPT-5+ session model generates images itself through the hosted image tool when its provider or proxy has no image model.
- The default image model chain now uses `openai/gpt-image-2`, `openai-codex/gpt-image-2`, and the GA `gemini-3-pro-image` (Google and OpenRouter) instead of `gpt-image-1` and the Gemini preview id.
- Reduced CPU while streaming replies and tool calls: the reveal no longer deep-compares frozen leading content on every flush, streamed argument extraction no longer re-verifies the whole prefix, and deltas no longer queue extension notifications when no extension listens for `message_update` ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).
- Reduced CPU and allocations for in-memory reads (URLs, notebooks, converted documents), tool-result spill checks, write read-projection guards, and hashline prefix stripping ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Fixed alt+p and `/switch` model picker latency by avoiding unnecessary catalog rebuilds
- Fixed `--tools` with an unknown name printing a stack trace and listing only the tools left after filtering; it now prints a clean error naming unknown tools, built-in tools unavailable in the session, and the built-in and registered tools ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed unknown CLI flags exiting 1 with an extra "ended before completing" line instead of exiting 2 ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed a mistyped `--model` in print mode telling you to set an API key; it now suggests the closest available models ([#13623](https://github.com/can1357/oh-my-pi/pull/13623) by [@H4vC](https://github.com/H4vC))
- Fixed the alt+p / `/switch` model picker taking seconds to appear: it rebuilt the whole model catalog on every open before painting, and now re-reads it only when startup discovery is still landing or models.yml changed
- Fixed `tool_call` `additionalContext` being delivered more than once when several extension or hook handlers on the same call returned identical text ([#13633](https://github.com/can1357/oh-my-pi/pull/13633) by [@andrebrait](https://github.com/andrebrait))
- Fixed hosted OpenAI web search on hosts that accept only string tool_choice values, such as Command Code ([#13666](https://github.com/can1357/oh-my-pi/pull/13666) by [@riicodespretty](https://github.com/riicodespretty))

### Removed

- Removed the web search provider picker from `omp setup`; set the `web` model role (or keep the free default chain) instead.

## [18.4.2] - 2026-09-28

### Added

- The shell's `cp` builtin accepts macOS's `-c` (clone where possible, else copy; same as `--reflink=auto`).

### Changed

- Removed unused timestamp metadata from model usage tracking queries to optimize database overhead
- Improved session storage reliability by using atomic inode identity verification for lock management
- Optimized internal role chain resolution and caching to reduce event-loop contention during judge initialization
- On macOS, the shell's `cp` builtin now also clones (copy-on-write) when overwriting an existing file, instead of rewriting its data; the destination keeps its permissions, and hard-linked destinations are still written in place.
- The `find` tool now fails with a timeout error after 20 seconds instead of blocking the turn when the judge model stalls.
- Reduced main-thread stalls with many agents running: `read` code summaries now parse off the main thread, streamed tool-call snapshots no longer deep-copy growing argument text on every delta, and model-cache reads skip re-parsing unchanged rows.
- Reduced CPU while an agent streams: the working-row token rate and status line no longer re-tokenize or re-resolve settings every frame, and `^` model mentions no longer rebuild the model scope per keystroke.
- `task` and `/vibe` subagents now get their own Python kernel and JS/Ruby/Julia eval state instead of sharing the parent's, so agents can no longer overwrite each other's variables or reset each other's kernels.
- On Windows, the shell's `cp` builtin now clones files (copy-on-write) on ReFS and Dev Drive volumes by default, falling back to a regular copy elsewhere; `--reflink` and `-c` no longer fail there.

### Fixed

- Fixed mouse handling ignoring per-mode TUI mouse setting
- Fixed the shell's `cp --reflink=always` emptying an existing destination when the filesystem cannot clone; the destination is now left untouched.
- Fixed `block-clone` task isolation on Windows ReFS and Dev Drive volumes failing on files whose size is not a whole number of clusters, larger than 4 GiB, or sparse.
- Fixed Google Antigravity requests failing with `429 RESOURCE_EXHAUSTED` on every turn: the system prompts' RFC 2119 conventions line is reworded so the endpoint no longer rejects it ([#13379](https://github.com/can1357/oh-my-pi/pull/13379) by [@heshuoshuo0512](https://github.com/heshuoshuo0512))
- Fixed CRLF `SKILL.md` files injecting raw YAML frontmatter into user-invoked and autoload skill messages ([#13590](https://github.com/can1357/oh-my-pi/issues/13590)).
- Fixed Cursor native Grep ignoring requested context, Read negative offsets starting at the top, and Delete reporting zero-byte files ([#13600](https://github.com/can1357/oh-my-pi/issues/13600)).

## [18.4.1] - 2026-09-28

### Changed

- With LSP disabled (`--no-lsp` or `lsp.enabled: false`), startup skips language-server discovery and warmup, and the welcome screen no longer shows the LSP Servers section
- The first frame's status bar now renders live at the current terminal width from the cached model, thinking level, and status-line settings instead of replaying an `…`-filled snapshot: path and git branch are always current, the context gauge shows the window without a stale percent, git dirty counts no longer blank out when the session bar takes over, and folders that never ran omp paint the bar (and your theme) too.
- Moved the composer startup cache (theme, welcome, recent sessions, LSP rows, status bar) from per-project JSON files under `cache/composer/` to a single `cache/composer.db`; the old directory is no longer read and can be deleted.
- Improved interactive startup: the session status bar appears sooner because `retry.fallbackChains` validation, the background model-catalog refresh, and project daemon registration no longer block the first session frame.
- Reduced CPU use from subagent HUD repaints during active sessions ([#13245](https://github.com/can1357/oh-my-pi/pull/13245) by [@iliaal](https://github.com/iliaal)).
- Clarified which provider transports honor `thinkingBudgets` and that local OpenAI-compatible models use effort controls instead ([#13503](https://github.com/can1357/oh-my-pi/issues/13503)).
- `/fork` now prints how to resume the session it leaves behind (`omp --resume <id>` or `/resume <id>`) instead of the new transcript's filename ([#13338](https://github.com/can1357/oh-my-pi/pull/13338) by [@LlemonDuck](https://github.com/LlemonDuck))
- `/vibe` status checks no longer redraw every worker the director killed: `vibe_wait` and `vibe_list` leave killed sessions off the wall with a `N killed hidden` count, and `vibe_list` collapses them to one trailing line naming the most recent (transcripts stay at `history://<id>`) ([#13073](https://github.com/can1357/oh-my-pi/pull/13073) by [@igasmi](https://github.com/igasmi)).

### Fixed

- Fixed `find` exhausting memory on trees with many matching lines: its keyword scan now counts matches as they stream in, holding a few hundred MiB where a 5-million-line tree took several GiB, and finishes faster ([#13495](https://github.com/can1357/oh-my-pi/issues/13495))
- Fixed a native compaction speculation that failed for good turning off background compaction for the rest of the cycle. With `compaction.methodOrder` such as `["remote", "soft"]`, speculation now moves to the next configured method and the threshold pass keeps deferring to it, instead of running that method on the blocking path ([#13478](https://github.com/can1357/oh-my-pi/pull/13478) by [@andrebrait](https://github.com/andrebrait)).
- Extensions that register bash through the legacy `createBashTool`/`createBashToolDefinition` with a `spawnHook` no longer make every bash call fail with `ready and env require a service name.` ([#13461](https://github.com/can1357/oh-my-pi/pull/13461) by [@sjawhar](https://github.com/sjawhar))
- Fixed `/new` with automatic thinking starting the new session at the previous session's classified effort instead of the provisional level, both in its first `thinking_level_change` entry and on the wire ([#13383](https://github.com/can1357/oh-my-pi/issues/13383))
- Fixed a corrupt `agent.db` crashing every launch with `no such table` (for example `hint_usage`) instead of being preserved and recreated ([#13530](https://github.com/can1357/oh-my-pi/pull/13530) by [@Hunter-124](https://github.com/Hunter-124))
- Fixed `edit` rejecting a one-line replacement of an `if` opener, `case` label, or function signature with another of the same shape as an "ambiguous boundary" whenever another edit in the same batch broke the file's syntax; it now applies with the usual syntax-error warning. ([#13522](https://github.com/can1357/oh-my-pi/pull/13522))
- Jujutsu status and diffs now report renames and copies (`R`/`C`, `rename from`/`rename to`) the way `jj status` and `jj diff` do, instead of a delete plus an add ([#13406](https://github.com/can1357/oh-my-pi/pull/13406) by [@sjawhar](https://github.com/sjawhar)).
- Fixed a subagent that finished before a later step failed (such as the isolation merge) losing its evidence: the `task` result now names the child's exit status and `agent://` output, keeps that output on disk, and is marked as an error ([#13557](https://github.com/can1357/oh-my-pi/pull/13557) by [@aktanazat](https://github.com/aktanazat))
- Fixed SDK sessions created with `agentDir` loading user rules (`rules/`, `RULES.md`) and custom tools from the default agent dir instead of that `agentDir`; `discoverCustomToolPaths` and `discoverAndLoadCustomTools` accept an `agentDir` argument ([#13558](https://github.com/can1357/oh-my-pi/pull/13558) by [@aktanazat](https://github.com/aktanazat))
- Reduced daemon broker metadata writes for historical services when owners reconnect or the broker restarts ([#13471](https://github.com/can1357/oh-my-pi/pull/13471) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed compaction re-emitting the whole transcript into native scrollback when `display.collapseCompacted` is off, for both the automatic compaction-end and the manual `/compact` path ([#12140](https://github.com/can1357/oh-my-pi/issues/12140), [#13235](https://github.com/can1357/oh-my-pi/pull/13235) by [@holny](https://github.com/holny))
- Subagents can submit their preceding report with a data-less yield after a finish reminder ([#12837](https://github.com/can1357/oh-my-pi/pull/12837) by [@iliaal](https://github.com/iliaal)).
- Fixed session dispose losing the final message and exit record on SQL/indexed session storage ([#13415](https://github.com/can1357/oh-my-pi/pull/13415) by [@sjawhar](https://github.com/sjawhar))
- Fixed the `recall`, `reflect`, and `memory_edit` tool descriptions naming each other by bare name when those tools are reachable only as `xd://` devices ([#13207](https://github.com/can1357/oh-my-pi/pull/13207) by [@andrebrait](https://github.com/andrebrait)).
- Listed the directories searched for agent files in the `task` tool's unknown-agent error, with the home directory shortened to `~`
- Fixed sessions and subagents of the same agent in different working directories (such as one git worktree per task) never sharing the cached Anthropic system prompt: context files, workspace tree, workspace roots, and other directory-specific sections now come after the static system prompt, which stays a cache hit across directories ([#13104](https://github.com/can1357/oh-my-pi/issues/13104))
- Fixed the startup "What's New" heading and config warnings keeping the dark palette on a light terminal: they were colored before the terminal reported its background, so the heading rendered near-white on white. Both now resolve their color at render time and follow the auto theme switch
- Fixed idle `display: true` custom messages (such as extension `pi.sendMessage` notices sent without starting a turn) not appearing in the transcript until the session was reloaded ([#12718](https://github.com/can1357/oh-my-pi/pull/12718) by [@Broglah1](https://github.com/Broglah1)).
- Fixed `omp usage` ignoring usage providers registered by extensions, which left those accounts listed as having no usage data; `omp usage` now also accepts `-e`/`--extension` and `--no-extensions` ([#13579](https://github.com/can1357/oh-my-pi/issues/13579))
- Fixed a task model saved in `/agents` being ignored for the rest of the session after an Alt+P session-only pick ([#13345](https://github.com/can1357/oh-my-pi/issues/13345)).
- Fixed tool calls made through an `xd://` alias being recorded under the alias, which made OpenAI/OpenRouter Responses replay reject every later request ([#13352](https://github.com/can1357/oh-my-pi/issues/13352)).
- Fixed pasted images in skill invocations not reaching the configured vision model when the main model supports only text ([#13480](https://github.com/can1357/oh-my-pi/issues/13480)).
- A provider listed in `disabledProviders` no longer answers through a retry fallback chain, an advisor or a restored model, and gets no credential however one of its models was selected ([#13194](https://github.com/can1357/oh-my-pi/pull/13194) by [@sjawhar](https://github.com/sjawhar)).
- Fixed `glob` silently clamping `limit` above 200 while advising `Use limit=<clamped>` retries: a clamped request is now disclosed up front and the "Use limit=" advice is dropped once the hard cap is reached ([#13263](https://github.com/can1357/oh-my-pi/issues/13263))
- Fixed subagents that stop to wait for their own background job failing with a missing yield instead of waiting for the job ([#13305](https://github.com/can1357/oh-my-pi/issues/13305)).
- Fixed a failed session append leaving partial bytes behind on Windows, where ftruncate is refused on the append handle: the rollback now reopens the file without O_APPEND and verifies it is still the same file before truncating ([#13362](https://github.com/can1357/oh-my-pi/pull/13362) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed plugin installation failing on Windows outside developer mode by linking the plugin through a directory junction, matching the marketplace link ([#13364](https://github.com/can1357/oh-my-pi/pull/13364) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the grep tool searching subdirectories for globs whose base path merely resolved to the cwd: only globs spelled without a directory prefix (like `*.ts`) now match at any depth, while `./*.ts` and absolute paths stay scoped to their directory ([#13360](https://github.com/can1357/oh-my-pi/pull/13360) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed the `ask` tool's "Other (type your own)" prompt sending RPC and SDK clients a terminal-rendered title (options with icon glyphs, lines clipped to the terminal width) instead of the question text; the interactive TUI's own ask dialog is unaffected ([#13477](https://github.com/can1357/oh-my-pi/pull/13477) by [@andrebrait](https://github.com/andrebrait))
- Fixed prewalk targets registered by extensions resolving before their provider was loaded. The hand-off now retries after extension registration, preserves role fallback order, and refreshes a cold runtime provider when needed.
- Fixed saving settings on Windows through a symlinked `config.yml` whose target contains `..` writing a file other than the one the link reads, and `agent.db` staying open after its storage is closed ([#13351](https://github.com/can1357/oh-my-pi/pull/13351) by [@Vortex727](https://github.com/Vortex727))
- Fixed grep line ranges (`path:N-M`) returning out-of-range lines for absolute paths with `./` or `..` segments ([#13296](https://github.com/can1357/oh-my-pi/pull/13296) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed service requests the project's service broker cannot parse, such as commands added by a newer omp after an update, waiting 30 seconds to time out; the broker now rejects them immediately with the reason ([#13301](https://github.com/can1357/oh-my-pi/pull/13301) by [@eggpeat](https://github.com/eggpeat)).
- Fixed sessions stopping on "Anthropic stream stalled while waiting for the next event" (and other mid-stream stalls, HTTP/2 resets, premature closes, or sockets closed mid-response) when the connection died after the reply's text had already rendered. Replay was refused to avoid duplicating shown text and the tool-turn continuation needed a tool call, so text-only turns had no recovery; the partial turn is now kept and the model is asked to continue from where it stopped, up to 3 times per prompt when `retry.enabled` is on ([#13333](https://github.com/can1357/oh-my-pi/pull/13333) by [@jerryfane](https://github.com/jerryfane))
- Fixed editing one fallback chain in the model hub, or one agent in `/agents`, saving every chain or agent a `--config` overlay supplies into `config.yml` ([#13308](https://github.com/can1357/oh-my-pi/pull/13308) by [@Vortex727](https://github.com/Vortex727))
- Fixed `omp install --dry-run <local-path>` and `omp plugin link --dry-run` linking the plugin and writing the lockfile instead of only previewing ([#13241](https://github.com/can1357/oh-my-pi/pull/13241)).
- Sessions containing assistant messages with no recorded usage now open with that usage counted as zero, instead of crashing on load with `undefined is not an object (evaluating 'usage.cacheRead')` ([#13386](https://github.com/can1357/oh-my-pi/pull/13386) by [@ParadaCarleton](https://github.com/ParadaCarleton)).
- Fixed rules with an `astCondition` and `interruptMode: always` letting the matching `write` or `edit` run before the interrupt, so the file changed on disk even though the rule fired; the call is now blocked before it executes ([#13303](https://github.com/can1357/oh-my-pi/pull/13303) by [@JYeswak](https://github.com/JYeswak))
- Fixed rules not applying to tool calls made from inside `eval` (for example `tool.write(...)`), which ran without any rule check; they are now checked the same way as direct calls ([#13316](https://github.com/can1357/oh-my-pi/pull/13316) by [@JYeswak](https://github.com/JYeswak))
- Fixed bash calls whose optional fields arrive filled with empty values being rejected as service starts ([#13182](https://github.com/can1357/oh-my-pi/issues/13182)).
- Fixed keyless vLLM providers failing every request with "No API key found" ([#13246](https://github.com/can1357/oh-my-pi/issues/13246)).
- Fixed the Agent Hub usage gauge measuring a subagent against its startup model's context window after a fallback model swap ([#13061](https://github.com/can1357/oh-my-pi/pull/13061)).
- Fixed HTML session exports failing to render offline or under a strict script CSP; the viewer libraries are now inlined ([#12948](https://github.com/can1357/oh-my-pi/issues/12948)).
- Fixed hashline edits rejecting files whose names contain `#` (such as yadm alternate files) ([#13428](https://github.com/can1357/oh-my-pi/pull/13428)).
- Fixed a module created with `write` leaving the importing file stuck on TS2307 in typescript-language-server ([#12925](https://github.com/can1357/oh-my-pi/pull/12925)).
- Fixed startup waiting up to 10s on an unresponsive LM Studio loopback probe; the probe now gives up after 250ms like Ollama and llama.cpp ([#12945](https://github.com/can1357/oh-my-pi/issues/12945)).
- The interactive `/usage` dashboard keeps connected accounts visible when some or all usage lookups fail, showing unavailable usage instead of hiding accounts ([#13476](https://github.com/can1357/oh-my-pi/pull/13476) by [@aktanazat](https://github.com/aktanazat)).
- Fixed multiline pastes splitting into separate submissions after a terminal drops bracketed-paste mode, and text typed right after Enter being erased by the post-submit clear ([#13440](https://github.com/can1357/oh-my-pi/pull/13440) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed subagents never compacting when the parent sets `compaction.midTurnEnabled: false`; a subagent's run is a single turn, so subagents keep mid-run compaction on unless a spawn overrides it ([#13212](https://github.com/can1357/oh-my-pi/pull/13212)).
- Fixed the exit resume hint so the `omp --resume <id>` command prints on its own line, letting triple-click select just the command ([#12748](https://github.com/can1357/oh-my-pi/pull/12748) by [@F0Rextasy](https://github.com/F0Rextasy)).

## [18.4.0] - 2026-09-28

### Added

- Added the `telemetry.otlpExportEnabled` setting under Settings → Providers → Privacy to disable OTLP trace, log, and metric export even when `OTEL_*` endpoints are configured; exporting remains enabled by default.
- Added a first-launch warning when Python evaluation is enabled but no working Python interpreter is available, with guidance for configuring `python.interpreter` and checking the installation with `omp setup python --check`.

### Changed

- Updated `omp stats` and `/stats` to open the redesigned dashboard immediately while session data synchronizes in the background with live progress; `--json` and `--summary` continue to synchronize before producing output.
- Replaced the stats dashboard’s Behavior page with a Frustration page that can classify messages using the `judge` model role, showing an estimated cost before analysis and recording `/stats` spending in the current session.
- Clarified the `eval` tool documentation to explain that its kernel may be shared with the parent session and concurrent task subagents.

### Fixed

- Fixed `/tree` reopening saved Ask results instead of navigating past them when an optional preview was saved as `null`.
- Fixed the legacy `createGrepTool()` API when searching with both a file path and a `glob` filter.
- Improved task and subagent reliability: eligible saved usage resets are now redeemed automatically when polling is throttled or transient failures occur, concurrent tasks share confirmed resets, headless subagents retain assignments across session transitions, tagged `^model` agents are available to nested subagents, and `wait` returns promptly with information about still-running work when no owned jobs are available.
- Fixed SDK requests using `ApiKeyResolver` to wait for a nearby healthy credential when a drained account’s quota block is about to expire, instead of immediately failing with a multi-hour quota error.
- Fixed Anthropic requests failing after native compaction when experimental context notes were enabled.
- Fixed Windows path handling for 8.3 short paths, including project-directory detection and home-directory display in status, tool labels, and errors.
- Fixed `edit` `PUT >N` producing syntactically invalid code when inserting shallower constructs near closing braces.
- Fixed Windows one-shot commands, including `omp update`, incorrectly reporting successful completion as an error; also fixed this behavior when no user npm or Bun configuration file exists.
- Fixed missing judge token counts corrupting session usage totals and displaying `$NaN`.
- Fixed Cursor sessions under-reporting token usage and cost, compacting based on the wrong context measurement, and applying shell-command timeouts in the wrong units.
- Updated goal mode to wait for user input when all remaining todos are blocked instead of repeatedly requesting approval.
- Fixed `pi-background-tasks` 2.6.0 and later failing to load due to a missing legacy `pi-ai` compatibility export.
- Fixed blob broker requests when `PI_PROXY` is configured.
- Fixed `generate_image` reporting the catalog model instead of the image model actually used by the ChatGPT/Codex backend; saved image metadata now reflects the provider-returned size and quality.
- Fixed fast-model fallback selection so it no longer chooses Gemini or MiniMax models when no `smol` role is configured.
- Fixed extension tool renderers using upstream pi’s `renderCall(args, theme, context)` signature failing to render.
- Fixed Nix flake and NixOS module builds failing because the native package version stamp was not recognized.
- Fixed Nix dependency-lock checks failing after obsolete stats chart dependencies were removed.

## [18.3.5] - 2026-09-27

### Added

- Added API-key-billed OpenAI Responses web search (`openai/gpt-6-luna`, then `openai/gpt-5.6-luna`), tried after every Codex entry in the default search fallback chain so ChatGPT-subscription search is exhausted before any API usage is billed ([#13467](https://github.com/can1357/oh-my-pi/pull/13467) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Added prompt-cache warming, ported from [earendil-works/pi](https://github.com/earendil-works/pi): shortly before a prompt-cache entry expires, the main agent loop replays its last request and cuts the replay off at the first generated token, so idle gaps no longer force a full-prefix cache re-write. A refresh fires only when the expected avoided-miss cost clears its cost by $0.05, and warming stops as soon as a refresh misses the cache. Controlled by `providers.cacheWarming` (`off` / `streaming` / `idle`, default `idle`); idle warming covers 5-minute entries only, and models without a declared `promptCache` lifetime are never warmed. Extensions can override each decision through the `cache_warming_decision` event ([#12699](https://github.com/can1357/oh-my-pi/pull/12699) by [@KamijoToma](https://github.com/KamijoToma)).

## [18.3.4] - 2026-09-27

### Breaking Changes

- Replaced the `task` tool's `complexity` field with `solutionSpace`, a description of how open-ended the subtask is; `auto` thinking for spawned subagents now picks effort from it alone

### Changed

- `auto` thinking now picks effort for every turn by how open-ended the problem is, so large volumes of mechanical work no longer raise it

### Fixed

- Fixed agents looping for hours when every turn spends the whole output limit on reasoning: length-stop retries now tell the model its reasoning was discarded and to act in smaller steps, and a subagent whose length-stop recovery gives up now fails with that error instead of being re-prompted into the same loop
- Fixed tagging a model with `^` mid-session dropping the provider prompt cache for every following turn: new `m<N>` pseudonyms now arrive as a hidden session notice instead of rewriting the `task` description, which only absorbs them at a base-prompt rebuild

## [18.3.3] - 2026-09-27

### Added

- Added a unified predictive text engine with N-gram, SmolLM2, and macOS native providers, including cross-engine blending, background model downloads, and a cross-process prediction daemon.
- Added the `omp predict` command for evaluating completion performance and support for ingesting existing Claude Code and Codex prompt histories to bootstrap predictions on new installations.
- Added `omp skill list [dir] [--json]` to report skills resolved for a session directory, including discovery warnings in JSON output.
- Added a centralized progress display for background tool and model downloads, including support for downloading the SmolLM2-135M word-completion model.
- Added dynamic evaluation guidance through hidden session notices.
- Added a required `complexity` rationale to the `task` tool to improve automatic thinking-depth selection.
- Agents using `task` or `bash` now receive the `wait` tool for background-process coordination, and subagents can receive it when explicitly requested.
- Added context-aware suggestions to empty composers based on agent activity and effort.
- Added optional global or per-project memory scopes to the `retain` and `learn` tools when Mnemopi scoping is enabled.
- Added `/btw` to focused subagent views for asking questions about that agent's transcript with separate side-conversation history.

### Changed

- Completion behavior now uses the N-gram engine for standard `auto` completion across platforms, with blended N-gram and SmolLM confidence scoring where applicable; the SmolLM2 model uses a 145 MB GGUF (Q8_0) download and is prefetched only when explicitly activated.
- Updated `spelling.autocomplete` to use an enum-based engine configuration.
- Completion ghost text is now preserved through manual keystrokes.
- Window input actions now default to background execution; set `takeover: true` to opt into foreground activation, with clarified cross-platform coordinate and activation behavior.
- `omp tiny-models download` can now download the word-completion model.
- Updated `/play` help, read-tool summaries, platform-aware shortcut labels, and other UI hints for clearer interaction guidance.
- Updated the empty-submit behavior to account for live-steered messages and surface pending live-steering status in the UI.
- `ps --all` now includes exited global services, while the default view shows live global services.
- Orchestrator task documentation now follows a Target/Change/Acceptance format.
- Slash-command and hint usage tracking is now persistent and namespaced.

### Fixed

- Preserved MCP `structuredContent` in live tool-result details so evaluation callers can consume server data without reparsing model-facing JSON; spilled results continue to retain an artifact reference without duplicating the payload in session history.
- Fixed Collab hosts becoming unable to reclaim a room after a brief network interruption; hosts now retry room recovery without losing guests or queued updates.
- Fixed one-shot commands that stopped before completing, such as `omp config set` on a fresh Windows profile, incorrectly exiting successfully without output; they now report failure with diagnostic guidance.

## [18.3.2] - 2026-09-25

### Added

- Added `ctx.agent` to the extension context, reporting whether the session is the top-level agent or a subagent, plus its registry id, agent definition name, task depth and parent id, so handlers rebound to subagent sessions can tell which agent they serve ([#13314](https://github.com/can1357/oh-my-pi/pull/13314) by [@andrebrait](https://github.com/andrebrait))
- Added tracking of Anthropic's usage-limit wrap-up allowance for Claude subscription accounts: after the 5-hour or weekly limit is reached, the status line and `/slow status` show `limit reached · wrapping up · resets HH:MM`, and the agent is told to wrap up when neither low priority nor extra usage will continue the work ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

### Changed

- `providers.anthropic.slowMode` now controls only the low-priority lane; the usage-limit wrap-up allowance is tracked for every first-party Claude subscription account ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))
- Enter on the `/model` hub sidebar now moves focus to the model list (like →) instead of acting on the highlighted row ([#13347](https://github.com/can1357/oh-my-pi/pull/13347) by [@H4vC](https://github.com/H4vC))

### Fixed

- Fixed the Windows bash tool exporting `TEMP`, `TMP`, and `TMPDIR` with 8.3 short names such as `ADMINI~1`, so they now match the long-form `pwd`/`$PWD` after `cd "$TEMP"` ([#13265](https://github.com/can1357/oh-my-pi/pull/13265) by [@CoderTCY](https://github.com/CoderTCY))
- `edit` and `write` no longer refuse handwritten files named `generated.go`, `generated.ts`, `generated.js`, or `generated.py`; these are treated as auto-generated only when their header carries a generated-code marker ([#13138](https://github.com/can1357/oh-my-pi/issues/13138), [#13139](https://github.com/can1357/oh-my-pi/pull/13139) by [@radkawar](https://github.com/radkawar))
- Fixed the `edit` tool warning that valid Go 1.26 `new(expr)` calls (e.g. `new(f(x))`) introduced a syntax error, and `ast_grep`/`ast_edit` reporting parse errors on them ([#13148](https://github.com/can1357/oh-my-pi/issues/13148), [#13149](https://github.com/can1357/oh-my-pi/pull/13149) by [@radkawar](https://github.com/radkawar))
- Fixed hashline `PUT N*` / `CUT N*` on the first statement of a block (for example a Go or Python function that opens with an `if`) also replacing or deleting every statement after it ([#13153](https://github.com/can1357/oh-my-pi/issues/13153), [#13154](https://github.com/can1357/oh-my-pi/pull/13154) by [@radkawar](https://github.com/radkawar))
- Fixed the `Full output: artifact://` link on large background bash and eval results pointing at a truncated copy with `[…elided…]` gaps instead of the complete output ([#13142](https://github.com/can1357/oh-my-pi/issues/13142), [#13143](https://github.com/can1357/oh-my-pi/pull/13143) by [@radkawar](https://github.com/radkawar))
- Fixed `grep` paths like `dir/*.go` also matching files in subdirectories of `dir` ([#13146](https://github.com/can1357/oh-my-pi/issues/13146), [#13150](https://github.com/can1357/oh-my-pi/pull/13150) by [@radkawar](https://github.com/radkawar))
- Fixed auto-compaction re-sending a failed native (server-side) compaction on every turn, re-reading the full context each time; after a failure a retry would repeat, the next configured method runs instead until a compaction succeeds ([#13310](https://github.com/can1357/oh-my-pi/pull/13310) by [@alphastorm](https://github.com/alphastorm))
- Fixed a `/slow off` session resending requests indefinitely when another session had activated the shared Anthropic low-priority lane ([#13340](https://github.com/can1357/oh-my-pi/pull/13340) by [@H4vC](https://github.com/H4vC))

## [18.3.1] - 2026-09-25

### Added

- Added a filter to the Esc Esc rewind selector: press `f` and type to show only items containing every word, then Enter to rewind ([#13295](https://github.com/can1357/oh-my-pi/pull/13295) by [@H4vC](https://github.com/H4vC))
- Added native filesystem support for `local://` and `omp://` URLs across file-search, content-search, AST, shell, and related tools, including support for virtual working directories.
- Added a native `cp` builtin for filesystem copy operations.
- Added IDA Pro integration for opening executables and IDA databases, browsing pseudocode, assembly, imports, exports, strings, and cross-references, and performing database-aware actions such as renaming, commenting, type editing, function creation, saving, and persistent Python execution.
- Added shared, project-scoped IDA database access with broker-managed host processes, configurable concurrency and idle cleanup via `ida.maxOpen` and `ida.idleCloseSec`, automatic autosaving, and universal Mach-O architecture selection with `:@<arch>` syntax and host-architecture detection. IDA features can be configured with `ida.enabled`, `ida.python`, and `ida.installDir`.
- Added the `/slow [on|off|status]` command for opting into lower-priority service tiers on OpenAI, Google, and Anthropic subscription sessions, including automatic continuation when Anthropic session limits are reached.
- Added the `providers.openaiLiveSteering` setting to control whether input can be delivered while a response is in progress.
- Added session-wide approval for configuration changes through an `Always for this session` option in `cfg://` prompts, with clear timeout handling for unanswered prompts.
- Added the `cfg://` protocol and a configuration registry for reading, modifying, unsetting, and reactively managing layered agent settings with approval and precedence feedback.
- Added paged reading for large files, with metadata that allows clients to recover and continue displaying results.
- Added per-agent compaction thresholds for task and evaluation subagents, configurable as percentages or fixed token limits without changing the main session threshold.
- Added trusted additional context for extension and hook tool results, including `ctx.addAdditionalContext()`, allowing instructions to reach the model without altering displayed tool results.
- Added dictation support to `/btw` follow-up input.
- Added support for multiple simultaneous browser instances, including concurrent Chrome and Edge connections.
- Added detailed benchmark phases for measuring single-user throughput, parallel scaling, and prefill performance, with automatic prefill sizing based on model context limits.
- Added opt-in CUDA support to the Nix package for tiny-model inference through ONNX Runtime.
- Added reliable RPC prompt lifecycle reporting with `prompt_result`, structured provider errors, session-settled state, prompt identifiers, event filtering, and `--no-ui` support for non-interactive hosts.
- Added RPC session management through `open_session`, plus corresponding TypeScript and Python client APIs including `openSession`, `setEventFilter`, `onPromptResult`, `onSessionSettled`, and `waitForSettled`.
- Added `attachment://` and `conflict://` resource URL handlers.
- Added a per-server MCP `instructions: false` option to keep a server's guidance out of the system prompt while retaining its tools.
- Added stale tool-result eviction for advisors: before each review, an advisor replaces its own `read`/`grep`/`glob` output from reviews older than the latest one with a short placeholder, so it stops re-sending that output on every request. The deltas it reviews, the notes it wrote, and other tool results such as `recall` are never touched. Turn it off with `advisor.evictStaleResults` ([#13238](https://github.com/can1357/oh-my-pi/pull/13238) by [@alnaggar-dev](https://github.com/alnaggar-dev))

### Changed

- Improved recovery from output-length and context-window limits so truncated but actionable turns can be retained and retries are handled more accurately.
- Shortened the default system prompt by approximately 150 tokens while preserving its guidance.
- Improved Anthropic fallback handling so credit tokens and signed thinking context are preserved across same-provider fallbacks.
- Improved filesystem safety and path consistency across virtual URL protocols, including symlink and containment validation and correct Windows long-path reporting.
- Improved IDA database resource management with project sharing, bounded concurrency, idle cleanup, autosave, and clearer database status in listings.
- Improved runtime configuration behavior with type-safe layered settings, live updates, and safe sequential saves.
- Improved authentication and credential management to support live broker and credential-store changes.

### Fixed

- Fixed concurrent project access by enforcing file locking across processes.
- Fixed Windows file reads with line selectors such as `:1-40`.
- Fixed `omp update` and startup update checks to honor configured npm registries, including scoped registries and authentication tokens.
- Fixed invalid auto-QA grievance reports blocking the rest of the upload queue; rejected reports are now surfaced with the server error while other reports continue.
- Fixed advisor reviews making unnecessary follow-up requests, losing context after pruning, using the wrong thinking effort, or sending excessively large edit diffs.
- Fixed `/login` crashes in source-link and development installs after extension loading.
- Fixed retry fallback loops that could continue indefinitely when the fallback resolved to the same effective request.
- Fixed setup wizard detection for Gemini web search when Antigravity OAuth is active.
- Fixed headless print mode failing to complete an advisor review when a configured fallback reviewer was available.
- Fixed embedded shell startup when the inherited working directory had been deleted.
- Fixed Codex usage displays showing stale subscription plans and corrected usage views that combined separate quota limits.
- Fixed explicit model and provider selections bypassing `disabledProviders`; disabled providers are now refused and skipped during fallback.
- Fixed memory storage errors so failed items and underlying storage failures are identified.
- Fixed malformed user-level `mcp.json` files preventing valid MCP sources from loading.
- Fixed Anthropic server-side fallback requests using invalid model names.
- Fixed large-output model requests failing near the context limit by adjusting the output allowance to the remaining context.
- Fixed tool references in system prompts for tools exposed only through `xd://` devices.
- Fixed dictation remaining active after a recording restart during transcription.
- Fixed automatic account sign-outs going unannounced; sessions now report the affected account and login action through interactive, print, JSON, and RPC output.
- Fixed duplicate MCP tool listings in the system prompt.
- Fixed supervised service exits being missed or repeatedly replayed instead of being delivered to the session that started the service.
- Fixed memory backend failures to identify the affected item and underlying storage error.
- Fixed `write xd://<tool>` validation behavior so devices can return precise schema-mismatch responses.

## [18.3.0] - 2026-09-24

### Breaking Changes

- The `hub` tool is deprecated; use `wait`, `write`, and the `proc://` protocols instead.
- The `irc.timeoutMs` configuration setting has been removed.
- The edit mode syntax now uses `*** Edit File:`, `*** Find`, and `*** Replace` headers instead of `SM:` headers.
- Cancelling a process through `write` now requires an explicit `proc://<id>/kill` target; other write targets validate content normally.

### Added

- Added `omp://` documentation scopes for `find` and `omp find`. Search all embedded harness documentation with `omp://` or a specific document with `omp://<file>.md`; results are returned as canonical URLs that `read` can open, including range selectors.
- Added extension support for ephemeral, `/btw`-style side turns through `ctx.runEphemeralTurn()`, with optional tool suppression and output/context limits without adding the turn to session history.
- Added background job and service management through the `wait` tool and `proc://` URLs, including supervised services in `bash` and direct agent messaging through `agent://` write targets.
- Added `*** Insert Before` and `*** Insert After` edit operations for adding lines without replacing existing code.
- Added the `toks` command for offline token counting, including support for Jev (TypeSafe Jev 1.13) encodings.
- Added automatic discovery of Apple Foundation Models on supported Apple silicon devices.
- Added `/changelog last [N]` for viewing the latest release or a selected number of recent releases.
- Added terminal-based OAuth authentication with `omp login`, including browser-assisted login, account and organization details, and automatic model discovery refresh. Added provider support for `org-scoped-identity`, `oauth-token-env`, and per-account OAuth priority/reserve policies through `auth.accountPolicies`, with policy state shown by `omp usage`.
- Added the `daybreak` badge to `omp usage` for enabled accounts.
- Added `/export` and `/usage` to focused subagent views for exporting a focused transcript and viewing account usage without returning to the main session.
- Pasted clipboard images are now saved in the session artifact directory, allowing agents to read, copy, or upload them by file path.
- Added `/annotate` for attaching notes to diffs, replies, session messages, files, or quoted text and inserting or sending those notes in prompts and reviews.
- Added configurable MCP startup behavior through `MCP_STARTUP_TIMEOUT_MS`/`mcp.startupTimeoutMs` and `OMP_MCP_REQUIRE_READY=1`, allowing headless runs to require MCP servers to become ready before the first turn.
- Added native judgment usage reporting, including error stop reasons and messages, and added `openrouter/~typesafe/jev-latest` as a native judge candidate.

### Changed

- Session compaction now supports native Anthropic snapshot branches and rewinds.
- The default `bash.autoBackground.strategy` is now `catalog`.
- The `Launch` configuration group has been renamed to `Services`.
- Terminal OAuth behavior is now consistent between `omp login` and `omp auth-broker login`.
- Judgment fallback now uses only native candidates, preventing prompted models from replacing failed native judges.
- Browser screenshot comparisons now tolerate minor rasterizer differences.

### Fixed

- Fixed credential-aware API key resolution during authentication rotation.
- Fixed comma-separated line selectors in `read`, `grep` paths, and `fetch`; selectors now read the requested range, while a bare number selects only that line.
- Fixed `write` reporting JavaScript character counts instead of UTF-8 byte counts.
- Fixed background job and service status reporting, including incorrect durations, reused job IDs, stale logs after named-service restarts, and foreground calls incorrectly appearing as background jobs.
- Fixed `wait` and agent messaging so completed subagent results and peer messages are delivered reliably, including when a wait is interrupted by an incoming message.
- Fixed headless print mode dropping or silently ignoring MCP servers that start slowly; it now waits within the configured timeout and warns when a server is not ready.
- Fixed reader-mode `fetch` sending inline SVG icons and base64 images as unreadable model input; alt text is retained instead.
- Fixed long non-Latin judged TTSR output exceeding token limits by applying token-aware truncation.

## [18.2.11] - 2026-09-23

### Fixed

- Fixed nested `eval` Todo updates not being reflected by the Todo tracker, including cases where a cell fails after committing an update.
- Fixed strict-mode structured-output validation for JSON Schemas without a root `type`, preserving their `items` and `required` keywords.
- Improved streamed TTSR whole-buffer matching to avoid repeated scans from the beginning of the buffer.
- Fixed plural browser queries when compiled binaries provide shallow stack traces.
- Fixed browser `tab.fill` timing out on pages whose animation frames stall.
- Fixed the first LSP diagnostics request returning no results while a newly started language server is still analyzing.
- `/shake thinking` now reports the number of tokens freed.

## [18.2.10] - 2026-09-22

### Added

- Added live benchmark results table with real-time model ranking and per-kind performance metrics
- Added dedicated prefill throughput reporting for prefill-focused benchmarks
- Added `/record` slash command to capture terminal sessions as replayable `.ompcast` files
- Added `omp play` CLI for terminal-based playback of session recordings
- Added intent descriptions to judgment batching
- Added live progress tracking for judgment batches in the TUI

### Changed

- Refined AI-assisted git staging verification to reduce false positives
- Updated `omp bench` default profile to `chat` and improved CLI flag documentation
- Coalesced judgment batch drain operations for better performance under high load

## [18.2.9] - 2026-09-22

### Added

- Added Claude saved resets to usage views and `/usage reset`, with automatic blocked-limit recovery and expiring-reset redemption controlled by `claudeResets`.
- Added support for searching embedded harness documentation with `find` and `omp find` using `omp://` scopes, including file-specific searches and `:start-end` selectors; results open directly through canonical `omp://` URLs.

### Changed

- Updated server-side fallback documentation and logic to target claude-opus-5-5
- Added support for claude-opus-5-5 to model priority registry
- Updated the read tool guidance to decode images inline by default and require an explicit `:img` selector for SVG rendering.
- Improved model discovery and fallback behavior: authentication failures are surfaced in the `/models` hub, and models without a matching role-specific fallback now use the default fallback chain.
- Improved resilience for subagents by retrying provider stream failures that occur after partial output and preserving configured ordered model fallbacks at startup.
- MCP OAuth with Google issuers now requests offline access so refresh tokens can be issued; repeated auth-broker token rotations also preserve the required refresh and client metadata.
- MCP servers from omp-plugins now expand `${CLAUDE_PLUGIN_ROOT}` and `${OMP_PLUGIN_ROOT}` in commands, arguments, and working directories.
- `/review` now uses the session's current working directory after `/move` or `/wt`.
- Pasted and dragged image files now retain their original filesystem paths so the agent can act on the source files directly.
- Custom sessions can now be moved across filesystems without losing transcripts or artifacts.
- `hub jobs` now returns a compact, non-consuming status summary instead of replaying completed output or consuming pending auto-delivery.
- The display-reset shortcut now works while the ask dialog has keyboard focus, and `tab.press()` provides a clear error for the legacy argument order.
- Wayland keyboard input now follows the compositor's active XKB layout instead of assuming a US layout.
- LSP diagnostics now refresh when watched files are created or deleted and after a server reload.
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve`.

### Fixed

- Fixed JavaScript `eval` assignments in cells containing top-level `await` so they persist into subsequent cells.
- Fixed skill hints becoming out of sync with the active prompt after discarded rebuilds and in advisor sessions.
- Restored `pi.pi.askToolRenderer` for extensions that replace the built-in ask tool, preserving native rendering.
- Fixed npm plugin upgrades and reinstalls leaving stale or duplicate manifest entries that could break `bun install`.
- Fixed `eval` waits longer than approximately 24.8 days returning immediately because of native timer overflow.
- Fixed deleted sessions being resurrected from stale rewrite backups.
- Fixed `/collab` relay connections honoring `HTTPS_PROXY` and `NO_PROXY`.
- Fixed sessions remaining blocked by queued turns or Hindsight auto-recall after disposal or cancellation.
- Fixed edits to auto-generated files aborting the entire turn; they now return a tool-scoped error.
- Fixed Edit handling of invalid overlapping selections in multibyte text so the worker reports a match error instead of panicking.
- Fixed local memory consolidation on case-insensitive filesystems when project path casing changes between launches.
- Fixed first-time Xcode MCP connections on macOS by allowing the signed `omp` binary to request Apple Events permission.
- Fixed stale or duplicated TTSR trigger events during streaming.
- Fixed MCP OAuth credentials retaining their refresh endpoint and client metadata across repeated token rotations.
- Fixed local model and provider retry behavior for streamed and partially buffered failures.
- Fixed memory and session cleanup issues that could leave stale artifacts or inconsistent state.
- `lsp.formatOnWrite` now prefers a dedicated `isLinter` formatter server when a type-checker also claims the file ([#12847](https://github.com/can1357/oh-my-pi/pull/12847) by [@roboomp](https://github.com/roboomp)).
- `/extensions` no longer shows OMP-installed marketplace capabilities as disabled behind the foreign-plugin opt-in gate ([#12849](https://github.com/can1357/oh-my-pi/pull/12849) by [@roboomp](https://github.com/roboomp)).

### Removed

- Removed support for image query parameters (`?q=`) and bare image paths in the read tool.
- Custom models now honor provider-level `transport: pi-native` and send requests to the native gateway ([#12845](https://github.com/can1357/oh-my-pi/pull/12845) by [@joshrzemien](https://github.com/joshrzemien)).
- Fixed live models that match no `retry.fallbackChains` role primary (e.g. Fable after `/model`) resolving no chain, so a wait longer than `retry.maxDelayMs` aborted the session instead of walking `default` ([#12421](https://github.com/can1357/oh-my-pi/issues/12421)).
- Fixed skill hints drifting from the active prompt after discarded rebuilds or in advisor sessions ([#12148](https://github.com/can1357/oh-my-pi/pull/12148) by [@jerome-benoit](https://github.com/jerome-benoit)).
- Restored `askToolRenderer` on the extension namespace (`pi.pi.askToolRenderer`) after the pi-tui renderer migration dropped it, so extensions that shadow the built-in ask tool can keep the native rendering again. ([#12694](https://github.com/can1357/oh-my-pi/pull/12694) by [@xiechimon](https://github.com/xiechimon))
- Model discovery rejected with 401/403 now surfaces an authentication error in the /models hub instead of a silently empty model list. ([#12436](https://github.com/can1357/oh-my-pi/pull/12436) by [@xiechimon](https://github.com/xiechimon))
- Pasted or dragged image files now reach the agent with their original filesystem path, so it can read and act on the source file directly; clipboard screenshots keep working unchanged. ([#12404](https://github.com/can1357/oh-my-pi/pull/12404) by [@xiechimon](https://github.com/xiechimon))
- `/review` now runs VCS operations against the live session cwd after `/move` or `/wt` instead of the session-start checkout ([#12712](https://github.com/can1357/oh-my-pi/pull/12712) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Reinstalling or upgrading an npm plugin no longer leaves stale or duplicate manifest edges that broke `bun install` ([#12727](https://github.com/can1357/oh-my-pi/pull/12727) by [@F0Rextasy](https://github.com/F0Rextasy)).
- TTSR now emits one `ttsr_triggered` event per streamed violation instead of one per evaluation pass ([#12729](https://github.com/can1357/oh-my-pi/pull/12729) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Eval `wait()` timeouts above ~24.8 days no longer overflow the native timer and return immediately ([#12731](https://github.com/can1357/oh-my-pi/pull/12731) by [@F0Rextasy](https://github.com/F0Rextasy)).
- MCP OAuth against Google issuers now requests `access_type=offline` so refresh tokens are issued ([#12737](https://github.com/can1357/oh-my-pi/pull/12737) by [@F0Rextasy](https://github.com/F0Rextasy)).
- Deleting a session now also removes its stale `.bak` rewrite backups so the picker cannot resurrect it ([#12746](https://github.com/can1357/oh-my-pi/pull/12746) by [@F0Rextasy](https://github.com/F0Rextasy)).
- `/collab` relay WebSockets now honor `HTTPS_PROXY`/`NO_PROXY` like other transports ([#12762](https://github.com/can1357/oh-my-pi/pull/12762) by [@jacobcolyvan](https://github.com/jacobcolyvan)).
- `tab.press()` now rejects the inverted `press(selector, key)` call with a hint naming the corrected `(key, { selector })` form, instead of the key parser's opaque `Unknown key: <selector>` ([#12136](https://github.com/can1357/oh-my-pi/issues/12136)) ([#12266](https://github.com/can1357/oh-my-pi/pull/12266) by [@danilouchoa](https://github.com/danilouchoa)).
- The display-reset shortcut (`app.display.reset`, `alt+l` by default) now fires while the ask dialog holds keyboard focus, instead of being dropped silently; the #11215 global-listener promotion covered the other four editor display actions but missed this one ([#12217](https://github.com/can1357/oh-my-pi/issues/12217)) ([#12262](https://github.com/can1357/oh-my-pi/pull/12262) by [@danilouchoa](https://github.com/danilouchoa)).
- Custom sessions can move across filesystems without losing their transcript or artifacts ([#12360](https://github.com/can1357/oh-my-pi/issues/12360), [#12378](https://github.com/can1357/oh-my-pi/pull/12378) by [@Dante-dan](https://github.com/Dante-dan)).
- Fixed `hub jobs` replaying full output for every settled job and consuming pending auto-delivery; it now returns a compact non-consuming status summary ([#12547](https://github.com/can1357/oh-my-pi/pull/12547) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Compiled bytecode binaries now start correctly when bundled dependencies use `import.meta.resolve` ([#12133](https://github.com/can1357/oh-my-pi/pull/12133) by [@andrebrait](https://github.com/andrebrait)).
- Subagents now retry provider stream errors that arrive after buffered partial output, and such failures are reported as transport errors instead of schema-invalid results ([#12752](https://github.com/can1357/oh-my-pi/pull/12752) by [@bse-ai](https://github.com/bse-ai)).
- Edits targeting auto-generated files now return a tool-scoped rejection instead of aborting the whole turn ([#12499](https://github.com/can1357/oh-my-pi/pull/12499) by [@Dante-dan](https://github.com/Dante-dan)).
- Subagents with an ordered model fallback keep it reachable on startup when the parent default role shares the same primary model ([#12377](https://github.com/can1357/oh-my-pi/pull/12377) by [@Dante-dan](https://github.com/Dante-dan)).
- omp-plugins MCP servers now substitute `${CLAUDE_PLUGIN_ROOT}`/`${OMP_PLUGIN_ROOT}` in `command`, `args`, and `cwd` ([#12801](https://github.com/can1357/oh-my-pi/pull/12801) by [@holny](https://github.com/holny)).

## [18.2.8] - 2026-09-21

### Added

- Added comprehensive browser automation tools for accessibility auditing, React inspection, console and network monitoring, performance tracing, semantic DOM queries, tab management, screen recording with cursor overlays, downloads, custom initialization scripts, persistent storage, and WebMCP cross-frame tool discovery.
- Added support for buffered cloud transcription with OpenAI-compatible models.
- Added visual change detection for video processing, including FFMPEG analysis and SVG overlays.
- Added support for declaring native judges through custom providers using the `typesafe` and `openrouter-decisions` API values, with configurable base URLs, API keys, and headers.

### Changed

- Expanded browser security and resilience controls with configurable HTTPS error handling, domain allow-listing, and automatic tab recycling when security-sensitive state changes.
- Updated background job notifications to deliver output as follow-up messages and discourage unnecessary polling.
- Expanded the bash tool's documented auxiliary utilities and removed its truncation footer notice.

### Fixed

- Improved responsiveness in long sessions by significantly reducing the time required to scan provider context for credential patterns.
- Fixed native judges failing to honor configured request headers, enabling authenticated and header-routed judge providers to work as configured.
- Fixed LSP requests hanging when aborted while waiting for an earlier write to complete.

## [18.2.7] - 2026-09-21

### Breaking Changes

- Image-generation overrides now use model selectors, and web-search CLI overrides use --model instead of --provider.
- Removed the bash tool's env parameter.
- Eval judge(state, questions) is now awaited and returns answers directly; JudgmentHandle and judgment support in wait() have been removed.

### Added

- Added `find` tool for semantic workspace searching, allowing agents to locate behaviors and symbols using natural language
- Added `find` CLI command for performing semantic workspace searches
- Added batch evaluation with judge_batch(states, questions) / judgeBatch(...), including bounded background execution, incremental result and status access, per-item failure reporting, and the ability to wait for or reattach to jobs across turns or after a reset.
- Added the jevify magic keyword to have the agent establish an evaluation rubric before classifying bulk items and inspect only items flagged by the judge.
- Added omp web-search as an alias for omp search.
- Added tui.titleSpinner configuration to select the terminal-title working-state spinner (braille, dots, or line).
- Added Handlebars-based system prompt templates through SYSTEM_TEMPLATE.md, --system-prompt-template, and the SDK, with access to live settings and tool data.
- Added configurable image, web, speech, dictation, judge, and memory model roles with ordered fallbacks, legacy backend-setting migration, and omp models --kind filtering.
- Added native OpenRouter image generation, model-selected web-plugin search, and live discovery of TypeSafe judge models.

### Changed

- Updated agent system prompts to prioritize the `find` tool over `grep` and `glob` for behavioral lookups
- Refined system prompt instructions for XML tag handling and agent persona
- Updated sloppy edit tool syntax to use plain text headers instead of XML tags
- Improved startup performance by validating provider-qualified model selectors against only the relevant provider catalog.
- Reduced launch time for npm and compiled builds by embedding the model catalog more efficiently.

### Fixed

- Fixed system prompt configuration validation so systemPromptTemplate and customSystemPrompt cannot conflict with a full systemPrompt replacement, including when values are empty.
- Added browser-relay support for listing eligible pages without attaching to or claiming them.
- Fixed Codex compatibility with the sloppy edit tool.
- Capped concurrent eval judge and completion requests to prevent large fan-outs from overwhelming judge and fallback models.
- Temporarily avoids retrying judgment requests with credentials that recently failed due to authorization or billing errors.
- Fixed image and speech fallback models disappearing after discovery and eliminated incorrect incompatibility warnings for providers without credentials.
- Fixed resume and continue flows to hide empty sessions.
- Fixed edit operations that could loop after empty insertions or fail on Unicode no-op and overlapping duplicate matches.
- Fixed live subagent messages being delayed by agent discovery and roster discovery looping on dot-named transcripts.
- Fixed llama.cpp discovery and routing for PrismML Bonsai 2 27B GGUF models, including support for cached models and the Qwen 3.8 thinking-level ladder.

## [18.2.6] - 2026-09-18

### Fixed

- Fixed clipboard paste stalling on an empty clipboard; image and text clipboard reads now run concurrently so the empty-clipboard status surfaces after the slower read instead of the sum of both.
- Fixed memory recall blocks carrying a minute-resolution `Current time` stamp that dirtied the cached system prompt on every refresh; recall rows already carry dates, so the stamp is removed.
- Fixed `omp auth-broker token` and `omp auth-gateway token` exiting silently without creating a token on Windows when no token file exists yet; token and config reads now use `node:fs` instead of `Bun.file`.

## [18.2.5] - 2026-09-17

### Breaking Changes

- Moved terminal UI modules—including themes, tool renderers, chat, overlay, status-line, composer, setup wizard, and Git/PS/debug apps—to `@oh-my-pi/pi-tui`. The corresponding `@oh-my-pi/pi-coding-agent` subpaths no longer exist; names re-exported from the package root remain unchanged.

### Added

- Added `omp stream` for livestreaming terminal sessions at `live.omp.sh/<your Stencil username>`, with viewer chat, pane-per-session display for sessions in the same directory, screen redaction, and configurable `stream.serverUrl` and `stream.redactPatterns` settings. Use `--server` to override the stream server, `--title` to set a title, and `--no-tui` to retain the line-based log interface.
- Added Stencil account support to `/login`. `omp stream` uses a signed-in Stencil account or `STENCIL_API_KEY` for channel ownership and authentication. Sensitive environment, dotenv, `secrets.yml`, credential-shaped, and configured pattern-matching values are redacted before screen data is transmitted.
- Added faster keyless web search fallback by prioritizing the default keyless Parallel provider ahead of Perplexity.

### Changed

- Improved parent IRC message prompts to make interruption handling more reliable.
- Improved subagent task labels and plan filenames to use concise, action-oriented descriptions.
- Updated CLI byte sizes to use decimal KB units and made duration displays coarser and easier to read.

### Fixed

- Fixed `edit` auto-repair waiting up to 60 seconds when the `smol` model does not respond; it now times out after 20 seconds and reports repair start and timeout details.
- Fixed subagents leaving queued parent messages behind after tool interruptions.
- Fixed a subagent burning its whole run on `yield` calls that never finish it: an incremental-only `yield` turn no longer bypasses the request budget, and the forced final `yield` ends the run ([#12351](https://github.com/can1357/oh-my-pi/pull/12351) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed `browser.open({ app: { relay: true } })` waiting for the full tool timeout when no relay extension is installed or reachable; it now fails promptly with an actionable error while preserving the wait for a connected extension to recover.
- Fixed `edit` handling of ellipsis markers, inline closing tags, copy-ready corrections, and retries, including cases that could insert literal markers, misreport matches, omit the file target, or panic.
- Enabled `edit.enforceSeenLines` by default to reject hashline edits anchored to content that was not displayed, and prevented stale-tag recovery from applying edits to a structurally different duplicate construct ([#12369](https://github.com/can1357/oh-my-pi/pull/12369) by [@pedropaulovc](https://github.com/pedropaulovc)).
- Fixed startup failures when the plugins directory or its manifest cannot be read; inaccessible plugin roots are now skipped with a warning.
- Fixed generation token-rate displays for subagents and restored the main session's reading after switching focus.
- Fixed subagent HUD labels and plan filenames being populated with example prompt text on smaller models.
- Improved shell, file, session, and persistence operations to avoid unnecessary repeated work, improving responsiveness and resource usage.

## [18.2.4] - 2026-09-17

### Added

- Added an optional live generation speed readout via `composer.tokenRate`, showing smoothed tokens-per-second output in the working row and keeping the rate visible between turns.
- Added TypeSafe provider support through `/login typesafe` or `TYPESAFE_API_KEY`. TypeSafe can power thinking-level detection, unexpected-stop detection, and AI-assisted git staging with calibrated judgment probabilities; configure `providers.judgmentProvider` as `auto`, `typesafe`, or `llm` to select the judgment backend.
- Added the `judge(state, questions)` evaluation helper for Python and JavaScript cell code, supporting typed choice, boolean, and score judgments. It returns a handle whose `.wait()` method provides answers and probabilities, using TypeSafe when configured and available or a fallback chat model otherwise.

### Changed

- Unified thinking-level detection, unexpected-stop detection, and AI-assisted staging around a shared judgment system with automatic fallback across configured models when TypeSafe is unavailable or cannot complete a request. AI-assisted staging now evaluates files as a single batched judgment while preserving one yes/no decision per file.

## [18.2.3] - 2026-09-17

### Breaking Changes

- Config-backed headers now resolve asynchronously through `ModelRegistry.getProviderHeaders()` or `resolveModelHeaders()`; removed the synchronous `config/model-config-values` module.
- Removed the unused `ConfigFile.getMtimeMsAsync()`, `tryLoadAsync()`, `loadAsync()`, and `loadOrDefaultAsync()` methods.
- Custom SQL session clients must support transactions for atomic renames.

### Added

- Type `^` to tag a model for delegation, with atomic display-name chips and session-persisted `m1`, `m2`, … agents available to task and eval.
- Provider login and setup support masked secret prompts; RPC rejects secret prompts rather than requesting ordinary input.

### Changed

- Shell-backed API keys and headers resolve asynchronously without freezing terminal input or running during catalog construction.

### Fixed

- macOS process discovery now retains the complete PID list when locating executables and descendants. ([#12290](https://github.com/can1357/oh-my-pi/pull/12290) by [@iliaal](https://github.com/iliaal))
- Reduced snapshot-recording stalls when a session retains large file histories. ([#12279](https://github.com/can1357/oh-my-pi/pull/12279) by [@iliaal](https://github.com/iliaal))
- Cancelled background jobs remain tracked until execution finishes, so cleanup cannot report completion prematurely after retention expires. ([#12278](https://github.com/can1357/oh-my-pi/pull/12278) by [@iliaal](https://github.com/iliaal))
- Fixed localized edits rewriting unrelated bytes in files with invalid UTF-8; these edits now fail without modifying the file. ([#12277](https://github.com/can1357/oh-my-pi/pull/12277) by [@iliaal](https://github.com/iliaal))
- Fixed sloppy edits crashing with a char-boundary panic instead of reporting a match error when the file contains multibyte (e.g. CJK) text.
- Fixed retry timing reliability in agent sessions by ensuring sleep durations are monotonic
- Fixed data stability issues when processing streamed lines
- Resolved same-path move failures in indexed session storage
- Restricted and revived subagents retain parent-loaded extension hooks without enabling extension-contributed tools.
- Revived subagents honor the owning session's extension-discovery restrictions.
- Secret login answers stay hidden in later prompts and cannot be recovered through undo or yank.
- SQL session renames preserve data on same-path moves, missing sources, and failed overwrites.
- MySQL session writes no longer use deprecated upsert value references.
- MCP SSE requests honor one response deadline and report timeouts correctly without replaying accepted tool calls.
- Legacy extension package-import patterns follow native prefix precedence.
- Bundled extensions observe theme initialization and changes through the existing live `theme` export.
- Configured discovery models retain request-time credentials after offline cache reloads and failed refreshes.
- Runtime API-key overrides retain precedence over configured credentials.
- Element handles returned by `tab.waitForSelector`, `tab.$`, and related selector helpers can now be passed as arguments to `tab.evaluate` inside `tab.run` instead of failing with "JSHandles can be evaluated only in the context they were created".

## [18.2.2] - 2026-09-16

### Added

- Expanded built-in secret obfuscation to detect credentials in connection URLs regardless of environment-variable name, including PostgreSQL, MongoDB, MySQL, Redis, AMQP, and other supported schemes.
- Expanded built-in secret obfuscation to cover AWS access keys, Google API keys, Slack, npm, Stripe secret/restricted keys and webhook secrets, Hugging Face and SendGrid tokens, JWTs, Bearer tokens, and PEM private keys.
- Added the `tui.titleSpinner` setting to choose the terminal-title working-state animation (`braille`, `dots`, `line`, or `pulse`), alongside the existing `tui.titleState` toggle.

### Changed

- Session-stop hooks that block with a reason now keep the session running until they allow it or the user interrupts; explicit aborts are no longer restarted by a stop hook.
- Corrupt agent and prompt-history databases are now backed up before fresh stores are created, allowing startup to continue; credentials may need to be entered again.
- Agent and history database startup errors now identify the affected database file.
- Terminal-title spinner animations now work on native Windows; WSL retains the static separator to avoid unnecessary CPU usage.
- Explicit model refreshes now re-evaluate command-backed API keys and headers, allowing rotated credentials to take effect without restarting.
- Background job entries are removed shortly after their results are consumed or recovered, while unconsumed jobs remain available for inspection.

### Fixed

- Fixed the transcript collapsing into a compact no-spacing layout whenever the prompt, todo HUD, or other below-transcript chrome grew a few rows; the live tail now scrolls off the top instead.
- Fixed transcript layout and rebuilding issues that could collapse blank rows, leave tool calls displayed on one line, or show stale fragments after navigation, display changes, or compaction ([#12177](https://github.com/can1357/oh-my-pi/pull/12177) by [@shivamklr](https://github.com/shivamklr)).
- Fixed the `security-reviewer` agent so valid findings with anchors and remediation details are accepted.
- Stopping a subagent from Agent Hub now settles and reports its parent background job instead of leaving `hub wait` blocked indefinitely.
- Fixed prewalk handoff detection after edits or writes dispatched through Code Mode eval cells.
- Reduced main-thread stalls while streaming large edits by deferring AST-based matching until the edit is complete.
- Corrected the `/handoff` description so it accurately reflects that the command creates a handoff document and compacts the current session.
- Deferred misleading cold-cache `retry.fallbackChains` warnings until provider discovery completes.
- Fixed `--prewalk-into @default` so an explicitly selected startup model does not replace the configured default role, including ordered fallbacks and discovery-backed candidates.
- A corrupted or externally modified session file no longer leaves the session impossible to close; a subsequent Ctrl+C exits without rewriting the session log.
- Fixed silent MCP requests being terminated by an undeclared idle timeout; closing a legacy SSE connection now also cancels pending requests and notifications.
- Fixed browser reuse for Chromium installed behind Linux wrapper scripts and prevented duplicate launches when a profile is locked ([#12236](https://github.com/can1357/oh-my-pi/pull/12236) by [@shivamklr](https://github.com/shivamklr)).

Older entries are archived in [packages/coding-agent/CHANGELOG.md@1e3cc3ab94d0](https://github.com/can1357/oh-my-pi/blob/1e3cc3ab94d05617e79fb12d95711d58161747d3/packages/coding-agent/CHANGELOG.md).
