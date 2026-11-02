import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "./settings";

/** `notice` source of cost-gate warnings and refusals. */
export const COST_GATE_NOTICE_SOURCE = "cost-gate";

/** A model request the cost gate refused to send. */
export interface CostCapRefusal {
	/** Session-tree spend in USD when the request was refused. */
	readonly spent: number;
	/** The `session.maxCost` cap in USD. */
	readonly cap: number;
	readonly message: string;
}

/** Rejects a model request the cost gate refused (the caller sends nothing). */
export class CostCapError extends Error {
	constructor(readonly refusal: CostCapRefusal) {
		super(refusal.message);
		this.name = "CostCapError";
	}
}

function usd(amount: number): string {
	return `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;
}

/**
 * Running spend of one session tree: the root session, its subagents, and
 * their side requests share one gate. The total starts from the root's
 * recorded spend (so a resumed session keeps its history) and adds every
 * response's cost as it finishes. Thresholds are read from the root's
 * settings on each check, so setting or changing `session.warnCost` /
 * `session.maxCost` applies to the next request.
 */
export class CostGate {
	readonly #settings: Settings;
	readonly #warn: (message: string) => void;
	#spent: number;
	#warned: boolean;

	constructor(settings: Settings, recordedSpend: number, warn: (message: string) => void) {
		this.#settings = settings;
		this.#warn = warn;
		this.#spent = recordedSpend;
		const warnCost = cfgSessionWarnCost.get(settings);
		// A session resumed past its warning threshold was warned in the run that crossed it.
		this.#warned = warnCost !== undefined && recordedSpend >= warnCost;
	}

	get spent(): number {
		return this.#spent;
	}

	/** Whether `session.maxCost` is set, so requests can be refused at all. */
	get capped(): boolean {
		return cfgSessionMaxCost.get(this.#settings) !== undefined;
	}

	/** Calls `onChange` after `session.maxCost` changes in the gate's settings; returns the unsubscribe. */
	onCapChange(onChange: () => void): () => void {
		return cfgSessionMaxCost.listen(this.#settings, () => onChange());
	}

	/** The refusal for the next model request, or `undefined` to send it. */
	check(): CostCapRefusal | undefined {
		const cap = cfgSessionMaxCost.get(this.#settings);
		if (cap === undefined || this.#spent < cap) return undefined;
		return {
			spent: this.#spent,
			cap,
			message: `Cost cap reached: this session spent ${usd(this.#spent)} of its ${usd(cap)} cap (--max-cost / session.maxCost), so the next model request was not sent.`,
		};
	}

	/** Throws {@link CostCapError} when the next model request must not be sent. */
	admit(): void {
		const refusal = this.check();
		if (refusal) throw new CostCapError(refusal);
	}

	/** Adds a finished response's cost; warns once when the total first reaches `session.warnCost`. */
	record(cost: number): void {
		if (!(cost > 0)) return;
		this.#spent += cost;
		const warnCost = cfgSessionWarnCost.get(this.#settings);
		if (this.#warned || warnCost === undefined || this.#spent < warnCost) return;
		this.#warned = true;
		this.#warn(
			`Cost warning: this session has spent ${usd(this.#spent)}, past its ${usd(warnCost)} warning threshold (--warn-cost / session.warnCost).`,
		);
	}

	/** Records the response's cost once the provider finishes producing it. */
	meter(stream: AssistantMessageEventStream): AssistantMessageEventStream {
		stream.result().then(
			message => this.record(message.usage.cost.total),
			() => {},
		);
		return stream;
	}
}

/**
 * Wraps a stream function so each request passes the gate current when it is
 * sent, and adds its cost to that gate. Wrap the function that sends one
 * provider attempt (inside concurrency slots and retry loops), so a request
 * that waited for a slot or retries is checked when it actually goes out.
 */
export function guardStreamFn(streamFn: StreamFn, currentGate: () => CostGate | undefined): StreamFn {
	return (model, context, options) => {
		const gate = currentGate();
		if (!gate) return streamFn(model, context, options);
		const refusal = gate.check();
		if (refusal) return Promise.reject(new CostCapError(refusal));
		const stream = streamFn(model, context, options);
		return stream instanceof Promise ? stream.then(sent => gate.meter(sent)) : gate.meter(stream);
	};
}
