import type { RenderScheduler } from "@oh-my-pi/pi-tui/tui";
import type { VirtualTerminal } from "./virtual-terminal";

export class StressRenderScheduler implements RenderScheduler {
	#time = 0;
	#nextTimerId = 0;
	#immediateCallbacks: (() => void)[] = [];
	#renderCallbacks = new Map<number, () => void>();

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediateCallbacks.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): { cancel(): void } {
		const id = this.#nextTimerId;
		this.#nextTimerId += 1;
		this.#renderCallbacks.set(id, callback);
		return {
			cancel: () => {
				this.#renderCallbacks.delete(id);
			},
		};
	}

	async drain(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediateCallbacks.length > 0 || this.#renderCallbacks.size > 0) {
			rounds += 1;
			if (rounds > 100) throw new Error("Render scheduler did not settle after 100 drain rounds");
			const immediate = this.#immediateCallbacks;
			this.#immediateCallbacks = [];
			for (const callback of immediate) callback();
			if (this.#renderCallbacks.size === 0) continue;
			const render = [...this.#renderCallbacks.values()];
			this.#renderCallbacks.clear();
			for (const callback of render) callback();
		}
		await term.flush();
	}
}
