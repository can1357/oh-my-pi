import type { DeferredDiagnosticsEntry, ToolSession } from "../tools";
import { getDiagnosticsLedger } from "./diagnostics-ledger";
import type { FileDiagnosticsResult } from "@oh-my-pi/pi-tui/tools/lsp";
import type { WritethroughDeferredHandle } from "./index";

import { cfgLspDiagnosticsDeduplicate } from "./settings";

/** Coordinates late LSP diagnostics for one mutation tool instance. */
export class DeferredDiagnostics {
	readonly #pendingFetches = new Map<string, AbortController>();
	readonly #fallbackVersions = new Map<string, number>();

	constructor(private readonly session: ToolSession) {}

	/** Begin a file mutation and return the handle consumed by LSP writethrough. */
	begin(path: string): WritethroughDeferredHandle {
		const existing = this.#pendingFetches.get(path);
		if (existing) {
			existing.abort();
			this.#pendingFetches.delete(path);
		}

		const controller = new AbortController();
		const mutationVersion = this.#bumpVersion(path);
		return {
			onDeferredDiagnostics: diagnostics => {
				this.#pendingFetches.delete(path);
				this.#inject(path, diagnostics, mutationVersion);
			},
			signal: controller.signal,
			finalize: diagnostics => {
				if (!diagnostics) {
					this.#pendingFetches.set(path, controller);
				} else {
					controller.abort();
				}
			},
		};
	}

	#inject(path: string, diagnostics: FileDiagnosticsResult, mutationVersion: number): void {
		// Read at delivery time so `lsp.diagnosticsDeduplicate` changes apply to in-flight fetches too.
		const deduplicate = cfgLspDiagnosticsDeduplicate.get(this.session.settings);
		const effective = deduplicate ? getDiagnosticsLedger(this.session).reduce(path, diagnostics) : diagnostics;
		// An unjudged file carries no messages but must not be dropped: the
		// server published nothing, so the file was never checked (issue #15408).
		if (deduplicate && effective.messages.length === 0 && (effective.unjudgedServers?.length ?? 0) === 0) return;

		const entry: DeferredDiagnosticsEntry = {
			path,
			summary: effective.summary ?? "",
			messages: effective.messages ?? [],
			errored: effective.errored,
			// The servers that published no verdict travel with the entry: a
			// zero-message result that only carries `unjudgedServers` must not
			// reach the renderer as a clean file (issue #15408).
			unjudgedServers: effective.unjudgedServers,
			isStale: () => this.#version(path) !== mutationVersion,
		};
		this.session.queueDeferredDiagnostics?.(entry);
	}

	#bumpVersion(path: string): number {
		if (this.session.bumpFileMutationVersion) return this.session.bumpFileMutationVersion(path);
		const next = (this.#fallbackVersions.get(path) ?? 0) + 1;
		this.#fallbackVersions.set(path, next);
		return next;
	}

	#version(path: string): number {
		if (this.session.getFileMutationVersion) return this.session.getFileMutationVersion(path);
		return this.#fallbackVersions.get(path) ?? 0;
	}
}
