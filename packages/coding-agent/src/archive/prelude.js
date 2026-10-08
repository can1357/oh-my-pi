{
	const call = async (method, action, options, required) => {
		if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
			throw new TypeError(`archive.${method}() expects an options object`);
		}
		const { silent, ...params } = { ...options, ...required };
		const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
		const response = await globalThis.__omp_prelude__("archive", { ...defined, action });
		if (!silent && response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_display__(response.text);
		}
		return response && typeof response === "object" ? response.details : undefined;
	};
	globalThis.archive = Object.freeze({
		projects: options => call("projects", "projects", options),
		sessions: options => call("sessions", "sessions", options),
		session: (id, options) => call("session", "session", options, { id }),
		prompts: options => call("prompts", "prompts", options),
		search: (query, options) => call("search", "prompts", options, { query }),
		recaps: options => call("recaps", "recaps", options),
	});
}
