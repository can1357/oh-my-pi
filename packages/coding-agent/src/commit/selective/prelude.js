{
	const call = async (action, params) => {
		const defined = Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
		const response = await globalThis.__omp_prelude__("commit", { ...defined, action });
		// The bridge returns bare text when a call has no details.
		if (typeof response === "string") return { text: response, details: undefined };
		if (!response || typeof response !== "object") throw new Error("commit returned an invalid response");
		return { text: typeof response.text === "string" ? response.text : "", details: response.details };
	};
	const log = (text, silent) => {
		if (!silent && text) globalThis.__omp_log__("log", text);
	};
	const units = list => (list && list.length > 0 ? list.map(String) : undefined);
	/** `given` as an options object for `method`; throws on a non-object or a name outside `known`, as Python does for keywords. */
	const accept = (method, given, known) => {
		if (given === undefined) return {};
		if (given === null || typeof given !== "object" || Array.isArray(given)) {
			throw new TypeError(`${method}() takes an options object: { ${known.join(", ")} }`);
		}
		const unknown = Object.keys(given).filter(key => !known.includes(key));
		if (unknown.length > 0) {
			const names = unknown.map(key => `"${key}"`).join(", ");
			throw new TypeError(`${method}(): unknown option ${names}; expected ${known.join(", ")}`);
		}
		return given;
	};
	class Draft {
		#text;
		constructor(details, text) {
			this.id = details.id;
			this.details = details;
			this.#text = text;
		}
		toString() {
			return this.#text;
		}
		async #run(action, params, silent) {
			const response = await call(action, { ...params, draft: this.id });
			log(response.text, silent);
			return response;
		}
		async show(path, options) {
			const { silent } = accept("show", options, ["silent"]);
			return (await this.#run("show", { path }, silent)).text;
		}
		async take(path, options) {
			const { units: ids, grep, silent } = accept("take", options, ["units", "grep", "silent"]);
			this.#text = (await this.#run("take", { path, units: units(ids), grep }, silent)).text;
			return this;
		}
		async drop(path, options) {
			const { units: ids, grep, silent } = accept("drop", options, ["units", "grep", "silent"]);
			this.#text = (await this.#run("drop", { path, units: units(ids), grep }, silent)).text;
			return this;
		}
		async only(globs, options) {
			const { silent } = accept("only", options, ["silent"]);
			this.#text = (await this.#run("only", { globs: [globs].flat() }, silent)).text;
			return this;
		}
		async diff(options) {
			const { silent } = accept("diff", options, ["silent"]);
			return (await this.#run("diff", {}, silent)).text;
		}
		async commit(subject, options) {
			const { body, fixes, amend, noVerify, silent } = accept("commit", options, [
				"body",
				"fixes",
				"amend",
				"noVerify",
				"silent",
			]);
			const response = await this.#run(
				"commit",
				{
					subject,
					body,
					fixes: fixes === undefined ? undefined : [fixes].flat(),
					amend: amend || undefined,
					noVerify: noVerify || undefined,
				},
				silent,
			);
			// The committed draft is gone; continue with what remains.
			this.id = response.details.remaining.id;
			this.details = response.details.remaining;
			this.#text = response.text;
			return response.details;
		}
	}
	globalThis.commit = Object.freeze({
		async draft(options) {
			const { agents, repo, silent } = accept("draft", options, ["agents", "repo", "silent"]);
			const { text, details } = await call("draft", { agents, repo });
			log(text, silent);
			return new Draft(details, text);
		},
	});
}
