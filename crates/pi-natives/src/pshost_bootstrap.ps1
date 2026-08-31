#Requires -Version 7.0
<#
    pshost_bootstrap.ps1 — persistent PowerShell host loop for the omp `PsHost`
    native sidecar.

    Spawned once per host instance (one warm host per agent session; ephemeral
    runs get their own) by crates/pi-natives/src/pshost.rs as:

        pwsh -NoLogo -NoProfile -NonInteractive -File <this> -ParentPid <pid> -HistoryDepth <n>

    Protocol (both directions): 4-byte big-endian length prefix + UTF-8 JSON body
    over the process's stdin (requests in) / stdout (events out). stderr is left
    free for catastrophic diagnostics only.

    Requests  (Rust -> host): {type:"exec",id,command,cwd?,env?,width}
                              {type:"stop",id}
                              {type:"exit"}
    Events    (host -> Rust): {type:"ready",pid}
                              {type:"chunk",id,stream:"output"|"information"|"warning"|"verbose"|"debug"|"error",text}
                              {type:"done",id,exitCode?,hadErrors,stopped}

    A single shared runspace ($rs) executes every user command at top scope, so
    variables, imported modules, $LASTEXITCODE, and the live result objects in
    $global:__omp persist across tool calls and remain inspectable via
    `Enter-PSHostProcess -Id <pid>`.
#>
[CmdletBinding()]
param(
    # PID of the omp process. The host self-terminates if the parent dies, so a
    # hard omp crash cannot orphan this sidecar.
    [int] $ParentPid = 0,
    # Cap on retained result history (ring of $global:__omp.History entries).
    [int] $HistoryDepth = 20
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# Hard cap on a single frame in either direction; must match MAX_FRAME_BYTES in
# pshost.rs. Outbound chunks are split below it, inbound violations mean the
# stream is desynced beyond recovery.
$MaxFrameBytes = 64MB

# The sidecar's stdin/stdout are the length-prefixed JSON protocol channel the
# Rust side reads from and writes to. Native executables spawned by user
# commands inherit this process's OS standard handles, so a child that reads
# stdin (most visibly Git for Windows' git.exe, which blocks on it for every
# subcommand) hangs forever and steals request bytes, and a child that writes
# directly to the inherited stdout (e.g. a .NET Process started outside
# PowerShell's pipeline with RedirectStandardOutput=false) emits raw bytes where
# the frame reader expects a length prefix and tears the host down. Detach both
# at startup: keep the real pipes for our own reader/writer, and repoint the
# inheritable STDIN/STDOUT slots at the null device so children see EOF on read
# and discard writes. (Console.SetIn/SetOut only swap this process's managed
# reader/writer; the OS handles a child inherits are separate slots, so the
# redirect needs a P/Invoke.)
Add-Type -Namespace Omp -Name Stdio -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int n, System.IntPtr h);
[DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(System.IntPtr h, uint mask, uint flags);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern System.IntPtr CreateFileW(string name, uint access, uint share, System.IntPtr sec, uint disp, uint flags, System.IntPtr templ);
[DllImport("libc", SetLastError=true)] static extern int open(string path, int flags);
[DllImport("libc", SetLastError=true)] static extern int dup(int fd);
[DllImport("libc", SetLastError=true)] static extern int dup2(int oldfd, int newfd);
[DllImport("libc", SetLastError=true)] static extern int close(int fd);
[DllImport("libc", SetLastError=true)] static extern int fcntl(int fd, int cmd, int arg);
// Preserve the protocol stream on stdHandle/posixFd, then point the inheritable
// slot at the null device so spawned children can't touch the protocol channel.
static System.IO.Stream Detach(int stdHandle, int posixFd, bool forWrite) {
    var access = forWrite ? System.IO.FileAccess.Write : System.IO.FileAccess.Read;
    if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows)) {
        // Wrap the original pipe handle (ownsHandle:false — the process still
        // owns it), then point the inheritable slot at NUL. SetStdHandle only
        // repoints the std SLOT; it does not touch HANDLE_FLAG_INHERIT on the
        // original handle value, which is still open (via `keep`/`orig`) and,
        // by default, inheritable -- a child spawned with handle inheritance
        // enabled (bInheritHandles=TRUE) would still receive it as an extra
        // handle even though the std slot itself now points at NUL. A
        // long-lived child holding that duplicate open after the host
        // exits/crashes would keep the pipe alive and hide EOF from Rust's
        // reader, stalling in-flight run() calls until their own timeout
        // instead of promptly reporting host death -- the Windows analogue of
        // the POSIX FD_CLOEXEC fix below. Clear the flag before anything else
        // can spawn and inherit it.
        System.IntPtr orig = GetStdHandle(stdHandle);
        SetHandleInformation(orig, 1u /* HANDLE_FLAG_INHERIT */, 0u);
        var keep = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(orig, false), access, 1);
        uint gen = forWrite ? 0x40000000u : 0x80000000u; // GENERIC_WRITE : GENERIC_READ
        System.IntPtr nul = CreateFileW("NUL", gen, 0x3u, System.IntPtr.Zero, 3u, 0u, System.IntPtr.Zero);
        SetStdHandle(stdHandle, nul);
        return keep;
    }
    // POSIX: dup the real descriptor aside, then swap the fd to /dev/null so
    // children inherit EOF/discard while our stream keeps the pipe. dup(2)
    // never carries FD_CLOEXEC to the duplicate (POSIX-specified), so without
    // explicitly setting it here a forked native command still inherits this
    // now-non-stdio fd; a long-lived orphaned child holding it open would
    // then keep the pipe's write end alive after the host exits/crashes,
    // hiding EOF from the Rust reader and stalling in-flight run() calls
    // until their own timeout instead of promptly reporting host death.
    int saved = dup(posixFd);
    fcntl(saved, 2 /* F_SETFD */, 1 /* FD_CLOEXEC */);
    int nulFd = open("/dev/null", forWrite ? 1 : 0); // O_WRONLY : O_RDONLY
    if (nulFd >= 0) { dup2(nulFd, posixFd); close(nulFd); }
    return new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle((System.IntPtr)saved, true), access, 1);
}
public static System.IO.Stream DetachStdin()  { return Detach(-10, 0, false); }
public static System.IO.Stream DetachStdout() { return Detach(-11, 1, true); }
'@

