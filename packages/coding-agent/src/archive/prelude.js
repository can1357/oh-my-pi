{
	/** Plain JSON params: Dates become ISO strings; a RegExp becomes its source, its flags merged into `flags`. */
	const normalize = params => {
		const normalized = {};
		let flags = typeof params.flags === "string" ? params.flags : "";
		for (const key in params) {
			let value = params[key];
			if (value === undefined) continue;
			if (value instanceof Date) value = value.toISOString();
			else if (value instanceof RegExp) {
				for (const flag of value.flags) if ("ims".includes(flag) && !flags.includes(flag)) flags += flag;
				value = value.source;
			}
			normalized[key] = value;
		}
		if (flags) normalized.flags = flags;
		return normalized;
	};
	const call = async (method, action, options, required) => {
		if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {
			throw new TypeError(`archive.${method}() expects an options object`);
		}
		const { silent, ...params } = { ...options, ...required };
		const response = await globalThis.__omp_prelude__("archive", { ...normalize(params), action });
		if (!silent && response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_log__("log", response.text);
		}
		return response && typeof response === "object" ? response.details : undefined;
	};
	globalThis.archive = Object.freeze({
		projects: options => call("projects", "projects", options),
		sessions: options => call("sessions", "sessions", options),
		session: (id, options) => call("session", "session", options, { id }),
		prompts: options => call("prompts", "prompts", options),
		search: (query, options) => call("search", "search", options, { query }),
		recaps: options => call("recaps", "recaps", options),
		calls: options => call("calls", "calls", options),
		grep: (pattern, options) => call("grep", "grep", options, { pattern }),
		stats: options => call("stats", "stats", options),
		messages: (id, options) => call("messages", "messages", options, { id }),
	});
}
