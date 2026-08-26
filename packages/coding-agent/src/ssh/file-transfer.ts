/**
 * Byte-preserving remote file I/O over the shared SSH ControlMaster connection.
 *
 * Unlike `executeSSH` (which truncates/sanitizes through an OutputSink) and
 * `runSshCaptureSync` (which `.trim()`s output), these helpers move raw bytes so
 * `ssh://` reads/writes round-trip exactly — leading/trailing whitespace, tabs,
 * and final newlines are preserved.
 */
import { ptree } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import {
	buildPowerShellCommand,
	type PowerShellShell,
	quotePosixPath,
	quotePowerShellLiteral,
	wrapInPosixShell,
} from "./utils";

/** Per-operation timeout for remote transfers (matches the ssh tool's grep window). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Frame markers wrapping every parsed Windows transfer response (spec §3). */
const XFER_BEGIN = "PI_XFER_BEGIN|";
const XFER_END = "PI_XFER_END|";

type TransferChannel = { kind: "posix"; shell: "sh" | "bash" | "zsh" } | { kind: "powershell"; shell: PowerShellShell };

/**
 * Resolve the verified transfer channel for a host. POSIX hosts require a
 * round-tripped sh/bash/zsh (as before, #3719); Windows hosts require a
 * round-tripped powershell/pwsh driving the `-EncodedCommand` channel.
 */
async function resolveTransfer(target: SSHConnectionTarget): Promise<TransferChannel> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (info.os === "windows") {
		if (info.transferShell === "powershell" || info.transferShell === "pwsh") {
			return { kind: "powershell", shell: info.transferShell };
		}
		throw new Error(
			`ssh://: ${target.name} is a Windows host with no reachable powershell/pwsh for ssh:// read/write — use \`bash\` with a remote SSH command for this host`,
		);
	}
	if (info.transferShell === "sh" || info.transferShell === "bash" || info.transferShell === "zsh") {
		return { kind: "posix", shell: info.transferShell };
	}
	// No transferShell — or a powershell/pwsh value, which probing can only
	// produce for a Windows host (a non-Windows host here means a
	// hand-corrupted cache). Either way: no verified POSIX shell.
	throw new Error(
		`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use \`bash\` with a remote SSH command for this host)`,
	);
}

/**
 * Normalize a percent-decoded ssh:// path for a Windows remote: `/C:/x` →
 * `C:\x` (the leading `/` before a drive letter is an artifact of URL paths),
 * `//server/share` → `\\server\share` (UNC), remaining `/` → `\`.
 */
