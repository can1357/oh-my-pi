import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import {
	type CodexContextWindowIdentity,
	getOpenAICodexContextWindow,
	resetOpenAICodexHistoryAfterCompaction,
	restoreOpenAICodexContextWindow,
	setOpenAICodexHistoryIngestion,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	canUseCodexHistoryNotes,
	getCodexContextWindowPolicy,
	codexHistoryNotesAgentPath,
	type HistoryNotesAgentIdentity,
	type CodexHistoryNotesAuth,
	CodexHistoryNotesBackend,
} from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import type { CodexContextWindows } from "@oh-my-pi/pi-catalog/types";
import type { Settings } from "../config/settings";
import { createCodexHistoryNotesTools } from "../tools/codex-history-notes";
import { CodexContextWindowProtocol } from "./codex-context-window";
import { sessionEntryIdOf } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { DEFAULT_MAX_BYTES } from "./streaming-output";

const identitySchema = type({
	threadId: "string",
	firstWindowId: "string",
	"previousWindowId?": "string",
	windowId: "string",
	windowNumber: "number.integer > 0",
	"agentPath?": "string",
});

interface RuntimeHost {
	settings: Settings;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	providerSessionId(): string;
	model(): Model | undefined;
	resolveAuth(model: Model): Promise<CodexHistoryNotesAuth>;
	agentIdentity: HistoryNotesAgentIdentity;
}

/** Owns frozen activation, live route availability, backend access and persisted window identity. */
export class CodexContextWindowRuntime {
	readonly protocol: CodexContextWindowProtocol;
	readonly backend: CodexHistoryNotesBackend;
	readonly #host: RuntimeHost;
	readonly #windowRequested: boolean;
	readonly #notesRequested: boolean;
	#sessionId?: string;
	#available = false;
	#threadHint?: string;
	#policy?: CodexContextWindows;
	#notesTools?: AgentTool[];
	#initialized = false;
	#lastIdentity?: CodexContextWindowIdentity;

	constructor(host: RuntimeHost) {
		this.#host = host;
		this.#windowRequested = host.settings.get("compaction.methodOrder").includes("window");
		const notesMode = host.settings.get("providers.openai-codex.historyNotes");
		this.#notesRequested =
			notesMode === "on" ||
			(notesMode === "auto" && getCodexContextWindowPolicy(host.model())?.useHistoryNotes === true);
		this.protocol = new CodexContextWindowProtocol(codexHistoryNotesAgentPath(host.agentIdentity));
		this.backend = new CodexHistoryNotesBackend(async () => {
			const model = host.model();
			if (!model || model.api !== "openai-codex-responses") throw new Error("Codex model unavailable");
			return host.resolveAuth(model);
		});
	}

	get windowActive(): boolean {
		return (
			this.#host.settings.get("compaction.enabled") &&
			this.#available &&
			this.#windowRequested &&
			this.#policy !== undefined
		);
	}
	get notesActive(): boolean {
		return this.#available && this.#notesRequested;
	}
	get policy(): CodexContextWindows | undefined {
		return this.windowActive ? this.#policy : undefined;
	}
	get effectiveLimit(): number {
		return resolveThresholdTokens(this.#host.model()?.contextWindow ?? 0, this.#host.settings.getGroup("compaction"));
	}
	get identity(): CodexContextWindowIdentity {
		const identity = getOpenAICodexContextWindow(this.#host.providerSessionId(), this.#host.providerSessionState);
		if (
			this.#lastIdentity &&
			identity.windowId !== this.#lastIdentity.windowId &&
			identity.windowNumber <= this.#lastIdentity.windowNumber
		) {
			restoreOpenAICodexContextWindow(
				this.#host.providerSessionId(),
				this.#host.providerSessionState,
				this.#lastIdentity,
			);
			return this.#lastIdentity;
		}
		return (this.#lastIdentity = identity);
	}

	async refresh(): Promise<void> {
		this.#available = false;
		if (this.#notesRequested) {
			setOpenAICodexHistoryIngestion(this.#host.providerSessionId(), this.#host.providerSessionState, undefined);
		}
		const model = this.#host.model();
		if ((!this.#windowRequested && !this.#notesRequested) || model?.api !== "openai-codex-responses") return;
		try {
			if (!canUseCodexHistoryNotes(await this.#host.resolveAuth(model))) return;
		} catch {
			return;
		}
		this.#available = true;
		this.#policy = getCodexContextWindowPolicy(model);
		const sessionId = this.#host.providerSessionId();
		if (this.notesActive) {
			setOpenAICodexHistoryIngestion(sessionId, this.#host.providerSessionState, this.protocol.agentName);
		}
		if (this.#sessionId === sessionId && this.#initialized) return;
		this.#lastIdentity = undefined;
		this.#sessionId = sessionId;
		const branch = this.#host.sessionManager.getBranch();
		let restored = false;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			const candidate =
				entry.type === "compaction" && entry.method === "window"
					? entry.preserveData?.codexContextWindow
					: entry.type === "custom" && entry.customType === "codex.context-window"
						? entry.data
						: undefined;
			if (candidate === undefined) continue;
			const identity = identitySchema(candidate);
			if (identity instanceof type.errors) continue;
			if (this.#host.agentIdentity.kind === "sub" && identity.agentPath !== this.protocol.agentName) continue;
			restoreOpenAICodexContextWindow(sessionId, this.#host.providerSessionState, identity);
			restored = true;
			break;
		}
		if (!restored)
			this.#host.sessionManager.appendCustomEntry("codex.context-window", {
				...this.identity,
				agentPath: this.protocol.agentName,
			});
		this.#initialized = true;
		this.protocol.reset(this.identity);
		await this.refreshThreadHint();
	}

	async refreshThreadHint(): Promise<void> {
		this.#threadHint = this.notesActive ? await this.backend.threadHint(this.#backendContext()) : undefined;
	}

	#backendContext() {
		// Match codex-rs's session-store identity, not its separate thread identity.
		return {
			sessionId: this.identity.sessionId,
			agentName: this.protocol.agentName,
			truncation: { mode: "bytes" as const, limit: DEFAULT_MAX_BYTES },
		};
	}

	notesTools(): AgentTool[] {
		if (!this.notesActive) return [];
		return (this.#notesTools ??= createCodexHistoryNotesTools(this.backend, () => this.#backendContext()));
	}

	transform(context: Context): Context {
		if (!this.windowActive && !this.notesActive) return context;
		const identity = this.identity;
		setOpenAICodexHistoryIngestion(
			this.#host.providerSessionId(),
			this.#host.providerSessionState,
			this.notesActive ? this.protocol.agentName : undefined,
		);
		return this.protocol.transform(context, {
			identity,
			policy: this.#policy,
			threadHint: this.#threadHint,
			getMessageId: message => (message.role === "assistant" ? undefined : sessionEntryIdOf(message)),
		});
	}

	startNewWindow(): CodexContextWindowIdentity {
		resetOpenAICodexHistoryAfterCompaction({
			sessionId: this.#host.providerSessionId(),
			providerSessionState: this.#host.providerSessionState,
		});
		const identity = this.identity;
		this.protocol.reset(identity);
		return identity;
	}

	restore(identity: CodexContextWindowIdentity): void {
		restoreOpenAICodexContextWindow(this.#host.providerSessionId(), this.#host.providerSessionState, identity);
		this.#lastIdentity = identity;
		this.protocol.reset(identity);
	}
}
