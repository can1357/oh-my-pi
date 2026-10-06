import { buildSkillDiagnosticsSnapshot, type SkillDiagnosticsSnapshot } from "../../extensibility/skill-diagnostics";
import { cfgSkillsShowStartupDiagnostics } from "../../extensibility/settings";
import type { AgentSession } from "../../session/agent-session";
import type { RpcSkillDiagnosticsUpdateFrame } from "./rpc-types";

/**
 * Projects the session's shared skill-diagnostic workflow onto RPC and emits only effective changes.
 *
 * The analysis commands call the same `session.skillDiagnosticController` the interactive panel uses; this
 * class keeps no workflow state of its own, so ids, consent, progress and results mean the same thing on
 * every interface.
 */
export class RpcSkillDiagnostics {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcSkillDiagnosticsUpdateFrame) => void;
	#lastEmitted: SkillDiagnosticsSnapshot | undefined;

	constructor(session: AgentSession, output: (frame: RpcSkillDiagnosticsUpdateFrame) => void) {
		this.#session = session;
		this.#output = output;
		const unsubscribeMetadata = session.subscribeCommandMetadataChanged(() => this.#emitIfChanged());
		session.addDisposer(unsubscribeMetadata);
		// Status, progress, results and application are semantic changes of the same snapshot.
		session.addDisposer(session.skillDiagnosticController.subscribe(() => this.#emitIfChanged()));
		cfgSkillsShowStartupDiagnostics.listen(session, () => this.#emitIfChanged());
		this.#emitIfChanged();
	}

	snapshot(): SkillDiagnosticsSnapshot {
		return buildSkillDiagnosticsSnapshot(
			this.#session.sessionManager.getCwd(),
			this.#session.skillDiagnostics,
			cfgSkillsShowStartupDiagnostics.get(this.#session.settings),
			this.#session.skillDiagnosticController.items(),
		);
	}

	async setStartupDiagnostics(enabled: boolean): Promise<SkillDiagnosticsSnapshot> {
		cfgSkillsShowStartupDiagnostics.set(this.#session.settings, enabled);
		this.#emitIfChanged();
		await this.#session.settings.flush();
		return this.snapshot();
	}

	#emitIfChanged(): void {
		const snapshot = this.snapshot();
		if (this.#lastEmitted !== undefined && Bun.deepEquals(snapshot, this.#lastEmitted)) return;
		// Detached copy: records the controller later mutates in place must not make the next comparison a no-op.
		this.#lastEmitted = structuredClone(snapshot);
		this.#output({ type: "skill_diagnostics_update", data: snapshot });
	}
}
