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
	const units = list => {
		const ids = list.flat().map(String);
		return ids.length > 0 ? ids : undefined;
	};
	/**
	 * Split `args` into positionals and a trailing options object. Throws on an option name outside
	 * `known` (as Python does for keywords) and on more than `max` positionals.
	 */
	const parse = (method, args, known, max = Infinity) => {
		const last = args.at(-1);
		const hasOptions = last !== null && typeof last === "object" && !Array.isArray(last);
		const options = hasOptions ? last : {};
		const unknown = Object.keys(options).filter(key => !known.includes(key));
		if (unknown.length > 0) {
			const names = unknown.map(key => `"${key}"`).join(", ");
			throw new TypeError(`${method}(): unknown option ${names}; expected ${known.join(", ")}`);
		}
		const positionals = hasOptions ? args.slice(0, -1) : args;
		if (positionals.length > max) {
			throw new TypeError(`${method}() takes at most ${max} positional argument(s), got ${positionals.length}`);
		}
		return [positionals, options];
	};
	/** A parameter given positionally or as an option, not both. */
	const either = (method, name, positional, option) => {
		if (positional !== undefined && option !== undefined) {
			throw new TypeError(`${method}(): ${name} given both positionally and as an option`);
		}
		return positional ?? option;
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
		[Symbol.for("nodejs.util.inspect.custom")]() {
			return this.#text;
		}
		async show(...args) {
			const [[path], { silent }] = parse("show", args, ["silent"], 1);
			return (await this.#run("show", { path }, silent)).text;
		}
		async take(...args) {
			this.#text = (await this.#select("take", args)).text;
			return this;
		}
		async drop(...args) {
			this.#text = (await this.#select("drop", args)).text;
			return this;
		}
		async #select(method, args) {
			const [[path, ...ids], options] = parse(method, args, ["units", "grep", "silent"]);
			const given = either(method, "units", ids.length > 0 ? ids : undefined, options.units);
			return this.#run(method, { path, units: units([given ?? []]), grep: options.grep }, options.silent);
		}
		async only(...args) {
			const [globs, { silent }] = parse("only", args, ["silent"]);
			this.#text = (await this.#run("only", { globs: globs.flat() }, silent)).text;
			return this;
		}
		async diff(...args) {
			const [, { silent }] = parse("diff", args, ["silent"], 0);
			const { text, details } = await this.#run("diff", {}, silent);
			// What printed may show long edited lines as word rows; the patch is returned as it is.
			return details?.patch ?? text;
		}
		async commit(...args) {
			const [[subject, body], options] = parse("commit", args, ["body", "fixes", "amend", "noVerify", "silent"], 2);
			const { fixes, amend, noVerify, silent } = options;
			const response = await this.#run(
				"commit",
				{
					subject,
					body: either("commit", "body", body, options.body),
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
		async draft(...args) {
			const [[scope], options] = parse("draft", args, ["agents", "repo", "silent"], 1);
			const { repo, silent } = options;
			const agents = either("draft", "agents", scope, options.agents);
			const { text, details } = await call("draft", { agents, repo });
			log(text, silent);
			return new Draft(details, text);
		},
	});
}
