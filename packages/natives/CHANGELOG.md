# Changelog

## [Unreleased]

### Fixed

- Fixed macOS `setValue` on native text fields that Contacts, Reminders, Calendar, Font Book and System Settings showed but never stored: the text is now entered the way `win.type` enters it, and a mismatch names what the field reads

## [18.8.8] - 2026-10-10

### Changed

- Reduced macOS accessibility-tree latency for `ax()` without changing its text output: each element's children are read once, and its bounds, which the tree never shows, are no longer read ([#15159](https://github.com/can1357/oh-my-pi/pull/15159) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed macOS computer use reporting `AxFailed` instead of `StaleRef` for a ref whose element the app had removed ([#15156](https://github.com/can1357/oh-my-pi/pull/15156) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed macOS `el.press()` and `el.perform()` reporting `AxFailed` when the app did not answer in time, such as a press that opens a modal dialog; they now report `AxUnconfirmed` ([#15156](https://github.com/can1357/oh-my-pi/pull/15156) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.7] - 2026-10-09

### Added

- Added `wasmGrammarFor` for tree-sitter grammars loaded as WebAssembly on demand from `<natives dir>/grammars`, and `missingGrammars` on `astGrep`/`astEdit` results naming languages skipped because their grammar is not installed.

### Changed

