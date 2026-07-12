/** Shared fakes for capture workflow tests: a controllable runner and a scripted Telegram transport. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ReplayChannel } from "../../src/capture/queue";
import { CaptureStore } from "../../src/capture/store";
import type { TelegramTransport } from "../../src/capture/telegram";
import type {
	CaptureRunnerAdapter,
	CaptureTurnInput,
	CreateCaptureSessionInput,
	RunnerEvent,
	RunnerInfo,
	RunnerRunHandle,
	RunnerRunStatus,
	RunnerSessionRef,
} from "../../src/capture/types";

export function tempDataDir(prefix = "capture-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function createTestStore(dataDir = tempDataDir()): { store: CaptureStore; dataDir: string } {
	return { store: new CaptureStore({ dataDir }), dataDir };
}

export interface FakeDispatch {
	runnerRunId: string;
	kind: "create" | "resume";
	session: RunnerSessionRef;
	input: CreateCaptureSessionInput | CaptureTurnInput;
	channel: ReplayChannel<RunnerEvent>;
}

/**
 * Controllable runner: every createSession/resumeSession returns a handle whose
 * event channel the test drives explicitly (emit / finish / fail).
 */
export class FakeRunnerAdapter implements CaptureRunnerAdapter {
	readonly dispatches: FakeDispatch[] = [];
	readonly cancelled: string[] = [];
	#counter = 0;
	/** When set, the next dispatch throws (e.g. to simulate an offline runner). */
	failNextDispatch: Error | undefined;

	async createSession(input: CreateCaptureSessionInput): Promise<RunnerRunHandle> {
		return this.#dispatch(
			"create",
			{ sessionId: `session-${++this.#counter}`, sessionFile: `/fake/sessions/s${this.#counter}.jsonl` },
			input,
		);
	}

	async resumeSession(session: RunnerSessionRef, input: CaptureTurnInput): Promise<RunnerRunHandle> {
		return this.#dispatch("resume", session, input);
	}

	#dispatch(
		kind: "create" | "resume",
		session: RunnerSessionRef,
		input: CreateCaptureSessionInput | CaptureTurnInput,
	): RunnerRunHandle {
		if (this.failNextDispatch) {
			const error = this.failNextDispatch;
			this.failNextDispatch = undefined;
			throw error;
		}
		const channel = new ReplayChannel<RunnerEvent>();
		const dispatch: FakeDispatch = {
			runnerRunId: `run-${this.dispatches.length + 1}`,
			kind,
			session,
			input,
			channel,
		};
		this.dispatches.push(dispatch);
		return { runnerRunId: dispatch.runnerRunId, session, events: channel.subscribe() };
	}

	/** Latest dispatch, for driving events. */
	get last(): FakeDispatch {
		const dispatch = this.dispatches[this.dispatches.length - 1];
		if (!dispatch) throw new Error("no dispatches yet");
		return dispatch;
	}

	emit(event: RunnerEvent): void {
		this.last.channel.push(event);
	}

	/** Emit a standard successful turn: start, deltas, end (with session ref). */
	finish(text: string, options: { hasError?: boolean; error?: string } = {}): void {
		const dispatch = this.last;
		dispatch.channel.push({ type: "agent_start" });
		if (text) dispatch.channel.push({ type: "text_delta", text });
		dispatch.channel.push({
			type: "agent_end",
			hasError: options.hasError ?? false,
			...(options.error !== undefined ? { error: options.error } : {}),
			session: dispatch.session,
		});
		dispatch.channel.close();
	}

	async cancelRun(runnerRunId: string): Promise<void> {
		this.cancelled.push(runnerRunId);
		const dispatch = this.dispatches.find(d => d.runnerRunId === runnerRunId);
		if (dispatch) {
			dispatch.channel.push({ type: "agent_end", hasError: false, session: dispatch.session });
			dispatch.channel.close();
		}
	}

	getRunStatus(runnerRunId: string): RunnerRunStatus {
		return this.cancelled.includes(runnerRunId) ? "cancelled" : "unknown";
	}

	async listRunners(): Promise<RunnerInfo[]> {
		return [
			{ id: "local-pi", name: "Local pi session", location: "local", available: true },
			{ id: "msi-windows-main", name: "MSI Windows Main", location: "remote", available: true },
		];
	}
}

export interface RecordedTelegramCall {
	method: string;
	payload: Record<string, unknown>;
}

/** In-memory Bot API: records outbound calls and lets tests inspect them. */
export class FakeTelegramTransport implements TelegramTransport {
	readonly calls: RecordedTelegramCall[] = [];
	#messageId = 100;
	readonly files = new Map<string, Uint8Array>();
	/** Method name → error message to throw once. */
	failOnce = new Map<string, string>();

	async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ method, payload });
		const failure = this.failOnce.get(method);
		if (failure) {
			this.failOnce.delete(method);
			throw new Error(failure);
		}
		if (method === "sendMessage") return { message_id: ++this.#messageId };
		if (method === "editMessageText") return true;
		if (method === "getFile") return { file_path: `files/${String(payload.file_id)}` };
		if (method === "getUpdates") return [];
		return {};
	}

	async sendPhoto(
		payload: Record<string, unknown>,
		_photo: { bytes: Uint8Array; mimeType: string },
	): Promise<unknown> {
		this.calls.push({ method: "sendPhoto", payload });
		return { message_id: ++this.#messageId };
	}

	async downloadFile(filePath: string): Promise<Uint8Array> {
		return this.files.get(filePath) ?? new Uint8Array([1, 2, 3]);
	}

	callsOf(method: string): RecordedTelegramCall[] {
		return this.calls.filter(call => call.method === method);
	}

	get lastMessageId(): number {
		return this.#messageId;
	}
}

/** A tiny valid-enough PNG payload (not a real image, but valid bytes). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const PNG_BASE64 = PNG_BYTES.toBase64();

export function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestId: crypto.randomUUID(),
		source: { type: "screen-region", capturedAt: "2026-07-11T00:00:00.000Z", application: "Visual Studio Code" },
		instruction: "Investigate this error and identify the likely source.",
		routing: {},
		...overrides,
	};
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}
