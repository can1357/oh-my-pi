import type { RpcBridge } from "../rpc/bridge";
import type { RpcSessionState } from "../rpc/protocol";

/**
 * Plan mode: whether it is on, and the switch.
 *
 * The mode was terminal-only until now — `/plan` carries no non-TUI handler, so
 * this client was never even told the command existed. It reads `planMode` from
 * the session state rather than remembering what it last asked for, because the
 * terminal can move the mode too and a remembered answer would go quietly
 * wrong.
 *
 * Nothing renders when the server does not report the field: an older omp
 * cannot honour the toggle, and offering one would be a lie.
 */
export function PlanModeBadge({ bridge, state }: { bridge: RpcBridge; state: RpcSessionState | null }) {
	const plan = state?.planMode;
	if (!plan) return null;

	return (
		<button
			className="omp-picker__trigger"
			type="button"
			data-plan={plan.enabled || undefined}
			aria-pressed={plan.enabled}
			title={
				plan.enabled
					? `Plan mode: the working tree is read-only${plan.planFilePath ? ` · ${plan.planFilePath}` : ""}`
					: "Plan mode: the agent researches and proposes before it acts"
			}
			onClick={() => void bridge.setPlanMode(!plan.enabled)}
		>
			{plan.enabled ? "plan" : "plan off"}
		</button>
	);
}
