import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import type { Protocol } from "devtools-protocol";
import type { CDPSession, Page } from "puppeteer-core";
import { resizeImage } from "../../utils/image-resize";
import { buildChangedFrameContactSheetPng, requireMediaBinary, runFfmpeg } from "../../utils/video";
import { resolveToCwd } from "../path-utils";
import type { RunOutput } from "./run-output";

const DEFAULT_FPS = 30;
const DEFAULT_QUALITY = 80;
const DEFAULT_CONTACT_SHEET_THRESHOLD = 0.02;
const MAX_CONTACT_SHEET_TILES = 12;

interface CursorMouseEvent {
	readonly clientX: number;
	readonly clientY: number;
}

interface CursorShadowRoot {
	append(...nodes: CursorElement[]): void;
}

type CursorElement = HTMLElement & {
	readonly shadowRoot: CursorShadowRoot | null;
	readonly style: HTMLElement["style"] & {
		cssText: string;
		transform: string;
		left: string;
		top: string;
	};
	attachShadow(options: { mode: "open" }): CursorShadowRoot;
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
};

interface CursorDocument {
	readonly documentElement: { append(node: CursorElement): void } | null;
	createElement(tag: string): CursorElement;
	getElementById(id: string): CursorElement | null;
	addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: string, listener: () => void): void;
}

interface CursorPageGlobal {
	readonly document: CursorDocument;
	readonly innerWidth: number;
	readonly innerHeight: number;
	__ompRecordingCursorCleanup?: () => void;
	addEventListener(type: string, listener: (event: CursorMouseEvent) => void, capture: boolean): void;
	removeEventListener(type: string, listener: (event: CursorMouseEvent) => void, capture: boolean): void;
}

/** Options accepted by browser video recording helpers. */
export interface RecordingOptions {
	/** Constant output frames per second, from 1 through 60. */
	fps?: number;
	/** Draw page mouse movement and click ripples into captured frames. */
	cursor?: boolean;
	/** Write and display a changed-frame PNG contact sheet after encoding. */
	contactSheet?: boolean;
	/** Changed-pixel ratio, from 0 through 1, needed for an intermediate contact-sheet tile. */
	contactSheetThreshold?: number;
	/** Capture and encoding quality, from 0 through 100. */
	quality?: number;
}

/** Result returned after recording starts. */
export interface RecordingStartResult {
	/** Absolute output video path. */
	readonly path: string;
	/** Constant output frames per second. */
	readonly fps: number;
}

/** Result returned after a recording is finalized. */
export interface RecordingStopResult {
	/** Absolute output video path. */
	readonly path: string;
	/** Elapsed recording time in milliseconds. */
	readonly durationMs: number;
	/** Number of CDP screencast frames captured before constant-rate duplication. */
	readonly frames: number;
	/** Encoded video size in bytes. */
	readonly bytes: number;
	/** Absolute changed-frame contact-sheet path when requested. */
	readonly contactSheet?: string;
}

/** Current persistent recording state for a tab worker. */
export interface RecordingStatus {
	/** Whether the tab is currently recording. */
	readonly active: boolean;
	/** Absolute destination path while active. */
	readonly path?: string;
	/** Requested constant frame rate while active. */
	readonly fps?: number;
	/** Elapsed milliseconds while active. */
	readonly durationMs?: number;
	/** Number of screencast frames accepted so far. */
	readonly frames?: number;
}

/** Context used to surface contact-sheet images from the active browser run. */
export interface RecordingStopContext {
	/** Active run cancellation signal. */
	readonly signal?: AbortSignal;
	/** Run output receiving the generated contact-sheet image. */
	readonly output?: RunOutput;
	/** Prevent WebP conversion when the active vision backend cannot decode it. */
	readonly excludeWebP?: boolean;
}

interface ValidatedRecordingOptions {
	fps: number;
	cursor: boolean;
	contactSheet: boolean;
	contactSheetThreshold: number;
	quality: number;
}

