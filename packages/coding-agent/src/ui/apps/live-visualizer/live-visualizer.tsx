/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The realtime-call panel: the phase (a spinner while the model works), the
 * mic level as a meter, the user's streaming transcript and Mute / End call
 * buttons. Escape, Ctrl+C and the configured stop chords end the call;
 * Space toggles mute.
 *
 * The terminal draws a rounded box with a two-row spectrum animated by the
 * call's frame counter (the `omp.app.live` look); natively the frame ticks
 * leave the tree unchanged.
 */
import type { JSXNode, KeyEvent } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import "../../styles/apps/live-visualizer/look";
import { callEnergy, type LiveCallModel, meterValue, PHASE_COLORS, PHASE_ICONS, PHASE_TONES } from "./model";
import { ActionButton } from "../../overlays/panels/common";

export interface LiveVisualizerProps {
	readonly model: LiveCallModel;
	onStop(): void;
	onToggleMute(): void;
	/** Configured chords (`app.live.toggle`, Ctrl+L by default) that also end the call. */
	readonly stopKeys?: readonly string[];
}

/** Terminal facts of the call card. */
export interface LiveCardTerm {
	readonly phase: string;
	readonly frame: number;
	readonly energy: number;
}

export function LiveVisualizer(props: LiveVisualizerProps): JSXNode {
	const model = props.model;
	const energy = () => callEnergy(model.phase(), model.level());
	const onKey = (key: KeyEvent): boolean => {
		if (key.id === "escape" || key.id === "ctrl+c" || props.stopKeys?.includes(key.id)) {
			props.onStop();
			return true;
		}
		if (key.id === "space") {
			props.onToggleMute();
			return true;
		}
		return false;
	};
	const onAction = (act: string): void => {
		if (act === "mute") props.onToggleMute();
		else if (act === "end") props.onStop();
	};
	const status = (): JSXNode => {
		const phase = model.phase();
		const color = PHASE_COLORS[phase];
		if (phase === "working") return <spinner label={[{ s: color, t: phase }]} tone={PHASE_TONES[phase]} />;
		return <text spans={[{ s: color, t: `${PHASE_ICONS[phase]} ${phase}` }]} />;
	};
	const meterTone = () => (model.phase() === "muted" ? "muted" : model.phase() === "error" ? "error" : "success");
	return (
		<card
			role="omp.app.live"
			tone={() => PHASE_TONES[model.phase()]}
			term={() => ({ phase: model.phase(), frame: model.frame(), energy: energy() }) satisfies LiveCardTerm}
			onKey={onKey}
			onAction={onAction}
		>
			<row key="head" gap="sm" align="center">
				{status}
			</row>
			<row role="omp.app.live.level" gap="sm" align="center">
				<text spans={[{ s: "muted", t: "mic" }]} />
				<meter value={() => meterValue(energy())} style="bar" size="md" tone={meterTone} grow={1} />
			</row>
			<text
				spans={() => [{ s: "accent", t: model.transcript() }] satisfies TspSpan[]}
				wrap="none"
				truncate="start"
			/>
			<row key="actions" role="omp.actions" gap="sm" align="center">
				<spacer grow={1} />
				<ActionButton
					id="mute"
					label={() => (model.phase() === "muted" ? "Unmute" : "Mute")}
					title={() => `${model.phase() === "muted" ? "Unmute" : "Mute"}  ␣`}
					keys={["space"]}
				/>
				<ActionButton id="end" label="End call" title="End call  esc" tone="error" keys={["escape"]} />
			</row>
		</card>
	);
}
