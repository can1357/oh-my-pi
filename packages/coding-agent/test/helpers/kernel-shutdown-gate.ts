/** Makes each later `kernel.shutdown()` resolve `started`, then wait for `finish` before running the kernel's own shutdown. */
export function gateShutdown<TArgs extends unknown[], TResult>(kernel: {
	shutdown: (...args: TArgs) => Promise<TResult>;
}): { started: Promise<void>; finish: () => void } {
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const shutdown = kernel.shutdown.bind(kernel);
	kernel.shutdown = async (...args) => {
		started.resolve();
		await finish.promise;
		return await shutdown(...args);
	};
	return { started: started.promise, finish: () => finish.resolve() };
}
