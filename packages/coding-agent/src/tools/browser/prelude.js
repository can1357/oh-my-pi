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
		const response = await globalThis.__omp_prelude__("browser", { ...options, action });
		if (response && typeof response.text === "string" && response.text.length > 0) {
			globalThis.__omp_log__("log", response.text);
		}
		return response && typeof response.details === "object" && response.details !== null ? response.details : {};
	};
	// A printed `tab.observe()` result, or one left as a cell's last value, shows every element, one line each,
	// through util.inspect's custom hook; the object, `.elements` and every field stay as they are for code.
	// Nested in another value (a smaller `depth` than the top level's), the same lines sit inside brackets, so
	// the outer value's keys stay apart. An unlimited `depth` (`null`, `Infinity`) is the same at every level, so
	// the bracketed form is used there too. The top-level form ends with a newline, so a further `print`
	// argument starts a line of its own instead of reading as fields of the last element.
	//
	// The short form is only for an observation whose objects are all as `observe()` returned them: `snapshot`
	// records each one's prototype and own properties, and `untouched` compares those, reading nothing but the
	// recorded objects' own descriptors. Anything Eval code changed (a field, a getter, a Proxy, a prototype) is
	// therefore never read or run here: that observation goes to plain inspect, with no cut at 100 items.
	const inspectCustom = Symbol.for("nodejs.util.inspect.custom");
	const knownElementKeys = new Set(["id", "role", "name", "value", "description", "keyshortcuts", "states"]);
	const snapshot = root => {
		const records = [];
		const seen = new Set();
		const visit = value => {
			if (value === null || typeof value !== "object" || seen.has(value)) return;
			seen.add(value);
			const keys = Reflect.ownKeys(value);
			const properties = keys.map(key => Object.getOwnPropertyDescriptor(value, key));
			records.push({ object: value, prototype: Object.getPrototypeOf(value), keys, properties });
			for (const property of properties) visit(property.value);
		};
		visit(root);
		return records;
	};
	const untouched = records => {
		for (const { object, prototype, keys, properties } of records) {
			const now = Reflect.ownKeys(object);
			if (Object.getPrototypeOf(object) !== prototype || now.length !== keys.length) return false;
			for (let at = 0; at < keys.length; at++) {
				const was = properties[at];
				const is = now[at] === keys[at] && Object.getOwnPropertyDescriptor(object, keys[at]);
				if (!is || !("value" in is) || !Object.is(is.value, was.value)) return false;
				if (is.enumerable !== was.enumerable) return false;
			}
		}
		return true;
	};
	const plain = { depth: null, compact: true, breakLength: Infinity, maxArrayLength: null, maxStringLength: null };
	const showField = (value, inspect) =>
		typeof value === "string" ? JSON.stringify(value) : inspect(value, { ...plain, customInspect: false });
	const elementLine = (entry, inspect) => {
		if (entry === null || typeof entry !== "object") return showField(entry, inspect);
		// Own fields only: one this element lacks is not looked up on a prototype Eval code can reach.
		const element = Object.assign(Object.create(null), entry);
		const role = element.role;
		let line = `[${showField(element.id, inspect)}] ${typeof role === "string" && /^\S+$/.test(role) ? role : showField(role, inspect)}`;
		for (const key of ["name", "value", "description", "keyshortcuts"]) {
			if (element[key] !== undefined)
				line += ` ${key === "name" ? "" : `${key}=`}${showField(element[key], inspect)}`;
		}
		for (const [key, value] of Object.entries(element)) {
			if (!knownElementKeys.has(key) && value !== undefined) line += ` ${key}=${showField(value, inspect)}`;
		}
		if (Array.isArray(element.states) && element.states.length > 0) line += ` ${element.states.join(" ")}`;
		return line;
	};
	const withPrintForm = observation => {
		if (observation === null || typeof observation !== "object" || !Array.isArray(observation.elements)) {
			return observation;
		}
		const elements = observation.elements;
		let records = [];
		const printAs = (target, open, close, rows) =>
			Object.defineProperty(target, inspectCustom, {
				value(depth, options, inspect) {
					// Reached through another object (inherited, or copied onto it): that object prints itself.
					if (this !== target) return this;
					if (!untouched(records)) {
						return inspect(target, { ...options, depth, customInspect: false, maxArrayLength: null });
					}
					const lines = rows(inspect);
					if (lines.length === 0) return `${open}${close}`;
					return Number.isFinite(depth) && depth === options.depth
						? `${lines.join("\n")}\n`
						: [open, ...lines.map(line => `  ${line}`), close].join("\n");
				},
			});
		printAs(elements, "[", "]", inspect => elements.map(element => elementLine(element, inspect)));
		printAs(observation, "Observation {", "}", inspect => {
			const lines = [];
			for (const [key, value] of Object.entries(observation)) {
				if (key !== "elements" && value !== undefined) lines.push(`${key}: ${showField(value, inspect)}`);
			}
			lines.push(`elements (${elements.length}; tab.id(n) acts on [n]):`);
			for (const element of elements) lines.push(elementLine(element, inspect));
			return lines;
		});
		records = snapshot(observation);
		return observation;
	};
	const callValue = async (name, chain) => {
		const details = await invoke("call", { name, chain });
		return details.value;
	};
	const directMethods = [
		"url",
		"title",
		"goto",
		"back",
		"forward",
		"reload",
		"pushState",
		"frames",
		"dialog",
		"handleDialog",
		"setDialogs",
		"ariaSnapshot",
		"a11y",
		"webmcpList",
		"webmcpInvoke",
		"webmcpEvents",
		"screenshot",
		"diffScreenshot",
		"pdf",
		"extract",
		"click",
		"dblclick",
		"hover",
		"focus",
		"check",
		"uncheck",
		"keyDown",
		"keyUp",
		"mouseMove",
		"mouseDown",
		"mouseUp",
		"clickAt",
		"wheel",
		"highlight",
		"type",
		"fill",
		"press",
		"scroll",
		"drag",
		"scrollIntoView",
		"select",
		"uploadFile",
		"waitForUrl",
		"text",
		"html",
		"value",
		"attr",
		"count",
		"box",
		"styles",
		"isVisible",
		"isEnabled",
		"isChecked",
		"waitForText",
		"evaluate",
		"waitFor",
		"waitForSelector",
		"emulate",
		"devices",
		"clipboardRead",
		"clipboardWrite",
		"clipboardCopy",
		"clipboardPaste",
		"cookies",
		"setCookies",
		"clearCookies",
		"storage",
		"setStorage",
		"clearStorage",
		"saveState",
		"loadState",
		"addInitScript",
		"removeInitScript",
		"initScripts",
		"waitForDownload",
		"downloads",
		"console",
		"errors",
		"clearConsole",
		"traceStart",
		"traceStop",
		"profileStart",
		"profileStop",
		"metrics",
		"route",
		"unroute",
		"routes",
		"requests",
		"request",
		"clearRequests",
		"harStart",
		"harStop",
		"allowedDomains",
		"vitals",
		"reactEnable",
		"reactTree",
		"reactInspect",
		"reactRenders",
		"reactSuspense",
		"recordStart",
		"recordStop",
		"recordRestart",
		"recording",
	];
	const elementMethods = [
		"click",
		"dblclick",
		"check",
		"uncheck",
		"highlight",
		"type",
		"fill",
		"press",
		"hover",
		"focus",
		"select",
		"uploadFile",
		"scrollIntoView",
		"boundingBox",
		"isVisible",
		"isHidden",
		"text",
		"html",
		"value",
		"attr",
		"styles",
		"isEnabled",
		"isChecked",
		"evaluate",
	];
	const frameMethods = [
		"click",
		"fill",
		"type",
		"press",
		"text",
		"html",
		"value",
		"attr",
		"count",
		"isVisible",
		"ariaSnapshot",
		"evaluate",
		"waitFor",
		"waitForSelector",
		"screenshot",
	];
	const makeElement = (name, handleMethod, handleArgs) => {
		const element = {};
		const renderedArgs = handleArgs.map(value => JSON.stringify(value)).join(", ");
		element.toString = () => `<element tab.${handleMethod}(${renderedArgs}) on ${name}>`;
		for (const method of elementMethods) {
			element[method] = (...args) =>
				callValue(name, [
					{ method: handleMethod, args: handleArgs },
					{ method, args: encodeArgs("tab helper argument", args) },
				]);
		}
		return Object.freeze(element);
	};
	const makeFrame = (name, selector) => {
		const frame = {};
		frame.toString = () => `<frame tab.frame(${JSON.stringify(selector)}) on ${name}>`;
		for (const method of frameMethods) {
			frame[method] = (...args) =>
				callValue(name, [
					{ method: "frame", args: encodeArgs("tab helper argument", [selector]) },
					{ method, args: encodeArgs("frame helper argument", args) },
				]);
		}
		return Object.freeze(frame);
	};
	const makeTab = name => {
		const tab = {};
		Object.defineProperty(tab, "name", { value: name, enumerable: true });
		tab.toString = () => `<tab ${name}>`;
		for (const method of directMethods) {
			tab[method] = (...args) => callValue(name, [{ method, args: encodeArgs("tab helper argument", args) }]);
		}
		tab.id = id => makeElement(name, "id", encodeArgs("tab helper argument", [id]));
		tab.ref = id => makeElement(name, "ref", encodeArgs("tab helper argument", [id]));
		tab.frame = selector => makeFrame(name, selector);
		tab.observe = (...args) =>
			callValue(name, [{ method: "observe", args: encodeArgs("tab helper argument", args) }]).then(withPrintForm);
		tab.run = async (fnOrCode, options) => {
			if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
				throw new TypeError("tab.run() expects a function or code string");
			}
			if (typeof fnOrCode === "function" && Array.isArray(options)) {
				throw new TypeError(
					"tab.run() expects an options object; pass the function's arguments as { args: [...] }: tab.run(async ({ page }, url) => …, { args: [url] })",
				);
			}
			const opts = validateOptions("tab.run", options);
			const args = opts.args ?? [];
			if (typeof fnOrCode === "string" && (!Array.isArray(args) || args.length > 0)) {
				throw new TypeError("tab.run() passes args only to a function; a code string receives none");
			}
			if (!Array.isArray(args)) {
				throw new TypeError(
					"tab.run() args must be an array of the function's arguments after its scope: tab.run(async ({ page }, url) => …, { args: [url] })",
				);
			}
			const parameters = { name };
			if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
			if (typeof fnOrCode === "function") {
				parameters.fn = serializeFunction("tab.run()", fnOrCode);
				parameters.args = encodeArgs("tab helper argument", args);
			} else {
				parameters.code = fnOrCode;
			}
			const details = await invoke("run", parameters);
			return details.value;
		};
		tab.close = async options => {
			const opts = validateOptions("tab.close", options);
			await invoke("close", { ...opts, name });
		};
		return Object.freeze(tab);
	};
	globalThis.browser = Object.freeze({
		async open(options) {
			if (typeof options === "string") {
				throw new TypeError(
					"browser.open() expects an options object; pass the URL inside it: browser.open({ url, name })",
				);
			}
			const opts = validateOptions("browser.open", options);
			const details = await invoke("open", opts);
			return makeTab(typeof details.name === "string" ? details.name : (opts.name ?? "main"));
		},
		tab(name = "main") {
			if (typeof name !== "string" || name.length === 0) {
				throw new TypeError("browser.tab() expects a tab name");
			}
			return makeTab(name);
		},
		async tabs() {
			const details = await invoke("tabs", {});
			return Array.isArray(details.value) ? details.value : [];
		},
		async targets(options) {
			const details = await invoke("targets", validateOptions("browser.targets", options));
			return Array.isArray(details.value) ? details.value : [];
		},
		async close(options) {
			await invoke("close", validateOptions("browser.close", options));
		},
	});
}
