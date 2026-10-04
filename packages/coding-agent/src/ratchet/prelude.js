{
	const call = async (flow, action, params) => {
		const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
		const response = await globalThis.__omp_prelude__("ratchet", { ...defined, flow, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_display__(response.text);
		}
		return response && typeof response === "object" ? response.details : undefined;
	};
	const paths = value => (value === undefined ? undefined : typeof value === "string" ? [value] : [...value]);
	globalThis.ratchet = flow =>
		Object.freeze({
			flow,
			init: ({ cases, harness, change, offLimits, command } = {}) =>
				call(flow, "init", {
					cases: paths(cases),
					harness: paths(harness),
					change: paths(change),
					off_limits: paths(offLimits),
					command,
				}),
			plan: ({ goal, reps, stop, command, prices } = {}) => call(flow, "plan", { goal, reps, stop, command, prices }),
			split: (cases, { testFraction, seed } = {}) => call(flow, "split", { cases, test_fraction: testFraction, seed }),
			approve: (stage, { question, preview } = {}) => call(flow, "approve", { stage, question, preview }),
			check: variant => call(flow, "check", { variant }),
			gate: (variant, { change } = {}) => call(flow, "gate", { variant, change }),
			train: variant => call(flow, "train", { variant }),
			status: () => call(flow, "status", {}),
		});
}
