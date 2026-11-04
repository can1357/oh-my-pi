/**
 * `CustomToolContext` across subagent worker links (codec kind `"custom-tool-context"`).
 *
 * A worker-hosted child calls main-thread tools (MCP tools, kernel-defined custom tools) with its own
 * tool context, whose session manager, settings overlay and getters are worker-local live objects.
 * The sender encodes the context as a call-time snapshot plus remote async operations; the receiver
 * rebuilds a `CustomToolContext`:
 *
 * - `sessionManager` is a {@link ToolContextSessionView}: the scalar getters (`getCwd`, ids, paths,
 *   leaf id, header) answer from the snapshot; `ensureOnDisk`, `allocateArtifactPath`,
 *   `saveArtifact`, `getArtifactPath` and `putBlob` run on the sender's session manager. Synchronous
 *   transcript reads (`getEntries`, `getBranch`, `getTree`, `getEntry`, `getLeafEntry`, `getLabel`,
 *   `getUsageStatistics`), `putBlobSync` and `getArtifactManager` throw: the receiver can never block
 *   on the sending thread, and shipping the transcript with every call is not viable.
 * - `isIdle()`/`hasQueuedMessages()` report the sender's state when the call was made.
 * - `abort()` aborts the sender's run (fire-and-forget).
 * - `settings`: a worker sends the nearest main-backed mirror of its settings (child-local overlay
 *   values are not visible to main-side tool code); main sends its instance, which the worker mirrors.
 * - `modelRegistry`, `model`, `localProtocolOptions`, `autoApprove` cross as values/proxies.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import type { CustomToolContext } from "../../extensibility/custom-tools/types";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import type { ArtifactManager } from "../../session/artifacts";
import type { BlobPutOptions, BlobPutResult } from "../../session/blob-store";
import type { SessionEntry, SessionHeader, SessionTreeNode, UsageStatistics } from "../../session/session-entries";
import type { ReadonlySessionManager } from "../../session/session-manager";
import { isMainThread } from "../identity";
import type { RpcCodec } from "../rpc";

/** Codec kind of {@link toolContextCodec}. */
export const TOOL_CONTEXT_KIND = "custom-tool-context";

/** Wire snapshot of the sender's read-only session manager. */
export interface WireSessionView {
	readonly cwd: string;
	readonly recordedCwd: string | undefined;
	readonly sessionDir: string;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionName: string | undefined;
	readonly artifactsDir: string | null;
	readonly leafId: string | null;
	readonly header: SessionHeader | null;
	readonly ensureOnDisk: () => Promise<void>;
	readonly allocateArtifactPath: (toolType: string) => Promise<{ id?: string; path?: string }>;
	readonly saveArtifact: (content: string, toolType: string) => Promise<string | undefined>;
	readonly getArtifactPath: (id: string) => Promise<string | null>;
	readonly putBlob: (data: Uint8Array, options?: BlobPutOptions) => Promise<BlobPutResult>;
}

/** Wire form of a `CustomToolContext`. */
export interface WireToolContext {
	readonly session: WireSessionView;
	readonly modelRegistry: ModelRegistry;
	readonly model: Model | undefined;
	readonly idle: boolean;
	readonly queued: boolean;
	readonly abort: () => void;
	readonly settings: Settings | undefined;
	readonly localProtocolOptions: LocalProtocolOptions | undefined;
	readonly autoApprove: boolean | undefined;
}

/** Thrown by {@link ToolContextSessionView} operations that would need a synchronous cross-thread read. */
export class CrossThreadSessionReadError extends Error {
	constructor(method: string) {
		super(`SessionManager.${method}() is unavailable to a tool running on another thread than its session`);
		this.name = "CrossThreadSessionReadError";
	}
}

/** Receiver-side `ReadonlySessionManager` built from a {@link WireSessionView}; see the module doc. */
export class ToolContextSessionView implements ReadonlySessionManager {
	readonly #wire: WireSessionView;

	constructor(wire: WireSessionView) {
		this.#wire = wire;
	}

	getCwd(): string {
		return this.#wire.cwd;
	}

	getRecordedCwd(): string | undefined {
		return this.#wire.recordedCwd;
	}

	getSessionDir(): string {
		return this.#wire.sessionDir;
	}

	getSessionId(): string {
		return this.#wire.sessionId;
	}

	getSessionFile(): string | undefined {
		return this.#wire.sessionFile;
	}

	getSessionName(): string | undefined {
		return this.#wire.sessionName;
	}

	getArtifactsDir(): string | null {
		return this.#wire.artifactsDir;
	}

	getLeafId(): string | null {
		return this.#wire.leafId;
	}

	getHeader(): SessionHeader | null {
		return this.#wire.header;
	}

	ensureOnDisk(): Promise<void> {
		return this.#wire.ensureOnDisk();
	}

	allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		return this.#wire.allocateArtifactPath(toolType);
	}

	saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		return this.#wire.saveArtifact(content, toolType);
	}

	getArtifactPath(id: string): Promise<string | null> {
		return this.#wire.getArtifactPath(id);
	}

	putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#wire.putBlob(data, options);
	}

	putBlobSync(_data: Buffer, _options?: BlobPutOptions): BlobPutResult {
		throw new CrossThreadSessionReadError("putBlobSync");
	}

	getArtifactManager(): ArtifactManager | null {
		throw new CrossThreadSessionReadError("getArtifactManager");
	}

	getLeafEntry(): SessionEntry | undefined {
		throw new CrossThreadSessionReadError("getLeafEntry");
	}

	getEntry(_id: string): SessionEntry | undefined {
		throw new CrossThreadSessionReadError("getEntry");
	}

	getLabel(_id: string): string | undefined {
		throw new CrossThreadSessionReadError("getLabel");
	}

	getBranch(_fromId?: string): SessionEntry[] {
		throw new CrossThreadSessionReadError("getBranch");
	}

	getEntries(): SessionEntry[] {
		throw new CrossThreadSessionReadError("getEntries");
	}

	getTree(): SessionTreeNode[] {
		throw new CrossThreadSessionReadError("getTree");
	}

	getUsageStatistics(): UsageStatistics {
		throw new CrossThreadSessionReadError("getUsageStatistics");
	}
}

/** Structural match for a `CustomToolContext` built by sdk/session-tools (plain object, live getters). */
function isToolContext(value: unknown): value is CustomToolContext {
	if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return (
		typeof Reflect.get(value, "isIdle") === "function" &&
		typeof Reflect.get(value, "hasQueuedMessages") === "function" &&
		typeof Reflect.get(value, "abort") === "function" &&
		"sessionManager" in value &&
		"modelRegistry" in value
	);
}

function wireSessionView(manager: ReadonlySessionManager): WireSessionView {
	return {
		cwd: manager.getCwd(),
		recordedCwd: manager.getRecordedCwd(),
		sessionDir: manager.getSessionDir(),
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
		sessionName: manager.getSessionName(),
		artifactsDir: manager.getArtifactsDir(),
		leafId: manager.getLeafId(),
		header: manager.getHeader(),
		ensureOnDisk: () => manager.ensureOnDisk(),
		allocateArtifactPath: toolType => manager.allocateArtifactPath(toolType),
		saveArtifact: (content, toolType) => manager.saveArtifact(content, toolType),
		getArtifactPath: id => manager.getArtifactPath(id),
		putBlob: (data, options) => manager.putBlob(Buffer.from(data.buffer, data.byteOffset, data.byteLength), options),
	};
}

/** The settings a worker can name to main: itself when it mirrors a main instance, else its nearest mirrored ancestor. */
function sendableSettings(settings: Settings | undefined): Settings | undefined {
	if (isMainThread()) return settings;
	for (let current = settings; current; current = current.overlayParent()) {
		if (current.isMirror) return current;
	}
	return undefined;
}

function encodeToolContext(ctx: CustomToolContext): WireToolContext {
	const abort = ctx.abort;
	return {
		session: wireSessionView(ctx.sessionManager),
		modelRegistry: ctx.modelRegistry,
		model: ctx.model,
		idle: ctx.isIdle(),
		queued: ctx.hasQueuedMessages(),
		abort: () => abort(),
		settings: sendableSettings(ctx.settings),
		localProtocolOptions: ctx.localProtocolOptions,
		autoApprove: ctx.autoApprove,
	};
}

function isWireToolContext(value: unknown): value is WireToolContext {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "session") === "object" &&
		typeof Reflect.get(value, "abort") === "function" &&
		typeof Reflect.get(value, "idle") === "boolean"
	);
}

function decodeToolContext(data: unknown): CustomToolContext {
	if (!isWireToolContext(data)) throw new Error("custom-tool-context: malformed wire value");
	const { idle, queued, abort } = data;
	const settings = data.settings instanceof Settings ? data.settings : undefined;
	return {
		sessionManager: new ToolContextSessionView(data.session),
		modelRegistry: data.modelRegistry,
		model: data.model,
		isIdle: () => idle,
		hasQueuedMessages: () => queued,
		abort: () => {
			// The sender's abort is a remote call; its link may already be closing.
			Promise.resolve(abort()).catch((error: unknown) =>
				logger.debug("Cross-thread tool abort failed", { error: String(error) }),
			);
		},
		settings,
		localProtocolOptions: data.localProtocolOptions,
		autoApprove: data.autoApprove,
	};
}

/** Codec carrying tool contexts both ways; register on both ends of a link. */
export const toolContextCodec: RpcCodec<CustomToolContext> = {
	kind: TOOL_CONTEXT_KIND,
	is: isToolContext,
	encode: encodeToolContext,
	decode: decodeToolContext,
};