- Reduced syntax-highlighting startup work by bundling the complete precompiled grammar set ([#14104](https://github.com/can1357/oh-my-pi/pull/14104) by [@iliaal](https://github.com/iliaal)).
- Changed standalone binaries to embed each native addon as its own deterministic zstd frame instead of a timestamped gzip tarball, making binaries smaller.
- Updated the shell's built-in `jq` to jaq 3.1.1, which `jq --version` now reports ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))

### Fixed

- Fixed the built-in `jq` erroring where jq returns `null` (`.a.b` over `{}`, `.[0]` over `null`) and lacking `IN`, `input_filename`, `input_line_number` and `--unbuffered` ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq` reading each file operand separately: `-s` now slurps them into one array and `input` reads on into the next file, as in jq ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq` stopping at the first input that fails and rejecting `"021"` and `"+1"` in `tonumber`, where jq does neither; a run that reported a failing input is never shortened by the output minimizer, even when it exits 0 ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Fixed the built-in `jq`'s `halt_error` printing its message to stdout; like jq, it now goes to stderr ([#14659](https://github.com/can1357/oh-my-pi/pull/14659) by [@will-bogusz](https://github.com/will-bogusz))
- Shrank the native addon by about 77 MB: only 17 common tree-sitter grammars are linked in, and the other 39 languages load WebAssembly grammars from the grammar directory, treated as unsupported until installed.

## [18.8.4] - 2026-10-08

### Fixed

- Fixed long output from a failing `jq` command hiding its error message: the output minimizer now shortens `jq` output only when the command succeeded ([#14657](https://github.com/can1357/oh-my-pi/pull/14657) by [@will-bogusz](https://github.com/will-bogusz))

## [18.8.1] - 2026-10-07

### Added

- Added the `PI_NATIVES_DIR` configuration option to control where compiled native addons are extracted. The version-specific subdirectory remains appended, allowing separate `HOME` environments to share the same native addon copy without sharing other data.

### Fixed

- Fixed background shell builtins and other in-process commands so they terminate when their subshell exits and can be stopped with `kill %N`, matching the behavior of external commands.

## [18.7.0] - 2026-10-06

### Breaking Changes

- Renamed the `linux-all` Bazel target (`//:natives-linux-all`) to `all` (`//:natives-all`); the renamed target now includes Darwin addons.
- Removed the `gen:native` and `gen:native:reset` scripts. Standalone binary builds now embed the native addon archive and manifest instead of writing them to `native/`.

### Added

- Enhanced `rasterizeSvg` with optional scaling and terminal-cell padding, allowing SVGs to render larger while preserving 1:1 display in terminals.
- Added `OMP_NATIVE_FEATURES` for passing extra Cargo features to local native addon builds; Bazel builds ignore this setting.
- Added support for cross-compiling macOS native addons from Linux hosts.

### Changed

- macOS addon release stamping now works on any host by refreshing the addon's ad-hoc signature automatically.

### Fixed

- Fixed `tail` failing to print files, or omitting their first 64 KiB, when file sizes were exact multiples of 64 KiB.
- Fixed `tail` printing nothing, or dropping lines from the file's first 64 KiB, when the file size is an exact multiple of 64 KiB ([#14264](https://github.com/can1357/oh-my-pi/pull/14264) by [@jchanghong023](https://github.com/jchanghong023))
- Fixed native `sed` and `jq` killing the host process with SIGBUS when an input file is truncated while they read it ([#14613](https://github.com/can1357/oh-my-pi/issues/14613))
- Fixed `tail -f` piped into a command that exits early (such as `head -n 1` or `grep -m1`) never stopping on macOS ([#14614](https://github.com/can1357/oh-my-pi/issues/14614))
- Native `sort -u` keeps punctuation-distinct paths under UTF-8 locales instead of silently dropping records ([#14606](https://github.com/can1357/oh-my-pi/issues/14606)).

## [18.6.3] - 2026-10-06

### Breaking Changes

- `isoResolve` now returns a Promise and runs off the JavaScript thread; a backend found available is not re-probed ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))

### Added

- Added `encodeSixelAsync` and `decodeSixelToPngAsync`, which encode and decode SIXEL off the JavaScript thread ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- Added `warmBlockParse`, which parses a file for block context off the JavaScript thread so later block-context lookups answer from the cache; files over 4 MiB, which the cache does not keep, are skipped ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- Added native screenshot region capture without replacing the full-frame coordinate reference, native cancellation generations, and cross-process input/focus ownership.
- Added operation-scoped physical Escape cancellation on macOS.
- Added native application discovery/launch, background menus, combined image/AX observations, display targets, bounded held input, task control ownership, and macOS Space movement.

### Changed

- Replaced per-screenshot macOS subprocesses and intermediate PNGs with a persistent ScreenCaptureKit main-loop worker on macOS 14+ and in-process CoreGraphics on macOS 12/13.
- Read macOS window metadata from one coherent Quartz snapshot instead of re-enumerating the desktop for each window property.
- Defaulted desktop capture to the focused window's monitor, retaining explicit all-display and display-ID selection.
- Removed legacy desktop-addon emulation; computer use now requires the current native capture/cancellation API.
- Sped up the embedded shell on command output that is not valid UTF-8: decoding is linear, so commands printing binary data no longer stall (1 MiB took 14 s), and captured output is decoded once ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up edit previews while edit arguments stream: diffs, fuzzy matching and hashline parsing no longer redo or copy all their work for every streamed chunk ([#14520](https://github.com/can1357/oh-my-pi/pull/14520) by [@H4vC](https://github.com/H4vC))
- Sped up `fuzzyFind`: a cached scan is scored in place instead of being copied on every call ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up applying multi-hunk patches and `astEdit` calls with many edits ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Sped up `countTokens` on long runs of one kind of character, such as whitespace or letters ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up builtins that print many lines (`ls`, `find`, `paste`, `diff`, `cmp`, `wc`, `echo`, `ts`), `while read` and `mapfile` loops over files, and `sed` scripts using `N` ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Sped up flowchart and state diagram rendering in `renderMermaidAscii`; a 40-node flowchart renders about 14× faster, with identical output ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `find -type`, `rm -r`, `mkdir -p`, `ls` and `stat`, especially on Windows ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Sped up `sed` scripts that use regular expressions, `printf` output, and `sort -`, which now reads standard input directly instead of copying it to a temporary file ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `cp` and `mv` of directory trees; `mv` within one filesystem no longer walks the moved tree first ([#14524](https://github.com/can1357/oh-my-pi/pull/14524) by [@H4vC](https://github.com/H4vC))
- Staging files or hunks keeps the git index's file stat cache, so the next status check no longer re-reads every tracked file; staging many files rewrites the index once ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- `pidwait` and PTY sessions wait for process exit and cancellation events instead of polling ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Applying a patch to the worktree reads only the files the patch touches ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up `listWorkspace`, `fuzzyFind` with followed symlinks, and `fd`; the file-mention scan cache releases expired entries sooner ([#14527](https://github.com/can1357/oh-my-pi/pull/14527) by [@H4vC](https://github.com/H4vC))
- Sped up parsing of large hashline edits ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Sped up copy-on-write task isolation setup on reflink (Linux) and ReFS (Windows) volumes ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))
- `Process.waitForExit()` on a single process waits for the operating system's exit notification instead of polling every 50 ms ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Reduced memory and copying in `renderMermaidAscii`, snapcompact rendering and single-display desktop screenshots ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- `DesktopSession.capabilities` no longer blocks behind a running capture or input operation: while one runs, it answers from the capabilities read by the latest capture or capabilities call; otherwise it reads them live ([#14529](https://github.com/can1357/oh-my-pi/pull/14529) by [@H4vC](https://github.com/H4vC))
- Native OAuth logins are detected as soon as the browser redirects, without polling every 20 ms ([#14531](https://github.com/can1357/oh-my-pi/pull/14531) by [@H4vC](https://github.com/H4vC))
- Reduced the memory used by the local completion model's tokenizer ([#14533](https://github.com/can1357/oh-my-pi/pull/14533) by [@H4vC](https://github.com/H4vC))
- Long lines cut by the lint, gt and system output minimizers now end in `…[+N]`, showing how many characters were dropped ([#14532](https://github.com/can1357/oh-my-pi/pull/14532) by [@H4vC](https://github.com/H4vC))
- Reduced the memory used by tokenizer tables and by counting Claude tokens on long inputs ([#14530](https://github.com/can1357/oh-my-pi/pull/14530) by [@H4vC](https://github.com/H4vC))

### Fixed

- Rejected stale display-layout coordinates before pointer input and zoom, and preserved the previous coordinate frame when a capture is canceled.
- Released held input on cancellation and refused competing native mutations before dispatch.
- Fixed `umask` in the embedded shell changing the host process's umask; the mask now belongs to the shell, applies to files created by redirections, builtins such as `touch`, `mkdir` and `cp`, and external commands, and a subshell's `umask` no longer leaks out ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed diff hunk headers sometimes naming a different enclosing function than `git diff` does ([#14521](https://github.com/can1357/oh-my-pi/pull/14521) by [@H4vC](https://github.com/H4vC))
- Fixed `enable exec` and `enable suspend` restoring builtins that replace or stop the host process ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `ls -t` and `ls -S` listing entries with equal times or sizes in arbitrary order, and `ls --group-directories-first` scrambling entries within each group; ties now sort by name as in GNU `ls` ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Fixed `rm -r` and `rm -d` on Windows failing on a directory that has the read-only attribute ([#14523](https://github.com/can1357/oh-my-pi/pull/14523) by [@H4vC](https://github.com/H4vC))
- Fixed `declare -r` listing only readonly variables that were also traced, and `declare -t` listing every variable ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `sed` regular expressions treating `\b` as a backspace instead of a word boundary ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `mv` between filesystems losing modification times, modes, ownership, subdirectory extended attributes and hard links, failing on sockets, and removing source symlinks when copying an entry failed ([#14524](https://github.com/can1357/oh-my-pi/pull/14524) by [@H4vC](https://github.com/H4vC))
- Fixed `sort` reading standard input again for each repeated `-` operand ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `sort` collating text only on its first run in a session and taking its collation order, decimal point and thousands separator from omp's own locale instead of the shell's `LC_ALL`, `LC_COLLATE`, `LC_NUMERIC` and `LANG`, and `sort --parallel` changing the host's thread pool: `--parallel=N` now limits that sort to N threads and rejects invalid counts as GNU sort does ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed `tac` crashing omp when the file it read was truncated at the same time ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed `tail -f` piped into a command that exits early (such as `grep -m1`) never stopping, including when following provider-backed paths ([#14525](https://github.com/can1357/oh-my-pi/pull/14525) by [@H4vC](https://github.com/H4vC))
- Fixed run cancellation on Windows terminating an unrelated older process when the cancelled command reused the process ID of that process's exited parent ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed staging hunks and stashing clearing the index's skip-worktree flags, so files outside a sparse checkout no longer show as deleted afterwards ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed the `psql` output minimizer listing every table row whose first column began with a word like `ERROR` above the table, instead of applying the row limit ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed a PTY command hanging forever when its output callback stopped consuming output; the bridge now disconnects after the stall timeout like the shell bridge ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Fixed `Process.args()` on Windows returning an empty list for elevated processes when the caller is not elevated ([#14526](https://github.com/can1357/oh-my-pi/pull/14526) by [@H4vC](https://github.com/H4vC))
- Fixed strings passed to native functions sometimes losing their last characters when they ended in non-ASCII text (seen as `highlightCode` dropping the end of long lines) ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `renderMermaidAscii` hanging and running out of memory on an `xychart` axis whose range is finer than floating-point precision ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed copied task isolation trees on Windows turning directory symlinks into file symlinks ([#14528](https://github.com/can1357/oh-my-pi/pull/14528) by [@H4vC](https://github.com/H4vC))
- Fixed `getWorkProfile()` attributing async work to the wrong region or dropping it ([#14454](https://github.com/can1357/oh-my-pi/pull/14454) by [@H4vC](https://github.com/H4vC))
- Fixed `read` and `mapfile` in the embedded shell treating Ctrl-C and Ctrl-D bytes in a file or pipe as an interrupt or end of input (`printf 'a\003b\n' | read -r x` failed, `printf '\004x\n' | mapfile` stored nothing); they are keys only when standard input is a terminal ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `read` storing each byte of UTF-8 input as a separate character (`é` became `Ã©`); `read -n` and `read -N` now count characters instead of bytes, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `read -d` with a multibyte delimiter never matching; it stops at the delimiter's first byte, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `echo -e -E` expanding escapes; the later option wins, as in bash ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `mapfile -O` writing into a readonly array; it now fails before reading any input, as bash does ([#14522](https://github.com/can1357/oh-my-pi/pull/14522) by [@H4vC](https://github.com/H4vC))
- Fixed `computer` element refs expiring after two `ax()` reads of a window while the element was still there: an element now keeps its `[ref=eN]` across `ax()` and `find()` reads, even after missing a single snapshot. An element whose role or label changes gets a new ref, and its old ref keeps working until it expires; on Windows, an element that reuses a gone element's `RuntimeId` gets a new ref, and one whose `RuntimeId` cannot be read gets a new ref on every read ([#14485](https://github.com/can1357/oh-my-pi/pull/14485) by [@will-bogusz](https://github.com/will-bogusz))

## [18.6.2] - 2026-10-04

### Fixed

- Fixed short snapcompact PNGs being emitted below the minimum dimensions accepted by some vision backends ([#14355](https://github.com/can1357/oh-my-pi/issues/14355)).

## [18.6.1] - 2026-10-04

### Fixed

- Fixed concurrent searches through host-provided filesystem callbacks so they no longer starve other asynchronous filesystem operations, and ensured canceled searches release promptly.

## [18.5.1] - 2026-10-03

### Fixed

- Fixed macOS computer-use scrolling so takeover and desktop scroll actions move iPhone Mirroring and other pixel-forwarding windows reliably, with smooth mouse-like wheel steps.
- Fixed macOS computer-use value entry for date and time controls, including Calendar date pickers, with support for ISO 8601 dates and date-times and clear validation for unsupported formats.
- Fixed macOS computer-use value entry for popup buttons, allowing options to be selected by title with confirmation and reporting available options when a title is not found.
- Fixed macOS accessibility values for checkboxes, radio buttons, and radio groups so snapshots, attributes, and window information return usable numbers, titles, and referenced element values instead of debug representations.

## [18.5.0] - 2026-10-03

### Fixed

- Fixed Ctrl+V on Windows sometimes pasting text with a few characters replaced by unrelated glyphs (for example `https://` turning into `՞ttp缀難//`); clipboard reads and writes no longer run at the same time ([#14144](https://github.com/can1357/oh-my-pi/pull/14144) by [@H4vC](https://github.com/H4vC))

## [18.4.10] - 2026-10-02

### Fixed

- Fixed the embedded shell sometimes hanging on a pipeline with a stage that stopped (for example with `kill -STOP $$`) before the shell began waiting on it; the pipeline now becomes a stopped job ([#14023](https://github.com/can1357/oh-my-pi/pull/14023) by [@sjawhar](https://github.com/sjawhar))

## [18.4.9] - 2026-10-01

### Added

- Added `readTextFromClipboard()` for reading plain text from the system clipboard without starting a subprocess.
- Added `Shell.pids()` to retrieve the IDs of still-running processes spawned by an in-flight shell command.

## [18.4.7] - 2026-10-01

### Fixed

- Fixed omp 18.4.3 and later crashing with a segmentation fault at startup on Apple silicon Macs running macOS older than 27; Apple Foundation Models support now loads only on macOS 27 and later

## [18.4.5] - 2026-09-30

### Fixed

- Fixed macOS spell checking and Apple word completion adding a duplicate terminal icon to the Dock for every omp session ([#12491](https://github.com/can1357/oh-my-pi/issues/12491))
- Fixed `computer.windows()` on macOS marking every window of the frontmost app as focused. One window is marked now: the app's accessibility focused window, or its frontmost window when Accessibility permission is not granted. With the permission, `computer.focusedWindow()` no longer returns a floating panel such as TextEdit's Fonts panel in front of the document ([#13673](https://github.com/can1357/oh-my-pi/pull/13673) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed non-Latin prompts that quote code in backticks or fences losing most of their prose score, which made the typing predictor's vocabulary refuse to learn them ([#13758](https://github.com/can1357/oh-my-pi/pull/13758) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed `computer.window(...).ax()` leaving out everything inside an unnamed container. On macOS, Reminders, Contacts, Notes and Font Book windows showed only their toolbar and window buttons, and Calendar lost its month grid; Windows and Linux trees now also keep content under unnamed containers such as custom panes, lists and fillers ([#13822](https://github.com/can1357/oh-my-pi/pull/13822) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed Wayland `computer.drag()` sending all waypoints in one burst, preventing HTML5 drag-and-drop targets from receiving `drop` ([#13860](https://github.com/can1357/oh-my-pi/issues/13860)).
- Fixed Wayland computer input staying unavailable after a cancelled RemoteDesktop permission prompt or a disconnected input session ([#13857](https://github.com/can1357/oh-my-pi/issues/13857)).
- Fixed Wayland `win.screenshot()` returning the top-left of the monitor for native Wayland windows whose position AT-SPI cannot report (Discord, Teams, Chromium); it now fails with `CaptureFailed` instead of capturing the wrong region ([#13854](https://github.com/can1357/oh-my-pi/issues/13854)).
- Fixed `computer.focusedElement()` failing with `AxFailed: atspi: null reference` on Linux while a Chromium or Electron app (Spotify, Discord, Steam, …) is running ([#13855](https://github.com/can1357/oh-my-pi/issues/13855)).

## [18.4.4] - 2026-09-29

### Fixed

- Fixed `computer.window(id).ax()` and `find()` failing with `AxFailed` on macOS sheets, popovers and open menus that `computer.windows()` lists, such as TextEdit's Save sheet or a Calendar event popover ([#13659](https://github.com/can1357/oh-my-pi/pull/13659) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed macOS 26 background scrolls moving twice the requested distance; background hovers, scrolls and right or middle clicks are now delivered once ([#13739](https://github.com/can1357/oh-my-pi/pull/13739) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed macOS `takeover` clicks and scrolls failing with `AX action 'AXRaise' failed (AXError(-25205))` on covered windows that do not support `AXRaise`, such as iPhone Mirroring, even when activation brings them forward; a window that stays covered still refuses before any input is sent ([#13737](https://github.com/can1357/oh-my-pi/pull/13737) by [@will-bogusz](https://github.com/will-bogusz)).
- Fixed `ps -r` in the in-process `ps` builtin: it now sorts by CPU usage, highest first, as on macOS/BSD, instead of filtering to running processes. Also added `ps -m`, which sorts by memory usage.
- Fixed process states on macOS in the `ps`, `top`, and `pgrep`/`pkill -r` builtins: idle processes showed as running (`R`), which made `ps r` list nearly every process. States now come from each process's threads, as Apple `ps` does.
- Removed the procps-only `l` (multithreaded) STAT flag from `ps` on macOS; Apple `ps` doesn't print it.

## [18.4.3] - 2026-09-28

### Changed

- Lowered the macOS native addons' minimum supported macOS version to 12.0 (previously 15.5)
- Reduced snapshot cost on every hashline read and grep: file-hash tagging no longer builds a normalized copy of the file, and the seen-line prefix regex is compiled once ([#13650](https://github.com/can1357/oh-my-pi/pull/13650) by [@H4vC](https://github.com/H4vC)).

### Fixed

- Fixed released Darwin arm64 addons omitting Apple Foundation Models support ([#13610](https://github.com/can1357/oh-my-pi/issues/13610)).
- Fixed the edit tool's `replace block`/`delete block` operations in indentation-based languages such as Python extending a statement's block over every following statement in its body when a comment line at a different indentation came right after it ([#13358](https://github.com/can1357/oh-my-pi/pull/13358) by [@jchanghong023](https://github.com/jchanghong023)).

## [18.4.2] - 2026-09-28

### Added

- Added `summarizeCodeAsync` for non-blocking source structure summarization on the libuv thread pool

### Fixed

- Fixed concurrent streaming searches hanging indefinitely or ignoring cancellation while waiting to deliver results to JavaScript.
- Fixed ngram word completion losing learned state between sessions on Windows when saving its snapshot ([#13589](https://github.com/can1357/oh-my-pi/issues/13589)).
- Fixed Windows shell pipelines losing their final output when cancelled or timed out (e.g. `yes x | tail -5`): cancelled runs now get a longer grace period to flush before being aborted ([#13365](https://github.com/can1357/oh-my-pi/pull/13365) by [@jchanghong023](https://github.com/jchanghong023))

## [18.4.1] - 2026-09-28

### Fixed

- Fixed `grep` retaining every matching line until the search finished: the new `onMatches` option streams bounded batches while the search runs, pauses the search while JS catches up, and returns only counts ([#13495](https://github.com/can1357/oh-my-pi/issues/13495))
- Fixed omp crashing at startup on macOS when built from source with `SDKROOT` set (e.g. via Nix) on a host whose Command Line Tools ship the macOS 27 SDK ([#13168](https://github.com/can1357/oh-my-pi/pull/13168) by [@johnrichardrinehart](https://github.com/johnrichardrinehart)).
- Hashline edit rejections for a tag issued for another file now name the path the tag belongs to ([#13464](https://github.com/can1357/oh-my-pi/pull/13464) by [@holny](https://github.com/holny)).
- Fixed the native terminal output pump exiting on temporary nonblocking backpressure ([#13463](https://github.com/can1357/oh-my-pi/pull/13463) by [@hancens1024](https://github.com/hancens1024)).
- Fixed commits failing on Windows when a repository has commit hooks; hooks now run through `git hook run` ([#13366](https://github.com/can1357/oh-my-pi/pull/13366) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed Windows path stats lacking a file identity, which let `rg` search its own redirected output and made `tail -F` report spurious replacements ([#13367](https://github.com/can1357/oh-my-pi/pull/13367) by [@jchanghong023](https://github.com/jchanghong023)).
- Fixed the embedded shell running backtick spans inside a quoted heredoc within a double-quoted command substitution ([#13307](https://github.com/can1357/oh-my-pi/issues/13307)).
- Fixed native operations to deliver results completed within their timeout and reject results when an abort signal arrives before settlement ([#13209](https://github.com/can1357/oh-my-pi/pull/13209) by [@Komzpa](https://github.com/Komzpa)).
- Fixed `ulimit` in the embedded shell changing the host process's own resource limits, including from inside `( … )` subshells: limits are now shell state applied only to the external commands the shell spawns ([#13325](https://github.com/can1357/oh-my-pi/issues/13325))

## [18.4.0] - 2026-09-28

### Added

- Added Windows path utilities for converting between long and 8.3 short path spellings without resolving symlinks or junctions. Import them from `@oh-my-pi/pi-natives/path`.

### Fixed

- Fixed the native `xargs` builtin so `-P`/`--max-procs` correctly limits parallel command execution, including GNU-compatible `-P 0` behavior.
- Improved snapcompact rendering performance for stretched shapes on Windows x64, Intel Macs, and Linux CPUs without AVX2, with no visual changes.

## [18.3.5] - 2026-09-27

### Changed

- Improved syntax highlighting to use about 5x less memory and run 3-5x faster by compiling grammars with Oniguruma instead of fancy-regex; highlighted output is unchanged.

### Fixed

- Fixed SmolLM word completion (`spelling.autocomplete: smollm`) being about 25x slower on Windows x64 and Intel Macs; suggestions are unchanged ([#13488](https://github.com/can1357/oh-my-pi/pull/13488) by [@H4vC](https://github.com/H4vC))

## [18.3.4] - 2026-09-27

### Fixed

- Fixed the native addon keeping every `bun test --isolate`/`--parallel` test file's global object and module graph alive, which grew each test worker by ~15 MB per file until the run was OOM-killed.

## [18.3.3] - 2026-09-27

### Added

- Added a `TextPredictor` N-API binding for managing the high-performance ghost-text completion engine.

### Changed

- Updated desktop input-control capabilities to use a unified `takeover` setting, including `takeover: true` for forced foreground pointer interaction.

## [18.3.1] - 2026-09-25

### Added

- Added support for asynchronous file I/O and custom filesystem providers in native shell execution, including resolving arbitrary `scheme://` paths through native operation options.

### Fixed

- Fixed shell access to standard and special file descriptors, including `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, and `/dev/tty`, preventing heredoc commands from hanging the TUI.
- Fixed native operations such as grep, glob, AST, shell, and VCS calls to promptly honor an `AbortSignal` that was already aborted when the operation starts.
- Fixed Windows path formatting in the shell’s `fd` and `find` builtins so POSIX path patterns match correctly.

## [18.3.0] - 2026-09-24

### Added

- Added native bindings for Apple Foundation Models availability checks, text generation, and cancellation.
- Added offline token counting support for TypeSafe Jev 1.13 `state` inputs via `Encoding.Jev` (excluding the request frame).

## [18.2.11] - 2026-09-23

### Changed

- Improved `warmHighlighter()` so it prepares TypeScript, TSX, JavaScript, Bash, Python, Rust, and Markdown highlighting in the background, reducing delays on the first highlight for these languages.

## [18.2.9] - 2026-09-22

### Fixed

- Fixed stale workspace addons failing when first used; the error now identifies the addon and provides the command to rebuild native addons.
- Fixed background bash jobs hanging indefinitely when output forwarding stalls.

## [18.2.7] - 2026-09-21

### Added

- Added `renderMermaidAscii`, a native Mermaid-to-ASCII/Unicode renderer supporting flowcharts, state, sequence, class, ER, and xychart diagrams with color modes, themes, and direction overrides.
- Added a `default` package export condition so CommonJS consumers, including bytecode bundles, can load the native bindings.

### Changed

- Improved Mermaid flowchart rendering to respect dependency order, reduce crossings, align branches, and wrap long labels without truncation.

### Fixed

- Fixed Mermaid rendering issues involving arrowhead alignment and duplicate edge junctions around mixed-width node shapes.
- Fixed sloppy edit grammar compatibility with Codex constrained decoding.

## [18.2.1] - 2026-09-15

### Added

- Added `maxBytes` to `VcsGitRepo.diffText` options: rendering stops and the call rejects with an `OutputTooLarge` VcsError once the patch crosses the cap, so callers can bound the memory a large change set may consume ([#11454](https://github.com/can1357/oh-my-pi/pull/11454) by [@sjawhar](https://github.com/sjawhar)).
- Native addon embedding now rejects stale release binaries before standalone builds can package them ([#11831](https://github.com/can1357/oh-my-pi/issues/11831)).
- Fixed git repository discovery treating an unpopulated `.git` directory (no `HEAD`) as a checkout, which made `/wt` and isolated tasks fail with a raw "No such file or directory (os error 2)" instead of reporting that no Git repository was found. Discovery now skips such entries and keeps walking toward the root, matching `git rev-parse`.
- Added `vcsDiscoverForDisplay` (`repoForDisplay`): like repository discovery, but equal-root jj+git ties prefer Jujutsu for the status line and footer. Git-safe automation must keep using `vcsDiscover` ([#11071](https://github.com/can1357/oh-my-pi/issues/11071), [#11325](https://github.com/can1357/oh-my-pi/pull/11325) by [@boazy](https://github.com/boazy)).
- Shell and PTY command output on Windows now falls back from UTF-8 to the system ANSI code page (e.g. GBK on Chinese locales) instead of emitting replacement characters.

### Changed

- Workspace startup scans skip excluded build directories and retain a bounded set of entries and directory rules.
- Limited newest-file searches use less memory on large directory trees when scan caching is disabled.

### Fixed

- Bounded filesystem scan cache memory and prevented stale scans from repopulating the cache after file changes. ([#11240](https://github.com/can1357/oh-my-pi/pull/11240) by [@iliaal](https://github.com/iliaal))
- Fixed the embedded shell and PTY sessions inheriting `GIT_DIR`, `GIT_WORK_TREE`, and related repo-location overrides from the host process, which made `git` run in a secondary worktree mutate the primary one ([#11082](https://github.com/can1357/oh-my-pi/issues/11082)).
- Added a vendored Astro grammar so `.astro` files highlight the `---` TypeScript frontmatter and `{…}` template expressions instead of falling back to plain HTML ([#11164](https://github.com/can1357/oh-my-pi/pull/11164) by [@byigitt](https://github.com/byigitt)).
- Fixed the TUI sometimes stopping repainting while the agent continued running.
- Fixed native Darwin OAuth helper compilation under sandboxed and custom build environments by respecting `$CC` ([#11869](https://github.com/can1357/oh-my-pi/pull/11869) by [@Malix-Labs](https://github.com/Malix-Labs)).

## [18.1.17] - 2026-09-10

### Fixed

- Fixed Wayland computer-use clicks landing in the wrong place on scaled monitors by mapping captures through the portal's logical monitor geometry ([#11540](https://github.com/can1357/oh-my-pi/issues/11540)).

## [18.1.15] - 2026-09-08

### Fixed

- Fixed C++ language inference excluding CUDA header (`.cuh`) files ([#10782](https://github.com/can1357/oh-my-pi/pull/10782) by [@alphastorm](https://github.com/alphastorm)).

## [18.1.9] - 2026-09-04

### Added

- Added native Sixel-to-PNG decoding for terminal graphics returned by shell commands.
- Added transactional native OAuth callback registration with one-shot callback delivery on macOS, Linux desktops, and Windows.

### Fixed

- Fixed native version-control cleanup to respect ignore rules and path boundaries while safely handling symlinks, nested repositories, and submodules.

## [18.1.7] - 2026-09-03

### Added

- Added Windows ARM64 native addon support, including platform-specific npm packages.

## [18.1.6] - 2026-09-03

### Breaking Changes

- Renamed `MacOSPowerAssertion` to `PowerAssertion` and `MacOSPowerAssertionOptions` to `PowerAssertionOptions`; the options and handle shapes are unchanged.

### Added

- Added edit-session and edit-store types and utilities for managing edit states, snapshots, hashline operations, edit modes, edit descriptions, editable notebook text, and inline sloppy regions.
- Added cross-platform sleep inhibition to `PowerAssertion` on Linux and Windows.

### Changed

- `PowerAssertion.start` now reports acquisition failures on Linux and Windows instead of returning a handle that silently does nothing; platforms without an implementation continue to receive a no-op handle.

### Fixed

- Fixed native `git add` so staging an empty file list no longer stages macOS filename-normalization duplicates of tracked paths or files ignored only by a nested `.gitignore`.

## [18.1.5] - 2026-09-03

### Changed

- Updated `worktreeAdd` to support additional worktree creation options, including preserving uncommitted changes.

## [18.1.3] - 2026-09-02

### Fixed

- Fixed `grep` and `sed` treating basic regular expressions as extended ones, which silently matched every line for patterns like `^+` or `s/^\+/` and swapped the meanings of `+` and `\+` ([#10298](https://github.com/can1357/oh-my-pi/pull/10298) by [@mruangutai](https://github.com/mruangutai)).

## [18.1.0] - 2026-09-01

### Fixed

- Fixed TTY output backpressure reporting so pending write progress is accurately reflected during large writes.

## [18.0.11] - 2026-08-29

### Fixed

- Fixed staging and committing files through a reused Git repository handle, ensuring newly staged changes are correctly included in commits even on filesystems with coarse timestamp resolution.

## [18.0.10] - 2026-08-28

### Added

- Added native process replacement support for the CLI’s `/restart` command.
- Added `VcsGitRepo.mergeBase(a, b)` to find the best common ancestor of two Git revisions, returning `null` when the histories are unrelated.

## [18.0.9] - 2026-08-28

### Breaking Changes

- Replaced the Git-specific `watchHead` and `headWatchTarget` API with the backend-neutral `watch` and `VcsRepo.watchTarget` APIs.

### Added

- Added portable repository discovery and read operations through `VcsRepo`, `repo()`, and `require()`, with support for Git and Jujutsu and explicit capability checks for staged and revision diffs.
- Added the `Vcs*` API for repository operations across Git and Jujutsu, including repository discovery, refs and status, diffs, staging, commits, branches, worktrees, patch application, stash, cherry-pick, and CLI-backed push, fetch, and clone operations with cancellation support.

### Fixed

- Fixed Git intent-to-add files so they appear correctly as unstaged additions in `statusPorcelain` and are handled correctly when staging or applying patches.

## [18.0.8] - 2026-08-27

### Fixed

- Large session histories no longer leave macOS Terminal unresponsive during repaint.
- Bounded the interactive PTY reader→JS queue (64 × ≤64 KiB) and forward chunks through a separate `call_async` pump so a fast child plus a stalled JS consumer cannot accumulate unbounded output in-process, without freezing PTY input/resize/kill. After a finite child exit, wait until accepted output reaches `on_chunk`; only a permanently open slave skips that wait. Cancel, timeout, and that stuck-open path abort the pump before `start()` resolves. Same defect class as the non-PTY bash bridge (#4078).

## [18.0.6] - 2026-08-26

### Fixed

- Improved TypeScript and TSX syntax highlighting, including correct handling of type annotations and template literals.

## [18.0.5] - 2026-08-25

### Added

- Added asynchronous, size-bounded SVG-to-PNG rasterization for terminal media previews.
- Added the `DiffStream` API for processing text and byte input incrementally, opening files asynchronously, reporting stable-prefix progress, generating exact unified diffs, and warming syntax grammars asynchronously.

## [18.0.3] - 2026-08-23

### Fixed

- `macOSCheckSpelling` no longer reports the whole checked string as misspelled: automatic language identification returns an orthography result spanning the entire text, which leaked through as a typo range overlapping the real word span (doubling editor text under the undercurl and drifting the cursor).

## [18.0.1] - 2026-08-23

### Fixed

- Native macOS spellchecker now honors all active system dictionaries: misspelling detection uses automatic language identification and completions/guesses/corrections select the per-word language, so non-English text (e.g. Russian) is checked instead of only the shared checker's current language ([#9334](https://github.com/can1357/oh-my-pi/issues/9334)).
- Fixed PTY command cancellation leaking zombie child processes: a race where cancellation after spawn only attempted a single non-blocking reap could miss processes still being reaped by the kernel, and an early heartbeat check that bailed out without killing or reaping the child. On Unix, cancellation now polls for the child briefly and hands any straggler to a detached reaper, so the process is always waited on without an unbounded wait.
- Fixed installed CLIs losing desktop capture when the resolved prebuilt addon still exposes the pre-parity `DesktopSession` ABI. That ABI is now adapted behind the current session contract, legacy error codes are translated, and the adapter ships in the published native core package.

## [18.0.0] - 2026-08-22

### Added

- Added native macOS spellchecker APIs (`macOSAutocorrectWord`, `macOSCheckSpelling`, `macOSCompleteWord`, `macOSSpellingGuesses`, and `macOSSpellCheckerAvailable`) that run asynchronously without blocking the JavaScript thread.
- Added `HighlightStream`, a stateful incremental syntax highlighter that supports chunked highlighting while maintaining parser state.
- Added `TtyWriter`, an off-thread terminal output writer that performs non-blocking writes and tracks backlog metrics for renderer frame skipping.

### Changed

- Word completion now automatically appends a space unless followed by punctuation or whitespace.

## [17.4.1] - 2026-08-21

### Changed

- `bun run build:native` now builds through the local cargo/napi-rs backend by default, with Bazel available as an opt-in via `OMP_NATIVE_BUILD_BACKEND=bazel` or extra Bazel arguments after `--`.

## [17.4.0] - 2026-08-20

### Added

- Added offline `countTokens` support for Anthropic Claude families (`ClaudeV3`, `ClaudeV47`, `ClaudeV5`) via a high-performance native port of `ctok`.
- Added exact offline token counting support for Qwen (3.5+, 3.6+, 3.8), DeepSeek (V3, V4, R1), Kimi (K2, K3), and GLM-5 models alongside rebuilt OpenAI encodings, with optimized zero-allocation string passing from JavaScript.
- Added `nodeChainAt` native API to retrieve innermost-first tree-sitter node chains with grammar kinds and line spans for structural syntax analysis.

### Changed

- Improved shell builtins (`grep`, `rg`, `sed`, `cat`, `head`, `tail`, `jq`, `ls`, etc.) to stream output progressively with destination-aware line buffering for pipes, terminals, and live TUI output, while maintaining block buffering for file writes.
- Updated compound blocks (`{ ...; }`, `(...)`) and shell-function pipeline stages to run concurrently with other pipeline stages, preventing head-of-line blocking and pipe buffer deadlocks.

### Fixed

- Fixed the shell output minimizer dropping failure details from non-TTY `bun test` runs: the `(fail)` line, code frame, `error:` assertion, and stack trace are now kept instead of collapsing a failing run to bare pass/fail counts; unrecognized failing test formats now fall back to head/tail instead of counts-only output.

## [17.3.8] - 2026-08-19

### Changed

- `enclosingBlockBoundaries` and `blockRangeAt` now reuse a parsed tree-sitter tree when the same source and language were parsed before, and skip subtrees whose line span holds no visible line. Together these cut the block-context work the `read` tool performs on every non-raw read: for an 81KB TypeScript source with a mid-file window, 13.4ms to 4.45ms on a first parse and to 0.149ms once the tree is cached; for a 1.06MB source, 188.1ms to 55.8ms and to 0.440ms. The tree cache is bounded (12 entries, 4MiB of retained source) and verifies content byte-for-byte on every hit, so a hash collision can only cost a re-parse. The subtree skip is proven equivalent by differential comparison against the exhaustive walk across 4827 repository files and 38,616 window comparisons.

## [17.3.5] - 2026-08-16

### Fixed

- Fixed the native `xargs` builtin panicking in `-I`/`-i` replace mode when stdin is empty; it now exits successfully without running the command, matching GNU behavior.
- Fixed inline-code foreground color incorrectly carrying into plain text when a Markdown codespan ended exactly at a soft-wrap boundary.
- Fixed `wrapTextWithAnsi` leaving a trailing space plus a stray underline open/close pair on the line above a soft wrap when a style opened immediately after that space (e.g. `read this thread <underline>https://…`), a regression from the codespan color-bleed fix: only sequences that follow visible content now ride along with the current token, while sequences after whitespace still wait for the token they style.

## [17.3.4] - 2026-08-14

### Added

- Added the async `pdfToMarkdown` native API backed by `pdf-inspector`, with page numbering, page-count, OCR-needed-page, and encoding-issue metadata.

### Changed

- Docker images (`Dockerfile`, `scripts/install-tests/*.dockerfile`) build the native addon through the cargo/napi-rs backend (`OMP_NATIVE_BUILD_BACKEND=cargo`) instead of Bazel: a single fixed host target gains nothing from hermetic cross toolchains, and none of those images shipped bazelisk. `OMP_NATIVE_CARGO_PROFILE` picks the profile for that path (images use `ci`, local default stays `local`).

### Fixed

- Fixed the root Cargo workspace failing to load when a stale directory exists under `crates/` — e.g. a deleted crate whose directory survived `git reset --hard`. `members` no longer globs `crates/pi-*`, so a directory without a `Cargo.toml` can no longer break every cargo and Bazel build.
- Fixed Docker build contexts shipping nested build output: `.dockerignore` patterns are anchored at the context root, so bare `target/` and `dist/` matched neither `go-port/*/target` (~1.4 GB) nor `packages/*/dist` (~600 MB).
- Fixed `deviceCheckGenerateToken` aborting the whole process with `SIGTRAP` when called from a macOS session without GUI/graphic access (SSH, a launchd `LaunchDaemon`, a CI runner, a service account, a sandbox), which made every `openai-codex/*` OAuth model unusable for such accounts. `-[DCDevice isSupported]` synchronously opens an XPC connection to the per-user DeviceCheck metadata daemon, which exists only in an interactive GUI login session; without one the connection setup hits `_xpc_api_misuse` and traps before any completion handler runs, so the promise never rejects. The binding now checks the caller's security session for the `sessionHasGraphicAccess` attribute first and resolves `{ supported: false, error: … }` instead of touching DeviceCheck when it is absent ([#8353](https://github.com/can1357/oh-my-pi/issues/8353)).

## [17.3.1] - 2026-08-13

### Fixed

- Fixed `omp` failing to start on a clean Windows install with `Failed to load pi_natives native addon for win32-x64 ... The specified module could not be found` (LoadLibrary error 126). The shipped win32-x64 addon linked the dynamic MSVC CRT (`/MD`) and imported `VCRUNTIME140.dll` from the Visual C++ Redistributable, which is absent on a fresh Windows install. The addon now statically links the CRT (`+crt-static` for rustc plus the `static_link_msvcrt` cc feature for its C dependencies), so the `.node` imports only core Windows system DLLs ([#8439](https://github.com/can1357/oh-my-pi/issues/8439)).

## [17.3.0] - 2026-08-13

### Fixed

- Fixed an issue where shell-internal background jobs (such as `yes >/dev/null &`) could survive a one-shot shell session and consume CPU indefinitely after the command returned.

## [17.2.12] - 2026-08-08

### Changed

- Consolidated every shell builtin into one crate, `crates/pi-builtins` (the renamed and de-vendored `brush-builtins` fork), with one module per command. The 46 `crates/vendor/uu-*` crates, `crates/vendor/jaq`, `crates/pi-uu-grep`, `crates/pi-uu-diff`, and everything that had accumulated inline in `pi-shell` (`fd`, `cmp`, `which`, the moreutils set, and the `ps`/`top`/`pgrep`/`pkill`/`pidwait`/`kill`/`sleep`/`timeout`/`nohup` process builtins) now live beside the bash builtins they sit next to at runtime, and register through `pi_builtins::utility_builtins()` and `pi_builtins::process_builtins()`. `pi-shell/src/shell.rs` shrank by ~4,200 lines.

### Fixed

- Fixed `sort --compress-program` spawning its compressor and decompressor without the shell's working directory or exported environment, so a program installed only on the shell's `PATH` was not found, and with stderr inherited from the host process, where its diagnostics could corrupt the TUI. Both children now launch through the shell's child context and their stderr is forwarded to the command's own file descriptor.
- Fixed `realpath -q` exiting 0 after a failed operand; it suppresses the diagnostic but now reports failure, matching GNU.

### Removed

- Removed `crates/pi-uutils-ctx`. Utility builtins previously reached their stdio, working directory, and environment through a thread-local context installed around each invocation; they now receive an explicit `Host` value (`pi-builtins/src/host.rs`) carrying the command's file descriptors, the shell working directory, the exported environment, cancellation, and the accumulated exit status. The uutils entry-point plumbing (`uumain`, `UResult`/`UError`, `set_exit_code`, `crate_version!`) went with it; each utility is now an ordinary brush builtin implementing `host::Utility`.

## [17.2.11] - 2026-08-07

### Added

- Added support for Windows hosts in `bun run build`, enabling local N-API builds against VS Build Tools without requiring a pre-configured vcvars prompt.

### Changed

- Replaced the miniaudio (`maudio`) dependency with in-house platform audio backends for `AudioCapture`/`AudioPlayback`: CoreAudio AudioQueue on macOS, shared-mode WASAPI on Windows, and PulseAudio (ALSA fallback) loaded via `dlopen` on Linux. Removes the bindgen/libclang requirement and the Windows rustc-ICE workaround from the native build.

### Fixed

- Fixed CPU feature detection (AVX2) on Windows hosts, resolving an issue where the native addon loader and local builds incorrectly fell back to the baseline variant, while improving startup performance by ~270ms.
- Fixed `bun run build:bindings` failing on Windows due to incorrect resolution of the `@napi-rs/cli` entry point.
- Fixed a compiler crash (rustc ICE) when building the `maudio` package for Windows.
- Fixed synthesized macOS keyboard and pointer events suppressing physical user input.
- Fixed several Wayland input and capture issues, including preventing read-only calls from acquiring persistent input control, fixing GNOME Wayland pointer input initialization, and resolving conflicts between `libei` input and PipeWire screen capture.
- Fixed compilation of the `wayland-pipewire` Cargo feature.
- Improved security on Wayland by cleaning up orphaned world-readable RemoteDesktop restore tokens on startup.

## [17.2.10] - 2026-08-06

### Fixed

- Fixed per-window capture failing on Wayland with `InvalidTarget` errors for window IDs returned by `desktop.windows()`.
- Fixed `desktop.capabilities()` incorrectly reporting `capture: true` on Wayland builds compiled without the `wayland-pipewire` feature.

## [17.2.9] - 2026-08-05

### Changed

- Bounded fuzzy-find scored-match retention to the top-K results (worst-first heap) instead of collecting and fully sorting every hit; ranking and totals are unchanged ([#7415](https://github.com/can1357/oh-my-pi/issues/7415)).

### Fixed

- Fixed newer OMP versions deleting a freshly created older native addon cache directory during concurrent startup, which could interrupt extraction with `ENOENT`.

## [17.2.7] - 2026-08-03

### Added

- Added missing procps/BSD output format specifiers and aliases to the in-process `ps` shell builtin, including support for columns like `tpgid`, `pri`, `flags`, `wchan`, and various user/group/time fields.
- Updated `ps -j` to include the TPGID column, `ps -l` to display the single-character S column, and the STAT column to support the `+` foreground process group flag.

## [17.2.6] - 2026-08-03

### Added

- Added non-blocking, process-owned `FileLock` bindings using abstract Unix sockets on Linux, named mutexes on Windows, and persistent `flock(2)` sidecars on other Unix platforms.

## [17.2.5] - 2026-08-03

### Breaking Changes

- Replaced DesktopSession.execute(actions, window) and action batches with dedicated per-operation methods for capture, pointer, keyboard, window, and accessibility. Capture capabilities now apply per call, and coordinate input requires a prior frame for the same target.

### Added

- Added a cross-platform, in-process ps shell builtin supporting BSD/procps selection forms, custom output columns, sorting, process metrics, and header suppression.
- Added unified desktop backends for macOS, Win32, X11, and Wayland behind a single session API, featuring capture-free window discovery, isolated capture, explicit background/foreground delivery, native accessibility trees (AX/UIA/AT-SPI) with generational references, and structured errors for unsupported background input.

### Fixed

- Fixed accessibility snapshots incorrectly marking a window root as focused based on its app-local AXFocused attribute when another application held global focus; the root annotation now correctly reflects the global window-roster focus flag.
- Improved coordinate-frame error messages for pointer input before capture, out-of-frame coordinates, and between-display points to clearly explain the capture-frame contract and remedy instead of throwing a generic bounds check.
- Fixed duplicated characters in AppKit targets on macOS caused by background keyboard events being posted through both CoreGraphics and SkyLight; events are now delivered once via the authenticated SkyLight route.

## [17.2.2] - 2026-07-31

### Changed

- Updated native HTML-to-Markdown rendering to html-to-markdown-rs 3.9.2 defaults, which may result in formatting differences (such as fenced code blocks and cycling nested-list bullets) compared to version 2.30.0.

### Fixed

- Fixed a heap corruption crash when opening PulseAudio on Linux ARM64 by shipping target-specific miniaudio Rust layouts for GNU and musl native addons.
- Fixed local Bazel addon builds on NixOS by exposing system CMake tools to sandboxed build scripts and correctly bundling Opus.
- Fixed workspace native addon loading to correctly prefer the workspace build over an installed leaf package.
- Fixed process crashes caused by pathological HTML inputs; conversions that exceed the native-stack DOM depth limit now reject instead of returning silently truncated Markdown.

## [17.2.1] - 2026-07-30

### Fixed

- Fixed the `computer` tool advertising Wayland support that never worked: on the default rootless XWayland (GNOME/KDE/sway) the X11 root window has no readable pixmap, so root `GetImage` failed on every screenshot with a raw `BadMatch` protocol dump. `Monitor::all` now probes root drawability at initialization and fails fast with an actionable `DESKTOP_BACKEND_UNAVAILABLE` message naming the rootless-XWayland constraint, and `docs/computer-use.md` now lists rootless XWayland as unsupported ([#7085](https://github.com/can1357/oh-my-pi/issues/7085)).

## [17.2.0] - 2026-07-30

### Changed

- Split the native voice engine (miniaudio capture/playback, WebRTC peer, Opus media) out of the `pi-natives` addon crate into a napi-free `pi-voice` rlib. The addon keeps thin `#[napi]` adapters, so the JS API is unchanged; the webrtc/opus/miniaudio dependency graph now compiles once into the library and no longer rebuilds with the addon leaf (which recompiles every release via its version-sentinel edit).
- Release binaries now build in parallel with the test fan-out; npm leaf publishing moved to a dedicated post-validation job (`release_native_leaves`), and darwin release bazel caches are pre-warmed on native-affecting main pushes — cutting release wall time from the previous serialized tests → cold darwin build pipeline.

## [17.1.8] - 2026-07-28

### Fixed

- Fixed an issue on macOS (darwin) where the native addon delivered zero AudioCapture callbacks, which prevented microphone audio from being captured.

## [17.1.6] - 2026-07-27

### Changed

- CI now exports Bazel disk caches only after exact misses and reuses one native addon artifact across Linux test and release jobs. macOS release jobs now build only their own architecture.
- Native addons now build with Bazel (rules_rust + hermetic zig cc toolchains for linux-gnu/musl, host Xcode for darwin, and a hermetic clang-cl + xwin toolchain for windows-msvc) instead of the napi CLI + cargo-zigbuild/cargo-xwin pipeline. `bun run build` drives `scripts/bazel-natives.ts`; TypeScript binding regeneration moved to `bun run build:bindings` (needed only when the Rust API surface changes). CI caches through a content-addressed bazel-remote action cache instead of sccache + target-directory snapshots, cutting warm native rebuilds from ~20 minutes to seconds and cold cache-hit builds to ~2.5 minutes.

### Fixed

- napi binding build failures now surface the exit code and the tail of stdout/stderr instead of a bare "napi build failed" message ([#6799](https://github.com/can1357/oh-my-pi/pull/6799)).
- Silenced cross-platform Rust build warnings: dead-code on unix-only fields/helpers in `pi-uutils-ctx`, `pi-shell` (fd owner filters, coreutils argv), and vendored `uu-find`/`uu-stat` when compiling for Windows, and deprecated `libc::time_t` casts in `pi-iso` on musl. `pi-walker` now declares the `windows-sys` features it uses (`Win32_Foundation`, `Win32_Security`, `Win32_Storage_FileSystem`, `Win32_System_IO`) instead of relying on workspace-wide feature unification.

## [17.1.5] - 2026-07-27

### Fixed

- Fixed the native `sort` builtin panicking with `SendError(..)` at `chunks.rs:248` when the chunk-channel receiver disconnected early (e.g. a consumer thread stopping after an error or closed output); the reader now stops gracefully instead of unwrapping the failed send, and a panicking external-sort worker thread is surfaced as an error instead of silently emitting truncated output ([#6736](https://github.com/can1357/oh-my-pi/issues/6736)).

## [17.1.4] - 2026-07-26

### Added

- Added the `@oh-my-pi/pi-natives/desktop` factory entry, which defers native addon loading until a desktop worker initializes its session.

### Fixed

- Fixed Linux native audio over forwarded PulseAudio servers: capture now handles 125 ms Android fragments without stalling, and playback buffers enough audio to avoid TCP underruns and stuttering ([#6628](https://github.com/can1357/oh-my-pi/pull/6628) by [@anatoli-tsinovoy](https://github.com/anatoli-tsinovoy)).
- Fixed older running OMP versions deleting newer native addon cache directories during cleanup, which could race a new version's first-run extraction and crash with `ENOENT`.
- Fixed macOS computer screenshots occasionally returning the pre-action frame instead of reflecting completed keyboard and pointer input ([#6595](https://github.com/can1357/oh-my-pi/pull/6595) by [@wolfiesch](https://github.com/wolfiesch)).

## [17.1.3] - 2026-07-24

### Changed

- `astEdit` without an explicit `lang` now rewrites mixed-language paths per file (each file parsed in its own inferred language, patterns compiled per language) instead of erroring when the path/glob spans multiple languages. A pattern that parses in no discovered language is still reported (or fails the call under `failOnParseError`); files whose language cannot be inferred surface as per-file parse errors instead of aborting the whole call.

## [17.1.2] - 2026-07-24

### Fixed

- Fixed native addon builds with CMake 4.x (bundled opus policy floor) and stopped passing `-C target-cpu=native` on darwin arm64, which baked build-host CPU features into shipped addons and broke `ring` compilation.

## [17.1.1] - 2026-07-24

### Added

- Added native `AudioCapture`, `AudioPlayback`, and `LiveWebRtcPeer` classes for low-latency microphone capture, gapless speaker playback, and WebRTC offer/answer sessions with Opus media and `oai-events` data-channel delivery.
- Added a macOS `deviceCheckGenerateToken` export that generates Apple DeviceCheck attestation tokens natively: it drives `DCDevice.generateToken` through raw Objective-C runtime FFI with a hand-built completion block literal and a bounded one-second wait, resolving `{ supported, tokenBase64, error, latencyMs }` to mirror the ChatGPT desktop app's `devicecheck.node` addon contract. Non-macOS builds resolve `supported: false` without touching the network.
- Added a genuine native desktop backend for computer use, bundled in the core addon on every published platform: macOS Quartz/CGEvent, Windows Win32/`SendInput`, and a pure-Rust Linux X11 backend (`x11rb` capture over the display socket, XTest input with keysym mapping) that links no GUI system libraries — so Linux x64/arm64, glibc and musl are all supported and headless hosts are unaffected. Wayland sessions work through XWayland. Execute batches enforce a 60-second native deadline (`DESKTOP_DEADLINE_EXCEEDED`) and never emit input after it expires; unsupported pure-Wayland capture and out-of-XTest-range or negative-origin coordinate layouts fail closed.

### Fixed

- Fixed macOS computer screenshots taking roughly 30 seconds under Bun by replacing xcap's deprecated window-list capture with a bounded system capture path; direct screenshots now complete in under half a second on the verified host.

## [17.0.8] - 2026-07-22

### Added

- Added jsdiff-compatible native diff exports: `diffLines`, `diffWords`, `diffLineRuns`, and `structuredPatchHunks`.
- Added batch vector kernels for mnemopi recall paths: `cosineSimilarityPairs`, `vectorIndexTopK`, and `mmrRerankIndices`.

### Changed

- Updated diff functions (`diffLines`, `diffWords`, `diffLineRuns`, `structuredPatchHunks`) to process UTF-16 code units natively end to end via `Utf16String`, supporting ill-formed JS strings with unpaired surrogates without throwing or converting to UTF-8.

### Fixed

- Fixed a critical issue where the in-process `rm` builtin treated an empty path operand as the current working directory, causing `rm -rf ""` to recursively delete the current directory. Empty operands are now rejected, matching GNU `rm` behavior.

### Removed

- Removed unused `similar` crate dependency and dev-dependency on npm `diff`.

## [17.0.5] - 2026-07-18

### Added

- Added optional PTY start callbacks that report the spawned child PID before command completion.

## [17.0.3] - 2026-07-17

### Fixed

- Fixed `~` (tilde) not expanding for every element of a brace expansion in the bash tool, so `mkdir -p ~/project/{a,b}` now creates both `a` and `b` under `$HOME/project` instead of leaving a literal `~/project/b` in the working directory ([#5819](https://github.com/can1357/oh-my-pi/issues/5819)).
- Fixed ANSI text wrapping to close and restore OSC 8 hyperlinks at physical line boundaries, preventing link targets from leaking into appended content ([#5885](https://github.com/can1357/oh-my-pi/issues/5885)).

## [17.0.2] - 2026-07-17

### Fixed

- Fixed an issue where running `uv run --extra <package> pytest` bypassed native pytest minimization due to a wrapper parsing error.
- Fixed a bug where timed-out shell pipelines dropped captured output and could cause Windows hosts to terminate during teardown. (#5316)

## [17.0.1] - 2026-07-16

### Fixed

- Fixed the pi-natives version sentinel emitting "reinstall to re-sync" when a long-lived process survives an in-place upgrade: the loader now detects that the resident addon exposes a _prior_ release's sentinel and reports "omp was upgraded while this session was running — restart to pick up the new version (disk is already consistent)" instead of misdiagnosing it as a stale on-disk file ([#4812](https://github.com/can1357/oh-my-pi/issues/4812)).

## [17.0.0] - 2026-07-15

### Fixed

- Fixed the in-process grep builtin to correctly handle escaped alternation (\|) in default and -G (GNU basic-regex) searches, while preserving the correct regex dialects for -E, -F, and -P.

## [16.5.2] - 2026-07-14

### Fixed

- Fixed an issue where Windows PTY callers were forced through shell command re-quoting by supporting direct executable and argument launching.

## [16.4.6] - 2026-07-12

### Added

- Added an in-process `readlink` shell builtin (vendored from uutils coreutils 0.8.0), supporting `-f`/`-e`/`-m` canonicalization, `-n`/`-z` delimiters, and `-v`/`-q`/`-s` verbosity, with path operands resolved against the shell working directory.
- Added in-process shell builtins for `realpath`, `touch`, `stat`, `date`, `mktemp`, `seq`, `yes`, `printenv`, `ln`, `truncate`, `tac`, `nproc`, `uname`, `whoami`, and `hostname` (vendored from uutils coreutils 0.8.0), plus native `which` (shell PATH lookup) and `diff` (unified output, `-U`/`-q`/`-N`, binary detection, recursive directory compare) builtins. All resolve path operands against the shell working directory, read the shell's exported environment, and honor abort/timeout cancellation; `ln` is gated with the destructive set (`PI_DISABLE_UUTILS_DESTRUCTIVE`), and system-mutating modes (`date --set`, hostname setting) are disabled.

### Fixed

- Fixed `ast_edit` rejecting byte-identical duplicate replacements as "Overlapping replacements detected": multiple rewrite ops matching the same node with the same output now collapse into one deterministic edit (deduped in both the preview listing/counts and the apply pass), so only genuinely divergent overlaps error.

## [16.4.5] - 2026-07-11

### Added

- Added context-safe, in-process shell builtins for common utilities including base64, basename, dirname, cut, tee, tr, paste, comm, sed, xargs, jq, and the md5sum/sha/b2sum checksum family. These builtins run without spawning external binaries, support pipelines, respect shell-relative paths and environment variables, and honor abort/timeout cancellation.

## [16.4.4] - 2026-07-11

### Fixed

- Fixed fuzzyFind tie-breaking logic to prefer shallower paths first, preventing deeply nested matches from ranking above shallow ones on score ties.
- Fixed macOS installation issues for pi-natives by statically linking PCRE2, removing the runtime dependency on Homebrew's dynamic libpcre2-8.0.dylib library.

## [16.4.3] - 2026-07-11

### Fixed

- Optimized non-recursive glob patterns (e.g., `dir/*.json`) to prevent traversing entire subtrees, significantly improving performance and preventing timeouts when searching large directories.
- Fixed native filesystem searches (`glob`, `grep`, and AST search/edit) incorrectly excluding explicitly rooted directories due to ancestor ignore rules.

## [16.3.13] - 2026-07-09

### Fixed

- Fixed unbounded memory growth in the native bash output bridge when a command produces output faster than the JS event loop consumes it: the shell streaming path now uses a bounded chunk queue with real backpressure (pipe readers park until the JS callback catches up, parking the child on its pipe) instead of buffering the entire surplus in memory. No output is dropped — the rolling tail view, `[raw output: artifact://…]` lossless capture, and byte accounting are unaffected ([#4078](https://github.com/can1357/oh-my-pi/issues/4078)).
- Fixed `readImageFromClipboard` on Windows failing with "could not be converted to the appropriate format" for screenshots taken by Qt-based tools such as PixPin and Snipaste. arboard hands their `CF_DIBV5` payload (`BI_RGB` plus an alpha mask, rewritten to `BI_BITFIELDS`) to a header-less BMP decode that mis-places the pixel offset for V4/V5 bitfield headers; the native reader now falls back to decoding the raw `CF_DIB` clipboard bytes directly, so image paste no longer depends on the PowerShell bridge. ([#3426](https://github.com/can1357/oh-my-pi/issues/3426))
- Fixed OMP being killed outright (OOM on memory-capped hosts such as WSL) when an output-heavy bash command hit its timeout: the unbounded output-bridge backlog could grow by gigabytes before cancellation and starve the JS event loop far past the deadline; with the bounded backpressured bridge the run resolves at its deadline with flat memory ([#4866](https://github.com/can1357/oh-my-pi/issues/4866)).

## [16.3.12] - 2026-07-08

### Fixed

- Fixed the native build script failing to locate the `@napi-rs/cli` `napi` binary on Windows because the `PATH` lookup joined entries with a Unix `:` separator instead of the platform delimiter (`path.delimiter`).
- Fixed a Windows regression where an abnormal `omp` exit or bash cancellation could `TerminateProcess` unrelated `pwsh.exe` / `powershell.exe` sessions (including other Cursor terminal tabs). `SpawnRegistry` stored only the raw pid of each brush-spawned child and re-opened it via `Process::from_pid` at cancellation time; between those two moments Windows could recycle a freed pid onto an unrelated PowerShell, and `signal_tree` then walked the wrong subtree via Toolhelp. The observer now pins a stable `Process` handle at spawn time — on Windows the open handle keeps the pid slot reserved, on Linux the pidfd carries identity, on macOS the `(pid, start_time)` triple detects impersonation — so cancellation can only reach children this run actually launched. The registry sweeps exited entries once the recorded set crosses a small threshold so a long bash loop of short external commands cannot pin one owned OS handle per historical spawn. ([#4605](https://github.com/can1357/oh-my-pi/issues/4605))

## [16.3.6] - 2026-07-04

### Changed

- Rewrote native `grep` directory search to stream while the tree is walked: a work-stealing parallel traversal feeds searchers directly, and content-mode match budgets now terminate the walk itself instead of only the search. Limited searches keep deterministic path-ordered first pages at every budget size via windowed commits, with oversized files still deferred behind normal-sized results.
- Faster filesystem walker: gitignore/ignore state is now derived from each directory's own listing instead of up to five per-directory stat probes, per-entry allocations were eliminated through pooled directory scratch buffers and reusable path builders, and a new parallel unordered file-candidate walk API backs full-scan grep.
- Concurrent `grep` calls are no longer serialized against each other, searchers are reused per worker instead of rebuilt per file, and non-multiline patterns opt into grep-regex's line-terminator fast path with a compatibility fallback.

## [16.3.0] - 2026-07-02

### Added

- Added `workingDir` to `ShellRunResult` to allow hosts to synchronize the session's current working directory without executing a hidden probe command.

### Fixed

- Fixed an issue where panics in native worker tasks (such as grep, AST parsing, globbing, workspace listing, HTML-to-markdown conversion, fuzzy finding, and clipboard image reading) would abort the host process instead of properly rejecting the returned JavaScript Promise.
- Fixed a crash on Windows under low memory or commit charge conditions when spawning worker threads for token counting or sorting operations.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed high memory usage in native `astGrep` and `astMatch` by retaining only the requested page window of match payloads during broad searches while preserving exact totals.

## [16.2.10] - 2026-06-30

### Added

- Added a platform-native no-ignore filesystem traversal path for `glob`/`grep` scans, using `getattrlistbulk` on macOS, `getdents64`/`statx` on Linux, and `NtQueryDirectoryFile` with `FileIdFullDirectoryInformation` on Windows while preserving the existing `WalkBuilder` path for gitignore-aware scans.

## [16.2.7] - 2026-06-30

### Added

- Added embedded Silver TrueType font rendering support to `renderSnapcompactPng`, featuring automatic per-glyph fallback for missing bitmap characters and anti-aliased scaling for East Asian wide code points.
- Added the `snapcompactSupportedChars` function to check font capability for specific characters.

## [16.2.5] - 2026-06-28

### Fixed

- Fixed the in-process `grep` builtin rejecting GNU-grep's `--color`/`--colour` (with or without `=WHEN`) and `--version` flags. The shadowing rejection broke bash's near-universal `alias grep='grep --color=auto'`, causing bare `grep` in any pipeline to fail with exit 2. The builtin now accepts and ignores `--color[=WHEN]` (its output goes through in-process file descriptors, never a TTY, so ANSI injection would corrupt downstream consumers) and reports its version through the context streams ([#3755](https://github.com/can1357/oh-my-pi/issues/3755)).

## [16.2.4] - 2026-06-28

### Fixed

- Fixed a crash in the in-process `tail` builtin where the host process would abort with a `BrokenPipe` panic if the stdout consumer closed the pipe early.

## [16.1.23] - 2026-06-26

### Added

- Added Nix and Mermaid syntax highlighting support to `highlightCode`/`supportsLanguage` via vendored `Nix.sublime-syntax` and `Mermaid.sublime-syntax` definitions plus `nix`, `mermaid`, and `mmd` aliases.
- Added in-process [uutils](https://github.com/uutils/coreutils)-backed shell builtins to the embedded brush `Shell`: `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `ls`, `find`, `grep`, `mkdir`, `rm`, and `mv`. These vendored + patched utilities run inside the shell process (no `fork`/`exec`), resolve path operands against the shell working directory, route stdio through the command's (possibly piped/redirected) file descriptors, read the shell's exported environment, and honor abort/timeout cancellation (a blocked `stdin` read unwinds cleanly). `grep` is built on the ripgrep `grep-*` crates and `find` on `uutils/findutils`; the rest are pinned to `uutils/coreutils` 0.8.0 (matching the bundled `uucore`). Registration is gated: set `PI_DISABLE_UUTILS_BUILTINS` to fall back to the system binaries for the whole set, or `PI_DISABLE_UUTILS_DESTRUCTIVE` / `PI_DISABLE_RM_BUILTIN` / `PI_DISABLE_MV_BUILTIN` to disable only the destructive `rm`/`mv` shadows.

## [16.1.17] - 2026-06-24

### Added

- Added `setHangulCompatJamoWidthOverride(value)` to override the Hangul Compatibility Jamo (U+3131..U+318E) display width at runtime via a process-global atomic, instead of relying solely on the compile-time `cfg!(target_os = "macos")` heuristic. The actual width is decided by the client terminal (not the host OS), so the TUI resolves it from the terminal identity and pushes the result here. Encoding: `0` = platform default (macOS narrow, otherwise UAX#11), `1` = narrow (1 cell), `2` = wide (2 cells), `3` = Unicode width (no correction). The leaf width helpers read this override, so no width/slice/truncate/wrap signatures change.

## [16.1.15] - 2026-06-22

### Added

- Added `Shell.liveBackgroundJobCount()` reporting the number of live external background jobs (`&`/`nohup` children) on a persistent session, reaping completed jobs first via a silent `poll()`. Lets the host retain a shell whose background process is still running instead of dropping it (which would SIGKILL the child via kill-on-drop).

### Fixed

- Fixed `pi_natives` failing to load in Bun worker threads on macOS x64 when the host built only the `modern` (AVX2) variant. The runtime detector's `child_process.spawnSync("sysctl", …)` returned null from the worker even though the build-time detector succeeded in the parent, so `loadNative()` resolved `variant=baseline` and searched a file list that excluded the on-disk `pi_natives.darwin-x64-modern.node`. Resolution now prefers `Bun.spawnSync`, tries `/usr/sbin/sysctl` before bare `sysctl`, and caches the first context's verdict via a private env key so child workers and subprocesses inherit it instead of re-detecting ([#3238](https://github.com/can1357/oh-my-pi/issues/3238)).

## [16.1.14] - 2026-06-22

### Fixed

- Enabled full Julia syntax highlighting support in highlightCode

## [16.1.12] - 2026-06-21

### Added

- Added Julia syntax highlighting to `highlightCode`/`supportsLanguage` via a vendored `Julia.sublime-syntax` folded into syntect's default set (`jl`/`julia` aliases); syntect ships no Julia grammar.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Changed renderSnapcompactPng to return a promise instead of a string value

### Fixed

- Fixed directory `grep` continuing to walk large trees after the requested content match budget had already been satisfied, which could make broad coding-agent searches time out before returning the first page of matches ([#2738](https://github.com/can1357/oh-my-pi/issues/2738)).

## [16.0.11] - 2026-06-19

### Fixed

- Fixed native shell execution reporting `pi-natives:command: syntax error at end of input` for a valid `&&`/`;` chain whose later pipeline stage is a compound command, e.g. `echo x && git log | while read h; do …; done | head`. The output minimizer's segmented-chain runner rebuilds each chain segment from the brush-parser AST via `pipeline.to_string()` and re-executes that string, but `simple_segment` only validated the _first_ pipeline stage — so a compound later stage (`while`/`for`/`if`/subshell) was re-serialized without its terminator (`Display` drops it) and re-run as broken shell. `simple_segment` now requires every stage to be a `Display`-safe simple command, and — closing the recurring class of brush `Display` round-trip divergences (here-doc close-tag quoting, multi-byte char/byte offsets) at its root — each reconstructed segment is re-parsed and must match the original pipeline shape before the chain runner executes it; any divergence runs the command whole via the unsegmented path instead of corrupting it.

## [16.0.7] - 2026-06-18

### Added

- Added Fortran support to the AST tooling, including file/alias resolution.

## [16.0.6] - 2026-06-18

### Removed

- Removed the `cache` option from `GrepOptions`

## [16.0.4] - 2026-06-17

### Fixed

- Fixed `summarizeCode` BFS unfold aborting the entire pass when it hit an oversized, un-unfoldable leaf span (e.g. an HTML `<style>` raw-text block, an embedded blob, or a minified line) whose only unfold candidate is its whole body. The overflow check used to `break` the breadth-first loop, so any large leaf encountered before its siblings starved the rest of the tree — an HTML page summarized to `<style> ... </style>` plus `<div class="page"> ... </div>`, collapsing the document body into one dead `...`. An overflowing span is now skipped (left folded, its subtree unexplored) and the BFS keeps unfolding the remaining queued siblings, so structured siblings like the `<body>` DOM are revealed up to `unfoldLimit` while the oversized leaf stays folded.

## [16.0.2] - 2026-06-16

### Added

- Added Emacs Lisp (`.el`, `.emacs`, `emacs-lisp`/`elisp`) support to native tree-sitter language inference, enabling astGrep/astEdit, summarizeCode, and blockRangeAt on Emacs Lisp source.

## [16.0.1] - 2026-06-15

### Fixed

- Fixed shipped Linux native addons failing to load with `version 'GLIBC_2.39' not found` on distributions older than Ubuntu 24.04. After native builds moved onto the Ubuntu 24.04 (glibc 2.39) self-hosted runner, the x64 addon was a plain host build that linked the runner's glibc and the arm64 cross-build floated up to GLIBC_2.30; the `linux-x64` (baseline + modern) and `linux-arm64` addons are now built through `cargo-zigbuild` against a pinned glibc 2.17 floor, restoring portability to any glibc ≥ 2.17 (CentOS 7 / Ubuntu 14.04 era).
- Fixed Linux native builds hard-failing when `RUSTC_WRAPPER=sccache` points at an unavailable shared cache backend. The native build script now retries the `napi` build once without the sccache wrapper after a cache-storage startup failure, so install smoke tests and local fallback builds can proceed while preserving the cached fast path when the backend is healthy.
- Fixed shell cancellation cleanup failing to reap child processes inside containers whose guest kernel was built without `CONFIG_PROC_CHILDREN` (e.g. some Kata/microVM guests): the Linux descendant walk relied solely on `/proc/<pid>/task/<tid>/children`, which does not exist there, so `children()` / `live_descendants()` returned empty and termination waves never reached the children. It now falls back to scanning `/proc` and grouping by parent pid (the primitive the macOS path already uses) when no `children` file is readable, keeping the cheap per-task fast path on kernels that support it.

## [15.13.1] - 2026-06-15

### Fixed

- Fixed `pi-natives` deadlocking at addon load (`dlopen` hang) on some Linux hosts. The load-time Tokio runtime install added in 15.12.6 ran inside `#[module_init]`, which executes while the dynamic-loader lock is held; building the multi-thread runtime there eagerly spawns worker threads, and a fresh worker blocking to acquire the loader lock the init thread still owns deadlocks the whole load (every native consumer hangs at startup). The runtime is now built from an exported `__ompInstallTokioRuntime` that the JS loader calls once, immediately after `dlopen` returns and before any async native runs; `#[module_init]` only installs the crash handler. napi-rs materializes its runtime lazily on first async use (`RT` is a `LazyLock`) and `create_custom_tokio_runtime` only records the runtime, so the post-load install is still adopted — preserving the Windows commit-limit thread probing/back-off from 15.12.6 without spawning under the loader lock.
- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `delete block` / `insert after block` ops) returning no block for a construct whose opening line follows a blank line — most visibly in Swift, where `replace block` on a SwiftUI `var body: some View {` (or any statement/declaration after a blank line) failed with "could not resolve a syntactic block… (unsupported language, blank/closer line, or parse error)". tree-sitter-swift inserts a zero-width separator node at the start of a statement that follows a blank line; the resolver queried the first content column with a zero-width point range, which `ts_node_named_descendant_for_point_range` absorbs into that invisible node and bubbles back up to the enclosing body (or the file root), so no block was found. The query now spans the first content character (a one-column-wide range) so it skips zero-width nodes and descends into the node that actually begins on the line.
- Fixed native shell execution reporting `unterminated here document sequence` for a multi-command line that contains a here-doc with a quoted or escaped delimiter (`<<'TAG'`, `<<"TAG"`, `<<\TAG`) followed by another command (e.g. a `sqlite3 … <<'SQL' … SQL` query followed by an `echo`/second command). The output minimizer's segmented-chain runner rebuilds each `&&`/`;`/newline segment from the brush-parser AST via `pipeline.to_string()`, and that `Display` impl re-emits a quoted/escaped here-doc's _closing_ delimiter with its quotes intact (`'SQL'` instead of the required bare `SQL`) — an invalid close tag that the re-run segment never matches. Here-doc-bearing pipelines are now ineligible for segmentation, so the command runs whole via the unsegmented path (where the executor parses it correctly); a lone here-doc was unaffected because it was never segmented.
- Fixed native addon loading leaving stale `~/.omp/natives/<version>` cache directories behind after updates; successful loads now remove older version directories best-effort.
- Fixed Linux source-built native addons hanging during package import by keeping the Windows-only Tokio worker probe out of non-Windows module initialization ([#2553](https://github.com/can1357/oh-my-pi/issues/2553)).
- Fixed `pi-iso` Windows clippy failures in symlink placeholder metadata, block-clone path resolution, and readonly cleanup handling ([#2379](https://github.com/can1357/oh-my-pi/pull/2379) by [@oldschoola](https://github.com/oldschoola)).

## [15.12.6] - 2026-06-14

### Fixed

- Fixed `pi-natives` aborting the whole process at addon load on memory-constrained Windows hosts (`OS can't spawn worker thread`, typically OS error 1455 — pagefile/commit limit). napi-rs builds its own Tokio runtime with one eagerly-spawned worker per CPU, and that spawn _panics_ rather than erroring, so under `panic = "abort"` the failure was uncatchable. The addon now installs its own runtime at load: it probes how many threads the OS will actually grant (starting from the Tokio default, clamped to a small ceiling since CPU-heavy native work runs on libuv/Rayon and Tokio's separate blocking pool, not the scheduler workers), sizes the multi-thread runtime to the probed count, and falls back to a current-thread runtime if not even one worker can be spawned — no panic on any path.

## [15.12.4] - 2026-06-13

### Fixed

- Fixed native shell execution rejecting quoted heredocs whose closing delimiter is the final line without a trailing newline, matching bash paste-run snippets.

## [15.11.7] - 2026-06-12

### Added

- Added the X.org misc `6x12` and `8x13` BDF fonts (public domain, vendored in `crates/pi-natives/src/fonts/`) to `renderSnapcompactPng`, alongside two new options for the snapcompact eval-winner shapes: `stretch: false` renders glyphs at natural size on the requested cell box while keeping the 4-bit indexed encoder (e.g. 8x13 glyphs on an 8x16 pitch, the "8on16" shapes), and `columns: 2` flows pre-wrapped newline-separated lines down two newspaper columns with a 3-cell gutter (the "doc" shapes); in doc mode sentence hues also advance across a terminator followed by a newline
- Added a line-break marker to `renderSnapcompactPng`: `U+2588` (FULL BLOCK) fills its entire cell box with pitch-black ink in both grid and doc layouts, ignoring the sentence hue and dim state, and counts as a sentence boundary after a `.`/`!`/`?` terminator

### Changed

- `renderSnapcompactPng` now clips the frame height to the text: the PNG stays `size` pixels wide but is only `usedRows * lineRepeat * cellHeight` tall (dim toggles are zero-width; doc layout counts `\n`-separated lines), so a partially filled frame no longer pads to a full square of blank rows
- `renderSnapcompactPng` indexed frames now narrow the palette to the colors actually printed and pick the matching bit depth (plain `bw` 1-bit, dim/banded 2-bit, sentence hues up to 4-bit), and both encode paths moved from `Balanced` to `High` deflate: `8on16-bw` frames shrink ~35%, `6x12-dim` ~10%, sentence-hue doc frames ~9% — pure PNG, no decoder-side changes (lossless WebP was measured at only ~8% beyond this and rejected for provider-compatibility risk)

## [15.11.4] - 2026-06-12

### Fixed

- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `insert after block` ops) failing on extensionless shell rc/profile files. `Path::extension` returns `None` for both bare (`zshrc`) and dotfile (`.zshrc`, `.bashrc`) forms, so language inference fell through to "unrecognized" and block resolution was permanently unresolvable on those files — an agent retrying the block op would loop on the same error. Known shell rc/profile basenames (`zshrc`/`zshenv`/`zprofile`/`zlogin`/`zlogout`/`bashrc`/`bash_profile`/`bash_login`/`bash_logout`/`bash_aliases`/`profile`/`kshrc`/`mkshrc`/`shrc`, with or without a leading dot) now resolve to the bash grammar.

## [15.11.0] - 2026-06-10

### Breaking Changes

- Changed `renderSnapcompactPng(text, options)` to return a base64-encoded PNG `string` instead of a `Uint8Array`

### Added

- Added dim-span ink toggles to `renderSnapcompactPng`: `U+000E`/`U+000F` in the input switch to a dim gray ink (palette index 9) and back without occupying a glyph cell, letting callers visually de-emphasize spans such as archived tool output
- Added `renderSnapcompactPng(text, options)`: rasterizes pre-normalized text onto a square PNG in an eval-validated snapcompact shape. Options select the bundled font (`5x8` X.org BDF or `8x8` unscii-8, both public domain, shipped in `crates/pi-natives/src/fonts/`), the ink variant (`sent` six-hue sentence cycling or `bw` black), line repetition (each text line printed N times, copies on a pale highlight band), and a target cell size — cells differing from the font's natural cell render via Lanczos3 stretch into an anti-aliased RGB frame (e.g. the OpenAI-optimal 6x6 unscii shape); native-cell shapes encode as 4-bit indexed PNG. Replaces the JS rasterizer/PNG writer previously in `@oh-my-pi/pi-agent-core`.

## [15.10.12] - 2026-06-10

### Added

- Added deterministic shell-output minimization to the native shell pipeline, including opt-in per-command rewrite telemetry surfaced through `executeShell().minimized` for callers that want compact inline output plus a separately persisted original capture.

### Fixed

- Fixed native crash-log directory resolution diverging from the JS logger when `PI_CONFIG_DIR` is absolute: the config root now mirrors `path.join(homedir, PI_CONFIG_DIR)` semantics (absolute values re-rooted under `$HOME`, `.`/`..` components normalized), and an empty `PI_CODING_AGENT_DIR` no longer disables XDG state-dir resolution.
- Fixed shell-output minimization condensing `pyright`/`basedpyright` `--outputjson` runs into a diagnostics summary; machine-readable JSON output now passes through untouched.
- Fixed `pi-natives` aborting Bun on Windows with `memory allocation of N bytes failed` and no backtrace whenever the native cdylib hit a Rust panic or out-of-memory condition. The release profile uses `panic = "abort"`, so neither default handler emitted any context — Bun received only the bare message and tore down the TUI session before flushing. Module load now installs `std::panic::set_hook` and `std::alloc::set_alloc_error_hook` via `#[napi::module_init]`; both hooks capture `Backtrace::force_capture()` (so it works without `RUST_BACKTRACE=1`) and write a structured report — pid, thread, size/alignment for OOM, source location and message for panics, full backtrace — to the same logs directory the JS logger uses (`$XDG_STATE_HOME/omp/logs/` on Linux/macOS when the user has migrated to XDG and `PI_CODING_AGENT_DIR` isn't customized, otherwise `~/.omp/logs/`) and to stderr before the host process exits. The OOM hook prints the canonical allocation-failure line before any allocation-prone diagnostics and aborts immediately on re-entry, so real process-wide OOM still surfaces the fallback message instead of recursing in the report path ([#2211](https://github.com/can1357/oh-my-pi/issues/2211)).

## [15.10.11] - 2026-06-10

### Added

- Added a `maxCountPerFile` option to `grep` that caps how many matches a single file may contribute, so one hot file can no longer exhaust the global `maxCount` budget in path order and starve every file sorted after it out of the result set entirely.
- Added `PI_DEBUG_STARTUP` streaming markers to the addon loader (`native:loadNative:start`, `native:extractEmbeddedAddon:start`, `native:require:<file>`, `native:loadNative:done`), written with synchronous stderr writes so a hang inside first-run extraction or `dlopen()` — which blocks the event loop and defeats any timer-based diagnostics — still leaves the failing step as the last marker on stderr.
- Added a `skippedOversized` count to `GrepResult`: directory walks now report how many files were silently skipped for exceeding the 4MB per-file grep limit (previously they vanished without a trace, letting callers conclude a symbol does not exist).

### Changed

- Parallelized the mtime-ranked `glob()` walk (the path OMP `find` always takes): per-thread bounded top-N heaps replace the single-threaded full-stat traversal, so large trees rank in a fraction of the wall clock while keeping the deterministic mtime-desc/path ordering and bounded memory.

### Fixed

- Fixed cross-line grep being a silent no-op on real files: `multiline` set the `(?m)` flag on the regex matcher but never enabled `multi_line` on the `Searcher`, which stayed line-oriented, so any pattern spanning a `\n` returned zero matches with no error.

## [15.10.5] - 2026-06-08

### Added

- Added the `enclosingBlockBoundaries` native API (with `EnclosingBoundaryOptions` and `LineRange` types) that returns, for a set of visible line ranges, the off-window boundary lines of every multi-line tree-sitter node whose span crosses the window — the closer when an opener is shown and the opener when a closer is shown. Covers brace and indentation languages (Python) via real syntactic spans; returns `null` for unrecognized languages or sources with syntax errors so callers can fall back to a lexical scan.
- Added a `nohup` shell builtin to the embedded `pi_shell`, shadowing the external `/usr/bin/nohup`. It runs its operand command and propagates that command's exit status (and reports `missing operand` / exit 125 with no operand), but deliberately does **not** mask `SIGHUP` or detach the child into a new session the way real `nohup` does. Agents reach for `nohup … &` assuming the shell is one-shot; in this persistent embedded shell that assumption is wrong and the only effect of real `nohup` was to leak background processes that outlived the host. The builtin keeps such commands as ordinary descendants so they are reaped with the host instead of surviving as orphans.

## [15.10.2] - 2026-06-08

### Added

- Added the `super` modifier to `matchesKey` / `parseKey` / `parseKittySequence`. Key identifiers may now include `super+` (anywhere in the modifier prefix), and Kitty CSI-u sequences whose modifier mask contains the super bit (8) — e.g. Ghostty's macOS Option+Backspace `ESC [127;11u` — are now recognised instead of dropped ([#2064](https://github.com/can1357/oh-my-pi/issues/2064)).

### Fixed

- Fixed the native `copyToClipboard` leaving the X11 clipboard empty on Linux even while the process kept running. arboard answers clipboard `SelectionRequest`s from a background thread that lives only as long as a `Clipboard` instance exists, and the binding dropped its transient `Clipboard` immediately after `set_text` — tearing that thread down so the selection lost its owner and the clipboard read back empty (matching the `returned ok but clipboard=''` symptom). The Linux path now holds a single `Clipboard` for the lifetime of the process so the owner thread keeps serving, with no `xclip`/`wl-copy` subprocess; macOS/Windows keep the transient write on the calling thread ([#2075](https://github.com/can1357/oh-my-pi/issues/2075)).

## [15.10.1] - 2026-06-07

### Fixed

- Fixed `applyBashFixups` corrupting commands that contain multi-byte UTF-8 before a trailing `| head`/`| tail` (or `2>&1`). `brush-parser` reports source positions as Unicode-scalar (char) offsets, but `pi_shell::fixup` sliced the command `&str` by those numbers as if they were byte offsets, so each multi-byte char (e.g. `✓`/`×` in a `grep -E` pattern) shifted the cut earlier and left a mangled command — e.g. `… |✓|×|XCTAssert" | tail -80` became `… |✓|×-80`, orphaning the closing quote and making the shell reject the whole pipeline with `unterminated double quote`. Positions are now translated to byte offsets before slicing.

## [15.9.0] - 2026-06-04

### Fixed

- Bounded sorted `glob()` scans to `maxResults` during uncached traversal and emitted `onMatch` callbacks only for entries admitted to the bounded top-`maxResults` heap so broad OMP `find` progress and timeout partials stay consistent with the returned mtime-ranked set while keeping parent-process memory bounded ([#1761](https://github.com/can1357/oh-my-pi/issues/1761)).
- Fixed `wrapTextWithAnsi` hanging (infinite loop) on text containing a BEL-terminated string escape — DCS/SOS/PM/APC (`ESC P`/`ESC X`/`ESC ^`/`ESC _`) closed by `BEL` instead of `ST`. `ansi_seq_len_u16` only accepted the `ST` (`ESC \`) terminator for these (OSC already accepted both), so a BEL-terminated APC such as the TUI cursor marker (`ESC _ pi:c BEL`) was left unclassified: it was miscounted as visible width and `break_long_word`'s non-ESC scan could not advance past the `ESC`, spinning forever. The terminator set now matches OSC (ST **or** BEL), and `break_long_word` defensively emits and steps over any escape it cannot classify so a malformed/unknown sequence can never wedge the wrap loop.

## [15.7.0] - 2026-05-31

### Added

- Added `blockRangeAt` native API along with `BlockRange` and `BlockRangeOptions` types to return the 1-indexed line span of the outermost tree-sitter node beginning on a given line

### Fixed

- Fixed an interactive shell inside a **pipeline** (`zsh -i ... | awk`, `time zsh -i | cat`, etc.) suspending the embedded host with `suspended (tty input)`. The earlier embedded-host fix `setsid`-detached external children so they could not seize the host's controlling tty, but carved pipeline stages out because a later stage that `setpgid`-joined a detached leader failed with EPERM — leaving every pipeline stage in the host session, where an interactive child opened `/dev/tty`, `tcsetpgrp`'d itself to the foreground, and stopped the host (OMP) on its next tty read. `pi_shell` now detaches pipeline stages too: `child_session_action` returns `DetachSession` for any non-terminal-stdin child regardless of pipeline membership, and `execute_external_command` skips `process_group(...)` entirely for detached children so no cross-session `setpgid` is attempted. Pipeline stages no longer share one process group, which the embedded host does not rely on (cancellation walks the descendant tree and pipes are session-independent).

## [15.6.0] - 2026-05-30

### Changed

- Changed npm publishing to ship `@oh-my-pi/pi-natives` as a small core loader package plus per-platform optional dependency leaf packages, so installs fetch only the host platform's native addon instead of every supported `.node` binary.

## [15.5.10] - 2026-05-28

### Fixed

- Fixed background bash jobs pinning the JS main thread at ~200% CPU when the child process emits output in many tiny writes (printf-style progress, llama-cli token streams). `pi_shell`'s pipe reader forwarded every chunk through a separate `ThreadsafeFunction::call` per kernel `read(2)`, so a chatty child produced millions of cross-thread napi callbacks that the JS main thread had to drain serially — even after the child exited, the queue kept the process saturated for seconds. The bridge now greedily coalesces every chunk already in the mpsc queue into a single batched call (capped at 64 KiB) before crossing into JS, collapsing 1-byte writes into one napi dispatch and bringing the steady-state callback rate back to the JS event-loop's throughput.

## [15.5.9] - 2026-05-28

### Changed

- Changed native addon extraction to skip re-extracting cached `.node` files when their size already matches embedded archive metadata
- Changed standalone binaries to embed native addons as a compressed tarball and unpack them into the versioned native cache on first run instead of embedding each `.node` file uncompressed.

### Fixed

- Fixed CI native addon builds retaining ELF debug and symbol sections in release artifacts; stripped builds are now verified to reject `.debug_*`, `.zdebug_*`, `.symtab`, and `.strtab` sections.

### Security

- Hardened embedded addon archive extraction by rejecting unsafe entry names and non-file archive entries before writing binaries to disk

## [15.5.4] - 2026-05-27

### Added

- Added `Hashline` class with methods to format headers, parse/apply hashline edits, split inputs, compute diffs, generate previews, and recover from stale hashes
- Added `HashlineChunker` class to stream UTF-8 text into numbered hashline chunks incrementally
- Added `HashlineCursorKind`, `HashlineEditKind`, and `HashlineTokenKind` exports for hashline cursor/edit/token discrimination
- Added `unfoldUntilLines` and `unfoldLimitLines` options to `SummaryOptions` to control BFS unfold visibility with an optional hard cap

## [15.5.0] - 2026-05-26

### Fixed

- Fixed bash heredocs (`<<`) and here-strings (`<<<`) deadlocking the shell on Windows past ~4 KiB and on macOS past 16-64 KiB. `brush_core::interp::setup_open_file_with_contents` wrote the entire body into an anonymous pipe synchronously before handing the reader to the next command; once the body exceeded the OS pipe buffer the writer blocked forever and the `bash` tool timed out at the hard 305 s ceiling without ever launching the consumer. The Linux fast path still uses `F_SETPIPE_SZ` to grow the pipe in-place; every other OS-threaded platform (and Linux bodies above `pipe-max-size`) now decouples the write onto a fire-and-forget thread that terminates naturally on drain or `BrokenPipe`; no-thread targets keep the upstream synchronous path so heredocs do not fail at thread spawn.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey` claiming `ctrl+m`/`ctrl+j`/`ctrl+i`/`ctrl+h`/`ctrl+[` for the single bytes terminals emit for Enter/Tab/Backspace/Escape in legacy mode. Pressing Enter no longer triggers a `ctrl+m` binding; the named keys now own those bytes and the colliding `ctrl+<letter>` combinations only match when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. The same gate now also applies to `ctrl+alt+<letter>` legacy `ESC + <ctrl-char>` sequences (e.g. `\x1b\r` is Alt+Enter, not Ctrl+Alt+M). ([#1354](https://github.com/can1357/oh-my-pi/issues/1354))

## [15.0.2] - 2026-05-15

### Added

- Added a per-release version sentinel napi export (`__piNativesV{major}_{minor}_{patch}`). The Rust `js_name` is bumped in lock-step with the package version by `scripts/release.ts`; the JS loader computes the expected name from `package.json#version` and throws an actionable error when the on-disk `.node` doesn't expose it. This converts the silent `<sym> is not a function` crash from a stale addon into a load-time failure pointing at the real fix.
- Added `applyBashFixups(command)` — a synchronous brush-parser-driven rewrite that strips trailing `| head|tail …`, redundant `2>&1`, and the `|&` shorthand from top-level pipelines, returning `{ command, stripped }`. Replaces the hand-rolled top-level mask scanner in `pi-coding-agent`; tokenization, quoting, heredocs, command substitution, and nested compound commands are now handled by the real shell AST instead of regex/character-walking. Lives in `pi_shell::fixup` on the Rust side.

### Fixed

- Fixed `<sym> is not a function` crashes on Windows after `bun install -g @oh-my-pi/pi-coding-agent` updates while an `omp` process was running. Bun cannot overwrite a locked `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` and silently keeps the old binary alongside the new ESM wrapper, so the next launch loads mismatched code. The loader now mirrors the addon into `~/.omp/natives/<version>/` on Windows npm installs and prefers that copy at load time — each version gets its own filesystem path, so future updates land in `node_modules` unchallenged. The new version sentinel detects any remaining drift up front.
- Fixed `$env:NAME` PowerShell references being collapsed to `:NAME` when brush forwarded a command to a PowerShell (or any) subprocess. `pi-shell` now defines `env=$env` as a non-exported global on every brush session so the bash parameter expansion of `$env` yields the literal `$env`, leaving `$env:NAME` intact. User-driven assignments (`env=prod`) push their own command-scope binding and shadow the fallback, preserving the bash POSIX contract. ([#1079](https://github.com/can1357/oh-my-pi/issues/1079))

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun runtime version to >=1.3.14
- Removed `PhotonImage` class, `ImageFormat` enum, and `SamplingFilter` enum from native exports. General-purpose image decode/resize/encode now uses [`Bun.Image`](https://bun.com/docs/runtime/image), which ships in Bun 1.3.14+ with statically-linked libjpeg-turbo, libspng, and libwebp plus SIMD geometry kernels — same operations, zero native-addon footprint. `encodeSixel` stays (no Bun equivalent for the SIXEL terminal protocol).
- Removed `webp` Rust workspace dependency along with `PhotonImage`'s WebP encoder.

## [14.9.9] - 2026-05-12

### Breaking Changes

- Removed `projfsOverlayProbe`, `projfsOverlayStart`, and `projfsOverlayStop` overlays APIs and `ProjfsOverlayProbeResult` type from the public natives interface

### Added

- Added unified isolation APIs `isoBackend`, `isoProbe`, `isoResolve`, `isoStart`, `isoStop`, `isoDiff`, and `isoIsUnavailableError` for selecting, probing, resolving, starting, stopping, and diffing isolated filesystems
- Added `IsoBackendKind`, `IsoChangeKind`, `IsoDiff`, `IsoFileChange`, `IsoProbeResult`, and `IsoResolveResult` type exports to describe isolation backend capabilities and diff outcomes

### Changed

- Changed `native` exports to remove the platform-specific ProjFS-only overlay surface in favor of generic isolation controls

## [14.9.5] - 2026-05-12

### Fixed

- Fixed shell cancellation occasionally killing the harness. The `pi_shell` descendant tracker harvested every descendant's `pgid` into the kill set, so any subprocess that inherited the harness's pgid (any helper spawned via APIs that do not call `setpgid` — sibling LSP/MCP processes, etc.) dragged `harness.pgid` into the list and the follow-up `kill(-harness.pgid, SIGTERM)` terminated the harness alongside the targets. The classifier now only adopts a `pgid` when its leader is itself one of the new descendants, and `kill_process_group` refuses the harness's own process group as a last-line defense.
- Fixed macOS process-tree termination silently doing nothing. The descendant walk relied on `proc_listchildpids`, which on recent darwin kernels (25.4+) returns no entries when a process queries its own children, so `Process::descendants` came back empty and tree-kill cleanup never reached grandchildren. The walk now builds a one-shot `ppid → [pid]` map from `proc_listallpids` + `proc_pidinfo`, matching the approach already used by `find_by_path` and the Windows Toolhelp path.

### Changed

- Removed the 20 Hz background descendant tracker that scanned the harness's process tree for the entire lifetime of every shell command. Cancellation now does a small rescan-and-signal loop on demand (up to three waves — SIGTERM, then SIGKILL, then SIGKILL — with early exit as soon as no descendants remain). The previous tracker existed to pin process identities against PID reuse races, but `Process::from_pid` already pins identity by kernel start time / pidfd, so the constant scanning paid for nothing and added meaningful syscall load on macOS where each scan now does `proc_listallpids` + `proc_pidinfo` per pid.

## [14.9.3] - 2026-05-10

### Added

- Added `idle`, `system`, and `user` options to `MacOSPowerAssertion` so callers can request specific macOS sleep-prevention modes (`caffeinate -i`, `-s`, and `-u`) in addition to the existing `display` option
- Added support for combining multiple macOS power assertion flags in a single `MacOSPowerAssertion` handle

### Changed

- Changed `MacOSPowerAssertion.stop()` documentation to indicate it releases all held assertions and is safe to call repeatedly as a no-op

## [14.9.2] - 2026-05-10

### Added

- Added `listWorkspace`, a native single-pass workspace walker that returns bounded tree entries and AGENTS.md directory-context candidates together.

## [14.7.1] - 2026-05-06

### Added

- Added `size` property to `GlobMatch` for regular files to expose their byte size

### Changed

- Sped up native `grep` files-with-matches searches by stopping after the first match per file, reading small files without mmap overhead, and relying on grep-searcher binary detection instead of a separate full-file NUL scan.

### Fixed

- Fixed native `grep` `filesWithMatches` mode so `totalMatches` reports the number of matching files rather than line-match totals
- Fixed native `grep` count-mode limits applying to files instead of matches, and restored timeout/abort cancellation checks for small native filesystem scans.

## [14.7.0] - 2026-05-04

### Added

- Added `summarizeCode` function to expose native code summarization with `kind`, `startLine`, `endLine`, and optional `text` segments plus parse/elision metadata
- Added `minBodyLines` and `minCommentLines` options to `summarizeCode` to control when function/body and multiline comment elision is applied
- Added `SummaryOptions` and `SummaryResult` TypeScript definitions for typed `summarizeCode` input and output

## [14.6.1] - 2026-05-02

### Changed

- Changed the native package loader from CommonJS analyzer-visible assignments to a template-rendered ESM entry point with explicit named exports

## [14.5.13] - 2026-05-01

### Changed

- Stopped overriding `CARGO_TARGET_DIR` with an internal `target/napi-build/...` directory during native builds, so Cargo now uses the default or caller-provided target directory
- Simplified native build profile suffix formatting without changing `local` and `ci` values
- Changed the native build output behavior to avoid setting an isolated Cargo target directory automatically

### Removed

- Removed the host Zig CPU contract wrapper (`zig-safe-wrapper.ts`) and its `ZIG`/`PI_NATIVE_REAL_ZIG`/`PI_NATIVE_ZIG_TARGET`/`PI_NATIVE_ZIG_CPU` env handling, since the `zlob` Rust dependency that required Zig is gone
- Removed the `ci-release-verify-natives` script and its AVX-512 marker scan from the release pipeline

## [14.5.12] - 2026-04-30

### Breaking Changes

- Changed `waitForExit` to accept a single options object instead of a numeric timeout argument

### Added

- Added a `signal` option to `terminate` for cancelling termination while waiting for process shutdown
- Added abort `signal` support to `waitForExit` via `ProcessWaitOptions`
- Added a `ProcessWaitOptions` type and updated `waitForExit` to accept an options object

## [14.5.9] - 2026-04-30

### Fixed

- Fixed shell minimizer output so successful commands whose noise is fully stripped still return `OK` instead of an artifact-only result

## [14.5.6] - 2026-04-29

### Added

- Added shell minimizer support for CMake, CTest, Ninja, GoogleTest binaries, and Bun/Bunx wrappers that run those tools

## [14.5.2] - 2026-04-26

### Changed

- Changed local native build profile from `dev` to `local` for non-CI builds, updating the profile used by the build and local build output label

## [14.4.2] - 2026-04-26

### Removed

- Removed the `chunk` napi module (`ChunkState`, chunk schema, chunk rendering, chunk edit) and dropped `generate_chunk_schema()` from the build script

## [14.3.0] - 2026-04-25

### Added

- Added `text` to `MinimizerResult` so consumers can replace rewritten output with the minimized replacement text
- Added `settingsHash` to `MinimizerOptions` to verify the minimizer `settingsPath` contents against a xxHash64 digest before applying them
- Added `minimized` output telemetry via `MinimizerResult` on `ShellExecuteResult` and `ShellRunResult`, exposing the applied minimizer filter and original/minimized byte counts when output is rewritten
- Added a new `minimizer` option to `ShellExecuteOptions` and `ShellOptions` to configure per-command output minimization
- Added the `MinimizerOptions` API with controls for enabling minimization, overriding settings via `settingsPath`, allow/deny lists (`only`, `except`), and `maxCaptureBytes` capture limits

### Changed

- Changed the shell output minimizer to more aggressively compact successful test runs, git output, large listings, grep/find results, source reads, and dependency manifests
- Changed compound and piped shell commands to bypass output minimization entirely, keeping minimization limited to eligible whole-command output after the command exits

### Fixed

- Fixed chunk edit batches so later operations can reuse an initially validated checksum after an earlier operation changes that same chunk

### Removed

- Removed `PI_DEV` loader diagnostic env var and associated console logging in the native addon loader

### Security

- Added trust-gated loading for minimizer settings by requiring a matching `settingsHash` before accepting a settings file

## [14.2.0] - 2026-04-23

### Added

- Added Dart support to `astGrep` and `astEdit` through the native tree-sitter Dart grammar ([#748](https://github.com/can1357/oh-my-pi/pull/748) by [@0fflineuser](https://github.com/0fflineuser))

## [14.1.1] - 2026-04-14

### Added

- Added support for honoring the `ZIG` environment variable when resolving the Zig executable for native builds

### Removed

- Removed the `SearchDb` API from the natives type declarations
- Removed the optional `db` parameter from `fuzzyFind`, `glob`, and `grep`
- Removed the `fuzzyFind`, `glob`, and `grep` cache database argument previously used for search state

## [14.0.5] - 2026-04-11

### Breaking Changes

- Made `tabWidth` parameter required (no longer optional) for `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments`
- Removed `getIndentation`, `getDefaultTabWidth`, and `setDefaultTabWidth` (moved to `@oh-my-pi/pi-utils`)
- `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments` now require an explicit `tabWidth` argument

## [14.0.4] - 2026-04-10

### Added

- Added `normalizeIndent` option to `EditParams` to control indentation normalization for response rendering and inserted content
- Added `hasConflicts()` method to detect unresolved merge conflicts in parsed files
- Added `conflictCount()` method to count unresolved merge conflicts in the chunk tree

## [14.0.2] - 2026-04-09

### Added

- Added `Decl` variant to `ChunkRegion` enum for accessing semantic declarations without leading trivia
- Added `check:types` script for explicit TypeScript type checking
- Added `lint` script for running Biome linter
- Added `fmt` script for code formatting with Biome
- Added package exports field with typed entry point configuration
- Added turbo.json configuration for build task caching and optimization

### Changed

- Renamed `build:native` script to `build` for simpler invocation
- Updated `check` script to separately call `check:types` for type checking
- Modified tsconfig.json to extend `tsconfig.workspace.json` instead of `tsconfig.base.json`

## [14.0.0] - 2026-04-08

### Breaking Changes

- Changed `ChunkRegion.Inner` enum value to `ChunkRegion.Body` to align with region semantics
- Changed `ChunkRegion` enum values from `Container`, `Prologue`, `Body`, `Epilogue` to `Head`, `Inner`, `Tail` with updated semantics for region targeting
- Replaced `ChunkEditOp` enum values — `AppendChild`, `PrependChild`, `AppendSibling`, `PrependSibling`, and `ReplaceBody` are now `Before`, `After`, `Prepend`, and `Append` with updated semantics for region-scoped operations
- Removed `ReplaceBody` operation — use `Replace` with `region: ChunkRegion.Body` to replace only chunk body content
- Moved package entry point from `src/index.ts` to `native/index.js` — consumers must update imports to use the new native module path
- Removed TypeScript source files from `src/` directory — all APIs now exported from auto-generated `native/index.js` with types in `native/index.d.ts`
- Changed enum exports to runtime objects — `const enum` values are now available at runtime via generated enum exports in `native/index.js`

### Added

- Added `ChunkRegion` enum with `Container`, `Prologue`, `Body`, and `Epilogue` values for targeting specific regions within chunks
- Added `region` parameter to `EditOperation` to specify which chunk region to target (defaults to `Container`)
- Added `UnsupportedRegion` status to `ChunkReadStatus` enum to indicate when a chunk does not support the requested region
- Added `normalizeIndent` parameter to `RenderParams` and `ReadRenderParams` to normalize displayed indentation to canonical tabs
- Added `ReplaceBody` chunk edit operation to replace only the inner body of a chunk while preserving signature and closing delimiter
- Added `ChunkFocusMode` enum with `Expanded`, `Collapsed`, and `Container` modes for controlling chunk participation in focus-scoped render passes
- Added `FocusedPath` interface to pair paths with focus modes for the N-API boundary
- Added `focusedPaths` parameter to `RenderParams` to restrict rendering to specified chunks with their focus modes
- Generated native module bindings in `native/index.js` and `native/index.d.ts` from napi-rs build output
- Added `gen-enums.ts` script to extract and export runtime enum values from TypeScript const enums
- Added `embedded-addon.js` for managing embedded native addon variants and metadata
- Added `MacOSPowerAssertion` for session-scoped macOS idle-sleep prevention without shelling out

### Changed

- Changed `ChunkInfo.name` field to optional `identifier` field — now provides bare chunk identifier without kind prefix instead of display name
- Updated `region` parameter documentation in `EditOperation` to clarify full chunk targeting when omitted instead of container-scoped default
- Updated `ChunkEditOp` documentation to reflect region-scoped semantics — operations now target specific regions rather than chunk structure positions
- Changed `ChunkEditOp.Replace` documentation to clarify substring replacement via `find` parameter instead of line-based replacement
- Changed `EditOperation` interface to use `find` parameter for scoped find/replace operations instead of `line` and `endLine` parameters
- Changed `EditParams` documentation to remove mention of scheduling reordering for line-scoped groups
- Simplified native build pipeline by removing `--dev` flag support; debug builds no longer available through npm scripts
- Updated native module loader to check `XDG_DATA_HOME` environment variable for native addon location before falling back to `~/.omp/natives`
- Removed native binding validation function that checked for required exports at load time
- Refactored build pipeline to use napi-rs generated bindings instead of hand-written TypeScript wrappers
- Updated `build-native.ts` to generate runtime enum exports after native compilation
- Updated `embed-native.ts` to output JavaScript instead of TypeScript for embedded addon metadata

### Removed

- Removed `dev:native` npm script — use `build:native` for all build scenarios
- Removed inline pi-utils helpers and dependency on `@oh-my-pi/pi-utils` from native module loader
- Removed `logger.time()` wrapper calls from native module loading
- Removed all TypeScript wrapper modules from `src/` directory (appearance, ast, chunk, clipboard, glob, grep, highlight, html, image, keys, projfs, ps, pty, shell, text, work)
- Removed `src/bindings.ts` and `src/index.ts` entry points
- Removed `src/search-db.ts` and `src/search-db-types.ts`

## [13.16.1] - 2026-03-27

### Added

- Exported `SearchDb` class from main package entry point for direct instantiation
- Added `SearchDb` class for stateful shared search database instances to improve performance across multiple search operations
- Added optional `db` parameter to `grep()`, `glob()`, and `fuzzyFind()` functions to enable database-backed searching

### Changed

- Updated `grep()`, `glob()`, and `fuzzyFind()` function signatures to accept optional `db` parameter for database-backed searching

## [13.12.0] - 2026-03-14

### Breaking Changes

- Changed `abort()` method signature: removed optional `reason` parameter and changed return type from `void` to `Promise<void>`

## [13.4.0] - 2026-03-01

### Breaking Changes

- Changed `AstFindOptions.pattern` to `patterns` (now accepts array of strings instead of single string)
- Replaced `AstReplaceOptions.pattern` and `rewrite` with single `rewrites` option (Record<string, string>)

### Added

- `astGrep` now accepts multiple patterns in a single call; results from all patterns are merged and sorted by file path then position before offset/limit are applied
- `astEdit` now accepts a `rewrites` map (`Record<string, string>`) and applies all patterns per file in a single pass, compiling them once upfront
- Result ordering in `astGrep` is now deterministic: sorted by path, line, column using `BTreeSet`/`BTreeMap`

## [13.3.8] - 2026-02-28

### Added

- Added `astFind()` function for structural code search using AST patterns with support for language-specific matching, selectors, and meta-variable extraction
- Added `astReplace()` function for structural code rewriting with dry-run mode, replacement limits, and parse error handling
- Added `./ast` export path for accessing AST search and rewrite functionality

## [12.18.0] - 2026-02-21

### Changed

- Replaced custom `TextDecoder` usage with native `toString('utf-8')` for buffer decoding
- Replaced custom debug logging with structured `logger.time()` calls for startup performance tracking

## [12.17.1] - 2026-02-21

### Added

- Expanded package exports to support subpath imports for clipboard, glob, grep, highlight, html, image, keys, ps, pty, shell, text, and work modules
- Added wildcard export patterns (`./*`) for all submodules to enable flexible import paths

### Changed

- Updated package description to clarify native bindings for grep, clipboard, image processing, syntax highlighting, PTY, and shell operations
- Expanded package keywords to include clipboard, image, pty, shell, and syntax-highlighting for better discoverability
- Added README.md to package distribution files

## [12.10.0] - 2026-02-18

### Changed

- Updated addon filename resolution to include default filename fallback in both modern and baseline variant paths

## [12.8.2] - 2026-02-17

### Breaking Changes

- Removed `getSystemInfo()` and `SystemInfo` from package exports, breaking consumers that imported system info APIs from this package

## [12.8.0] - 2026-02-16

### Added

- Added support for x64 CPU variant selection with `TARGET_VARIANT` environment variable (modern/baseline) during build to optimize for specific ISA levels
- Added automatic AVX2 detection on Linux, macOS, and Windows to select optimal native addon variant at runtime
- Added `PI_NATIVE_VARIANT` environment variable to override CPU variant selection at runtime
- Added support for multiple native addon variants per platform (modern with AVX2, baseline without AVX2) for improved performance portability

### Changed

- Changed native addon filename scheme to include CPU variant suffix for x64 builds (e.g., `pi_natives.linux-x64-modern.node`)
- Changed embedded addon structure to support multiple variant files per platform instead of single file
- Changed native addon loader to automatically select appropriate variant based on CPU capabilities or explicit override
- Changed build output to include variant information in console messages

### Removed

- Removed fallback untagged `pi_natives.node` binary creation for native builds; platform-tagged variants are now required

### Fixed

- Fixed regex patterns containing literal braces (e.g. `${platform}`) failing with "repetition quantifier expects a valid decimal" by escaping `{`/`}` that don't form valid repetition quantifiers

## [12.5.0] - 2026-02-15

### Added

- Added `recursive` option to `GlobOptions` to control whether simple patterns match recursively (defaults to true)

### Changed

- Changed default glob pattern behavior to always use recursive matching for simple patterns instead of requiring explicit `**/` prefix
- Updated `fileType` filter documentation to clarify that symlinks match file/dir filters based on their target type

## [12.4.0] - 2026-02-14

### Added

- Exported `sanitizeText` function to strip ANSI codes, remove binary garbage, and normalize line endings in text output

## [12.1.0] - 2026-02-13

### Added

- Added `cache` option to `glob()`, `grep()`, and `fuzzyFind()` to enable shared filesystem scan caching
- Added `invalidateFsScanCache()` function to manually invalidate filesystem scan cache entries

## [11.14.0] - 2026-02-12

### Added

- Added `PtySession` class for PTY-backed interactive command execution with streaming output
- Added `PtyStartOptions` interface to configure pseudo-terminal sessions with command, working directory, environment variables, and terminal dimensions
- Added `PtyRunResult` interface to report command exit code, cancellation, and timeout status
- Added `write()` method to send raw input to PTY stdin
- Added `resize()` method to dynamically adjust PTY column and row dimensions
- Added `kill()` method to force-terminate active commands

## [11.3.0] - 2026-02-06

### Added

- OSC 52 fallback for clipboard operations over SSH/mosh connections
- Termux support with `termux-clipboard-set` integration
- Headless environment guards to prevent clipboard errors when no display server is available
- Async clipboard API with improved error handling and fallback strategies

### Changed

- OSC 52 clipboard emission now only occurs in real terminal environments (when stdout is a TTY), preventing unnecessary output in piped or headless contexts
- Improved error handling for OSC 52 writes to gracefully handle EPIPE errors when stdout is closed or piped to processes that exit early
- Clipboard functions now return promises for better async handling
- Native clipboard operations are now best-effort with graceful degradation

## [11.0.0] - 2026-02-05

### Removed

- Removed legacy type aliases `WasmMatch` and `WasmSearchResult`

## [10.6.0] - 2026-02-04

### Changed

- Added separate grep context before/after options in bindings

## [10.2.2] - 2026-02-02

### Added

- Exported `getWorkProfile` function and `WorkProfile` type for work profiling capabilities

## [10.2.0] - 2026-02-02

### Breaking Changes

- Replaced `find()` with `glob()` - update imports and function calls
- Changed file type filtering from string values to `FileType` enum
- Removed `abortShellExecution()` function - use `Shell.abort()` method instead
- Removed `RequestOptions` parameter from `htmlToMarkdown()` - pass options directly

### Added

- Added `glob()` function for file discovery with glob pattern matching and .gitignore support
- Added `Cancellable` interface for timeout and abort signal support across async operations
- Added `FileType` enum to filter glob results by file type (File, Dir, Symlink)
- Added `signal` parameter to shell operations for cancellation via AbortSignal

### Changed

- Renamed `find()` to `glob()` for file discovery operations
- Renamed `FindMatch` to `GlobMatch` and `FindOptions` to `GlobOptions`
- Moved timeout and abort signal handling into unified `Cancellable` interface across grep, glob, and shell modules
- Updated `Shell.abort()` to accept optional abort reason parameter
- Simplified `htmlToMarkdown()` signature by removing `RequestOptions` parameter

### Removed

- Removed `RequestOptions` type and `wrapRequestOptions()` utility function
- Removed `abortShellExecution()` function; use `Shell.abort()` instead
- Removed `executionId` parameter from `ShellExecuteOptions`

## [10.1.0] - 2026-02-01

### Breaking Changes

- Changed `executionId` parameter type from `string` to `number` in `abortShellExecution()` and `ShellExecuteOptions`
- Removed `sessionKey` field from `ShellExecuteOptions`

### Added

- Added `getWorkProfile()` function to retrieve work scheduling profiling data from a circular buffer of recent activity
- Added `WorkProfile` type with folded stack format, markdown summary, SVG flamegraph, and sample metrics for profiling results

## [9.8.0] - 2026-02-01

### Breaking Changes

- Removed `resize()` function; use `PhotonImage.resize()` method instead
- Removed `terminateImageWorker()` function
- Changed `PhotonImage.new_from_byteslice()` to `PhotonImage.parse()`
- Changed `PhotonImage.get_bytes()` to `encode(ImageFormat.PNG, 100)`
- Changed `PhotonImage.get_bytes_jpeg(quality)` to `encode(ImageFormat.JPEG, quality)`
- Removed `get_width()` and `get_height()` methods; use `width` and `height` properties instead
- Removed manual resource management via `free()` and `Symbol.dispose`

### Added

- Added automatic extraction of embedded native addon to `~/.omp/natives/<version>` on first run for compiled binaries
- Added `embed:native` build script to embed platform-specific native addon payloads into compiled binaries
- Exported `Shell` class for creating persistent shell sessions with `run()` method and session options
- Exported `ShellOptions`, `ShellRunOptions`, and `ShellRunResult` types for shell session management
- Exported `find()` function for file discovery with glob patterns and .gitignore support
- Exported `FindOptions`, `FindMatch`, and `FindResult` types for file search operations
- Exported `ImageFormat` enum for specifying output formats (PNG, JPEG, WEBP, GIF) in image encoding
- Added `ImageFormat` enum for specifying output format (PNG, JPEG, WEBP, GIF) in `encode()` method
- Added `SamplingFilter` as exported enum instead of object
- Added `Shell` class with persistent session options (`sessionEnv`, `snapshotPath`) and a `run()` command API
- Exported `getSystemInfo()` function and `SystemInfo` type for retrieving system information including distro, kernel, CPU, and disk details
- Exported `copyToClipboard()` and `readImageFromClipboard()` functions for clipboard operations
- Exported `ClipboardImage` type for clipboard image data with MIME type information
- Added `wrapTextWithAnsi()` function to wrap text to a visible width while preserving ANSI escape codes across line breaks
- Added native clipboard helpers for copying text and reading images via arboard

### Changed

- Enhanced native addon loading to prioritize extracted embedded addon for compiled binaries before falling back to system paths
- Improved error messages to provide platform-specific guidance for addon loading failures, including manual download instructions for compiled binaries
- Reorganized native bindings into modular type files with declaration merging via `NativeBindings` interface
- Moved type definitions from implementation files to dedicated `types.ts` modules for better separation of concerns
- Enhanced `SystemInfo` type with additional fields: `os`, `arch`, `hostname`, `shell`, `terminal`, `de`, `wm`, and `gpu`
- Refactored module exports to use direct destructuring from native bindings instead of wrapper functions
- Changed `PhotonImage` API to use instance methods (`resize()`, `encode()`) instead of standalone functions
- Changed `PhotonImage` to use property accessors for `width` and `height` instead of getter methods
- Embedded native addon payload for compiled binaries and extract to `~/.omp/natives/<version>` on first run

## [9.7.0] - 2026-02-01

### Added

- Exported `killTree` function to kill a process and all its descendants using platform-native APIs
- Exported `listDescendants` function to list all descendant PIDs of a process
- Added `dev:native` npm script to build debug native binaries with `--dev` flag
- Added `OMP_DEV` environment variable support for loading and debugging development native builds
- Exported keyboard parsing and matching functions: `parseKey`, `parseKittySequence`, `matchesLegacySequence`, and `matchesKey` for terminal input handling
- Exported `KeyEventType` enum and `ParsedKittyResult` type for Kitty keyboard protocol support
- Added `parseKey` function to parse terminal input and return normalized key identifiers (e.g., "ctrl+c", "shift+tab")
- Added `parseKittySequence` function to parse Kitty keyboard protocol sequences with codepoint, modifier, and event type information
- Added `matchesLegacySequence` function to match legacy escape sequences for specific keys
- Added `matchesKey` function to match input against key identifiers with support for modifiers and Kitty protocol

### Changed

- Modified native binary build process to support both debug and release builds via `--dev` flag
- Updated native binary search to prioritize platform-tagged builds and separate debug/release candidates
- Changed debug builds to output to `pi_natives.dev.node` instead of mixing with release artifacts
- Improved native binary installation to use atomic rename operations and better fallback handling for Windows DLLs
- Reordered native binary search candidates to prioritize platform-tagged builds and avoid loading stale cross-compiled binaries
- Enhanced cross-compilation detection to prevent installing wrong-platform fallback binaries during cross-compilation builds

### Fixed

- Fixed potential issue where cross-compiled binaries could overwrite platform-specific native builds with incorrect architecture binaries

## [9.6.4] - 2026-02-01

### Breaking Changes

- Changed callback signature for `find()` and `grep()` streaming callbacks to receive `(error, match)` instead of `(match)` for proper error handling

## [9.6.2] - 2026-02-01

### Breaking Changes

- Renamed `EllipsisKind` enum to `Ellipsis`
- Changed `TextInput` type parameter to `string` in `truncateToWidth()`, `visibleWidth()`, `sliceWithWidth()`, and `extractSegments()` functions—Uint8Array is no longer accepted
- Removed `TextInput` type export from public API

### Added

- Added `visibleWidth()` function to measure the visible width of text, excluding ANSI codes

### Changed

- Reordered native module search paths to prioritize repository build artifacts
- Improved JSDoc documentation for `truncateToWidth()` with clearer parameter descriptions and behavior details
- Added early return optimization in `truncateToWidth()` to skip native call when text fits within maxWidth and padding is not requested
- Added early return optimization in `sliceWithWidth()` to return empty result when length is zero or negative

### Removed

- Removed validation checks for `PhotonImage` and `SamplingFilter` native exports
- Removed early return optimization in `truncateToWidth()` when text fits within maxWidth

## [9.6.1] - 2026-02-01

### Added

- Added `matchesKittySequence` function to match Kitty protocol sequences for codepoint and modifier

### Removed

- Removed `visibleWidth` function from text utilities

## [9.6.0] - 2026-02-01

### Added

- Support for cross-compilation via `CARGO_BUILD_TARGET` environment variable
- Support for overriding platform and architecture detection via `TARGET_PLATFORM` and `TARGET_ARCH` environment variables

### Changed

- Native build script now searches for release artifacts in target-specific directories when cross-compiling

## [9.5.0] - 2026-02-01

### Added

- Added `sortByMtime` option to `FindOptions` to sort results by modification time (most recent first) before applying limit
- Added streaming callback support to `grep()` function via optional `onMatch` parameter for real-time match notifications
- Exported `RequestOptions` type for timeout and abort signal configuration across native APIs
- Exported `fuzzyFind` function for fuzzy file path search with gitignore support
- Exported `FuzzyFindOptions`, `FuzzyFindMatch`, and `FuzzyFindResult` types for fuzzy search API
- Added `fuzzyFind` export for fuzzy file path search with gitignore support

### Changed

- Changed `grep()` and `fuzzyFind()` to support timeout and abort signal handling via `RequestOptions`
- Updated `GrepOptions` and `FuzzyFindOptions` to extend `RequestOptions` for consistent timeout/cancellation support
- Refactored `htmlToMarkdown()` to support timeout and abort signal handling

### Removed

- Removed `grepDirect()` function (use `grep()` instead)
- Removed `grepPool()` function (use `grep()` instead)
- Removed `terminate()` export from grep module
- Removed `terminateHtmlWorker` export from html module

### Fixed

- Fixed potential crashes when updating native binaries by using safe copy strategy that avoids overwriting in-memory binaries
