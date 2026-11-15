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
		async show(path, options = {}) {
			return (await this.#run("show", { path }, options.silent)).text;
		}
		async take(path, options = {}) {
			this.#text = (
				await this.#run("take", { path, units: units(options.units), grep: options.grep }, options.silent)
			).text;
			return this;
		}
		async drop(path, options = {}) {
			this.#text = (
				await this.#run("drop", { path, units: units(options.units), grep: options.grep }, options.silent)
			).text;
			return this;
		}
		async only(globs, options = {}) {
			this.#text = (await this.#run("only", { globs: [globs].flat() }, options.silent)).text;
			return this;
		}
		async diff(options = {}) {
			return (await this.#run("diff", {}, options.silent)).text;
		}
		async commit(subject, options = {}) {
			const fixes = options.fixes === undefined ? undefined : [options.fixes].flat();
			const response = await this.#run(
				"commit",
				{
					subject,
					body: options.body,
					fixes,
					amend: options.amend || undefined,
					noVerify: options.noVerify || undefined,
				},
				options.silent,
			);
			// The committed draft is gone; continue with what remains.
			this.id = response.details.remaining.id;
			this.details = response.details.remaining;
			this.#text = response.text;
			return response.details;
		}
	}
	globalThis.commit = Object.freeze({
		async draft(options = {}) {
			const { text, details } = await call("draft", { agents: options.agents, repo: options.repo });
			log(text, options.silent);
			return new Draft(details, text);
		},
	});
}
