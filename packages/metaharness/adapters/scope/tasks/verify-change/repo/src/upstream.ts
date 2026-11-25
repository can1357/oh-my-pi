/** Stand-in for the redirect service: answers after `latencyMs`, failing its first `failures` calls. */
export class Upstream {
	calls = 0;
	#latencyMs: number;
	#failures: number;

	constructor(latencyMs = 250, failures = 0) {
		this.#latencyMs = latencyMs;
		this.#failures = failures;
	}

	async resolve(slug: string): Promise<string> {
		this.calls++;
		await Bun.sleep(this.#latencyMs);
		if (this.#failures-- > 0) throw new Error("upstream unavailable");
		return `https://go.example/${slug}`;
	}
}
