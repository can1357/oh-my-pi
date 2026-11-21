/**
 * The Teach sheet: record clicks and typing on the tab (with optional spoken narration), prune bad steps, then
 * have the session turn them into a shortcut prompt.
 */
import type { ImageContent } from "@oh-my-pi/pi-wire";
import { Mic, MicOff, Pause, Play, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { TabContext, TeachStep } from "../../messages";
import { prepareWireImage } from "../images";
import type { PanelWorker } from "../session";
import { hostOf } from "../tab-context";
import { imageSrc } from "../timeline";
import { Favicon, Sheet } from "../ui";

/** Screenshots sent along with the recorded steps; more than this adds cost without adding understanding. */
const MAX_SHOTS = 12;
const SHOT_EDGE = 1024;

/** The slice of the Web Speech API the narration uses (Chrome ships it prefixed, without DOM typings). */
interface Recognition {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((event: RecognitionEvent) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
}
interface RecognitionEvent {
	resultIndex: number;
	results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
	const scope = globalThis as {
		SpeechRecognition?: RecognitionConstructor;
		webkitSpeechRecognition?: RecognitionConstructor;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** What a recorded step did, in the words of the step list. */
export function describeTeachStep(step: TeachStep): string {
	const target = step.name || step.text || step.selector || "the page";
	const role = step.role !== undefined && step.name ? `${step.role} ` : "";
	switch (step.kind) {
		case "click":
			return `Clicked ${role}“${target}”`;
		case "type":
			return step.value === undefined || step.value === ""
				? `Typed in “${target}”`
				: `Typed “${step.value}” in “${target}”`;
		case "key":
			return `Pressed ${step.key ?? "a key"}`;
		case "select":
			return `Selected “${step.value ?? ""}” in “${target}”`;
		case "navigate":
			return `Went to ${hostOf(step.url)}`;
	}
}

/** The recorded workflow as the text half of the “write a shortcut” prompt. */
export function teachPromptText(steps: readonly TeachStep[], shotSteps: readonly number[]): string {
	const lines = steps.map((step, index) => {
		const parts = [`${index + 1}. ${describeTeachStep(step)} — ${step.url}`];
		if (step.selector !== undefined) parts.push(`   selector: \`${step.selector}\``);
		if (step.text !== undefined && step.text !== step.name) parts.push(`   nearby text: “${step.text}”`);
		if (step.narration !== undefined && step.narration !== "") parts.push(`   I said: “${step.narration}”`);
		return parts.join("\n");
	});
	const shots =
		shotSteps.length === 0
			? ""
			: `\n\nThe attached screenshots show the page right after steps ${shotSteps.map(n => n + 1).join(", ")}, in that order.`;
	return [
		"Write a reusable shortcut prompt for this workflow. I recorded these steps in my browser:",
		"",
		lines.join("\n"),
		shots,
		"",
		"Describe the goal and the steps so you could repeat this later on the same kind of page; keep values that will differ next time as things to look up or ask for, not literals. Reply with only the prompt text.",
	].join("\n");
}

/** Up to {@link MAX_SHOTS} step screenshots, evenly spread, scaled for the model. */
export async function teachShots(
	steps: readonly TeachStep[],
): Promise<{ images: ImageContent[]; shotSteps: number[] }> {
	const withShots = steps.flatMap((step, index) =>
		step.screenshot === undefined ? [] : [{ index, shot: step.screenshot }],
	);
	const stride = Math.max(1, Math.ceil(withShots.length / MAX_SHOTS));
	const picked = withShots.filter((_, position) => position % stride === 0).slice(0, MAX_SHOTS);
	const images = await Promise.all(picked.map(async item => (await prepareWireImage(item.shot, SHOT_EDGE)).image));
	return { images, shotSteps: picked.map(item => item.index) };
}

function StepShot({ step }: { step: TeachStep }): ReactNode {
	const [zoomed, setZoomed] = useState(false);
	useEffect(() => {
		const timer = window.setTimeout(() => setZoomed(true), 300);
		return () => window.clearTimeout(timer);
	}, []);
	if (step.screenshot === undefined) return null;
	const hasPoint = step.x !== undefined && step.y !== undefined && step.viewport.width > 0 && step.viewport.height > 0;
	const origin = hasPoint
		? `${((step.x ?? 0) / step.viewport.width) * 100}% ${((step.y ?? 0) / step.viewport.height) * 100}%`
		: "50% 50%";
	return (
		<div className="pn-teach-shot">
			<img
				src={imageSrc(step.screenshot)}
				alt=""
				draggable={false}
				style={{ transformOrigin: origin, transform: zoomed && hasPoint ? "scale(2.5)" : undefined }}
			/>
			{hasPoint && <span className="pn-teach-shot-dot" />}
		</div>
	);
}

function Narration({ text }: { text: string }): ReactNode {
	const [open, setOpen] = useState(false);
	const long = text.length > 50;
	return (
		<button type="button" className="pn-teach-narration" disabled={!long} onClick={() => setOpen(v => !v)}>
			“{long && !open ? `${text.slice(0, 50)}…` : text}”
		</button>
	);
}

/** The sheet. `onGenerate` asks the session for the shortcut prompt and resolves with its text. */
export function TeachSheet(props: {
	worker: PanelWorker;
	tab: TabContext | null;
	onGenerate(steps: TeachStep[]): Promise<string>;
	onDone(result: { prompt: string; steps: TeachStep[] }): void;
	onClose(): void;
	onNotify(level: "info" | "error", message: string): void;
}): ReactNode {
	const { worker, tab } = props;
	const [phase, setPhase] = useState<"start" | "recording" | "writing">("start");
	const [steps, setSteps] = useState<TeachStep[]>([]);
	const [paused, setPaused] = useState(false);
	const [mic, setMic] = useState(false);
	const [hearing, setHearing] = useState("");
	/** The recorder is gone (a failed Done already stopped it); the kept steps can still be submitted. */
	const [stopped, setStopped] = useState(false);
	const pausedRef = useRef(false);
	pausedRef.current = paused;
	const recording = useRef(false);
	const recognition = useRef<Recognition | null>(null);
	/** Narration spoken before the first step; it belongs to that step once it exists. */
	const earlyNarration = useRef("");
	const tailRef = useRef<HTMLLIElement | null>(null);

	useEffect(
		() =>
			worker.onEvent(event => {
				if (event.event !== "teachStep" || pausedRef.current || !recording.current) return;
				const narration = earlyNarration.current;
				earlyNarration.current = "";
				setSteps(list => [...list, narration === "" ? event.step : { ...event.step, narration }]);
			}),
		[worker],
	);

	useEffect(() => {
		tailRef.current?.scrollIntoView({ block: "nearest" });
	}, [steps.length, hearing]);

	const stopMic = useCallback((): void => {
		const active = recognition.current;
		recognition.current = null;
		if (active !== null) {
			active.onend = null;
			active.stop();
		}
		setMic(false);
		setHearing("");
	}, []);

	// Leaving the sheet any way ends the recording; the worker's recorder must not outlive it.
	useEffect(
		() => () => {
			recognition.current?.stop();
			recognition.current = null;
			if (recording.current) {
				recording.current = false;
				void worker.request("teachStop", {}).catch(() => undefined);
			}
		},
		[worker],
	);

	const start = async (): Promise<void> => {
		if (tab === null) return;
		try {
			await worker.request("teachStart", { tabId: tab.tabId });
			recording.current = true;
			setSteps([]);
			setPaused(false);
			setStopped(false);
			setPhase("recording");
		} catch (error) {
			props.onNotify("error", `Couldn’t start recording: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const discard = (): void => {
		stopMic();
		if (recording.current) {
			recording.current = false;
			void worker.request("teachStop", {}).catch(() => undefined);
		}
		setSteps([]);
		setPhase("start");
	};

	const toggleMic = (): void => {
		if (mic) return stopMic();
		const Constructor = recognitionConstructor();
		if (Constructor === null) {
			props.onNotify("error", "Speech recognition is not available in this browser");
			return;
		}
		const session = new Constructor();
		session.continuous = true;
		session.interimResults = true;
		session.lang = navigator.language;
		session.onresult = event => {
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result[0]?.transcript.trim() ?? "";
				if (!result.isFinal) {
					interim += `${text} `;
					continue;
				}
				if (text === "" || pausedRef.current) continue;
				setSteps(list => {
					const last = list[list.length - 1];
					if (last === undefined) {
						earlyNarration.current = `${earlyNarration.current} ${text}`.trim();
						return list;
					}
					return [...list.slice(0, -1), { ...last, narration: `${last.narration ?? ""} ${text}`.trim() }];
				});
			}
			setHearing(interim.trim());
		};
		session.onerror = event => {
			if (event.error === "no-speech" || event.error === "aborted") return;
			props.onNotify(
				"error",
				event.error === "not-allowed" ? "Microphone access was blocked" : `Narration stopped: ${event.error}`,
			);
			stopMic();
		};
		// Chrome ends recognition after a stretch of silence; keep listening until the mic is turned off.
		session.onend = () => {
			if (recognition.current === session) session.start();
		};
		recognition.current = session;
		session.start();
		setMic(true);
	};

	const done = async (): Promise<void> => {
		stopMic();
		setPhase("writing");
		let final = steps;
		try {
			// The worker's copies carry the screenshots; ours carry the narration and the user's pruning.
			const recorded = recording.current ? await worker.request("teachStop", {}) : [];
			recording.current = false;
			const byTime = new Map(recorded.map(step => [step.at, step]));
			final = steps.map(step => ({ ...step, screenshot: step.screenshot ?? byTime.get(step.at)?.screenshot }));
			const prompt = await props.onGenerate(final);
			props.onDone({ prompt, steps: final });
		} catch (error) {
			props.onNotify(
				"error",
				`Couldn’t write the shortcut: ${error instanceof Error ? error.message : String(error)}`,
			);
			setStopped(!recording.current);
			setPhase("recording");
		}
	};

	const footer =
		phase === "start" ? undefined : (
			<div className="pn-teach-foot">
				<div className="pn-teach-controls">
					<button type="button" className="sh-btn pn-btn" disabled={phase === "writing"} onClick={discard}>
						Discard
					</button>
					<button
						type="button"
						className="sh-btn pn-btn"
						disabled={phase === "writing" || stopped}
						onClick={() => setPaused(value => !value)}
					>
						{paused ? <Play size={13} /> : <Pause size={13} />}
						{paused ? "Resume" : "Pause"}
					</button>
					<button
						type="button"
						className={`sh-btn pn-btn${mic ? " pn-btn--mic-on" : ""}`}
						aria-pressed={mic}
						disabled={phase === "writing"}
						onClick={toggleMic}
					>
						{mic ? <Mic size={13} /> : <MicOff size={13} />}
						{mic ? "Mic on" : "Mic off"}
					</button>
				</div>
				<button
					type="button"
					className="sh-btn sh-btn-primary pn-btn pn-btn--wide"
					disabled={steps.length === 0 || phase === "writing"}
					onClick={() => void done()}
				>
					{phase === "writing" ? "Writing shortcut…" : "Done"}
				</button>
			</div>
		);

	return (
		<Sheet
			title={
				<span className="pn-teach-title">
					<Favicon src={tab?.favIconUrl} size={16} />
					<span>{tab?.title || "No tab"}</span>
				</span>
			}
			closeLabel="Cancel"
			onClose={props.onClose}
			footer={footer}
		>
			{phase === "start" ? (
				<div className="pn-teach-start">
					<p>
						Do the task once on this tab. omp records each click and keystroke with a screenshot, then writes a
						shortcut that repeats it.
					</p>
					<button
						type="button"
						className="sh-btn sh-btn-primary pn-btn pn-btn--wide"
						disabled={tab === null}
						onClick={() => void start()}
					>
						Start recording
					</button>
				</div>
			) : (
				<ol className="pn-teach-steps">
					{steps.length === 0 && (
						<li className="pn-teach-hint">{paused ? "Recording is paused." : "Waiting for your first click…"}</li>
					)}
					{steps.map((step, index) => (
						<li key={step.at} className="pn-teach-step">
							<span className="pn-teach-num">{index + 1}</span>
							<div className="pn-teach-copy">
								<span className="pn-teach-desc">{describeTeachStep(step)}</span>
								<span className="pn-teach-host">{hostOf(step.url)}</span>
								{step.narration !== undefined && step.narration !== "" && <Narration text={step.narration} />}
								<StepShot step={step} />
							</div>
							<button
								type="button"
								className="pn-icon-btn pn-teach-remove"
								aria-label={`Remove step ${index + 1}`}
								disabled={phase === "writing"}
								onClick={() => setSteps(list => list.filter(item => item.at !== step.at))}
							>
								<Trash2 size={14} />
							</button>
						</li>
					))}
					{mic && (
						<li className="pn-teach-listening">
							<Mic size={13} />
							<span className="pn-shimmer-text">{hearing === "" ? "Listening…" : hearing}</span>
						</li>
					)}
					<li ref={tailRef} className="pn-teach-tail" aria-hidden="true" />
				</ol>
			)}
		</Sheet>
	);
}
