import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "@pk-nerdsaver-ai/pi-utils";
import {
	type BrowserContextCaptureOptions,
	BrowserContextError,
	type CapturedBrowserContext,
	IxBrowserContextClient,
} from "./browser-context";
import type {
	Annotation,
	BrowserContext,
	CaptureMode,
	CaptureRegion,
	ContextPacket,
	ForegroundAppContext,
	SelectionContext,
	VisualContext,
} from "./types";
import { isCaptureMode } from "./types";

/** Options for a single capture. */
export interface CaptureOptions {
	mode: CaptureMode;
	region?: CaptureRegion;
	includeClipboard?: boolean;
	includeActiveAppState?: boolean;
	userRequest: string;
	annotations?: Annotation[];
}

const annotationTypes = new Set<string>(["rectangle", "point", "arrow", "blur"]);

/** Reject malformed capture input before any filesystem or screenshot operation begins. */
export function assertCaptureOptions(options: unknown): asserts options is CaptureOptions {
	if (!isRecord(options)) throw new TypeError("Capture options must be an object");
	if (!isCaptureMode(options.mode)) {
		throw new TypeError(`Unsupported capture mode: ${String(options.mode)}`);
	}
	if (typeof options.userRequest !== "string" || options.userRequest.trim().length === 0) {
		throw new TypeError("Capture userRequest must be a nonblank string");
	}
	if (options.includeClipboard !== undefined && typeof options.includeClipboard !== "boolean") {
		throw new TypeError("Capture includeClipboard must be a boolean");
	}
	if (options.includeActiveAppState !== undefined && typeof options.includeActiveAppState !== "boolean") {
		throw new TypeError("Capture includeActiveAppState must be a boolean");
	}
	if (options.region !== undefined) assertCaptureRegion(options.region);
	if (options.mode === "region" && options.region === undefined) {
		throw new TypeError("Region capture requires a region");
	}
	if (options.annotations !== undefined) {
		if (!Array.isArray(options.annotations)) throw new TypeError("Capture annotations must be an array");
		for (const annotation of options.annotations) {
			if (
				!isRecord(annotation) ||
				typeof annotation.id !== "string" ||
				typeof annotation.type !== "string" ||
				!annotationTypes.has(annotation.type)
			) {
				throw new TypeError("Capture annotation is malformed");
			}
			if (
				!Array.isArray(annotation.bounds) ||
				annotation.bounds.length !== 4 ||
				!annotation.bounds.every(value => typeof value === "number" && Number.isFinite(value))
			) {
				throw new TypeError("Capture annotation bounds must contain four finite numbers");
			}
			if (annotation.label !== undefined && typeof annotation.label !== "string")
				throw new TypeError("Capture annotation label must be a string");
		}
	}
}

