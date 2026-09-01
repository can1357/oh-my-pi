import * as path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type BashPtyOptions, type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Destination that owns a bash result after a session or branch transition. */
export type BashAppendDestination =
	| { kind: "current"; manager: SessionManager }
	| { kind: "detached"; manager: SessionManager }
	| { kind: "branch"; manager: SessionManager; parentId: string | null };

/** Reference-counted session target captured when a bash execution starts. */
export interface BashSessionTarget {
	sessionId: string;
	refs: number;
	destination?: BashAppendDestination;
	pending?: Promise<BashAppendDestination>;
}

interface PendingBashMessage {
	target: BashSessionTarget;
	message: BashExecutionMessage;
}

/** Ownership snapshot spanning a session or branch transition. */
export interface BashSessionTransition {
	oldTarget: BashSessionTarget;
	newTarget: BashSessionTarget;
	oldSessionId: string;
	oldSessionFile: string | undefined;
	oldLeafId: string | null;
	detachedManager: SessionManager | undefined;
	resolveOld: ((destination: BashAppendDestination) => void) | undefined;
	resolveNew: (destination: BashAppendDestination) => void;
}

/** Capabilities the bash runner borrows from its owning session. */
export interface BashRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	isStreaming(): boolean;
}

/** Owns bash execution and preserves result ownership across transcript transitions. */
export class BashRunner {
	readonly #host: BashRunnerHost;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: PendingBashMessage[] = [];
	#sessionTarget: BashSessionTarget;

