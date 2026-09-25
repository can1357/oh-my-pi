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
			globalThis.__omp_display__(response.text);
		}
		return response && typeof response.details === "object" && response.details !== null ? response.details : {};
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
		"observe",
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
		tab.run = async (fnOrCode, options) => {
			if (typeof fnOrCode !== "function" && typeof fnOrCode !== "string") {
				throw new TypeError("tab.run() expects a function or code string");
			}
			const opts = validateOptions("tab.run", options);
			const parameters = { name };
			if (opts.timeout !== undefined) parameters.timeout = opts.timeout;
			if (typeof fnOrCode === "function") {
				parameters.fn = serializeFunction("tab.run()", fnOrCode);
				parameters.args = encodeArgs("tab helper argument", Array.isArray(opts.args) ? opts.args : []);
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
		async close(options) {
			await invoke("close", validateOptions("browser.close", options));
		},
	});
}
