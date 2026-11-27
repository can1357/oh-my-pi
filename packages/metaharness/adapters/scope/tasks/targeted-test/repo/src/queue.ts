/** Runs async jobs with at most `limit` in flight. */
export class JobQueue {
	#active = 0;
	#waiting: Array<() => void> = [];

	constructor(readonly limit: number) {}

	async run<T>(job: () => Promise<T>): Promise<T> {
		while (this.#active >= this.limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiting.push(resolve);
			await promise;
		}
		this.#active++;
		try {
			return await job();
		} finally {
			this.#active--;
			this.#waiting.shift()?.();
		}
	}
}