export function normalizeWindowsRemotePath(remotePath: string): string {
	const backslashed = remotePath.replace(/\//g, "\\");
	const drive = backslashed.replace(/^\\([A-Za-z]:\\)/, "$1");
	if (/^[A-Za-z]:\\/.test(drive)) {
		// Alternate data streams (`C:\file:stream`) are rejected: the write
		// contract stages a sibling temp, but a colon in the tail turns the
		// temp into another ADS on the base file, breaking the rename/commit
		// semantics. The drive-letter prefix is the only legal colon.
		if (drive.slice(3).includes(":")) {
			throw new Error(
				`ssh://: Windows paths with alternate data streams are unsupported (colon after the drive letter): ${remotePath}`,
			);
		}
		return drive;
	}
	if (/^\\\\[^\\]+\\[^\\]+/.test(backslashed)) {
		// Win32 device namespaces (`\\.\pipe\x`, `\\?\GLOBALROOT\...`) stat as
		// ordinary files (FileInfo), so the transfer would open a named pipe or
		// kernel object instead of a disk file — reject them outright. A named
		// pipe is `\\server\pipe\name`: `pipe` is the SHARE (second component),
		// not the server.
		const [server = "", share = ""] = backslashed.slice(2).split("\\");
		if (server === "." || server === "?" || share.toLowerCase() === "pipe") {
			throw new Error(
				`ssh://: Win32 device-namespace paths (\\\\.\\, \\\\?\\) and the reserved \\\\server\\pipe\\ share are unsupported for ssh:// transfers: ${remotePath}`,
			);
		}
		if (backslashed.slice(2).includes(":")) {
			throw new Error(
				`ssh://: Windows paths with alternate data streams are unsupported (colon in a UNC component): ${remotePath}`,
			);
		}
		return backslashed;
	}
	throw new Error(
		`ssh://: Windows hosts require an absolute drive path (ssh://host/C:/x) or UNC share (ssh://host//server/share): ${remotePath}`,
	);
}

function ps(lines: string[]): string {
	return lines.join("\r\n");
}

/**
 * Read at most `maxBytes` bytes and emit a strictly framed base64 payload:
 * BEGIN|B64|<n-hex>, one base64 line, END|B64. Base64 transport keeps the
 * payload immune to stdout encoding, CRLF translation, and BOM issues.
 */
export function buildWindowsReadScript(path: string, maxBytes: number): string {
	const p = quotePowerShellLiteral(path);
	return ps([
		"$ErrorActionPreference='Stop'",
		"try {",
		`  $fs = New-Object IO.FileStream(${p}, [IO.FileMode]::Open, [IO.FileAccess]::Read)`,
		"  try {",
		`    $toRead = ${maxBytes}`,
		"    $buf = New-Object byte[] $toRead",
		"    $total = 0",
		"    while ($total -lt $toRead) {",
		"      $n = $fs.Read($buf, $total, $toRead - $total)",
		"      if ($n -le 0) { break }",
		"      $total += $n",
		"    }",
		"    [Console]::Out.Write('PI_XFER_BEGIN|B64|')",
		"    [Console]::Out.Write($total.ToString('x'))",
		"    [Console]::Out.WriteLine('')",
		"    [Console]::Out.WriteLine([Convert]::ToBase64String($buf, 0, $total))",
		"    [Console]::Out.WriteLine('PI_XFER_END|B64')",
		"  } finally { $fs.Dispose() }",
		"} catch {",
		"  [Console]::Error.WriteLine($_.Exception.Message)",
		"  exit 1",
		"}",
		"exit 0",
	]);
}

/**
 * Stage stdin (base64 text) into `tmp` in the destination directory, then
 * commit by destination kind — the Windows mirror of the POSIX branch's
 * contract: a junction or directory symlink is refused (POSIX `-d` follows
 * links, so a link to a directory counts as a directory); a file symlink or
 * dangling link is replaced deterministically — the link itself is removed
 * before the rename, so a write can never land through the link target; an
 * existing regular file is rewritten IN PLACE (FileMode.Create truncates the
 * same NTFS object, preserving its ACLs, hardlinks, and alternate data
 * streams); a new path is committed by rename. The finally block removes the
 * staged temp on every exit path.
 */
export function buildWindowsWriteScript(dest: string, tmp: string): string {
	const d = quotePowerShellLiteral(dest);
	const t = quotePowerShellLiteral(tmp);
	return ps([
		"$ErrorActionPreference='Stop'",
		`$d = ${d}`,
		`$t = ${t}`,
		"try {",
		"  $parent = Split-Path -Parent $t",
		"  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
		"  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
		"  [IO.File]::WriteAllBytes($t, $bytes)",
		"  $existing = $null",
		"  try { $existing = Get-Item -LiteralPath $d -Force -ErrorAction Stop } catch [Management.Automation.ItemNotFoundException] { }",
		"  $isReparse = ($null -ne $existing) -and (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)",
		"  if ($isReparse) {",
		"    if ($existing -is [IO.DirectoryInfo]) {",
		"      [Console]::Error.WriteLine('ssh://: destination is a directory')",
		"      exit 1",
		"    }",
		"    Remove-Item -LiteralPath $d -Force",
		"    Move-Item -LiteralPath $t -Destination $d -Force",
		"  } elseif ($null -ne $existing -and $existing -is [IO.DirectoryInfo]) {",
		"    [Console]::Error.WriteLine('ssh://: destination is a directory')",
		"    exit 1",
		"  } elseif ($null -ne $existing) {",
		"    $src = New-Object IO.FileStream($t, [IO.FileMode]::Open, [IO.FileAccess]::Read)",
		"    try {",
		"      $dst = New-Object IO.FileStream($d, [IO.FileMode]::Create, [IO.FileAccess]::Write)",
		"      try { $src.CopyTo($dst) } finally { $dst.Dispose() }",
		"    } finally { $src.Dispose() }",
		"  } else {",
		"    Move-Item -LiteralPath $t -Destination $d -Force",
		"  }",
		"} catch {",
		"  [Console]::Error.WriteLine($_.Exception.Message)",
		"  exit 1",
		"} finally {",
		"  if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue }",
		"}",
		"exit 0",
	]);
}

/** Emit exactly one of directory/file/other/missing in a STAT frame. */
export function buildWindowsStatScript(path: string): string {
	const p = quotePowerShellLiteral(path);
	return ps([
		"$ErrorActionPreference='Stop'",
		"$item = $null",
		`try { $item = Get-Item -LiteralPath ${p} -Force -ErrorAction Stop }`,
		// Same missing-vs-access-failure split as the resolve script: a false
		// Test-Path would mask ACL/UNC errors as 'missing'.
		"catch [Management.Automation.ItemNotFoundException] { }",
		"catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
		"if ($null -eq $item) { $k = 'missing' }",
		"elseif ($item -is [IO.DirectoryInfo]) { $k = 'directory' }",
		"elseif ($item -is [IO.FileInfo]) { $k = 'file' }",
		"else { $k = 'other' }",
		"[Console]::Out.WriteLine('PI_XFER_BEGIN|STAT|0')",
		"[Console]::Out.WriteLine($k)",
		"[Console]::Out.WriteLine('PI_XFER_END|STAT')",
	]);
}

/**
 * One-roundtrip classification+fetch for Windows remotes: classify the path
 * in-script, then emit whichever frame matches — LIST for a directory (or a
 * plain B64 for a regular file when `maxBytes` >= 0), STAT otherwise. Saves
 * a full ssh exec roundtrip (~0.75s on hosts without connection multiplexing)
 * versus the POSIX stat-then-fetch sequence, whose per-command cost on such
 * hosts is dominated by remote channel/process creation, not the handshake.
 */
export function buildWindowsResolveScript(path: string, maxBytes: number, skipListing = false): string {
	const p = quotePowerShellLiteral(path);
	const lines = [
		"$ErrorActionPreference='Stop'",
		"$item = $null",
		`try { $item = Get-Item -LiteralPath ${p} -Force -ErrorAction Stop }`,
		// Item-not-found is the only condition that maps to 'missing'; any
		// other lookup failure (ACL denial, unreachable UNC share, provider
		// error) must exit nonzero so the real error surfaces instead of a
		// false "No such file or directory".
		"catch [Management.Automation.ItemNotFoundException] { }",
		"catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
		"if ($null -eq $item) { $k = 'missing' }",
		"elseif ($item -is [IO.DirectoryInfo]) { $k = 'directory' }",
		"elseif ($item -is [IO.FileInfo]) { $k = 'file' }",
		"else { $k = 'other' }",
	];
	if (maxBytes >= 0) {
		lines.push(
			"if ($k -eq 'file') {",
			`  $fs = New-Object IO.FileStream(${p}, [IO.FileMode]::Open, [IO.FileAccess]::Read)`,
			"  try {",
			`    $toRead = ${maxBytes + 1}`,
			"    $buf = New-Object byte[] $toRead",
			"    $total = 0",
			"    while ($total -lt $toRead) {",
			"      $n = $fs.Read($buf, $total, $toRead - $total)",
			"      if ($n -le 0) { break }",
			"      $total += $n",
			"    }",
			"    [Console]::Out.Write('PI_XFER_BEGIN|B64|')",
			"    [Console]::Out.Write($total.ToString('x'))",
			"    [Console]::Out.WriteLine('')",
			"    [Console]::Out.WriteLine([Convert]::ToBase64String($buf, 0, $total))",
			"    [Console]::Out.WriteLine('PI_XFER_END|B64')",
			"    exit 0",
			"  } finally { $fs.Dispose() }",
			"}",
		);
	}
	if (skipListing) {
		// Classification still needs the LIST frame kind; an empty body plus a
		// header count of 0 communicates "directory, listing skipped" without
		// enumerating (parity with the POSIX skipListing contract).
		lines.push(
			"if ($k -eq 'directory') {",
			"  [Console]::Out.WriteLine('PI_XFER_BEGIN|LIST|0')",
			"  [Console]::Out.WriteLine('PI_XFER_END|LIST')",
			"  exit 0",
			"}",
		);
	} else {
		lines.push(
			"if ($k -eq 'directory') {",
			`  $entries = @(Get-ChildItem -LiteralPath ${p} -Force)`,
			"  [Console]::Out.Write('PI_XFER_BEGIN|LIST|')",
			"  [Console]::Out.WriteLine($entries.Count.ToString('x'))",
			"  foreach ($e in $entries) {",
			"    if ($e.PSIsContainer) { $n2 = $e.Name + '/' } else { $n2 = $e.Name }",
			"    [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n2)))",
			"  }",
			"  [Console]::Out.WriteLine('PI_XFER_END|LIST')",
			"  exit 0",
			"}",
		);
	}
	lines.push(
		"[Console]::Out.WriteLine('PI_XFER_BEGIN|STAT|0')",
		"[Console]::Out.WriteLine($k)",
		"[Console]::Out.WriteLine('PI_XFER_END|STAT')",
		"exit 0",
	);
	return ps(lines);
}

/**
 * One strict-base64 line per entry (directories carry a trailing `/` INSIDE
 * the encoded payload, so non-ASCII names never touch the output encoding),
 * framed LIST|<count-hex> with the count cross-checked locally. Dotfiles
 * included (`-Force`). A missing/unreadable directory surfaces as a non-zero
 * exit via $ErrorActionPreference='Stop' — plain-ls parity, no masked empty
 * listing.
 */
export function buildWindowsListDirScript(path: string): string {
	const p = quotePowerShellLiteral(path);
	return ps([
		"$ErrorActionPreference='Stop'",
		`$entries = @(Get-ChildItem -LiteralPath ${p} -Force)`,
		"[Console]::Out.Write('PI_XFER_BEGIN|LIST|')",
		"[Console]::Out.WriteLine($entries.Count.ToString('x'))",
		"foreach ($e in $entries) {",
		"  if ($e.PSIsContainer) { $n = $e.Name + '/' } else { $n = $e.Name }",
		"  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($n)))",
		"}",
		"[Console]::Out.WriteLine('PI_XFER_END|LIST')",
	]);
}

const STRICT_B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Full BEGIN line contract: marker, kind enum, lowercase hex count — nothing else. */
const BEGIN_LINE_RE = /^PI_XFER_BEGIN\|(B64|STAT|LIST)\|([0-9a-f]+)$/;

/**
 * A strict-frame validation failure in the Windows transfer protocol (malformed
 * marker/base64/header, out-of-enum STAT body, bad LIST entry). Distinguishable
 * by type so callers can rethrow it instead of falling back to another
 * operation — a protocol-validation error must never degrade into a different
 * result (e.g. accepted file content) while transport failures may.
 */
export class WindowsTransferProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WindowsTransferProtocolError";
	}
}