interface RecordedFrame {
	path: string;
	timestampMs: number;
}

interface ActiveRecording {
	page: Page;
	session: CDPSession;
	spool: TempDir;
	path: string;
	options: ValidatedRecordingOptions;
	startedAt: number;
	frames: RecordedFrame[];
	pendingWrites: Set<Promise<void>>;
	nextFrame: number;
	writeError?: unknown;
	cursorScriptId?: string;
	finalizing: boolean;
	onFrame: (event: Protocol.Page.ScreencastFrameEvent) => void;
}

/** Named user-facing recording failure raised by every `tab.record*` helper. */
export class BrowserRecordingError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "BrowserRecordingError";
	}
}

function validateNumber(label: string, value: number, min: number, max: number): number {
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new BrowserRecordingError(`${label} must be a finite number from ${min} through ${max}`);
	}
	return value;
}

function validateOptions(options: RecordingOptions | undefined): ValidatedRecordingOptions {
	if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
		throw new BrowserRecordingError("tab.recordStart() options must be an object");
	}
	const fps = validateNumber("tab.recordStart() fps", options?.fps ?? DEFAULT_FPS, 1, 60);
	const quality = validateNumber("tab.recordStart() quality", options?.quality ?? DEFAULT_QUALITY, 0, 100);
	const contactSheetThreshold = validateNumber(
		"tab.recordStart() contactSheetThreshold",
		options?.contactSheetThreshold ?? DEFAULT_CONTACT_SHEET_THRESHOLD,
		0,
		1,
	);
	return {
		fps,
		quality: Math.round(quality),
		cursor: options?.cursor ?? false,
		contactSheet: options?.contactSheet ?? false,
		contactSheetThreshold,
	};
}

