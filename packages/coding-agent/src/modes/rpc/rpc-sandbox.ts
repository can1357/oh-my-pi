/**
 * OS sandbox control for RPC hosts (`--mode rpc` and `--mode rpc-ui`): the sandbox commands, the
 * `sandbox_update` notification, and two opt-in approval sub-protocols: hosts the egress proxy
 * meets (`sandbox_host_request` → `respond_sandbox_host`, or `sandbox_host_request_cancelled`) and
 * the agent's `sandbox_request` asks for a path or host (`sandbox_access_request` →
 * `respond_sandbox_access`, or `sandbox_access_request_cancelled`).
 *
 * Reads and writes go through the `/sandbox` panel's helpers (`modes/sandbox-panel.ts`), so an RPC
 * edit is a panel edit: it writes the global layer only and never project config. Without an
 * opt-in no approver is installed and the runtime refuses unknown hosts and access requests.
 */
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { Settings } from "../../config/settings";
import {
	type HostApproval,
	type SandboxAccessAnswer,
	type SandboxAccessKind,
	type SandboxAccessRequest,
	SandboxRuntime,
	sandboxAccessEffect,
} from "../../sandbox/runtime";
import {
	applySandboxChange,
	resetSandboxSetting,
	sandboxPanelModel,
	setSandboxList,
	setSandboxListMember,
} from "../sandbox-panel";
import type {
	RpcCommand,
	RpcSandboxFrame,
	RpcSandboxListId,
	RpcSandboxSettingId,
	RpcSandboxState,
	RpcSandboxSummary,
} from "./rpc-types";
import type { SandboxSettingChange } from "@oh-my-pi/pi-tui/overlays/sandbox-config";

/** How long a `sandbox_host_request` waits for `respond_sandbox_host` before it is denied. */
export const SANDBOX_HOST_REQUEST_TIMEOUT_MS = 120_000;

export type RpcSandboxCommand = Extract<
	RpcCommand,
	{
		type:
			| "get_sandbox"
			| "set_sandbox_setting"
			| "reset_sandbox_setting"
			| "edit_sandbox_list"
			| "grant_sandbox_host"
			| "revoke_sandbox_host"
			| "set_sandbox_host_prompts"
			| "respond_sandbox_host"
			| "grant_sandbox_path"
			| "revoke_sandbox_path"
			| "set_sandbox_access_prompts"
			| "respond_sandbox_access";
	}
>;

/** Machine-readable reason of a refused sandbox command, sent as the response `code`. */
export type RpcSandboxErrorCode = "sandbox_locked" | "invalid_value" | "unknown_request";

export class RpcSandboxError extends Error {
	constructor(
		message: string,
		readonly code: RpcSandboxErrorCode,
	) {
		super(message);
		this.name = "RpcSandboxError";
	}
}

const LIST_IDS: ReadonlySet<string> = new Set<RpcSandboxListId>([
	"allowWrite",
	"allowRead",
	"denyRead",
	"allowedHosts",
]);
const SETTING_IDS: ReadonlySet<string> = new Set<RpcSandboxSettingId>([
	"enabled",
	"mode",
	"scope",
	"fallback",
	"readScope",
	"networkMode",
	...(LIST_IDS as ReadonlySet<RpcSandboxListId>),
]);
const DECISIONS: ReadonlySet<string> = new Set<HostApproval>(["once", "session", "always", "deny"]);

export interface RpcSandboxControllerOptions {
	/** The session's working directory: the workspace the commands address. */
	cwd(): string;
	output(frame: RpcSandboxFrame): void;
	/** Runs a host or access prompt as time the session waits on its user. */
	waitForUser?<T>(dialog: () => Promise<T>): Promise<T>;
	/** Override of {@link SANDBOX_HOST_REQUEST_TIMEOUT_MS}. */
	hostRequestTimeoutMs?: number;
}

interface PendingHostRequest {
	host: string;
	answer: Promise<HostApproval>;
	resolve(decision: HostApproval): void;
	timer: NodeJS.Timeout;
}

interface Binding {
	cwd: string;
	runtime: Promise<SandboxRuntime>;
	unsubscribe?: () => void;
}

