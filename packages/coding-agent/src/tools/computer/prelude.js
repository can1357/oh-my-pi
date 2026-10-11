{
	const validateOptions = (label, options) => {
		if (options === undefined) return {};
		if (options === null || typeof options !== "object" || Array.isArray(options)) {
			throw new TypeError(`${label}() expects an options object`);
		}
		return options;
	};
	const serializeFunction = (label, fn) => {
		const source = String(fn);
		if (source.includes("[native code]")) {
			throw new TypeError(
				`${label} cannot serialize a native or bound function; pass an arrow or function expression`,
			);
		}
		return source;
	};
	const encodeArg = (label, value) => {
		if (typeof value === "function") return { __omp_fn: serializeFunction(label, value) };
		if (value instanceof RegExp) return { __omp_re: { source: value.source, flags: value.flags } };
		return value;
	};
	const encodeArgs = (label, args) => {
		const trimmed = [...args];
		while (trimmed.length > 0 && trimmed[trimmed.length - 1] === undefined) trimmed.pop();
		return trimmed.map(value => encodeArg(label, value));
	};
	const invoke = async (action, options) => {
		const response = await globalThis.__omp_prelude__("computer", { ...options, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_display__(response.text);
		}
		return response && typeof response.details === "object" && response.details !== null ? response.details : {};
	};
	const callValue = async chain => {
		const details = await invoke("call", { chain });
		return details.value;
	};
	const step = (method, args) => ({ method, args: encodeArgs("computer helper argument", args) });
	// Methods stay non-enumerable so handles display and serialize as their identity fields only.
	const defineMethod = (target, name, fn) => Object.defineProperty(target, name, { value: fn });
	const defineValueMethods = (target, methods, chain) => {
		for (const method of methods) {
			defineMethod(target, method, (...args) => callValue(chain(step(method, args))));
		}
	};

	const windowFields = ["id", "app", "title", "pid", "bounds", "focused"];
	const windowValueMethods = [
		"screenshot",
		"zoom",
		"click",
		"doubleClick",
		"move",
		"drag",
		"scroll",
		"type",
		"press",
		"raise",
		"ax",
		"holdKeys",
		"holdMouse",
		"bringToCurrentSpace",
	];
	const elementFields = ["ref", "role", "nativeRole", "title", "description", "enabled", "focused", "childCount"];
	const elementValueMethods = [
		"value",
		"setValue",
		"bounds",
		"attributes",
		"actions",
		"perform",
		"press",
		"click",
		"focus",
	];
	const desktopValueMethods = [
		"holdKeys",
		"holdMouse",
		"displays",
		"windows",
		"screenshot",
		"zoom",
		"click",
		"doubleClick",
		"move",
		"drag",
		"scroll",
		"type",
		"press",
	];

	const copyFields = (target, fields, snapshot) => {
		for (const field of fields) {
			if (snapshot[field] !== undefined)
				Object.defineProperty(target, field, { value: snapshot[field], enumerable: true });
		}
	};
	const defineElementMethods = (target, ref) => {
		const via = next => [step("ref", [ref]), next];
		defineValueMethods(target, elementValueMethods, via);
		defineMethod(target, "parent", async () => {
			const parent = await callValue(via(step("parent", [])));
			return parent ? makeElement(parent) : null;
		});
		defineMethod(target, "children", async () => (await callValue(via(step("children", [])))).map(makeElement));
	};
	const makeElement = snapshot => {
		const element = {};
		copyFields(element, elementFields, snapshot);
		defineMethod(element, "toString", () => `<element ${snapshot.ref} ${snapshot.role}>`);
		defineElementMethods(element, snapshot.ref);
		return Object.freeze(element);
	};
	const resolveElement = async chain => {
		const snapshot = await callValue(chain);
		return snapshot ? makeElement(snapshot) : null;
	};
	// `await ref("e5")` resolves the element; `ref("e5").click()` sends the element call
	// directly, so the lookup runs only when the handle itself is awaited.
	const makeRef = ref => {
		let lookup;
		const resolve = () => (lookup ??= resolveElement([step("ref", [ref])]));
		const handle = {};
		copyFields(handle, ["ref"], { ref });
		defineMethod(handle, "then", (onFulfilled, onRejected) => resolve().then(onFulfilled, onRejected));
		defineMethod(handle, "catch", onRejected => resolve().catch(onRejected));
		defineMethod(handle, "finally", onFinally => resolve().finally(onFinally));
		defineMethod(handle, "toString", () => `<element ref ${ref}>`);
		defineElementMethods(handle, ref);
		return Object.freeze(handle);
	};
	const makeWindow = snapshot => {
		const win = {};
		copyFields(win, windowFields, snapshot);
		defineMethod(win, "toString", () => `<window ${snapshot.id} ${snapshot.app}>`);
		const via = next => [step("window", [snapshot.id]), next];
		defineValueMethods(win, windowValueMethods, via);
		for (const [namespace, methods] of [["menu", ["items", "select"]]]) {
			const nested = {};
			// Separate menu titles travel as one array, so a trailing undefined title is not trimmed away.
			for (const method of methods)
				defineMethod(nested, method, (...args) =>
					callValue(via(step(`${namespace}.${method}`, args.length > 1 ? [args] : args))),
				);
			defineMethod(win, namespace, Object.freeze(nested));
		}
		defineMethod(win, "find", async query => (await callValue(via(step("find", [query])))).map(makeElement));
		// A non-silent observe() already printed its tree; `ax` stays readable but is left out
		// of display, spread and serialization, so a trailing `await win.observe()` shows it once.
		defineMethod(win, "observe", async options => {
			const silent = Boolean(options?.silent);
			const observation = await callValue(via(step("observe", [options])));
			if (!silent && typeof observation?.ax === "string") {
				Object.defineProperty(observation, "ax", { enumerable: false });
			}
			return observation;
		});
		defineMethod(win, "ref", makeRef);
		return Object.freeze(win);
	};
	const resolveWindow = async chain => {
		const snapshot = await callValue(chain);
		return snapshot ? makeWindow(snapshot) : null;
	};

	const makeDisplay = snapshot => {
		const target = {};
		copyFields(target, ["id"], snapshot);
		const via = next => [step("display", [snapshot.id]), next];
		defineValueMethods(
			target,
			desktopValueMethods.filter(method => method !== "displays" && method !== "windows"),
			via,
		);
		return Object.freeze(target);
	};

	const computer = {};
	defineValueMethods(computer, desktopValueMethods, next => [next]);
	computer.display = async selector => makeDisplay(await callValue([step("display", [selector])]));
	for (const [namespace, methods] of [
		["apps", ["list", "open"]],
		["control", ["acquire", "release", "state"]],
	]) {
		const nested = {};
		for (const method of methods)
			defineMethod(nested, method, (...args) => callValue([step(`${namespace}.${method}`, args)]));
		computer[namespace] = Object.freeze(nested);
	}
	computer.window = selector => resolveWindow([step("window", [selector])]);
	computer.focusedWindow = () => resolveWindow([step("focusedWindow", [])]);
	computer.elementAt = (x, y) => resolveElement([step("elementAt", [x, y])]);
	computer.focusedElement = () => resolveElement([step("focusedElement", [])]);
	computer.ref = makeRef;
	computer.clipboard = Object.freeze({
		read: () => callValue([step("clipboard.read", [])]),
		write: text => callValue([step("clipboard.write", [text])]),
	});
	computer.run = async (fnOrCode, options) => {
		if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
			throw new TypeError("computer.run() expects a function or code string");
		}
		const opts = validateOptions("computer.run", options);
		const parameters = {};
		if (opts.read_only !== undefined) parameters.read_only = opts.read_only;
		if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
		if (typeof fnOrCode === "function") {
			parameters.fn = serializeFunction("computer.run()", fnOrCode);
			parameters.args = encodeArgs("computer.run() argument", Array.isArray(opts.args) ? opts.args : []);
		} else {
			parameters.code = fnOrCode;
		}
		const details = await invoke("run", parameters);
		return details.value;
	};
	computer.capabilities = async () => {
		const details = await invoke("capabilities", {});
		return "backend" in details ? details : undefined;
	};
	computer.close = async () => {
		await invoke("close", {});
	};
	globalThis.computer = Object.freeze(computer);
}