function recordingError(error: unknown, action: string): BrowserRecordingError {
	if (error instanceof BrowserRecordingError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new BrowserRecordingError(`${action} failed: ${message}`);
}

function installCursorOverlay(): void {
	const state = globalThis as unknown as CursorPageGlobal;
	const document = state.document;
	state.__ompRecordingCursorCleanup?.();
	let root: CursorElement | undefined;
	let pointer: CursorElement | undefined;
	const onMove = (event: CursorMouseEvent): void => {
		if (pointer) pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
	};
	const onDown = (event: CursorMouseEvent): void => {
		if (!root) return;
		const ripple = document.createElement("div");
		ripple.className = "ripple";
		ripple.style.left = `${event.clientX}px`;
		ripple.style.top = `${event.clientY}px`;
		root.shadowRoot?.append(ripple);
		ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
	};
	const mount = (): void => {
		if (document.getElementById("__omp_recording_cursor__")) return;
		root = document.createElement("div");
		root.id = "__omp_recording_cursor__";
		root.setAttribute("aria-label", "OMP recording cursor overlay");
		root.setAttribute("aria-hidden", "true");
		root.setAttribute("inert", "");
		root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden";
		const shadow = root.attachShadow({ mode: "open" });
		const style = document.createElement("style");
		style.textContent =
			".pointer{position:absolute;left:0;top:0;width:0;height:0;border-left:8px solid white;border-top:14px solid black;border-right:4px solid transparent;filter:drop-shadow(0 0 1px white);transform:translate(-100px,-100px);transform-origin:0 0}.ripple{position:absolute;width:8px;height:8px;margin:-4px;border:2px solid #fff;border-radius:999px;box-shadow:0 0 0 1px #000;animation:omp-recording-ripple .45s ease-out forwards}@keyframes omp-recording-ripple{to{width:34px;height:34px;margin:-17px;opacity:0}}";
		pointer = document.createElement("div");
		pointer.className = "pointer";
		shadow.append(style, pointer);
		document.documentElement?.append(root);
	};
	if (document.documentElement) mount();
	else document.addEventListener("DOMContentLoaded", mount, { once: true });
	state.addEventListener("mousemove", onMove, true);
	state.addEventListener("mousedown", onDown, true);
	state.__ompRecordingCursorCleanup = () => {
		document.removeEventListener("DOMContentLoaded", mount);
		state.removeEventListener("mousemove", onMove, true);
		state.removeEventListener("mousedown", onDown, true);
		root?.remove();
		document.getElementById("__omp_recording_cursor__")?.remove();
		delete state.__ompRecordingCursorCleanup;
	};
}

function removeCursorOverlay(): void {
	const state = globalThis as unknown as CursorPageGlobal;
	state.__ompRecordingCursorCleanup?.();
	state.document.getElementById("__omp_recording_cursor__")?.remove();
}

function concatPath(filePath: string): string {
	return filePath.replaceAll("'", "'\\''");
}

async function encodeRecording(active: ActiveRecording, durationMs: number, signal?: AbortSignal): Promise<void> {
	const frames = active.frames;
	const firstTimestamp = frames[0]!.timestampMs;
	const framePeriodMs = 1_000 / active.options.fps;
	const encodedDurationMs = Math.max(durationMs, framePeriodMs);
	const offsets: number[] = [];
	let previous = 0;
	for (const [index, frame] of frames.entries()) {
		const observed = index === 0 ? 0 : Math.max(0, frame.timestampMs - firstTimestamp);
		const clamped = Math.min(encodedDurationMs, Math.max(previous, observed));
		offsets.push(clamped);
		previous = clamped;
	}
	const concatLines: string[] = [];
	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index]!;
		const current = offsets[index]!;
		const next = index + 1 < frames.length ? offsets[index + 1]! : encodedDurationMs;
		concatLines.push(`file '${concatPath(path.resolve(frame.path))}'`);
		concatLines.push(`duration ${(Math.max(1, next - current) / 1_000).toFixed(6)}`);
	}
	concatLines.push(`file '${concatPath(path.resolve(frames.at(-1)!.path))}'`);
	const concatFile = active.spool.join("frames.concat");
	await Bun.write(concatFile, `${concatLines.join("\n")}\n`);
	const absoluteConcatFile = path.resolve(concatFile);
	await fs.mkdir(path.dirname(active.path), { recursive: true });
	const quality = active.options.quality;
	const fpsFilter = `fps=${active.options.fps}`;
	const extension = path.extname(active.path).toLowerCase();
	if (extension === ".mp4") {
		await runFfmpeg(
			[
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				absoluteConcatFile,
				"-an",
				"-vf",
				`${fpsFilter},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
				"-c:v",
				"libx264",
				"-crf",
				String(Math.round(((100 - quality) * 51) / 100)),
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				active.path,
			],
			signal,
		);
		return;
	}
	const input = ["-f", "concat", "-safe", "0", "-i", absoluteConcatFile, "-an", "-vf", fpsFilter];
	try {
		await runFfmpeg(
			[
				...input,
				"-c:v",
				"libvpx-vp9",
				"-crf",
				String(Math.round(((100 - quality) * 63) / 100)),
				"-b:v",
				"0",
				"-deadline",
				"realtime",
				"-cpu-used",
				"5",
				active.path,
			],
			signal,
		);
	} catch (error) {
		if (signal?.aborted) throw error;
		await runFfmpeg(
			[
				...input,
				"-c:v",
				"libvpx",
				"-crf",
				String(Math.round(((100 - quality) * 63) / 100)),
				"-b:v",
				"1M",
				active.path,
			],
			signal,
		);
	}
}

/** Persistent, disk-backed CDP screencast state owned by one tab worker. */
export class RecordingController {
	#active?: ActiveRecording;
	#starting = false;

	/** Start recording a page to an absolute cwd-resolved MP4 or WebM path. */
	async start(
		page: Page,
		rawPath: string,
		cwd: string,
		options?: RecordingOptions,
		signal?: AbortSignal,
	): Promise<RecordingStartResult> {
		if (this.#active) throw new BrowserRecordingError(`A recording is already active at ${this.#active.path}`);
		if (this.#starting) throw new BrowserRecordingError("A recording is already starting");
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			throw new BrowserRecordingError("tab.recordStart() requires a non-empty output path");
		}
		const absolutePath = resolveToCwd(rawPath, cwd);
		const extension = path.extname(absolutePath).toLowerCase();
		if (extension !== ".mp4" && extension !== ".webm") {
			throw new BrowserRecordingError("tab.recordStart() path must end in .mp4 or .webm");
		}
		const validated = validateOptions(options);
		try {
			requireMediaBinary("ffmpeg");
		} catch (error) {
			throw recordingError(error, "tab.recordStart()");
		}
		this.#starting = true;
		let spool: TempDir | undefined;
		let session: CDPSession | undefined;
		let cursorScriptId: string | undefined;
		try {
			spool = await TempDir.create("omp-browser-recording-");
			session = await untilAborted(signal, () => page.createCDPSession());
			if (validated.cursor) {
				const script = await untilAborted(signal, () => page.evaluateOnNewDocument(installCursorOverlay));
				cursorScriptId = script.identifier;
				await untilAborted(signal, () => page.evaluate(installCursorOverlay));
			}
			const viewport =
				page.viewport() ??
				(await untilAborted(signal, () =>
					page.evaluate(() => {
						const pageGlobal = globalThis as unknown as { innerWidth: number; innerHeight: number };
						return { width: pageGlobal.innerWidth, height: pageGlobal.innerHeight };
					}),
				));
			const active: ActiveRecording = {
				page,
				session,
				spool,
				path: absolutePath,
				options: validated,
				startedAt: Date.now(),
				frames: [],
				pendingWrites: new Set(),
				nextFrame: 0,
				cursorScriptId,
				finalizing: false,
				onFrame: () => {},
			};
			active.onFrame = event => {
				const index = active.nextFrame++;
				const framePath = active.spool.join(`frame-${String(index).padStart(9, "0")}.jpg`);
				const timestampMs =
					typeof event.metadata.timestamp === "number" ? event.metadata.timestamp * 1_000 : Date.now();
				active.frames.push({ path: framePath, timestampMs });
				const write: Promise<void> = Bun.write(framePath, Buffer.from(event.data, "base64"))
					.then(() => undefined)
					.catch(error => {
						active.writeError ??= error;
					})
					.finally(() => {
						active.pendingWrites.delete(write);
						void active.session
							.send("Page.screencastFrameAck", { sessionId: event.sessionId })
							.catch(() => undefined);
					});
				active.pendingWrites.add(write);
			};
			session.on("Page.screencastFrame", active.onFrame);
			await untilAborted(signal, () =>
				session!.send("Page.startScreencast", {
					format: "jpeg",
					quality: validated.quality,
					maxWidth: Math.max(1, Math.round(viewport.width)),
					maxHeight: Math.max(1, Math.round(viewport.height)),
					everyNthFrame: Math.max(1, Math.round(60 / validated.fps)),
				}),
			);
			this.#active = active;
			return { path: absolutePath, fps: validated.fps };
		} catch (error) {
			if (cursorScriptId) await page.removeScriptToEvaluateOnNewDocument(cursorScriptId).catch(() => undefined);
			if (validated.cursor) await page.evaluate(removeCursorOverlay).catch(() => undefined);
			await session?.detach().catch(() => undefined);
			await spool?.remove().catch(() => undefined);
			throw recordingError(error, "tab.recordStart()");
		} finally {
			this.#starting = false;
		}
	}

	/** Stop and finalize the active recording. */
	async stop(context: RecordingStopContext = {}): Promise<RecordingStopResult> {
		const active = this.#active;
		if (!active) throw new BrowserRecordingError("tab.recordStop() requires an active recording");
		if (active.finalizing)
			throw new BrowserRecordingError("tab.recordStop() is already finalizing the active recording");
		active.finalizing = true;
		const durationMs = Math.max(0, Date.now() - active.startedAt);
		const contactPath = `${active.path}.contact.png`;
		let finalized = false;
		try {
			await untilAborted(context.signal, () => active.session.send("Page.stopScreencast"));
			active.session.off("Page.screencastFrame", active.onFrame);
			await Promise.all(active.pendingWrites);
			if (active.writeError) throw active.writeError;
			if (active.cursorScriptId) {
				await active.page.removeScriptToEvaluateOnNewDocument(active.cursorScriptId).catch(() => undefined);
			}
			if (active.options.cursor) await active.page.evaluate(removeCursorOverlay).catch(() => undefined);
			if (active.frames.length === 0) {
				const fallback = active.spool.join("frame-000000000.jpg");
				const bytes = await untilAborted(context.signal, () =>
					active.page.screenshot({ type: "jpeg", quality: active.options.quality }),
				);
				await Bun.write(fallback, bytes);
				active.frames.push({ path: fallback, timestampMs: 0 });
			}
			await encodeRecording(active, durationMs, context.signal);
			let contactSheet: string | undefined;
			if (active.options.contactSheet) {
				const sheet = await buildChangedFrameContactSheetPng(
					active.path,
					{
						outputPath: contactPath,
						fps: active.options.fps,
						threshold: active.options.contactSheetThreshold,
						maxTiles: MAX_CONTACT_SHEET_TILES,
					},
					context.signal,
				);
				contactSheet = sheet.path;
				if (context.output) {
					const resized = await resizeImage(
						{ type: "image", data: sheet.png.data, mimeType: sheet.png.mimeType },
						{ excludeWebP: context.excludeWebP },
					);
					context.output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
				}
			}
			const stat = await fs.stat(active.path);
			finalized = true;
			return {
				path: active.path,
				durationMs,
				frames: active.frames.length,
				bytes: stat.size,
				...(contactSheet ? { contactSheet } : {}),
			};
		} catch (error) {
			throw recordingError(error, "tab.recordStop()");
		} finally {
			active.session.off("Page.screencastFrame", active.onFrame);
			await active.session.send("Page.stopScreencast").catch(() => undefined);
			await Promise.all(active.pendingWrites);
			if (active.cursorScriptId) {
				await active.page.removeScriptToEvaluateOnNewDocument(active.cursorScriptId).catch(() => undefined);
			}
			if (active.options.cursor) await active.page.evaluate(removeCursorOverlay).catch(() => undefined);
			await active.session.detach().catch(() => undefined);
			await active.spool.remove().catch(() => undefined);
			if (this.#active === active) this.#active = undefined;
			if (!finalized) {
				await fs.rm(active.path, { force: true }).catch(() => undefined);
				await fs.rm(contactPath, { force: true }).catch(() => undefined);
			}
		}
	}

	/** Finalize an active recording, then immediately begin another. */
	async restart(
		page: Page,
		rawPath: string,
		cwd: string,
		options: RecordingOptions | undefined,
		context: RecordingStopContext = {},
	): Promise<RecordingStartResult> {
		if (this.#active) await this.stop(context);
		return await this.start(page, rawPath, cwd, options, context.signal);
	}

	/** Return the current persistent recording state without touching the page. */
	status(): RecordingStatus {
		const active = this.#active;
		if (!active) return { active: false };
		return {
			active: true,
			path: active.path,
			fps: active.options.fps,
			durationMs: Math.max(0, Date.now() - active.startedAt),
			frames: active.frames.length,
		};
	}

	/** Finalize the active recording during tab teardown, discarding failed output. */
	async close(): Promise<void> {
		if (!this.#active) return;
		await this.stop();
	}
}
