{
	const call = async (action, parameters = {}) => {
		const defined = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined));
		const response = await globalThis.__omp_prelude__("dsm", { ...defined, action });
		if (!response || typeof response !== "object" || !response.details || !Object.hasOwn(response.details, "value")) {
			throw new Error("dsm returned an invalid response");
		}
		return response.details.value;
	};
	const options = (value, allowed) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new TypeError("dsm options must be an object");
		for (const key of Object.keys(value)) {
			if (!allowed.includes(key)) throw new TypeError(`Unknown dsm option: ${key}`);
		}
		return value;
	};
	class Database {
		#lease;
		#reference;
		#backend;
		constructor(descriptor) {
			this.#lease = descriptor.lease;
			this.#reference = descriptor.handle;
			this.#backend = descriptor.backend;
			this.id = descriptor.id;
			this.backend = descriptor.backend;
			this.ref = descriptor.ref;
			this.path = descriptor.path;
			this.info = descriptor.info;
			Object.freeze(this);
		}
		handle() {
			return this.#reference;
		}
		async #run(action, parameters = {}) {
			return call(action, { ...parameters, lease: this.#lease, backend: this.#backend });
		}
		async view(view = "overview") {
			return this.#run("view", { view });
		}
		async exec(code, settings = {}) {
			return this.#run("exec", { code, ...options(settings, ["timeout"]) });
		}
		async rename(target, name) {
			return this.#run("rename", { target, name });
		}
		async comment(target, text, settings = {}) {
			return this.#run("comment", { target, text, ...options(settings, ["repeatable"]) });
		}
		async setType(target, decl) {
			return this.#run("set_type", { target, decl });
		}
		async makeFunction(target) {
			return this.#run("make_function", { target });
		}
		async save() {
			return this.#run("save");
		}
		async close(settings = {}) {
			return this.#run("close", options(settings, ["save"]));
		}
	}
	globalThis.dsm = Object.freeze({
		async open(path) {
			return new Database(await call("open", { path }));
		},
		async list() {
			return call("list");
		},
		async get(ref) {
			return new Database(await call("get", { ref }));
		},
	});
}