function assertCaptureRegion(region: unknown): asserts region is CaptureRegion {
	if (!isRecord(region)) throw new TypeError("Capture region must be an object");
	for (const name of ["x", "y"] as const) {
		const value = region[name];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new TypeError(`Capture region ${name} must be a finite number`);
		}
	}
	for (const name of ["width", "height"] as const) {
		const value = region[name];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new TypeError(`Capture region ${name} must be a finite positive number`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
	throw new TypeError(`Unsupported capture mode: ${String(value)}`);
}

export interface BrowserContextCaptureClient {
	capture(options: BrowserContextCaptureOptions): Promise<CapturedBrowserContext>;
}

type ForegroundAppCapture = () => Promise<ForegroundAppContext>;

const browserForegroundProcesses = new Set(["chrome", "msedge", "firefox", "slack", "teams", "ms-teams", "discord"]);

/** Whether foreground-app capture should also collect bounded IX browser/chat evidence. */
export function isBrowserForegroundProcess(processName: string | undefined): boolean {
	if (!processName) return false;
	return browserForegroundProcesses.has(processName.toLowerCase().replace(/\.exe$/, ""));
}

/** Service that captures the desktop context for a tag request. */
export class CaptureService {
	readonly #tempDir: string;
	readonly #browserContextClient: BrowserContextCaptureClient;
	readonly #foregroundAppCapture: ForegroundAppCapture;

	constructor(
		tempDir?: string,
		browserContextClient: BrowserContextCaptureClient = new IxBrowserContextClient(),
		foregroundAppCapture?: ForegroundAppCapture,
	) {
		this.#tempDir = tempDir ?? path.join(os.tmpdir(), "pi-desktop-tag");
		this.#browserContextClient = browserContextClient;
		this.#foregroundAppCapture = foregroundAppCapture ?? (() => this.#captureForegroundApp());
	}

	async init(): Promise<void> {
		await fs.mkdir(this.#tempDir, { recursive: true });
	}

	async capture(options: CaptureOptions): Promise<ContextPacket> {
		assertCaptureOptions(options);
		await this.init();

		const captureId = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const screenshotPath = path.join(this.#tempDir, `${captureId}.png`);
		const foregroundAppPromise = options.includeActiveAppState ? this.#foregroundAppCapture() : Promise.resolve({});
		const browserPromise = foregroundAppPromise.then(foregroundApp =>
			this.#captureBrowserContext(options, captureId, foregroundApp),
		);

		const [visual, foregroundApp, selection, browser, availableCapabilities] = await Promise.all([
			this.#captureVisual(options, screenshotPath),
			foregroundAppPromise,
			options.includeClipboard ? this.#captureSelection() : Promise.resolve({}),
			browserPromise,
			this.#resolveAvailableCapabilities(),
		]);

		return {
			captureId,
			timestamp,
			userRequest: options.userRequest,
			captureMode: options.mode,
			visual,
			foregroundApp,
			selection,
			browser,
			availableCapabilities,
		};
	}

	async #captureVisual(options: CaptureOptions, screenshotPath: string): Promise<VisualContext> {
		try {
			const { region } = options;
			switch (options.mode) {
				case "screen":
				case "browser":
					await captureScreenshot(screenshotPath, region);
					break;
				case "window":
					await captureWindowScreenshot(screenshotPath);
					break;
				case "region":
					await captureScreenshot(screenshotPath, region);
					break;
				default:
					assertNever(options.mode);
			}

			return {
				screenshotPath,
				selectedRegion: region,
				displayScale: 1,
				annotations: options.annotations ?? [],
			};
		} catch (error) {
			logger.debug("Screenshot capture failed", { error: error instanceof Error ? error.message : String(error) });
			return { screenshotPath: undefined, selectedRegion: options.region, displayScale: 1, annotations: [] };
		}
	}

	async #captureForegroundApp(): Promise<ForegroundAppContext> {
		if (process.platform !== "win32") {
			return {};
		}
		try {
			const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
$processId = 0
[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
    @{ Name = $process.Name; MainWindowTitle = $process.MainWindowTitle; Path = $process.Path } | ConvertTo-Json -Compress
} else {
    "{}"
}
`;
			const output = await runPowershell(script);
			const parsed = JSON.parse(output || "{}") as {
				Name?: string;
				MainWindowTitle?: string;
				Path?: string;
			};
			return {
				processName: parsed.Name,
				windowTitle: parsed.MainWindowTitle,
				executablePath: parsed.Path,
			};
		} catch (error) {
			logger.debug("Foreground app capture failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return {};
		}
	}

	async #captureSelection(): Promise<SelectionContext> {
		if (process.platform !== "win32") {
			return {};
		}
		try {
			const script = `
$text = Get-Clipboard -TextFormatType Text -ErrorAction SilentlyContinue
if ($text) { @{ text = $text } | ConvertTo-Json -Compress } else { "{}" }
`;
			const output = await runPowershell(script);
			const parsed = JSON.parse(output || "{}") as { text?: string };
			return { clipboardText: parsed.text };
		} catch (error) {
			logger.debug("Clipboard capture failed", { error: error instanceof Error ? error.message : String(error) });
			return {};
		}
	}

	async #captureBrowserContext(
		options: CaptureOptions,
		captureId: string,
		foregroundApp: ForegroundAppContext,
	): Promise<BrowserContext> {
		const shouldCapture =
			options.mode === "browser" ||
			(options.includeActiveAppState === true && isBrowserForegroundProcess(foregroundApp.processName));
		if (!shouldCapture) return {};

		try {
			const evidence = await this.#browserContextClient.capture({
				lane: "agent-a",
				session: `desktop-tag:${captureId}`,
				includeChat: true,
			});
			return {
				url: evidence.identity.url,
				title: evidence.identity.title,
				tabId: String(evidence.identity.tabId),
				evidenceStatus: "captured",
				provider: evidence.provider,
				identity: evidence.identity,
				routing: evidence.routing,
				accessibility: evidence.accessibility,
				...(evidence.chat ? { chat: evidence.chat } : {}),
				redactions: evidence.redactions,
				warnings: [],
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const code = error instanceof BrowserContextError ? error.code : "unknown";
			logger.debug("Browser evidence capture failed", { code, error: reason });
			return {
				evidenceStatus: "unavailable",
				warnings: [`IX browser evidence unavailable (${code}): ${reason}`],
			};
		}
	}

	async #resolveAvailableCapabilities(): Promise<string[]> {
		const capabilities = ["visual"];
		if (process.platform === "win32") {
			capabilities.push("clipboard", "foreground-app");
		}
		try {
			const response = await fetchWithTimeout("http://127.0.0.1:18086/ix-bridge/status", {}, 1_000);
			if (response.ok) capabilities.push("browser");
		} catch {
			// ignore
		}
		return capabilities;
	}
}

const IX_BRIDGE_COMMAND_TIMEOUT_MS = 1_500;

export async function fetchWithTimeout(
	input: string | URL | Request,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(input, { ...init, signal: controller.signal });
		const body = await response.arrayBuffer();
		return new Response(body.byteLength === 0 ? null : body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} finally {
		clearTimeout(timer);
	}
}

export function requestIxBridgeCommand(
	action: "get_url" | "get_title",
	timeoutMs = IX_BRIDGE_COMMAND_TIMEOUT_MS,
): Promise<Response> {
	return fetchWithTimeout(
		"http://127.0.0.1:18086/ix-bridge/command",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ lane: "agent-a", action, args: {} }),
		},
		timeoutMs,
	);
}

async function extractJsonText(response: Response | undefined, key: string): Promise<string | undefined> {
	if (!response) return undefined;
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const value = body[key];
	if (typeof value === "string") return value;
	const result = body.result;
	if (result && typeof result === "object" && key in result) {
		const nested = (result as Record<string, unknown>)[key];
		return typeof nested === "string" ? nested : undefined;
	}
	return undefined;
}

export async function captureScreenshot(screenshotPath: string, region?: CaptureRegion): Promise<void> {
	if (region !== undefined) assertCaptureRegion(region);
	if (process.platform !== "win32") {
		throw new Error(`Screenshot capture not implemented for ${process.platform}`);
	}

	await runPowershell(buildScreenshotScript(screenshotPath, region));
}

/** Capture the actual foreground window rather than falling back to the primary screen. */
export async function captureWindowScreenshot(screenshotPath: string): Promise<void> {
	if (process.platform !== "win32") {
		throw new Error(`Window screenshot capture not implemented for ${process.platform}`);
	}

	await runPowershell(buildWindowScreenshotScript(screenshotPath));
}

export function buildScreenshotScript(screenshotPath: string, region?: CaptureRegion): string {
	const outputPath = quotePowerShellString(screenshotPath);
	if (region) {
		assertCaptureRegion(region);
		return `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${region.width}, ${region.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
    $bmp.Save(${outputPath}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}
`;
	}

	return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bmp.Save(${outputPath}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}
`;
}

export function buildWindowScreenshotScript(screenshotPath: string): string {
	const outputPath = quotePowerShellString(screenshotPath);
	return `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DesktopTagWindowCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$hwnd = [DesktopTagWindowCapture]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { throw "No foreground window is available" }
$bounds = New-Object 'DesktopTagWindowCapture+RECT'
if (-not [DesktopTagWindowCapture]::GetWindowRect($hwnd, [ref]$bounds)) {
    throw "GetWindowRect failed for foreground window"
}
$width = $bounds.Right - $bounds.Left
$height = $bounds.Bottom - $bounds.Top
if ($width -le 0 -or $height -le 0) { throw "Foreground window has invalid bounds" }
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    $bmp.Save(${outputPath}, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $g.Dispose()
    $bmp.Dispose()
}
`;
}

function quotePowerShellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

async function runPowershell(script: string): Promise<string> {
	const scriptPath = path.join(os.tmpdir(), `pi-desktop-tag-${crypto.randomUUID()}.ps1`);
	await fs.writeFile(scriptPath, script, "utf8");
	try {
		const proc = Bun.spawn(["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (proc.exitCode !== 0) {
			throw new Error(`PowerShell failed: ${stderr || stdout}`);
		}
		return stdout.trim();
	} finally {
		await fs.unlink(scriptPath).catch(() => {});
	}
}