# ── Binary framing over raw stdio ────────────────────────────────────────────
$stdin  = [Omp.Stdio]::DetachStdin()
$stdout = [Omp.Stdio]::DetachStdout()

# DetachStdout guards children that inherit the OS stdout slot, but managed
# writes to [Console]::Out (e.g. [Console]::WriteLine from a loaded .NET
# library) still target this process's stdout — the private protocol handle
# above — and raw bytes there would desync the frame reader and kill the
# host. [Console]::Error targets the sidecar's separate OS stderr pipe, which
# never carries protocol frames, so it can't desync the reader — but Rust
# only retains that pipe as a startup-failure diagnostic tail (never routed
# to a running exec's result), so an unredirected direct write there would
# silently vanish instead of surfacing as command output. Point both at a
# thread-safe queue-backed writer instead; Publish-Streams periodically
# drains it (same as the PowerShell data streams) so a long-running,
# high-volume direct Console writer can't grow the sidecar's memory
# unbounded before Complete-Exec ever runs. A plain StringBuilder-backed
# StringWriter (the previous implementation) is NOT safe to read/clear
# concurrently with the pipeline's BeginInvoke() thread still appending to
# it -- Write() calls land on a background thread while the poll loop
# reading/draining runs on the main thread, genuinely concurrent.
# ConcurrentQueue is lock-free for exactly this producer/consumer pattern,
# so Drain() is always safe to call from the main thread.
Add-Type -TypeDefinition @'
using System.Collections.Concurrent;
using System.Text;
namespace Omp {
    public class QueueWriter : System.IO.TextWriter {
        readonly ConcurrentQueue<string> q = new ConcurrentQueue<string>();
        public override Encoding Encoding { get { return Encoding.UTF8; } }
        public override void Write(char value) { q.Enqueue(value.ToString()); }
        public override void Write(string value) { if (!string.IsNullOrEmpty(value)) q.Enqueue(value); }
        public bool HasContent { get { return !q.IsEmpty; } }
        public string Drain() {
            var sb = new StringBuilder();
            string s;
            while (q.TryDequeue(out s)) { sb.Append(s); }
            return sb.ToString();
        }
    }
}
'@
$script:consoleOut = [Omp.QueueWriter]::new()
$script:consoleErr = [Omp.QueueWriter]::new()
[Console]::SetOut($script:consoleOut)
[Console]::SetError($script:consoleErr)
# DetachStdin only repoints the OS stdin slot/handle; a managed Console.In
# reader PowerShell/.NET already resolved before detach still targets the
# original OS handle, so [Console]::ReadLine()/In.Read* from a submitted
# command or a loaded .NET library could block on -- or consume bytes from
# -- the protocol pipe instead of seeing EOF, desyncing the host exactly
# like an unredirected native stdin read would. TextReader.Null always
# returns EOF immediately without touching any handle. Verified this
# specific race doesn't independently reproduce in THIS bootstrap's actual
# control flow -- DetachStdin is the very first executable statement, well
# before any code (ours or the non-interactive host's own startup) has a
# chance to touch Console.In, so its lazy resolution here always happens
# after the OS-level handle is already NUL-redirected either way. Kept as
# defense-in-depth: SetIn unconditionally replaces whatever reference
# exists (even one a future refactor lets get cached earlier), and it's
# free -- there is no legitimate reason a submitted PowerShell command
# should read interactive stdin from this sidecar.
[Console]::SetIn([System.IO.TextReader]::Null)