	constructor(host: BashRunnerHost) {
		this.#host = host;
		this.#sessionTarget = {
			sessionId: host.sessionManager.getSessionId(),
			refs: 0,
			destination: { kind: "current", manager: host.sessionManager },
		};
	}

	/** Executes a bash command while retaining the session and branch that owned its start. */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean; pty?: BashPtyOptions },
	): Promise<BashResult> {
		const target = this.#captureSessionTarget();
		let targetTransferred = false;
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		try {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_bash")) {
				const hookResult = await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd,
				});
				if (hookResult?.result) {
					targetTransferred = true;
					await this.#recordResultForTarget(target, command, hookResult.result, options);
					return hookResult.result;
				}
			}

			// The hook's adapter forwards only entries that differ from the baseline
			// it is handed, and the child shell starts from the (cached, filtered)
			// spawn env — NOT from live process.env. Diffing against process.env
			// cancels out any variable an extension both mirrors into process.env
			// and injects via its hook (e.g. the secretsd session token file), so
			// hand the hook the env the child will actually receive. Pass a copy:
			// this.#host.settings.getShellConfig().env is a cached, shared object,
			// and a legacy hook that mutates its context.env in place (a supported
			// pattern) would otherwise poison that cache for every later command.
			const shellEnv =
				options?.useUserShell === true
					? extensionRunner
							?.getRegisteredTool("bash")
							?.definition.shellEnv?.({ command, cwd, env: { ...this.#host.settings.getShellConfig().env } })
					: undefined;

			const abortController = new AbortController();
			this.#abortControllers.add(abortController);
			let result: BashResult;
			try {
				result = await executeBashCommand(command, {
					onChunk,
					signal: abortController.signal,
					sessionKey: target.sessionId,
					cwd,
					timeout: clampTimeout("bash", undefined, this.#host.settings.get("tools.maxTimeout")) * 1000,
					onMinimizedSave: originalText => this.#saveOriginalArtifact(target, originalText),
					env: shellEnv,
					useUserShell: options?.useUserShell,
					pty: options?.pty,
				});
			} finally {
				this.#abortControllers.delete(abortController);
			}
			targetTransferred = true;
			await this.#recordResultForTarget(target, command, result, options);
			return result;
		} finally {
			if (!targetTransferred) await this.#releaseSessionTarget(target);
		}
	}

	/** Records a bash result supplied outside executeBash in the current ownership scope. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const target = this.#captureSessionTarget();
		const message = this.#createMessage(command, result, options);
		if (this.#host.isStreaming() && target === this.#sessionTarget) {
			this.#pendingMessages.push({ target, message });
			return;
		}
		if (target.destination) {
			try {
				this.#appendMessage(target.destination, message);
			} finally {
				void this.#releaseSessionTarget(target);
			}
			return;
		}
		void this.#appendOwnedMessage(target, message).catch(error => {
			logger.error("Failed to record bash result in its owning session", { error: String(error) });
		});
	}

	/** Cancels every running bash command. */
	abort(): void {
		for (const abortController of this.#abortControllers) abortController.abort();
	}

	/** Whether a bash command is currently running. */
	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether bash results are waiting for a safe persistence boundary. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Flushes deferred bash results without changing their captured ownership. */
	async flushPending(): Promise<void> {
		if (this.#pendingMessages.length === 0) return;
		const pending = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const { target, message } of pending) await this.#appendOwnedMessage(target, message);
	}

	/** Runs a leaf rewrite while retaining in-flight bash on its originating branch. */
	withBranchTransition<T>(mutate: () => T): T {
		const transition = this.beginSessionTransition();
		let transitioned = false;
		try {
			const result = mutate();
			this.markSessionTransition(transition);
			transitioned = true;
			return result;
		} finally {
			this.finishSessionTransition(transition, transitioned);
		}
	}

	/** Snapshots the owner of in-flight bash before a session or branch transition. */
	beginSessionTransition(options?: { persistDetached?: boolean }): BashSessionTransition {
		const oldTarget = this.#sessionTarget;
		let detachedManager: SessionManager | undefined;
		let resolveOld: ((destination: BashAppendDestination) => void) | undefined;
		if (oldTarget.refs > 0) {
			detachedManager = this.#host.sessionManager.cloneCurrentSession({ persist: options?.persistDetached });
			const pendingOld = Promise.withResolvers<BashAppendDestination>();
			oldTarget.destination = undefined;
			oldTarget.pending = pendingOld.promise;
			resolveOld = pendingOld.resolve;
		}
		const pendingNew = Promise.withResolvers<BashAppendDestination>();
		return {
			oldTarget,
			newTarget: {
				sessionId: this.#host.sessionManager.getSessionId(),
				refs: 0,
				pending: pendingNew.promise,
			},
			oldSessionId: this.#host.sessionManager.getSessionId(),
			oldSessionFile: this.#host.sessionManager.getSessionFile(),
			oldLeafId: this.#host.sessionManager.getLeafId(),
			detachedManager,
			resolveOld,
			resolveNew: pendingNew.resolve,
		};
	}

	/** Adopts a transition's new target as the live bash owner. */
	markSessionTransition(transition: BashSessionTransition): void {
		transition.newTarget.sessionId = this.#host.sessionManager.getSessionId();
		this.#sessionTarget = transition.newTarget;
	}

	/** Resolves destinations opened by beginSessionTransition. */
	finishSessionTransition(transition: BashSessionTransition, success: boolean): void {
		const manager = this.#host.sessionManager;
		const currentDestination: BashAppendDestination = { kind: "current", manager };
		let oldDestination: BashAppendDestination = currentDestination;
		if (success && transition.resolveOld) {
			const currentFile = manager.getSessionFile();
			const sameFile =
				transition.oldSessionFile === currentFile ||
				(transition.oldSessionFile !== undefined &&
					currentFile !== undefined &&
					path.resolve(transition.oldSessionFile) === path.resolve(currentFile));
			const sameSession = transition.oldSessionId === manager.getSessionId() && sameFile;
			if (sameSession) {
				oldDestination =
					transition.oldLeafId === manager.getLeafId()
						? currentDestination
						: { kind: "branch", manager, parentId: transition.oldLeafId };
			} else if (transition.detachedManager) {
				oldDestination = { kind: "detached", manager: transition.detachedManager };
			}
		}
		if (transition.resolveOld) {
			transition.oldTarget.pending = undefined;
			transition.oldTarget.destination = oldDestination;
			transition.resolveOld(oldDestination);
		}
		transition.newTarget.pending = undefined;
		transition.newTarget.destination = currentDestination;
		if (!success) transition.newTarget.sessionId = manager.getSessionId();
		transition.resolveNew(currentDestination);
		if (transition.detachedManager && (oldDestination.kind !== "detached" || transition.oldTarget.refs === 0)) {
			void transition.detachedManager.close().catch(error => {
				logger.warn("Failed to close detached bash session writer", { error: String(error) });
			});
		}
	}

	async #saveOriginalArtifact(target: BashSessionTarget, originalText: string): Promise<string | undefined> {
		try {
			const destination = target.destination ?? (await target.pending);
			return await destination?.manager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	#createMessage(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): BashExecutionMessage {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		return {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
	}

	#captureSessionTarget(): BashSessionTarget {
		this.#sessionTarget.refs++;
		return this.#sessionTarget;
	}

	async #releaseSessionTarget(target: BashSessionTarget): Promise<void> {
		if (target.refs <= 0) throw new Error("Bash session target released more than once");
		target.refs--;
		if (target.refs === 0 && target.destination?.kind === "detached") await target.destination.manager.close();
	}

	#appendMessage(destination: BashAppendDestination, message: BashExecutionMessage): void {
		switch (destination.kind) {
			case "current":
				this.#host.agent.appendMessage(message);
				destination.manager.appendMessage(message);
				break;
			case "detached":
				destination.manager.appendMessage(message);
				break;
			case "branch":
				destination.parentId = destination.manager.appendMessageToBranch(message, destination.parentId);
				break;
		}
	}

	async #appendOwnedMessage(target: BashSessionTarget, message: BashExecutionMessage): Promise<void> {
		try {
			const destination = target.destination ?? (await target.pending);
			if (!destination) throw new Error("Bash session target has no append destination");
			this.#appendMessage(destination, message);
		} finally {
			await this.#releaseSessionTarget(target);
		}
	}

	async #recordResultForTarget(
		target: BashSessionTarget,
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): Promise<void> {
		const message = this.#createMessage(command, result, options);
		if (this.#host.isStreaming() && target === this.#sessionTarget) {
			this.#pendingMessages.push({ target, message });
			return;
		}
		await this.#appendOwnedMessage(target, message);
	}
}
