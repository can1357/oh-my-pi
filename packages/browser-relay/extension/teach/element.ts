interface TeachElement {
	readonly localName: string;
	readonly id: string;
	readonly parentElement: TeachElement | null;
	readonly previousElementSibling: TeachElement | null;
	readonly nextElementSibling: TeachElement | null;
	readonly textContent: string | null;
	readonly labels?: ArrayLike<TeachElement> | null;
	getAttribute(name: string): string | null;
}

interface TeachRoot {
	getElementById(id: string): TeachElement | null;
	querySelectorAll(selector: string): ArrayLike<TeachElement>;
}

const SELECTOR_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "name", "aria-label"];
const NATIVE_ROLES: Readonly<Record<string, string>> = {
	article: "article",
	button: "button",
	details: "group",
	dialog: "dialog",
	fieldset: "group",
	form: "form",
	img: "img",
	li: "listitem",
	main: "main",
	meter: "meter",
	nav: "navigation",
	ol: "list",
	option: "option",
	output: "status",
	progress: "progressbar",
	summary: "button",
	table: "table",
	textarea: "textbox",
	ul: "list",
};
const CONTENT_ROLES: Readonly<Record<string, true>> = {
	button: true,
	link: true,
	tab: true,
	option: true,
	menuitem: true,
	menuitemcheckbox: true,
	menuitemradio: true,
	radio: true,
	checkbox: true,
	switch: true,
	heading: true,
	treeitem: true,
};

function normalize(text: string | null): string {
	return text?.replace(/\s+/g, " ").trim() ?? "";
}

/** Describe the semantic role of the common interactive and landmark elements Teach records. */
export function roleFor(element: TeachElement): string | undefined {
	const explicit = normalize(element.getAttribute("role")).split(" ", 1)[0];
	if (explicit) return explicit;
	const tag = element.localName;
	switch (tag) {
		case "input": {
			const type = element.getAttribute("type")?.toLowerCase();
			switch (type) {
				case "button": case "image": case "reset": case "submit": return "button";
				case "checkbox": return "checkbox";
				case "radio": return "radio";
				case "range": return "slider";
				case "number": return "spinbutton";
				case "search": return element.getAttribute("list") !== null ? "combobox" : "searchbox";
				case "color": case "date": case "datetime-local": case "file": case "hidden":
				case "month": case "password": case "time": case "week": return undefined;
				default: return element.getAttribute("list") !== null ? "combobox" : "textbox";
			}
		}
		case "a": case "area": return element.getAttribute("href") !== null ? "link" : undefined;
		case "select":
			return element.getAttribute("multiple") !== null || Number(element.getAttribute("size")) > 1 ? "listbox" : "combobox";
		default: return /^h[1-6]$/.test(tag) ? "heading" : Object.hasOwn(NATIVE_ROLES, tag) ? NATIVE_ROLES[tag] : undefined;
	}
}

/** Resolve ARIA references and native labels before visible contents and fallback naming attributes. */
export function nameFor(
	element: TeachElement,
	root: TeachRoot,
	text: (element: TeachElement, includeHidden: boolean) => string,
): string | undefined {
	function label(node: TeachElement, referenced: boolean): string {
		if (!referenced) {
			const ids = normalize(node.getAttribute("aria-labelledby"));
			if (ids) {
				const resolved = ids.split(" ").map(id => root.getElementById(id));
				const names = resolved.map(target => target && label(target, true)).filter(Boolean).join(" ");
				if (names) return names;
			}
		}
		const aria = normalize(node.getAttribute("aria-label"));
		if (aria) return aria;
		if (node.labels?.length) {
			const names = Array.from(node.labels, target => normalize(text(target, false))).filter(Boolean).join(" ");
			if (names) return names;
		}
		const tag = node.localName;
		const type = node.getAttribute("type")?.toLowerCase();
		if (tag === "img" || tag === "area" || (tag === "input" && type === "image")) {
			const alt = normalize(node.getAttribute("alt"));
			if (alt) return alt;
		}
		if (tag === "input" && (type === "button" || type === "submit" || type === "reset")) {
			const value = normalize(node.getAttribute("value"));
			if (value) return value;
			if (type === "submit") return "Submit";
			if (type === "reset") return "Reset";
		}
		const role = roleFor(node);
		if (referenced || (role && Object.hasOwn(CONTENT_ROLES, role))) {
			const contents = normalize(text(node, referenced));
			if (contents) return contents;
		}
		return normalize(node.getAttribute("title")) || normalize(node.getAttribute("placeholder"));
	}
	return label(element, false) || undefined;
}

/** Prefer a unique stable attribute, then a structural path with sibling indices only where needed. */
export function selectorFor(
	element: TeachElement,
	root: TeachRoot,
	escape: (value: string) => string,
): string | undefined {
	const unique = (selector: string, target: TeachElement) => {
		const matches = root.querySelectorAll(selector);
		return matches.length === 1 && matches[0] === target;
	};
	let tail = "";
	let fallback: string | undefined;
	for (let node: TeachElement | null = element; node; node = node.parentElement) {
		let selector: string | undefined;
		if (node.id) {
			const id = `#${escape(node.id)}`;
			if (unique(id, node)) selector = id;
		}
		const tag = escape(node.localName);
		if (!selector) {
			for (const attr of SELECTOR_ATTRIBUTES) {
				const value = node.getAttribute(attr);
				if (!value) continue;
				const byAttribute = `${tag}[${attr}="${escape(value)}"]`;
				if (unique(byAttribute, node)) {
					selector = byAttribute;
					break;
				}
			}
		}
		if (selector) return selector + tail;
		let index = 1;
		let repeated = false;
		for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
			++index;
			repeated ||= sibling.localName === node.localName;
		}
		for (let sibling = node.nextElementSibling; sibling && !repeated; sibling = sibling.nextElementSibling) {
			repeated = sibling.localName === node.localName;
		}
		const part = repeated ? `${tag}:nth-child(${index})` : tag;
		if (fallback === undefined && unique(part + tail, element)) fallback = part + tail;
		tail = ` > ${part}${tail}`;
	}
	return fallback;
}