function Write-Frame([hashtable] $Object) {
    $json  = $Object | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $len   = [BitConverter]::GetBytes([int]$bytes.Length)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
    $stdout.Write($len, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# PS-native stream colors (SGR). Labels are kept alongside the color so the text
# stays meaningful wherever ANSI is ignored (e.g. the model transcript).
$ESC = [char]27
$NL  = [Environment]::NewLine
function Format-AnsiText([string] $Text, [string] $Sgr) {
    if (-not $Text) { return '' }
    (($Text -split "\r?\n") | ForEach-Object {
        if ($_ -match '\S') { "$ESC[${Sgr}m$_$ESC[0m" } else { $_ }
    }) -join $NL
}

# Emit one non-empty stream block as chunk frames, normalizing a trailing
# newline so merged stream blocks stay visually separated downstream. Large
# blocks are split so a single frame can never exceed the reader's cap (which
# would tear down the host): 4M UTF-16 code units stays well under
# $MaxFrameBytes even after UTF-8 expansion and JSON escaping.
function Write-Chunk([int] $Id, [string] $Stream, [string] $Text) {
    if (-not $Text) { return }
    if (-not $Text.EndsWith("`n")) { $Text += $NL }
    $sliceChars = 4194304
    $offset = 0
    while ($offset -lt $Text.Length) {
        $len = [Math]::Min($sliceChars, $Text.Length - $offset)
        # Substring counts UTF-16 code units. Keep a non-BMP scalar in one
        # frame instead of splitting its surrogate pair into two invalid strings.
        if ($offset + $len -lt $Text.Length -and
            [char]::IsHighSurrogate($Text[$offset + $len - 1]) -and
            [char]::IsLowSurrogate($Text[$offset + $len])) {
            $len--
        }
        Write-Frame @{ type = 'chunk'; id = $Id; stream = $Stream; text = $Text.Substring($offset, $len) }
        $offset += $len
    }
}

# ── Shared session runspace (state lives here, across exec calls) ─────────────
$rs = [RunspaceFactory]::CreateRunspace()
$rs.Open()

function Invoke-OnRunspace([string] $Script, [object[]] $Arguments) {
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($Script)
    if ($Arguments) { foreach ($a in $Arguments) { [void]$ps.AddArgument($a) } }
    try { return $ps.Invoke() } finally { $ps.Dispose() }
}

# Initialize the object-retention store inside the shared runspace.
#
# Per-invocation exit attribution must not depend on $LASTEXITCODE changing
# value. Path-invoked applications and external scripts that exit with the
# same code as the previous native leave $LASTEXITCODE numerically unchanged,
# and some invocations never fire PostCommandLookupAction. A pre-lookup hook
# catches path invocations before resolution; the post-lookup hook classifies
# ordinary commands from PowerShell's resolved CommandInfo. Neither hook sees
# a user assignment to $LASTEXITCODE as command execution.
[void](Invoke-OnRunspace @'
$global:__omp = [ordered]@{}
$global:__omp.Last    = $null
$global:__omp.Counter = 0
$global:__omp.History = [ordered]@{}
$ProgressPreference   = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$global:__ompNativeRan = $false
$ExecutionContext.InvokeCommand.PreCommandLookupAction = {
    param($sender, $event)
    if ($event.CommandName -match '^(?:[A-Za-z]:)?[\\/]') {
        $global:__ompNativeRan = $true
    }
}
$ExecutionContext.InvokeCommand.PostCommandLookupAction = {
    param($sender, $event)
    if ($event.Command.CommandType -in @(
        [System.Management.Automation.CommandTypes]::Application,
        [System.Management.Automation.CommandTypes]::ExternalScript
    )) {
        $global:__ompNativeRan = $true
    }
}
'@)

# ── Exec lifecycle ───────────────────────────────────────────────────────────
# $current holds the single in-flight pipeline (the runspace runs one at a time;
# the omp manager serializes calls, the host enforces it).
$script:current = $null

# Detects a `return` statement at TOP LEVEL of $Command — i.e. not nested
# inside a function or scriptblock literal defined within the command text
# itself (those already have their own return boundary and are unaffected).
# Start-Exec splices $Command directly into $wrapped's try block for speed
# and to preserve Write-Error's compact ConciseView formatting (any nested
# scriptblock/function invocation boundary makes PowerShell fall back to a
# verbose per-error position block — confirmed empirically, and it also
# inflates high-volume error output past OutputSink's truncation window).
# A bare top-level `return`, though, would exit the WHOLE wrapped script via
# that same splice, skipping the counter/history/Out-String bookkeeping in
# the try's `finally` (see Start-Exec) — so those commands are instead
# dot-sourced from a literal scriptblock, which gives `return` its own
# boundary while still not opening a child scope (dot-sourcing never does),
# so user variables keep persisting into the next call either way.
function Test-HasTopLevelReturn([string] $Command) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($Command, [ref] $tokens, [ref] $parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        # Let the wrapped script itself surface the real syntax error at
        # invoke time (existing behavior) — don't second-guess unparsable text.
        return $false
    }
    $returns = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ReturnStatementAst] }, $true)
    foreach ($r in $returns) {
        $enclosing = $r.Parent
        $nested = $false
        while ($enclosing -and $enclosing -ne $ast) {
            if ($enclosing -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
                $enclosing -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) {
                $nested = $true
                break
            }
            $enclosing = $enclosing.Parent
        }
        if (-not $nested) { return $true }
    }
    return $false
}

