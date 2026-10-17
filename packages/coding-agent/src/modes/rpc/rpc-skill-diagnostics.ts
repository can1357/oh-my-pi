import { buildSkillDiagnosticsSnapshot, type SkillDiagnosticsSnapshot } from "../../extensibility/skill-diagnostics";
import { cfgSkillsShowStartupDiagnostics } from "../../extensibility/settings";
import type { AgentSession } from "../../session/agent-session";
import type { RpcSkillDiagnosticsUpdateFrame } from "./rpc-types";

/** Projects the resolver state onto RPC and emits only effective changes. */
export class RpcSkillDiagnostics {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcSkillDiagnosticsUpdateFrame) => void;
	#lastEmitted: SkillDiagnosticsSnapshot | undefined;

	constructor(session: AgentSession, output: (frame: RpcSkillDiagnosticsUpdateFrame) => void) {
		this.#session = session;
		this.#output = output;
		const unsubscribeMetadata = session.subscribeCommandMetadataChanged(() => this.#emitIfChanged());
		session.addDisposer(unsubscribeMetadata);
		cfgSkillsShowStartupDiagnostics.listen(session, () => this.#emitIfChanged());
		this.#emitIfChanged();
	}

	snapshot(): SkillDiagnosticsSnapshot {
		return buildSkillDiagnosticsSnapshot(
			this.#session.sessionManager.getCwd(),
			this.#session.skillDiagnostics,
			cfgSkillsShowStartupDiagnostics.get(this.#session.settings),
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
		this.#lastEmitted = snapshot;
		this.#output({ type: "skill_diagnostics_update", data: snapshot });
	}
}