function protocolError(what: string, stdout: string): never {
	throw new WindowsTransferProtocolError(
		`ssh://: Windows transfer protocol error (${what}); raw output sample: ${JSON.stringify(stdout.slice(0, 200))}`,
	);
}

/**
 * Strictly validate and decode a framed Windows transfer response. Remote
 * stdout is third-party data: anything that does not match the expected
 * single BEGIN/END pair of `kind` — malformed base64, wrong header count,
 * out-of-enum STAT bodies, stray or duplicated markers, a malformed BEGIN
 * line — is a protocol error, never degraded into file content or a `missing`
 * classification. Non-marker lines outside the frame (login banners) are
 * ignored.
 */
function parseTransferFrame(kind: "B64", stdout: string): Uint8Array;
function parseTransferFrame(kind: "STAT", stdout: string): RemotePathKind;
function parseTransferFrame(kind: "LIST", stdout: string): RemoteDirEntry[];
function parseTransferFrame(
	kind: "B64" | "STAT" | "LIST",
	stdout: string,
): Uint8Array | RemotePathKind | RemoteDirEntry[] {
	const lines = stdout.split(/\r?\n/);
	const beginIdx = lines.findIndex(l => l.startsWith(XFER_BEGIN));
	const endIdx = lines.findIndex(l => l.startsWith(XFER_END));
	if (beginIdx === -1) protocolError(`no ${XFER_BEGIN}${kind} frame`, stdout);
	if (endIdx === -1 || endIdx < beginIdx) protocolError(`missing ${XFER_END}${kind}`, stdout);
	// The selected pair must be the ONLY marker occurrence in the stream: a
	// stray BEGIN/END anywhere else (a second frame after the selected one, an
	// injected duplicate, markers inside the body) is corruption, not noise.
	for (let i = 0; i < lines.length; i++) {
		if (i !== beginIdx && i !== endIdx && (lines[i].startsWith(XFER_BEGIN) || lines[i].startsWith(XFER_END))) {
			protocolError(`stray frame marker at line ${i + 1}`, stdout);
		}
	}
	const beginMatch = BEGIN_LINE_RE.exec(lines[beginIdx]);
	if (!beginMatch) protocolError(`malformed ${XFER_BEGIN} line`, stdout);
	if (beginMatch[1] !== kind) protocolError(`expected ${kind} frame, got ${beginMatch[1]}`, stdout);
	if (lines[endIdx] !== `${XFER_END}${kind}`) protocolError("END kind mismatch", stdout);
	const header = Number.parseInt(beginMatch[2], 16);
	if (!Number.isSafeInteger(header) || header < 0) protocolError("bad header", stdout);
	const body = lines.slice(beginIdx + 1, endIdx);

	if (kind === "B64") {
		if (body.length !== 1) protocolError("B64 body must be exactly one line", stdout);
		const line = body[0];
		if (!STRICT_B64_RE.test(line) || line.length % 4 !== 0) {
			protocolError("B64 body is not strict base64", stdout);
		}
		const bytes = Buffer.from(line, "base64");
		if (bytes.length !== header) protocolError(`header says ${header} bytes, got ${bytes.length}`, stdout);
		return bytes;
	}
	if (kind === "STAT") {
		if (body.length !== 1) protocolError("STAT body must be exactly one line", stdout);
		const out = body[0];
		if (out !== "directory" && out !== "file" && out !== "other" && out !== "missing") {
			protocolError(`STAT body out of enum: ${JSON.stringify(out)}`, stdout);
		}
		return out;
	}
	// LIST
	if (body.length !== header) protocolError(`LIST header says ${header} entries, got ${body.length}`, stdout);
	const entries: RemoteDirEntry[] = [];
	for (const line of body) {
		if (!STRICT_B64_RE.test(line) || line.length % 4 !== 0 || line.length === 0) {
			protocolError("LIST entry is not strict base64", stdout);
		}
		let name: string;
		try {
			// Remote names are third-party data: invalid UTF-8 must surface as
			// a protocol error, never silently degrade into U+FFFD.
			name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line, "base64"));
		} catch {
			protocolError("LIST entry is not valid UTF-8", stdout);
		}
		const isDirectory = name.endsWith("/");
		const base = isDirectory ? name.slice(0, -1) : name;
		if (base.length === 0 || base.includes("/") || base.includes("\0")) {
			protocolError(`LIST entry has invalid name: ${JSON.stringify(name)}`, stdout);
		}
		entries.push({ name: base, isDirectory });
	}
	return entries;
}

