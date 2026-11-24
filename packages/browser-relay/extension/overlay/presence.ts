/**
 * What tells you omp is in this tab: the gradient edge, the working tag with its Stop and Open controls, the
 * needs-input tag, the group pill for a conversation's other tabs, and the toast for a Stop that went nowhere.
 */
import type { OverlayEvent, TabActivity } from "../messages";
import { el, icon, ompMark, skipMotion, svg } from "./dom";
import type { Point } from "./motion";

/** The viewport edge a tag hangs from. */
type Edge = "top" | "bottom";

/** A Stop with no acknowledgement after this long is reported as not delivered. */
const STOP_ACK_MS = 1500;
/** An acknowledged Stop that hasn't ended the turn after this long can be pressed again. */
const STOP_RETRY_MS = 5000;
/** How long the toast stays. */
const TOAST_MS = 3000;
/** The tag's slide off an edge before it reappears at the other one. */
const TAG_LEAVE_MS = 140;
const TAG_ENTER_MS = 240;
/** Label swap: the old one leaves, then the new one enters after a beat. */
const LABEL_EXIT_MS = 150;
const LABEL_ENTER_DELAY_MS = 210;
const LABEL_ENTER_MS = 250;

const STOP_FAILED = "Stop didn’t reach omp — open the panel";

function button(className: string, label: string, ...children: (Node | string)[]): HTMLButtonElement {
	const node = el("button", className, ...children);
	node.type = "button";
	node.setAttribute("aria-label", label);
	// A click on an overlay control must not take focus from the page field the user was in.
	node.addEventListener("mousedown", event => event.preventDefault());
	return node;
}

/** The side-panel glyph on the pill's Open control. */
function panelIcon(): SVGSVGElement {
	return icon(
		svg("rect", { x: "2", y: "3", width: "12", height: "10", rx: "2.5" }),
		svg("path", { d: "M9.75 3v10" }),
	);
}

/** Edge, tags, pill and toast for one tab. */
export class Presence {
	/** Decorative layers below the controls, the controls, then the frame, which runs unbroken over the tag. */
	readonly layers: HTMLElement[];
	readonly #emit: (op: OverlayEvent["op"]) => void;
	readonly #glow = el("div", "glow");
	readonly #frame = el("div", "frame");
	readonly #tag = el("div", "tag glass");
	readonly #live = el("span", "tag-live");
	readonly #liveText = el("span", "tag-live-text");
	readonly #moveTip = el("span", "tip");
	readonly #move: HTMLButtonElement;
	readonly #stop: HTMLButtonElement;
	readonly #stopText = el("span", "", "Stop");
	readonly #ask = el("div", "ask glass");
	readonly #pill = el("div", "pill glass");
	readonly #pillLead = el("span", "pill-lead");
	readonly #pillText = el("span", "pill-text");
	readonly #toast = el("div", "toast glass");

	#activity: TabActivity = { state: "idle" };
	#role: "main" | "secondary" = "main";
	#edgeEnabled = true;
	/** Where the user keeps the tag. */
	#preferred: Edge = "top";
	/** The agent is aiming at the tag's spot, so the tag is at the other edge for now. */
	#dodging = false;
	/** The edge the tag is at, or is sliding to. */
	#edge: Edge = "top";
	#edgeMoving = false;
	#label: string | undefined;
	#labelSwap = 0;
	#stopping = false;
	/** Session whose group pill the user dismissed in this tab. */
	#dismissed: string | null = null;
	#stopTimer: number | undefined;
	#toastTimer: number | undefined;