function Start-Exec([pscustomobject] $Request) {
    $id      = [int]$Request.id
    $command = [string]$Request.command
    $width   = if ($Request.width) { [int]$Request.width } else { 120 }

    # Clear stale [Console]::Out/Error content before this exec begins: a
    # background .NET task/thread spawned by a PREVIOUS command can keep
    # writing to these process-global buffers after that command's pipeline
    # has already completed and been drained. Without this, Complete-Exec
    # would attach that late, unrelated text to THIS exec's result. Mirrors
    # the Rust-side stderr_tail clear-at-start-of-exec fix (round 25) — a
    # background writer racing this exact clear remains a possible few-ms
    # window, but idle-period leakage is no longer unbounded.
    [void]$script:consoleOut.Drain()
    [void]$script:consoleErr.Drain()

    # cwd + env are injected as data (a session-state variable / the process env),
    # never string-interpolated, so user values cannot inject code. cwd is applied
    # via Set-Location inside the pipeline (see $wrapped): a bad path fails the run
    # fast instead of silently running the command in the previous directory.
    $requestedCwd = if ($Request.cwd) { [string]$Request.cwd } else { $null }
    $rs.SessionStateProxy.SetVariable('__ompCwd', $requestedCwd)
    # Clear the per-invocation exit sentinel host-side (via the proxy) BEFORE
    # $wrapped is built and parsed. A syntactically invalid user command throws
    # at parse time, so the in-band reset would never run and Complete-Exec
    # would read a stale __ompExit left by an earlier native command.
    $rs.SessionStateProxy.SetVariable('__ompExit', $null)
    if ($Request.env) {
        foreach ($p in $Request.env.PSObject.Properties) {
            # Process-scoped and never unset: per-call env persists for the
            # host's lifetime, consistent with shell-session semantics.
            [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value)
        }
    }

    # Two evaluation phases in the expandable here-string below: backtick-escaped
    # `$ (e.g. `$global:...) is literal text that executes LATER in the shared
    # runspace; bare $ ($commandBody) interpolates template values NOW,
    # host-side. Edit with that rule in mind.
    #
    # $commandBody runs BARE (unwrapped) at top scope so its own pipeline
    # output streams directly into $wrapped's own output stream -- captured
    # live in $out (the PSDataCollection given to BeginInvoke below) as it's
    # produced, regardless of whether a LATER statement throws a terminating
    # error. This used to be `$global:__omp.Last = @($commandBody)`: an
    # array-subexpression assignment is atomic -- if $commandBody threw
    # partway through, the WHOLE assignment was skipped (confirmed
    # empirically: `$x = @("before"; throw "boom")` leaves $x completely
    # UNCHANGED, not partially populated), silently discarding every object
    # already produced and leaving $global:__omp.Last/History/render
    # pointing at the PREVIOUS command instead of finalizing this one. $out
    # doesn't have that atomicity problem, so Complete-Exec (after
    # EndInvoke, success or not) now does the retention/History/render work
    # itself from $out's actual contents -- see there for the rest.
    # try/finally is a plain block (unlike & {}) so it doesn't open a child
    # scope, keeping `$x = 1` in the user command persisted into the next
    # call. $LASTEXITCODE is never written by the wrapper, so user commands
    # always read the true persisted value; this invocation's native exit is
    # attributed by the command-lookup hooks (including same-code path
    # repeats) inside a finally, so it is recorded even when the command
    # throws, calls exit, returns, or the pipeline is stopped. $commandBody
    # sits alone on its own line so a trailing line-comment cannot swallow the
    # `} finally {` that follows.
    #
    # See Test-HasTopLevelReturn above: most commands splice directly (fast
    # path, unchanged since introduction); a command with a bare top-level
    # `return` is dot-sourced from a literal scriptblock instead, so `return`
    # exits only the user command, not the whole wrapped script.
    $commandBody = if (Test-HasTopLevelReturn $command) { ". {`n$command`n}" } else { $command }
    $wrapped = @"
if (`$__ompCwd) {
    try { Set-Location -LiteralPath `$__ompCwd -ErrorAction Stop }
    catch { Write-Error "Set-Location failed: `$(`$_.Exception.Message)"; return }
}
`$global:__ompPrevExit = `$global:LASTEXITCODE
`$global:__ompNativeRan = `$false
try {
$commandBody
} finally {
if (`$global:__ompNativeRan -and `$null -ne `$global:LASTEXITCODE) {
    `$global:__ompExit = [int]`$global:LASTEXITCODE
}
}
"@

    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($wrapped)
    $out   = [System.Management.Automation.PSDataCollection[psobject]]::new()
    $async = $ps.BeginInvoke([System.Management.Automation.PSDataCollection[psobject]]$null, $out)
    $script:current = @{
        Id = $id; PS = $ps; Async = $async; Out = $out; Width = $width; Stopped = $false
        # High-water marks for incremental stream publishing (Publish-Streams).
        InfoIdx = 0; WarnIdx = 0; VerboseIdx = 0; DebugIdx = 0; ErrorIdx = 0
        # Sticky flag: Error records are released like the other streams
        # (see Publish-Streams) so a high-volume error loop can't retain
        # every record for the command's full duration; Complete-Exec reads
        # this instead of Streams.Error.Count, which would go back to 0
        # once records are removed.
        HadErrorRecords = $false
        # Sticky flag: direct [Console]::Error writes are now periodically
        # drained (see Publish-Streams) like the other streams, so
        # Complete-Exec can no longer tell from the buffer's state alone
        # whether this exec ever wrote anything to it (a poll may have
        # already drained and cleared it before completion runs).
        HadConsoleErr = $false
    }
}

# Publish new entries from the pipeline's data streams as labeled chunks.
# Called from the poll loop while the pipeline runs — so Write-Host /
# Write-Warning / Write-Verbose / Write-Debug / Write-Error progress reaches
# the TUI live instead of buffering until completion — and once more from
# Complete-Exec for the tail. PSDataCollection is documented thread-safe for
# concurrent producer/consumer access, so indexed reads here are safe while
# the pipeline thread appends. Success output is NOT streamed: PowerShell's
# table formatting needs the whole collection to size columns, so rendering
# per-object would regress every tabular result (see Complete-Exec).
function Publish-Streams([hashtable] $Cur) {
    $s = $Cur.PS.Streams

    # Info/Warning/Verbose/Debug records are released the instant they're
    # published: a long-running high-volume command (e.g. Write-Host in a
    # tight million-iteration loop) would otherwise retain every record for
    # the command's full duration even though its text already left via
    # Write-Chunk, growing the sidecar's memory unbounded. Indices `0..n-1`
    # (everything published since the last poll) are what's removed each
    # time; anything the pipeline appended AFTER `n` concurrently, while we
    # were reading/removing, is left untouched -- appends only ever land at
    # the end. The index resets to 0 to match the now-empty-up-to-`n`
    # collection.
    #
    # RemoveAt runs from `n-1` down to `0`, NOT ascending from `0`:
    # PSDataCollection has no RemoveRange, and removing index 0 repeatedly
    # shifts every remaining element down by one on EVERY call, making an
    # n-record burst O(n^2) instead of O(n) -- exactly the high-volume
    # bursts this release exists to stay responsive under. Removing from
    # the highest index first only shifts whatever was appended
    # concurrently past `n` (typically nothing, since the whole snapshot up
    # to `n` is being cleared in one pass) instead of the whole remaining
    # collection on every single removal.
    #
    # Error records are released the same way as the streams above: a
    # high-volume error loop (e.g. Write-Error ... -ErrorAction Continue in
    # a tight loop) would otherwise retain every ErrorRecord for the
    # command's full duration even though its text already left via
    # Write-Chunk. Complete-Exec's hadErrors check reads the sticky
    # HadErrorRecords flag set below instead of Streams.Error.Count (which
    # would read back 0 once records are removed).
    $n = $s.Information.Count
    if ($n -gt $Cur.InfoIdx) {
        $lines = for ($i = $Cur.InfoIdx; $i -lt $n; $i++) { [string]$s.Information[$i].MessageData }
        for ($i = $n - 1; $i -ge 0; $i--) { $s.Information.RemoveAt($i) }
        $Cur.InfoIdx = 0
        Write-Chunk -Id $Cur.Id -Stream 'information' -Text (@($lines) -join $NL)
    }
    $n = $s.Warning.Count
    if ($n -gt $Cur.WarnIdx) {
        $lines = for ($i = $Cur.WarnIdx; $i -lt $n; $i++) { "WARNING: $($s.Warning[$i].Message)" }
        for ($i = $n - 1; $i -ge 0; $i--) { $s.Warning.RemoveAt($i) }
        $Cur.WarnIdx = 0
        Write-Chunk -Id $Cur.Id -Stream 'warning' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Verbose.Count
    if ($n -gt $Cur.VerboseIdx) {
        $lines = for ($i = $Cur.VerboseIdx; $i -lt $n; $i++) { "VERBOSE: $($s.Verbose[$i].Message)" }
        for ($i = $n - 1; $i -ge 0; $i--) { $s.Verbose.RemoveAt($i) }
        $Cur.VerboseIdx = 0
        Write-Chunk -Id $Cur.Id -Stream 'verbose' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Debug.Count
    if ($n -gt $Cur.DebugIdx) {
        $lines = for ($i = $Cur.DebugIdx; $i -lt $n; $i++) { "DEBUG: $($s.Debug[$i].Message)" }
        for ($i = $n - 1; $i -ge 0; $i--) { $s.Debug.RemoveAt($i) }
        $Cur.DebugIdx = 0
        Write-Chunk -Id $Cur.Id -Stream 'debug' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Error.Count
    if ($n -gt $Cur.ErrorIdx) {
        $Cur.HadErrorRecords = $true
        $text = $(for ($i = $Cur.ErrorIdx; $i -lt $n; $i++) { $s.Error[$i] }) | Out-String -Width $Cur.Width
        for ($i = $n - 1; $i -ge 0; $i--) { $s.Error.RemoveAt($i) }
        $Cur.ErrorIdx = 0
        Write-Chunk -Id $Cur.Id -Stream 'error' -Text (Format-AnsiText $text '31;1')
    }
    # Direct [Console]::Out/Error writes, periodically drained the same way
    # as the PS data streams above -- QueueWriter.Drain() is lock-free-safe
    # to call from this (main) thread while the pipeline thread concurrently
    # writes, unlike the previous StringBuilder-backed implementation.
    # HadConsoleErr is sticky (mirrors HadErrorRecords) since Complete-Exec
    # can no longer infer "did this exec ever write to Console.Error" from
    # the buffer's state once polling has already drained it.
    if ($script:consoleOut.HasContent) {
        Write-Chunk -Id $Cur.Id -Stream 'output' -Text $script:consoleOut.Drain()
    }
    if ($script:consoleErr.HasContent) {
        $Cur.HadConsoleErr = $true
        Write-Chunk -Id $Cur.Id -Stream 'error' -Text (Format-AnsiText $script:consoleErr.Drain() '31;1')
    }
}

function Complete-Exec {
    $cur = $script:current
    $script:current = $null

    # A terminating error that escapes the whole wrapped script (bare
    # `throw`/`-ErrorAction Stop` past the try/finally) never reaches
    # Streams.Error -- PowerShell reports it by making EndInvoke itself
    # throw a MethodInvocationException instead (confirmed empirically:
    # Streams.Error.Count stays 0 for this exact case). Unwrap it via
    # IContainsErrorRecord so the error's own text/position still surfaces
    # instead of silently vanishing behind a generic "Command reported
    # errors" note with zero detail.
    $terminatingErrorText = $null
    try {
        $cur.PS.EndInvoke($cur.Async) | Out-Null
    } catch {
        $inner = $_.Exception.InnerException
        $terminatingErrorText = if ($inner -is [System.Management.Automation.IContainsErrorRecord]) {
            $inner.ErrorRecord | Out-String -Width $cur.Width
        } else {
            $_.Exception.Message
        }
    }

    # hadErrors is finalized AFTER Publish-Streams (below) runs its final
    # drain -- HadConsoleErr is set there, not computed from the
    # QueueWriter's state here, since polling may have already drained and
    # cleared any Console.Error content before completion runs.

    # Retain result objects (inspectable via Enter-PSHostProcess) and update
    # the History ring from whatever the pipeline actually produced. Done
    # here -- after EndInvoke, using $cur.Out -- rather than as $wrapped's
    # own trailing statement: $cur.Out accumulates objects live as they're
    # streamed, independent of whether the pipeline later throws a
    # terminating error, so this finalizes Last/Counter/History even for a
    # command that emitted output and THEN failed. Render via
    # Invoke-OnRunspace (not the host's own default runspace) so Out-String
    # sees $rs's own format data/culture/$FormatEnumerationLimit -- the
    # same context this render used to run in as $wrapped's own trailing
    # line. Success output renders once, from the whole collection: per-
    # object rendering would break table formatting (columns are sized from
    # every row). The data streams have been flowing live via
    # Publish-Streams; the tail is drained below.
    $omp = $null
    try { $omp = $rs.SessionStateProxy.GetVariable('__omp') } catch { } # best-effort
    $renderedOutput = ''
    if ($null -ne $omp) {
        $omp.Last = @($cur.Out)
        $omp.Counter++
        # History keys must stay strings: int indexing of an ordered
        # dictionary is positional, while @(Keys)[0] eviction below relies
        # on keyed writes.
        $omp.History[[string]$omp.Counter] = $omp.Last
        while ($omp.History.Count -gt $HistoryDepth) {
            $k = @($omp.History.Keys)[0]
            $omp.History.Remove($k)
        }
        $renderedOutput = (Invoke-OnRunspace 'param($w) $global:__omp.Last | Out-String -Width $w' @($cur.Width)) -join ''
    }
    Write-Chunk -Id $cur.Id -Stream 'output' -Text $renderedOutput
    if ($null -ne $terminatingErrorText) {
        Write-Chunk -Id $cur.Id -Stream 'error' -Text (Format-AnsiText $terminatingErrorText '31;1')
    }
    # Final drain: catches any Console.Out/Error and PS-stream content
    # written since the last poll (or the whole thing, for a fast command
    # that never got polled while running) and sets HadConsoleErr.
    Publish-Streams $cur
    $hadErrors = [bool]$cur.PS.HadErrors -or $cur.HadErrorRecords -or $cur.HadConsoleErr -or ($null -ne $terminatingErrorText)

    # Per-invocation exit code: the wrapped script records __ompExit only when
    # this pipeline ran a native/external-script command (LASTEXITCODE write
    # breakpoint flag or exit-code value change), so a stale code from an
    # earlier call never marks a later PS-only command as failed, while
    # $LASTEXITCODE itself stays untouched and readable.
    $ec = $null
    try { $ec = $rs.SessionStateProxy.GetVariable('__ompExit') } catch { } # best-effort
    $exitCode = if ($null -ne $ec) { [int]$ec } else { $null }

    $cur.PS.Dispose()
    Write-Frame @{ type = 'done'; id = $cur.Id; exitCode = $exitCode; hadErrors = $hadErrors; stopped = [bool]$cur.Stopped }
}

# ── Main event loop: async stdin reads + cooperative pipeline polling ─────────
Write-Frame @{ type = 'ready'; pid = $PID }

$buf      = [byte[]]::new(65536)
$pending  = [System.Collections.Generic.List[byte]]::new()
$readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
$alive    = $true
$watchdog = [System.Diagnostics.Stopwatch]::StartNew()

# PID-reuse guard for the watchdog: remember the parent's start time at launch;
# a recycled PID belonging to some new process will not match it.
$parentStart = $null
if ($ParentPid -gt 0) {
    try { $parentStart = (Get-Process -Id $ParentPid -ErrorAction Stop).StartTime } catch { } # best-effort
}

while ($alive) {
    # Parent-liveness watchdog (orphan guard for a hard omp crash), polled at
    # ~1s rather than every tick to keep idle CPU negligible.
    if ($ParentPid -gt 0 -and $watchdog.ElapsedMilliseconds -ge 1000) {
        $watchdog.Restart()
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        $parentGone = (-not $parent) -or ($parentStart -and $parent.StartTime -ne $parentStart)
        if ($parentGone) {
            # omp itself crashed or was hard-killed: nothing is left to call
            # dispose()'s Rust-side cleanup, which is what normally signals
            # this sidecar's own process group (round-4 spawns it as the
            # group leader) to reap background descendants -- a command's
            # fire-and-forget child, etc. Signal the group directly from
            # here instead, so those descendants don't survive as orphans
            # just because the watchdog's own exit path below only ever
            # tears down this one process.
            #
            # The TERM/KILL pair must NOT be sent directly from this pwsh
            # process: `-- "-$PID"` (negative pid) targets every member of
            # the group, INCLUDING this process itself, and pwsh's default
            # SIGTERM disposition is immediate termination -- signal
            # delivery can beat the interpreter back to the very next
            # statement, so a direct `kill -TERM` here could kill pwsh
            # before the follow-up `kill -KILL` escalation ever runs,
            # leaving a descendant that ignores/traps SIGTERM to survive
            # with its file locks held. Instead, spawn a detached bash
            # helper to run the whole TERM-then-KILL sequence: `set -m`
            # (job control, portable to both Linux and macOS bash without
            # depending on the Linux-only `setsid` binary) places the
            # backgrounded subshell in its OWN new process group, so it
            # survives regardless of what happens to this process or the
            # wrapper bash that spawned it.
            if (-not $IsWindows) {
                try {
                    $killScript = "set -m; ( kill -TERM -- -$PID 2>/dev/null; sleep 0.3; " +
                        "kill -KILL -- -$PID 2>/dev/null ) & disown"
                    $psi = New-Object System.Diagnostics.ProcessStartInfo
                    $psi.FileName = '/bin/bash'
                    $psi.ArgumentList.Add('-c')
                    $psi.ArgumentList.Add($killScript)
                    $psi.UseShellExecute = $false
                    [void][System.Diagnostics.Process]::Start($psi)
                } catch { } # best-effort
            }
            break
        }
    }

    # 50ms tick: an arriving frame completes the read task and unblocks Wait
    # immediately, so this bounds only pipeline-completion polling latency
    # while keeping the idle wakeup rate low.
    if ($readTask.Wait(50)) {
        $n = $readTask.Result
        if ($n -le 0) { break }            # stdin EOF -> shut down
        $slice = [byte[]]::new($n)
        [Array]::Copy($buf, 0, $slice, 0, $n)
        $pending.AddRange($slice)
        $readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
    }

    while ($pending.Count -ge 4) {
        $lenBytes = $pending.GetRange(0, 4).ToArray()
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBytes) }
        $frameLength = [BitConverter]::ToInt32($lenBytes, 0)
        if ($frameLength -lt 0 -or $frameLength -gt $MaxFrameBytes) {
            # The stream is desynced beyond recovery; die visibly rather than
            # misparse frames forever. (The shared runspace state is lost either
            # way — there is no realigning a corrupt length-prefixed stream.)
            $alive = $false
            break
        }
        if ($pending.Count -lt 4 + $frameLength) { break }
        $body = $pending.GetRange(4, $frameLength).ToArray()
        $pending.RemoveRange(0, 4 + $frameLength)
        # Framing is still aligned even if one body is garbage: skip it rather
        # than letting a malformed frame tear down the whole session runspace.
        try { $req = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json }
        catch { continue }

        switch ([string]$req.type) {
            'exec' {
                if ($null -eq $script:current) { Start-Exec $req }
                else { Write-Frame @{ type = 'done'; id = [int]$req.id; exitCode = $null; hadErrors = $true; stopped = $false } }
            }
            'stop' {
                if ($script:current -and $script:current.Id -eq [int]$req.id) {
                    $script:current.Stopped = $true
                    # BeginStop, never Stop: a synchronous Stop() blocks this
                    # event loop until the pipeline yields, and a pipeline stuck
                    # in an uncooperative native/.NET call never does — the loop
                    # must stay responsive so completion (or the Rust side's
                    # stop-ack timeout) can proceed.
                    try { [void]$script:current.PS.BeginStop($null, $null) } catch { } # best-effort
                }
            }
            'exit' { $alive = $false }
        }
    }

    if ($script:current) {
        Publish-Streams $script:current
        if ($script:current.Async.IsCompleted) { Complete-Exec }
    }
}

try { $rs.Close() } catch { } # best-effort
exit 0