interface PendingAccessRequest {
	kind: SandboxAccessKind;
	/** The frame offered no `always`: the backing list is decided by another layer. */
	canAlways: boolean;
	resolve(answer: SandboxAccessAnswer): void;
	/** Removes the tool call's abort listener. */
	detach(): void;
}

/** The list an `always` answer appends to, per access kind. */
const ACCESS_LISTS = { write: "allowWrite", read: "allowRead", host: "allowedHosts" } as const satisfies Record<
	SandboxAccessKind,
	RpcSandboxListId
>;

function pathKind(value: unknown): "write" | "read" {
	if (value !== "write" && value !== "read") throw invalid('kind must be "write" or "read"');
	return value;
}

function invalid(message: string): RpcSandboxError {
	return new RpcSandboxError(message, "invalid_value");
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${field} must be a non-empty string`);
	return value;
}

function settingId(value: unknown): RpcSandboxSettingId {
	if (typeof value !== "string" || !SETTING_IDS.has(value)) {
		throw invalid(`setting must be one of ${[...SETTING_IDS].join(", ")}`);
	}
	return value as RpcSandboxSettingId;
}

function listId(value: unknown): RpcSandboxListId {
	if (typeof value !== "string" || !LIST_IDS.has(value)) {
		throw invalid(`list must be one of ${[...LIST_IDS].join(", ")}`);
	}
	return value as RpcSandboxListId;
}

function hostName(value: unknown): string {
	if (typeof value !== "string" || !/^\S+$/.test(value)) throw invalid("host must be a non-empty host name");
	return value;
}

/** Runs a settings write; a value the setting's validator rejects is `invalid_value`. */
function write(apply: () => void): void {
	try {
		apply();
	} catch (error) {
		throw invalid(error instanceof Error ? error.message : String(error));
	}
}

/** Writes `value` to `setting`, checking the value's type first. */
function writeSetting(settings: Settings, setting: RpcSandboxSettingId, value: unknown): void {
	if (LIST_IDS.has(setting)) {
		if (!isStringList(value)) throw invalid(`${setting} takes a list of strings`);
		write(() => setSandboxList(settings, setting as RpcSandboxListId, value));
		return;
	}
	if (setting === "enabled") {
		if (typeof value !== "boolean") throw invalid("enabled takes a boolean");
	} else if (setting === "scope") {
		if (!isStringList(value)) throw invalid("scope takes a list of strings");
	} else if (typeof value !== "string") {
		throw invalid(`${setting} takes a string`);
	}
	// The setting's own validator checks enum members and scope items.
	write(() => applySandboxChange(settings, { id: setting, value } as SandboxSettingChange));
}

export class RpcSandboxController {
	readonly #options: RpcSandboxControllerOptions;
	readonly #timeoutMs: number;
	#binding: Binding | undefined;
	#updateScheduled = false;
	#hostPrompts = false;
	#accessPrompts = false;
	readonly #pending = new Map<string, PendingHostRequest>();
	readonly #pendingByHost = new Map<string, PendingHostRequest>();
	#disposed = false;
	readonly #pendingAccess = new Map<string, PendingAccessRequest>();

	constructor(options: RpcSandboxControllerOptions) {
		this.#options = options;
		this.#timeoutMs = options.hostRequestTimeoutMs ?? SANDBOX_HOST_REQUEST_TIMEOUT_MS;
	}

	/** Binds the session's workspace and sends one `sandbox_update` when the sandbox is enabled there. */
	async start(): Promise<void> {
		const runtime = await this.#runtime();
		if (runtime.status().state !== "off") this.#scheduleUpdate();
	}

	/** Follows the session into another cwd (`/move`, `/wt`): re-subscribes and sends `sandbox_update`; a no-op otherwise. */
	syncWorkspace(): void {
		this.#runtime().catch(error =>
			logger.warn("RPC sandbox: binding the workspace failed", { error: String(error) }),
		);
	}

	/** `get_state.sandbox`. */
	async summary(): Promise<RpcSandboxSummary> {
		const status = (await this.#runtime()).status();
		return status.state === "active" ? { state: status.state, backend: status.backend } : { state: status.state };
	}

	async state(): Promise<RpcSandboxState> {
		const workspace = this.#options.cwd();
		const runtime = await this.#runtime();
		const model = sandboxPanelModel(await Settings.init(), runtime);
		return {
			workspace,
			status: model.status,
			settings: {
				enabled: model.enabled,
				mode: model.mode,
				scope: model.scope,
				fallback: model.fallback,
				readScope: model.readScope,
				networkMode: model.networkMode,
				allowWrite: model.allowWrite,
				allowRead: model.allowRead,
				denyRead: model.denyRead,
				allowedHosts: model.allowedHosts,
			},
			locked: model.locked,
			listNotes: model.listNotes,
			ignored: model.ignored,
			effective: model.effective,
			blockedHosts: model.blockedHosts,
			sessionHosts: runtime.sessionHosts(),
			sessionPaths: runtime.sessionPaths(),
			hostPrompts: this.#hostPrompts,
			accessPrompts: this.#accessPrompts,
		};
	}

	/**
	 * Runs one sandbox command and returns its response `data`.
	 * @throws RpcSandboxError with the response `code` for a refused command.
	 */
	async handle(command: RpcSandboxCommand): Promise<RpcSandboxState | { enabled: boolean } | undefined> {
		switch (command.type) {
			case "get_sandbox":
				return this.state();
			case "set_sandbox_setting": {
				const setting = settingId(command.setting);
				const settings = await this.#unlocked(setting);
				writeSetting(settings, setting, command.value);
				return this.state();
			}
			case "reset_sandbox_setting": {
				const setting = settingId(command.setting);
				const settings = await this.#unlocked(setting);
				write(() => resetSandboxSetting(settings, setting));
				return this.state();
			}
			case "edit_sandbox_list": {
				const list = listId(command.list);
				const { op } = command;
				if (op !== "add" && op !== "remove" && op !== "replace")
					throw invalid('op must be "add", "remove" or "replace"');
				const entry = nonEmptyString(command.entry, "entry");
				const replacement = op === "replace" ? nonEmptyString(command.replacement, "replacement") : undefined;
				const settings = await this.#unlocked(list);
				write(() => {
					if (op === "add") setSandboxListMember(settings, list, entry, true);
					else if (op === "remove") setSandboxListMember(settings, list, entry, false);
					else if (replacement !== entry) {
						// Add first: a rejected replacement must not have removed the entry.
						setSandboxListMember(settings, list, replacement as string, true);
						setSandboxListMember(settings, list, entry, false);
					}
				});
				return this.state();
			}
			case "grant_sandbox_host": {
				const host = hostName(command.host);
				const { scope } = command;
				if (scope !== "session" && scope !== "always") throw invalid('scope must be "session" or "always"');
				// An `always` grant writes the global allowlist; a session grant writes no setting.
				if (scope === "always") await this.#unlocked("allowedHosts");
				const runtime = await this.#runtime();
				await runtime.grantHost(host, scope);
				return this.state();
			}
			case "revoke_sandbox_host": {
				const host = hostName(command.host);
				(await this.#runtime()).revokeHost(host);
				return this.state();
			}
			case "set_sandbox_host_prompts":
				if (typeof command.enabled !== "boolean") throw invalid("enabled takes a boolean");
				this.#setHostPrompts(command.enabled);
				return { enabled: this.#hostPrompts };
			case "respond_sandbox_host": {
				const requestId = nonEmptyString(command.requestId, "requestId");
				if (typeof command.decision !== "string" || !DECISIONS.has(command.decision)) {
					throw invalid('decision must be "once", "session", "always" or "deny"');
				}
				const unknown = () =>
					new RpcSandboxError(`No pending sandbox host request ${requestId}`, "unknown_request");
				if (!this.#pending.has(requestId)) throw unknown();
				// `always` writes the global allowlist, like an `always` grant; refused, the request stays pending.
				if (command.decision === "always") await this.#unlocked("allowedHosts");
				if (!this.#settle(requestId, command.decision)) throw unknown();
				return undefined;
			}
			case "grant_sandbox_path": {
				const kind = pathKind(command.kind);
				const target = nonEmptyString(command.path, "path");
				const runtime = await this.#runtime();
				// The runtime refuses roots, protected paths and invalid targets with the reason.
				write(() => runtime.grantPath(kind, target, "session"));
				return this.state();
			}
			case "revoke_sandbox_path": {
				const kind = pathKind(command.kind);
				const target = nonEmptyString(command.path, "path");
				const runtime = await this.#runtime();
				write(() => runtime.revokePath(kind, target));
				return this.state();
			}
			case "set_sandbox_access_prompts":
				if (typeof command.enabled !== "boolean") throw invalid("enabled takes a boolean");
				this.#setAccessPrompts(command.enabled);
				return { enabled: this.#accessPrompts };
			case "respond_sandbox_access": {
				const requestId = nonEmptyString(command.requestId, "requestId");
				const { decision } = command;
				let answer: SandboxAccessAnswer;
				if (decision === "instruct") {
					answer = { decision, instructions: nonEmptyString(command.instructions, "instructions") };
				} else if (decision === "session" || decision === "always" || decision === "deny") {
					answer = { decision };
				} else {
					throw invalid('decision must be "session", "always", "deny" or "instruct"');
				}
				const unknown = () =>
					new RpcSandboxError(`No pending sandbox access request ${requestId}`, "unknown_request");
				const pending = this.#pendingAccess.get(requestId);
				if (!pending) throw unknown();
				// `always` writes the backing global list; refused, the request stays pending. The frame's
				// `canAlways: false` (a list another layer decides, project config included) refuses it too.
				if (decision === "always") {
					if (!pending.canAlways) {
						throw new RpcSandboxError(
							`${ACCESS_LISTS[pending.kind]} is decided by another layer here; answer "session" instead`,
							"sandbox_locked",
						);
					}
					await this.#unlocked(ACCESS_LISTS[pending.kind]);
				}
				if (!this.#settleAccess(requestId, answer)) throw unknown();
				return undefined;
			}
		}
	}

	/** Denies and cancels every pending host and access request, uninstalls the approvers and stops `sandbox_update`. */
	dispose(): void {
		if (this.#disposed) return;
		this.#setHostPrompts(false);
		this.#setAccessPrompts(false);
		this.#disposed = true;
		this.#binding?.unsubscribe?.();
		this.#binding = undefined;
	}

	/** The global settings, once `id` is not decided by another layer (a write there would be shadowed). */
	async #unlocked(id: RpcSandboxSettingId): Promise<Settings> {
		const settings = await Settings.init();
		const reason = sandboxPanelModel(settings, await this.#runtime()).locked[id];
		if (reason) throw new RpcSandboxError(`sandbox ${id} cannot be changed here: ${reason}`, "sandbox_locked");
		return settings;
	}

	/** The runtime of the session's current workspace; a new workspace re-subscribes and schedules an update. */
	#runtime(): Promise<SandboxRuntime> {
		const cwd = this.#options.cwd();
		const previous = this.#binding;
		if (previous?.cwd === cwd) return previous.runtime;
		previous?.unsubscribe?.();
		const binding: Binding = { cwd, runtime: SandboxRuntime.for(cwd) };
		this.#binding = binding;
		binding.runtime.then(
			runtime => {
				if (this.#binding !== binding || this.#disposed) return;
				binding.unsubscribe = runtime.onChange(() => this.#scheduleUpdate());
			},
			() => {
				// Callers see the rejection; the next call retries.
				if (this.#binding === binding) this.#binding = undefined;
			},
		);
		if (previous) this.#scheduleUpdate();
		return binding.runtime;
	}

	/** One `sandbox_update` per tick, however many changes the tick saw. */
	#scheduleUpdate(): void {
		if (this.#updateScheduled || this.#disposed) return;
		this.#updateScheduled = true;
		setImmediate(async () => {
			this.#updateScheduled = false;
			if (this.#disposed) return;
			try {
				const state = await this.state();
				if (!this.#disposed) this.#options.output({ type: "sandbox_update", state });
			} catch (error) {
				logger.warn("RPC sandbox: building sandbox_update failed", { error: String(error) });
			}
		});
	}

	#setHostPrompts(enabled: boolean): void {
		// A queued opt-in that runs after shutdown must not leave the approver installed.
		if (enabled === this.#hostPrompts || (enabled && this.#disposed)) return;
		this.#hostPrompts = enabled;
		if (enabled) {
			SandboxRuntime.setHostApprover((host, port) => this.#askHost(host, port));
		} else {
			SandboxRuntime.setHostApprover(undefined);
			for (const id of this.#pending.keys()) this.#settle(id, "deny", "aborted");
		}
		this.#scheduleUpdate();
	}

	#askHost(host: string, port: number): Promise<HostApproval> {
		const existing = this.#pendingByHost.get(host);
		if (existing) return existing.answer;
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<HostApproval>();
		const request: PendingHostRequest = {
			host,
			answer: promise,
			resolve,
			timer: setTimeout(() => this.#settle(id, "deny", "timeout"), this.#timeoutMs),
		};
		this.#pending.set(id, request);
		this.#pendingByHost.set(host, request);
		this.#options.output({ type: "sandbox_host_request", id, host, port, timeoutMs: this.#timeoutMs });
		return this.#options.waitForUser ? this.#options.waitForUser(() => promise) : promise;
	}

	/** Answers pending request `id`; with `cancelled`, also tells the client it was answered without it. */
	#settle(id: string, decision: HostApproval, cancelled?: "timeout" | "aborted"): boolean {
		const request = this.#pending.get(id);
		if (!request) return false;
		this.#pending.delete(id);
		this.#pendingByHost.delete(request.host);
		clearTimeout(request.timer);
		if (cancelled) this.#options.output({ type: "sandbox_host_request_cancelled", id, reason: cancelled });
		request.resolve(decision);
		return true;
	}

	#setAccessPrompts(enabled: boolean): void {
		// A queued opt-in that runs after shutdown must not leave the approver installed.
		if (enabled === this.#accessPrompts || (enabled && this.#disposed)) return;
		this.#accessPrompts = enabled;
		if (enabled) {
			SandboxRuntime.setAccessApprover((request, signal) => this.#askAccess(request, signal));
		} else {
			SandboxRuntime.setAccessApprover(undefined);
			for (const id of this.#pendingAccess.keys()) this.#settleAccess(id, { decision: "deny" }, true);
		}
		this.#scheduleUpdate();
	}

	/** No timeout: the turn waits for the answer like any ask; an aborted tool call cancels the request. */
	#askAccess(request: SandboxAccessRequest, signal?: AbortSignal): Promise<SandboxAccessAnswer> {
		// A request queued behind an open one reaches this approver after prompts were turned off or the session ended.
		if (signal?.aborted || !this.#accessPrompts) return Promise.resolve({ decision: "deny" });
		const id = Snowflake.next() as string;
		const { promise, resolve } = Promise.withResolvers<SandboxAccessAnswer>();
		const onAbort = () => this.#settleAccess(id, { decision: "deny" }, true);
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingAccess.set(id, {
			kind: request.kind,
			canAlways: request.canAlways,
			resolve,
			detach: () => signal?.removeEventListener("abort", onAbort),
		});
		this.#options.output({
			type: "sandbox_access_request",
			id,
			kind: request.kind,
			target: request.target,
			intent: request.intent,
			...(request.command === undefined ? {} : { command: request.command }),
			...(request.alternative === undefined ? {} : { alternative: request.alternative }),
			effect: sandboxAccessEffect(request.kind, request.target),
			workspace: request.workspace,
			canAlways: request.canAlways,
		});
		return this.#options.waitForUser ? this.#options.waitForUser(() => promise) : promise;
	}

	/** Answers pending access request `id`; with `cancelled`, also tells the client it was answered without it. */
	#settleAccess(id: string, answer: SandboxAccessAnswer, cancelled?: boolean): boolean {
		const request = this.#pendingAccess.get(id);
		if (!request) return false;
		this.#pendingAccess.delete(id);
		request.detach();
		if (cancelled) this.#options.output({ type: "sandbox_access_request_cancelled", id, reason: "aborted" });
		request.resolve(answer);
		return true;
	}
}
