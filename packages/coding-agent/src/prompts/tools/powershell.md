Execute PowerShell in a persistent `pwsh` host whose session state is retained across calls.

Unlike one-shot shells, every call runs in the **same runspace**: variables, imported modules, functions, the current location, `$LASTEXITCODE`, and the **live result objects** from previous commands all persist. This makes PowerShell's object pipeline first-class — you can run an expensive command once, then inspect or post-process its results in later calls without re-running it.

## When to use

- Windows administration and any task that benefits from PowerShell's object pipeline (`Get-*` cmdlets, `Where-Object`, `Select-Object`, `Group-Object`, `.NET` types).
- Multi-step investigations where later steps depend on earlier results or imported modules.

For simple POSIX-style commands, prefer `bash`. For reading files, searching, or editing, use the dedicated `read` / `search` / `edit` tools.

## Session state

The most recent command's output objects are retained:

- `$__omp.Last` — the live objects emitted by your previous command. Inspect them without re-running: `$__omp.Last | Get-Member`, `$__omp.Last | Format-List *`, `$__omp.Last[0].SomeProperty`, `$__omp.Last | ConvertTo-Json -Depth 6`.
- `$__omp.History` — an ordered map of recent results, capped to the configured depth.

Variables you set persist too: `$data = Get-Process` in one call, then `$data | Sort-Object CPU` in the next.

## Parameters

- `command` (required): PowerShell to execute in the shared runspace.
- `cwd` (optional): working directory for this command; the location persists into the runspace afterward.
- `timeout` (optional): seconds before the in-flight pipeline is stopped. The runspace and all retained state survive a timeout — only the running pipeline is cancelled. (Exception: if the pipeline cannot be stopped because it is blocked in a native call, the host is terminated and the next call starts a fresh session host.)
- `host` (optional): which host runs the command.
  - `session` (default): the persistent session host described above.
  - `ephemeral`: a throwaway host spawned for this call only. Nothing from the session carries in, nothing carries out, and the process is fully terminated before the result returns — so any file locks or loaded assemblies are released by the time you see the output. Use it when loading assemblies or `Add-Type` classes that cannot be unloaded (e.g. importing a DLL you are about to rebuild). Costs a fresh process spawn (~1s) per call.
  - `new-session`: discard the current session host and run in a fresh replacement, which becomes the new session host. All variables, modules, `$__omp` history, and location from the old runspace are lost. Use it when the session runspace is already poisoned (an assembly or type you can no longer get rid of). The old host is fully terminated before the command runs.

## Notes

- All PowerShell output streams are captured. Success output and `Write-Host`/`Write-Information` are returned as-is; `Write-Warning`, `Write-Verbose` (with `-Verbose`), and `Write-Debug` (with `-Debug`) are returned with their `WARNING:`/`VERBOSE:`/`DEBUG:` labels; the error stream is surfaced too. Warnings, verbose, debug, and errors are color-coded like the PowerShell console.
- A non-zero exit code from a native command run in this call, or any error-stream write, marks the result as failed (warnings do not); a stale `$LASTEXITCODE` persisting from an earlier call never does. The command's output is still returned.
- The session host runs one pipeline at a time; session-host calls are serialized. `host: "ephemeral"` calls are independent processes and may run in parallel with other tool calls.
- For live debugging, the result carries the host PID — attach with `Enter-PSHostProcess -Id <pid>` then `Debug-Runspace`. (Not applicable to ephemeral hosts: their process is already gone when the result arrives.)
