import type { ReadableStreamDefaultReader } from "node:stream/web";
import { isFsError, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { throwIfAborted, ToolError } from "../../tool-errors";
import type { RelayKind } from "./kind";
import { NATIVE_HOST } from "./protocol";

const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const WINDOWS_RECORD = new RegExp(`^([1-9][0-9]{0,4}) (${UUID})(?:\\r?\\n)?$`, "i");
const PROBE_OUTPUT_LIMIT = 1024;

// The registered Windows manifest locates custom installs without consulting WSL paths or config.
const WINDOWS_RELAY_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\' + '${NATIVE_HOST}')
if (!$key) { return }
try {
  $manifest = $key.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
} finally {
  $key.Dispose()
}
# Reject UNC, device, relative and ADS paths before looking up any filesystem entry.
if ($manifest -isnot [string] -or $manifest -cnotmatch '\A[A-Za-z]:\\[^/:<>"|?*\x00-\x1f]+\z') { return }
$parts = $manifest.Substring(3).Split('\')
foreach ($part in $parts) {
  if (!$part -or $part -match '[ .]\z') { return }
}
$directory = $manifest.Substring(0, 3)
$driveType = [IO.DriveInfo]::new($directory).DriveType
if ($driveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) { return }
$parts[$parts.Length - 1] = 'endpoints'
# Walk one component at a time so a junction or link cannot redirect the search.
foreach ($part in $parts) {
  $directory = [IO.Path]::Combine($directory, $part)
  $item = Get-Item -LiteralPath $directory -Force
  if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
}

$recordName = '\A([1-9][0-9]{0,9})-([1-9][0-9]{0,4})\z'
$records = @(Get-ChildItem -LiteralPath $directory -File -Force | Where-Object {
  $_.Length -eq 0 -and !($_.Attributes -band ([IO.FileAttributes]::ReparsePoint -bor [IO.FileAttributes]::Device))
} | Sort-Object LastWriteTimeUtc -Descending)
if (!$records.Count) { return }

Add-Type -AssemblyName System.Net.Http
$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMilliseconds(500)
$client.MaxResponseContentBufferSize = 65536
try {
  foreach ($file in $records) {
    if ($file.Name -notmatch $recordName) { continue }
    $owner = [long]$Matches[1]
    $port = [int]$Matches[2]
    if ($port -gt 65535) { continue }
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $owner) { continue }
    try {
      $response = $client.GetAsync("http://127.0.0.1:$port/json/version").GetAwaiter().GetResult()
      try {
        if ([int]$response.StatusCode -notin @(200, 503)) { continue }
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (!$body.TrimStart().StartsWith('{')) { continue }
        $info = ConvertFrom-Json -InputObject $body
      } finally {
        $response.Dispose()
      }
    } catch { continue }
    if ($info.ompRelayVersion -isnot [string] -or !$info.ompRelayVersion -or
        $info.ompRelayInstance -isnot [string] -or $info.ompRelayInstance -notmatch '\A${UUID}\z') { continue }
    [Console]::Out.WriteLine("$port $($info.ompRelayInstance)")
    return
  }
} finally {
  $client.Dispose()
}
`;

const WINDOWS_PROBE_COMMAND = [
	"powershell.exe",
	"-NoProfile",
	"-NonInteractive",
	"-EncodedCommand",
	Buffer.from(WINDOWS_RELAY_PROBE, "utf16le").toString("base64"),
];

async function readProbePipe(reader: ReadableStreamDefaultReader<Uint8Array>, output?: Uint8Array): Promise<number> {
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return size;
		if (size + value.byteLength > PROBE_OUTPUT_LIMIT) {
			throw new ToolError("Windows relay probe exceeded the 1024-byte output limit", {
				stream: output ? "stdout" : "stderr",
			});
		}
		output?.set(value, size);
		size += value.byteLength;
	}
}

/** Find the newest Windows relay whose file record, listener and HTTP identity agree. */
export async function discoverWindowsRelay(signal?: AbortSignal, command = WINDOWS_PROBE_COMMAND): Promise<RelayKind> {
	throwIfAborted(signal);
	const deadline = AbortSignal.timeout(4_000);
	const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let phase = "spawn";
	try {
		const proc = Bun.spawn(command, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			lazy: true,
			signal: probeSignal,
			killSignal: "SIGKILL",
		});
		phase = "read";
		const stdout = proc.stdout.getReader();
		const stderr = proc.stderr.getReader();
		const output = new Uint8Array(PROBE_OUTPUT_LIMIT);
		try {
			// Interop can keep a pipe open after the helper exits, so bound the wait too.
			const [size] = await untilAborted(probeSignal, () =>
				Promise.all([
					readProbePipe(stdout, output),
					readProbePipe(stderr),
					proc.exited.then(exitCode => {
						if (exitCode !== 0) {
							throw new ToolError("Windows relay probe exited unsuccessfully", {
								exitCode,
								signal: proc.signalCode,
							});
						}
					}),
				]),
			);
			probeSignal.throwIfAborted();
			const match = WINDOWS_RECORD.exec(Buffer.from(output.buffer, 0, size).toString("utf8"));
			if (match && Number(match[1]) <= 65535) {
				return { kind: "relay", cdpUrl: `http://127.0.0.1:${match[1]}`, windowsInstance: match[2] };
			}
		} finally {
			if (proc.exitCode === null && proc.signalCode === null && !probeSignal.aborted) proc.kill("SIGKILL");
			for (const reader of [stdout, stderr]) {
				void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
	} catch (error) {
		throwIfAborted(signal);
		if (deadline.aborted) {
			throw new ToolError(
				"Windows browser relay discovery timed out after 4 seconds. Try again or configure browser.relayUrl.",
			);
		}
		// Raw spawn errors can include the encoded command, and pipe data is untrusted.
		const code = isFsError(error) && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? error.code : undefined;
		logger.debug(
			"browser relay: Windows discovery helper failed",
			error instanceof ToolError ? { failure: error.message, ...error.context } : { phase, code },
		);
	}
	throwIfAborted(signal);
	throw new ToolError(
		"No omp browser relay found on Windows. Open Chrome with the omp extension, make sure WSL interop is enabled, or configure browser.relayUrl.",
	);
}