export interface RemoteFileReadOptions {
	/** Maximum bytes to materialize; the helper fetches one extra byte to detect truncation. */
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RemoteFileReadResult {
	/** Raw file bytes, capped at `maxBytes`. */
	bytes: Uint8Array;
	/** True when the remote file was larger than `maxBytes` (`bytes` is the prefix). */
	truncated: boolean;
}

export interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

/**
 * Read a remote file's raw bytes. Fetches `maxBytes + 1` so the caller can
 * distinguish an exactly-`maxBytes` file from a larger (truncated) one.
 *
 * Throws `ptree.NonZeroExitError` (carrying the remote stderr tail) when the
 * file is missing/unreadable or the host is unreachable.
 */
export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const channel = await resolveTransfer(target);
	if (channel.kind === "powershell") {
		const norm = normalizeWindowsRemotePath(remotePath);
		const script = buildWindowsReadScript(norm, opts.maxBytes + 1);
		const args = await buildRemoteCommand(target, buildPowerShellCommand(channel.shell, script));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const text = new TextDecoder().decode(await child.bytes());
		await child.exitedCleanly;
		const raw = parseTransferFrame("B64", text);
		const truncated = raw.length > opts.maxBytes;
		return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
	}
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(channel.shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	// Drain stdout before awaiting exit so a full pipe can't deadlock the child.
	const raw = await child.bytes();
	await child.exitedCleanly;
	const truncated = raw.length > opts.maxBytes;
	return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
}

/**
 * Write `content` to a remote file byte-exact. Stdin is always staged first into
 * a uniquely named temp in the destination directory (so the remote never blocks
 * on an unread pipe and a dropped connection lands in the temp, never the
 * destination). The destination then dictates the commit:
 *  - a directory — or a symlink to one, since the `-d` test follows links — is
 *    refused (a plain `mv tmp dir` would move the temp INTO it).
 *  - an existing non-symlink regular file is rewritten IN PLACE from the staged
 *    temp, preserving its inode and therefore its ordinary permission bits (a
 *    `0600` secret stays `0600` on overwrite), ACLs, xattrs, and hardlinks. The
 *    setuid/setgid bits may be cleared by the write (per POSIX). This commit is
 *    not fully atomic — a remote-side failure during the local temp->dest copy
 *    (e.g. the disk filling) can truncate the destination — but the slow network
 *    transfer has already landed in the temp, and the temp is removed on failure.
 *    It also needs write permission on the file itself (a read-only file is
 *    refused, not silently replaced).
 *  - an existing special file (FIFO/socket/device) is refused, not replaced.
 *  - anything else (a new path, a symlink to a non-directory, a dangling symlink)
 *    is committed with an atomic rename, which REPLACES a symlink with a regular
 *    file rather than writing through it (resolving the link target is not
 *    portable across the macOS/Linux hosts this stack supports).
 * Throws `ptree.NonZeroExitError` when the remote path is unwritable or the host
 * is unreachable.
 */
export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions = {},
): Promise<void> {
	const channel = await resolveTransfer(target);
	if (remotePath.endsWith("/")) {
		throw new Error("ssh://: destination is a directory path (trailing '/'); ssh:// write requires a file path");
	}
	if (channel.kind === "powershell") {
		const dest = normalizeWindowsRemotePath(remotePath);
		const tmp = `${dest}.omp-tmp.${crypto.randomUUID()}`;
		const script = buildWindowsWriteScript(dest, tmp);
		const args = await buildRemoteCommand(target, buildPowerShellCommand(channel.shell, script), {
			allowStdin: true,
		});
		// Base64 on stdin: ASCII-safe text through any pipe encoding.
		const stdin = new TextEncoder().encode(Buffer.from(content).toString("base64"));
		using child = ptree.spawn(["ssh", ...args], {
			stdin,
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		await child.exitedCleanly;
		return;
	}
	const dest = quotePosixPath(remotePath);
	const tmp = quotePosixPath(`${remotePath}.omp-tmp.${crypto.randomUUID()}`);
	// Stage stdin into the temp first (so the remote never blocks on an unread
	// pipe and a dropped connection lands in the temp, never the destination).
	// An EXIT trap removes the staged temp on every exit path (staging failure,
	// in-place success, refuse branches, or a failed rename). Commit by
	// destination kind: a directory (or symlink to one; `-d` follows links) is
	// refused; an existing non-symlink regular file is rewritten IN PLACE
	// (preserving inode, permission bits, ACLs, xattrs, hardlinks; setuid/setgid
	// may clear); an existing special file (FIFO/socket/device) is refused;
	// anything else (a new path or a symlink to a non-directory) uses temp+rename,
	// replacing such a symlink rather than writing through it.
	const command =
		`t=${tmp}; trap 'rm -f -- "$t"' 0; ` +
		`mkdir -p -- "$(dirname "$t")" && ` +
		`cat > "$t" && { ` +
		`if [ -d ${dest} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; ` +
		`elif [ -f ${dest} ] && [ ! -L ${dest} ]; then cat "$t" > ${dest} || exit 1; ` +
		`elif [ -e ${dest} ] && [ ! -L ${dest} ]; then echo 'ssh://: destination is a special file (not a regular file)' >&2; exit 1; ` +
		`else mv "$t" ${dest}; fi; ` +
		`}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(channel.shell, command), { allowStdin: true });
	using child = ptree.spawn(["ssh", ...args], {
		stdin: content,
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	await child.exitedCleanly;
}

/** Classification of a remote path, used by the read handler's directory dispatch. */
export type RemotePathKind = "file" | "directory" | "other" | "missing";

/**
 * Classify a remote path with POSIX `test` (portable across Linux/BSD/macOS):
 * `directory`, regular `file`, `other` (special file), or `missing`.
 */
export async function statRemotePath(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemotePathKind> {
	const channel = await resolveTransfer(target);
	if (channel.kind === "powershell") {
		const script = buildWindowsStatScript(normalizeWindowsRemotePath(remotePath));
		const args = await buildRemoteCommand(target, buildPowerShellCommand(channel.shell, script));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const text = new TextDecoder().decode(await child.bytes());
		await child.exitedCleanly;
		return parseTransferFrame("STAT", text);
	}
	const p = quotePosixPath(remotePath);
	const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(channel.shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const out = new TextDecoder().decode(await child.bytes()).trim();
	await child.exitedCleanly;
	return out === "directory" || out === "file" || out === "other" ? out : "missing";
}

/** A single entry in a remote directory listing. */
export interface RemoteDirEntry {
	/** Entry name (no path component), trailing `/` stripped. */
	name: string;
	/** True when the entry is a directory. */
	isDirectory: boolean;
}

/**
 * List a remote directory one level deep with `ls -1Ap` (one per line; all
 * entries incl. dotfiles but not `.`/`..`; trailing `/` marks directories).
 * Plain `ls` (no `| head`) so a permission/race failure surfaces as a non-zero
 * exit instead of being masked as an empty listing. Entries are returned in
 * full, sorted directories-first then by name to mirror the local
 * directory-resource contract, so the read tool can paginate the listing.
 */
export async function listRemoteDir(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteDirEntry[]> {
	const channel = await resolveTransfer(target);
	if (channel.kind === "powershell") {
		const script = buildWindowsListDirScript(normalizeWindowsRemotePath(remotePath));
		const args = await buildRemoteCommand(target, buildPowerShellCommand(channel.shell, script));
		using child = ptree.spawn(["ssh", ...args], {
			signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const text = new TextDecoder().decode(await child.bytes());
		await child.exitedCleanly;
		const entries = parseTransferFrame("LIST", text);
		entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		return entries;
	}
	const command = `LC_ALL=C ls -1Ap -- ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(channel.shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const text = new TextDecoder().decode(await child.bytes());
	await child.exitedCleanly;
	const entries = text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => {
			const isDirectory = line.endsWith("/");
			return { name: isDirectory ? line.slice(0, -1) : line, isDirectory };
		});
	// JS sort is the order contract (mirrors buildDirectoryResource): dirs first, then by name.
	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}
/** Result of the one-roundtrip classify+fetch `resolveWindowsResource` op. */
export interface RemoteResource {
	kind: RemotePathKind;
	/** File bytes when kind is "file" (capped at `maxBytes`), else undefined. */
	bytes?: Uint8Array;
	/** True when the file exceeded `maxBytes` and `bytes` is the prefix. */
	truncated?: boolean;
	/** Directory listing when kind is "directory" and not skipped, dirs-first then by name. */
	entries?: RemoteDirEntry[];
	/** True when skipListing was requested and the listing was not fetched. */
	listingSkipped?: boolean;
}
/**
 * Classify and, when it is a file or directory, fetch a remote path — in one
 * ssh roundtrip on the PowerShell channel (Windows remotes pay ~0.5s remote
 * process creation per exec channel and lack connection multiplexing, so the
 * POSIX stat-then-fetch sequence's second spawn roughly doubles latency).
 * Only defined for the PowerShell channel; other hosts keep the caller-side
 * stat/read/list sequence — ControlMaster reuse depends on the LOCAL client
 * platform (`supportsSshControlMaster`, win32 → false), so a win32 client
 * talking to a POSIX remote still pays both roundtrips. The PowerShell merge
 * covers the transferShell channel this module itself drives; extending the
 * merge to the POSIX channel is deliberately out of scope here. Separate ops
 * also keep the transfer functions mockable per concern.
 * Returns undefined when the host's channel is not PowerShell.
 */
export async function resolveWindowsResource(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { maxBytes?: number; signal?: AbortSignal; timeoutMs?: number; skipListing?: boolean } = {},
): Promise<RemoteResource | undefined> {
	const channel = await resolveTransfer(target);
	if (channel.kind !== "powershell") return undefined;
	const maxBytes = opts.maxBytes ?? -1;
	const script = buildWindowsResolveScript(
		normalizeWindowsRemotePath(remotePath),
		maxBytes,
		opts.skipListing === true,
	);
	const args = await buildRemoteCommand(target, buildPowerShellCommand(channel.shell, script));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const text = new TextDecoder().decode(await child.bytes());
	await child.exitedCleanly;
	// The emitted frame kind IS the classification: B64 = file, LIST =
	// directory, STAT = other/missing. parseTransferFrame's strict validation
	// (single frame, header cross-checks, strict base64) applies unchanged.
	const beginLine = text.split(/\r?\n/).find(l => l.startsWith(XFER_BEGIN));
	const frameKind = BEGIN_LINE_RE.exec(beginLine ?? "")?.[1];
	if (frameKind === "B64") {
		// The script read maxBytes + 1 so an over-cap file is detectable —
		// the same truncation contract as `readRemoteFile`.
		const raw = parseTransferFrame("B64", text);
		const truncated = raw.length > maxBytes;
		return { kind: "file", bytes: truncated ? raw.subarray(0, maxBytes) : raw, truncated };
	}
	if (frameKind === "LIST") {
		const entries = parseTransferFrame("LIST", text);
		entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
		return { kind: "directory", entries, listingSkipped: opts.skipListing === true };
	}
	const stat = parseTransferFrame("STAT", text);
	// With maxBytes >= 0 the script emits B64 for a file and LIST for a
	// directory — a STAT frame claiming either means the frame was not
	// produced by our script (tampering/corruption): fail, never degrade
	// into an empty file or empty listing.
	if (maxBytes >= 0 && (stat === "file" || stat === "directory")) {
		protocolError(`STAT frame reports ${stat}; the merged script must emit B64/LIST for those kinds`, text);
	}
	return { kind: stat };
}