	/** `emit` sends the user's Stop, Open and Dismiss to the worker. */
	constructor(emit: (op: OverlayEvent["op"]) => void) {
		this.#emit = emit;
		this.#glow.setAttribute("aria-hidden", "true");
		this.#frame.setAttribute("aria-hidden", "true");

		this.#move = button("move", "Move to bottom", icon(svg("path", { d: "M8 3v10M4 9l4 4 4-4" })), this.#moveTip);
		this.#move.addEventListener("click", () => {
			this.#preferred = this.#edge === "top" ? "bottom" : "top";
			this.#dodging = false;
			this.#syncEdge();
		});
		const stopGlyph = el("span", "stop-glyph");
		stopGlyph.setAttribute("aria-hidden", "true");
		this.#stop = button("stop", "Stop omp", stopGlyph, this.#stopText);
		this.#stop.addEventListener("click", () => this.#pressStop());
		this.#live.append(this.#liveText);
		this.#tag.setAttribute("role", "group");
		this.#tag.setAttribute("aria-label", "omp");
		this.#tag.append(
			ompMark(),
			el("span", "tag-label", el("span", "tag-title", "omp is working"), this.#live),
			this.#move,
			this.#openButton(),
			this.#stop,
		);

		const dot = el("span", "dot");
		dot.setAttribute("aria-hidden", "true");
		this.#ask.setAttribute("role", "group");
		this.#ask.setAttribute("aria-label", "omp");
		this.#ask.append(dot, "omp needs you", this.#openButton());

		const open = button("", "Open omp", panelIcon(), el("span", "tip", "Open omp"));
		open.addEventListener("click", () => this.#emit("open"));
		const dismiss = button("", "Dismiss", icon(svg("path", { d: "M4 4l8 8M12 4l-8 8" })), el("span", "tip", "Dismiss"));
		dismiss.addEventListener("click", () => {
			if (this.#activity.state !== "idle") this.#dismissed = this.#activity.session;
			this.#emit("dismiss");
			this.#render();
		});
		const rule = el("span", "rule");
		rule.setAttribute("aria-hidden", "true");
		this.#pill.setAttribute("role", "group");
		this.#pill.setAttribute("aria-label", "omp");
		this.#pill.append(this.#pillLead, this.#pillText, rule, open, dismiss);

		this.#toast.setAttribute("role", "status");
		this.#syncEdgeLabels();
		this.layers = [this.#glow, this.#tag, this.#ask, this.#pill, this.#toast, this.#frame];
	}

	/** Show what a conversation is doing here. `main` tabs get edge and tags; `secondary` tabs get the pill. */
	setActivity(activity: TabActivity, role: "main" | "secondary"): void {
		const wasWorking = this.#activity.state === "working";
		this.#activity = activity;
		this.#role = role;
		if (activity.state === "idle") this.#dismissed = null;
		if (activity.state !== "working") {
			this.#dodging = false;
			if (wasWorking) this.#endStop();
		}
		this.#render();
	}

	/** Turn the edge glow and frame on or off (the user's setting). */
	setEdgeEnabled(enabled: boolean): void {
		this.#edgeEnabled = enabled;
		this.#render();
	}

	/** The agent's arrow is headed for `point` (null: nowhere); the working tag gets out of its way. */
	aim(point: Point | null): void {
		const dodging = point !== null && this.#covers(point);
		if (dodging === this.#dodging) return;
		this.#dodging = dodging;
		this.#syncEdge();
	}

	/** How far each edge's chrome (tag, needs-input tag, pill) reaches into the viewport, for the picker's hint. */
	occupied(): { top: number; bottom: number } {
		const reach = { top: 0, bottom: 0 };
		if (this.#tag.classList.contains("on")) reach[this.#edge] = this.#tag.offsetHeight;
		if (this.#ask.classList.contains("on")) reach[this.#edge] = 20 + this.#ask.offsetHeight;
		if (this.#pill.classList.contains("on")) reach.bottom = 16 + this.#pill.offsetHeight;
		return reach;
	}

	/** The worker's answer to a Stop press. */
	stopAck(delivered: boolean): void {
		if (!this.#stopping) return;
		clearTimeout(this.#stopTimer);
		if (delivered) this.#stopTimer = window.setTimeout(() => this.#endStop(), STOP_RETRY_MS);
		else this.#failStop();
	}

	/** Whether the tag, at the user's edge, would cover an arrow at `point` or its chip. */
	#covers(point: Point): boolean {
		if (this.#role !== "main" || this.#activity.state !== "working") return false;
		const { width, height } = this.#tag.getBoundingClientRect();
		const left = (window.innerWidth - width) / 2;
		// The chip hangs right of and below the tip, so the zone reaches further left and, at the bottom, further up.
		if (point.x < left - 96 || point.x > left + width + 32) return false;
		return this.#preferred === "top" ? point.y < height + 12 : point.y > window.innerHeight - height - 44;
	}

	#openButton(): HTMLButtonElement {
		const open = button("open", "Open omp", "Open omp");
		open.addEventListener("click", () => this.#emit("open"));
		return open;
	}

	#render(): void {
		const activity = this.#activity;
		const main = this.#role === "main";
		const working = activity.state === "working";
		const lit = this.#edgeEnabled && working;
		this.#glow.classList.toggle("on", lit);
		this.#frame.classList.toggle("on", lit && main);
		const tagWasOn = this.#tag.classList.contains("on");
		this.#tag.classList.toggle("on", main && working);
		this.#ask.classList.toggle("on", main && activity.state === "waiting");
		this.#stop.hidden = !(working && activity.canStop);
		// The label swaps in place only on a tag that is already up; a tag sliding in arrives with its label.
		this.#setLabel(main && working ? activity.label : undefined, tagWasOn && main && working);

		const pill = !main && activity.state !== "idle" && activity.session !== this.#dismissed;
		this.#pill.classList.toggle("on", pill);
		if (pill) {
			const lead = working ? ompMark() : el("span", "dot");
			lead.setAttribute("aria-hidden", "true");
			this.#pillLead.classList.toggle("on", !working);
			this.#pillLead.replaceChildren(lead);
			this.#pillText.textContent = working ? "omp is working in this group" : "omp needs you in this group";
		}
	}

	/** Bring the tag to the edge it belongs at, sliding it off the old edge first when it is on screen. */
	#syncEdge(): void {
		const other: Edge = this.#preferred === "top" ? "bottom" : "top";
		const edge = this.#dodging ? other : this.#preferred;
		if (edge === this.#edge) return;
		const from = this.#edge;
		this.#edge = edge;
		// A slide already on its way out lands at whichever edge is current when it finishes.
		if (this.#edgeMoving) return;
		const tag = this.#tag;
		if (!tag.classList.contains("on") || skipMotion()) {
			this.#syncEdgeLabels();
			return;
		}
		const away = (side: Edge) => ({ transform: `translateY(${side === "top" ? -100 : 100}%)`, opacity: 0 });
		const home = { transform: "translateY(0)", opacity: 1 };
		this.#edgeMoving = true;
		const leave = tag.animate([home, away(from)], { duration: TAG_LEAVE_MS, easing: "ease-in", fill: "forwards" });
		leave.onfinish = () => {
			this.#edgeMoving = false;
			this.#syncEdgeLabels();
			leave.cancel();
			tag.animate([away(this.#edge), home], { duration: TAG_ENTER_MS, easing: "cubic-bezier(.16,1,.3,1)" });
		};
	}

	#syncEdgeLabels(): void {
		this.#tag.dataset.edge = this.#edge;
		this.#ask.dataset.edge = this.#edge;
		const label = this.#edge === "top" ? "Move to bottom" : "Move to top";
		this.#move.setAttribute("aria-label", label);
		this.#moveTip.textContent = label;
	}

	/** Swap the live verb after “omp is working”, resizing the tag smoothly around it. */
	#setLabel(label: string | undefined, animate: boolean): void {
		if (label === this.#label) return;
		this.#label = label;
		const swap = ++this.#labelSwap;
		const box = this.#live;
		const text = this.#liveText;
		if (!animate || skipMotion()) {
			text.textContent = label ?? "";
			return;
		}
		const from = box.getBoundingClientRect().width;
		text.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-3px)" }], {
			duration: LABEL_EXIT_MS,
			easing: "ease-out",
			fill: "forwards",
		});
		setTimeout(() => {
			if (swap !== this.#labelSwap) return;
			for (const animation of text.getAnimations()) animation.cancel();
			text.textContent = label ?? "";
			const to = box.getBoundingClientRect().width;
			const timing = { duration: LABEL_ENTER_MS, easing: "ease-in-out" };
			box.animate([{ width: `${from}px` }, { width: `${to}px` }], timing);
			text.animate([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1 }], timing);
		}, LABEL_ENTER_DELAY_MS);
	}

	#pressStop(): void {
		if (this.#stopping) return;
		this.#stopping = true;
		this.#stop.disabled = true;
		this.#stopText.textContent = "Stopping…";
		this.#emit("stop");
		this.#stopTimer = window.setTimeout(() => this.#failStop(), STOP_ACK_MS);
	}

	#endStop(): void {
		clearTimeout(this.#stopTimer);
		this.#stopping = false;
		this.#stop.disabled = false;
		this.#stopText.textContent = "Stop";
	}

	#failStop(): void {
		this.#endStop();
		this.#toast.textContent = STOP_FAILED;
		this.#toast.classList.add("on");
		clearTimeout(this.#toastTimer);
		this.#toastTimer = window.setTimeout(() => this.#toast.classList.remove("on"), TOAST_MS);
	}
}
