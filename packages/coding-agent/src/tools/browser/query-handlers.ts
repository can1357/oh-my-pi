import type { CustomQueryHandler, default as PuppeteerInstance, Puppeteer as PuppeteerClass } from "puppeteer-core";

/** Root node Puppeteer passes to a custom query handler (the document for page-level queries). */
type QueryNode = Parameters<NonNullable<CustomQueryHandler["queryAll"]>>[0];

interface QueryRoot {
	querySelectorAll(selector: string): readonly Element[];
}

// Each handler is serialized with `Function.prototype.toString()` — by Puppeteer's custom query
// handler registry and by the Tern page kit — so it MUST stay self-contained: no references to
// module scope, imports, or other handlers.

/**
 * `label/` handler: controls whose `<label>` text, `aria-label`, or `aria-labelledby` text contains the
 * query (case-insensitive).
 */
export function queryByLabel(node: QueryNode, selector: string): Element[] {
	const root = node as unknown as QueryRoot;
	const wanted = selector.trim().toLocaleLowerCase();
	const matches = (value: string | null | undefined): boolean =>
		(value ?? "").trim().toLocaleLowerCase().includes(wanted);
	const elements = Array.from(root.querySelectorAll("*"));
	const result: Element[] = [];
	const seen = new Set<Element>();
	const add = (element: Element | null): void => {
		if (element && !seen.has(element)) {
			seen.add(element);
			result.push(element);
		}
	};
	for (const label of root.querySelectorAll("label")) {
		if (!matches(label.textContent)) continue;
		const htmlFor = label.getAttribute("for");
		if (htmlFor) {
			const target = label.ownerDocument?.getElementById(htmlFor) ?? null;
			if (
				target &&
				(node === target || (node as unknown as { contains(element: Element): boolean }).contains(target))
			) {
				add(target);
			}
		} else {
			const control = label.querySelector(
				"button,input,meter,output,progress,select,textarea",
			) as unknown as Element | null;
			add(control);
		}
	}
	for (const element of elements) {
		if (matches(element.getAttribute("aria-label"))) add(element);
		const labelledBy = element.getAttribute("aria-labelledby");
		if (!labelledBy) continue;
		const labelText = labelledBy
			.split(/\s+/)
			.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
			.join(" ");
		if (matches(labelText)) add(element);
	}
	return result;
}

/** `placeholder/` handler: elements whose `placeholder` contains the query (case-insensitive). */
export function queryByPlaceholder(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[placeholder]")).filter(element =>
		(element.getAttribute("placeholder") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/** `testid/` handler: elements whose `data-testid` equals the trimmed query. */
export function queryByTestId(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[data-testid]")).filter(
		element => element.getAttribute("data-testid") === wanted,
	);
}

/** `alt/` handler: elements whose `alt` contains the query (case-insensitive). */
export function queryByAlt(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[alt]")).filter(element =>
		(element.getAttribute("alt") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/** `title/` handler: elements whose `title` contains the query (case-insensitive). */
export function queryByTitle(node: QueryNode, selector: string): Element[] {
	const wanted = selector.trim().toLocaleLowerCase();
	return Array.from((node as unknown as QueryRoot).querySelectorAll("[title]")).filter(element =>
		(element.getAttribute("title") ?? "").trim().toLocaleLowerCase().includes(wanted),
	);
}

/**
 * `role/` handler: `role[name="…" exact]` — explicit or implicit ARIA role, optionally filtered by
 * accessible name. Anything else in the selector (a chained `>> role/…`, another attribute) is refused
 * rather than ignored, since ignoring it would match the outer element.
 */
export function queryByRole(node: QueryNode, selector: string): Element[] {
	const root = node as unknown as QueryRoot;
	const parsed =
		/^\s*([a-z][a-z0-9-]*)\s*(?:\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(exact))?\s*\])?\s*$/i.exec(
			selector,
		);
	if (!parsed) {
		throw new Error(
			`role/ selector ${JSON.stringify(selector)} is not one role with an optional [name="…"] or [name="…" exact] filter. ` +
				"role/ selectors do not chain; to act inside a section, pass the section's selector to observe({ selector }) or ariaSnapshot(selector) and use the id or ref it returns.",
		);
	}
	const wantedRole = parsed[1]!.toLocaleLowerCase();
	const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();
	const nameText = parsed[2] ?? parsed[3] ?? parsed[4];
	const wantedName = nameText === undefined ? undefined : normalizeSpace(nameText).toLocaleLowerCase();
	const exact = parsed[5]?.toLocaleLowerCase() === "exact";
	const hasLandmarkName = (element: Element): boolean =>
		Boolean(
			idrefText(element) ||
			normalizeSpace(element.getAttribute("aria-label") ?? "") ||
			normalizeSpace(element.getAttribute("title") ?? ""),
		);
	const isScoped = (element: Element, includeMain: boolean): boolean => {
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			const explicit = parent.getAttribute("role")?.trim().split(/\s+/)[0]?.toLocaleLowerCase();
			if (!explicit && parent.tagName.toLocaleLowerCase() === "section") return true;
			// Browser ancestors have the same element interface as the queried node.
			const ancestor = parent as Element;
			const role = explicit || implicitRole(ancestor);
			if (
				role === "article" ||
				role === "complementary" ||
				role === "navigation" ||
				(includeMain && role === "main")
			) {
				return true;
			}
		}
		return false;
	};
	const computeImplicitRole = (element: Element): string | null => {
		const tag = element.tagName.toLocaleLowerCase();
		if ((tag === "a" || tag === "area") && element.hasAttribute("href")) return "link";
		if (tag === "button") return "button";
		if (tag === "textarea") return "textbox";
		if (tag === "select") {
			const select = element as unknown as { multiple: boolean; size: number };
			return select.multiple || select.size > 1 ? "listbox" : "combobox";
		}
		if (tag === "option") return "option";
		if (tag === "img") {
			return element.getAttribute("alt") === "" &&
				!element.hasAttribute("tabindex") &&
				!Array.from(element.attributes).some(attribute => attribute.name.startsWith("aria-")) &&
				!normalizeSpace(element.getAttribute("title") ?? "")
				? "none"
				: "img";
		}
		if (tag === "ul" || tag === "ol" || tag === "menu") return "list";
		if (tag === "li") return "listitem";
		if (tag === "nav") return "navigation";
		if (tag === "main") return "main";
		if (tag === "form") return "form";
		if (tag === "section") return hasLandmarkName(element) ? "region" : "generic";
		if (tag === "aside") return hasLandmarkName(element) || !isScoped(element, false) ? "complementary" : "generic";
		if (tag === "header" || tag === "footer") {
			const scoped = isScoped(element, true);
			return tag === "header" ? (scoped ? "sectionheader" : "banner") : scoped ? "sectionfooter" : "contentinfo";
		}
		switch (tag) {
			case "article":
			case "dialog":
			case "meter":
			case "search":
			case "figure":
			case "blockquote":
			case "code":
			case "strong":
			case "time":
			case "mark":
				return tag;
			case "fieldset":
			case "details":
			case "optgroup":
			case "address":
			case "hgroup":
				return "group";
			case "hr":
				return "separator";
			case "progress":
				return "progressbar";
			case "output":
				return "status";
			case "thead":
			case "tbody":
			case "tfoot":
				return "rowgroup";
			case "dt":
			case "dfn":
				return "term";
			case "dd":
				return "definition";
			case "dl":
				return "descriptionlist";
			case "p":
				return "paragraph";
			case "em":
				return "emphasis";
			case "del":
			case "s":
				return "deletion";
			case "ins":
				return "insertion";
			case "sub":
				return "subscript";
			case "sup":
				return "superscript";
		}
		if (/^h[1-6]$/.test(tag)) return "heading";
		if (tag === "table") return "table";
		if (tag === "tr") return "row";
		if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
		if (tag === "td") return "cell";
		if (tag !== "input") return null;
		const type = ((element as unknown as { type?: string }).type || "text").toLocaleLowerCase();
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (type === "number") return "spinbutton";
		if (type === "search") return "searchbox";
		if (["button", "submit", "reset", "image"].includes(type)) return "button";
		if (!["hidden", "file", "color", "date", "datetime-local", "month", "time", "week"].includes(type)) {
			return "textbox";
		}
		return null;
	};
	/**
	 * Each element's implicit role, computed once per query: an aside's or header's role depends on its ancestors' roles,
	 * so nested asides would otherwise recompute every ancestor at each level.
	 */
	const roles = new Map<Element, string | null>();
	const implicitRole = (element: Element): string | null => {
		let role = roles.get(element);
		if (role === undefined) {
			role = computeImplicitRole(element);
			roles.set(element, role);
		}
		return role;
	};
	// Roles named by their content, so `title` names them only when the content is empty.
	const namedByContent =
		/^(?:button|cell|checkbox|columnheader|gridcell|heading|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|row|rowheader|switch|tab|term|tooltip|treeitem)$/.test(
			wantedRole,
		);
	/** An image input's name: its alt, value or title, else the browser's default caption for an image submit button. */
	const imageInputName = (element: Element): string =>
		normalizeSpace(element.getAttribute("alt") ?? "") ||
		normalizeSpace(element.getAttribute("value") ?? "") ||
		normalizeSpace(element.getAttribute("title") ?? "") ||
		"Submit";
	// Text as the accessibility tree reads it (as the Tern kit's `contentText`): hidden subtrees and
	// `visibility: hidden` text skipped, block children spaced apart, a child's `aria-labelledby` text,
	// `aria-label`, an image's `alt` or an embedded control's value in place of its content. `skip` is the
	// element being named, so a label around a field does not repeat the field's own value. `visibility`
	// "any" reads a hidden `aria-labelledby` target or native label whole, `display: none` descendants
	// included, as the accessibility tree does. `followRefs` is off inside a referenced subtree, so
	// `aria-labelledby` chains are not followed (and cannot cycle).
	const contentText = (
		start: Pick<Element, "childNodes">,
		skip: Element | null,
		visibility: unknown,
		followRefs = true,
		visited = new Set<Element>(),
	): string => {
		let text = "";
		const walk = (element: Pick<Element, "childNodes">, visibility: unknown): void => {
			for (const child of Array.from(element.childNodes)) {
				// 3 = Node.TEXT_NODE, 1 = Node.ELEMENT_NODE
				if (child.nodeType === 3 && (visibility === "visible" || visibility === "any")) {
					text += child.nodeValue ?? "";
				}
				if (child.nodeType !== 1 || child === skip) continue;
				const childElement = child as Element;
				const tag = childElement.tagName.toLocaleLowerCase();
				if (["script", "style", "template", "noscript"].includes(tag)) continue;
				if (visibility !== "any" && childElement.getAttribute("aria-hidden") === "true") continue;
				const style = getComputedStyle(childElement);
				if (style.display === "none" && visibility !== "any") continue;
				const gap = style.display === "inline" || style.display === "contents" ? "" : " ";
				const shown = visibility === "any" || style.visibility === "visible";
				const label = normalizeSpace(childElement.getAttribute("aria-label") ?? "");
				const labelledBy = followRefs ? idrefText(childElement, visited) : "";
				// Form controls expose `type`, `value` and `selectedOptions`, which the element type here does not declare.
				const control = childElement as unknown as {
					type?: string;
					value?: string;
					selectedOptions?: ArrayLike<{ text: string }>;
				};
				const inputType = tag === "input" ? (control.type ?? "").toLocaleLowerCase() : "";
				const inputButton = ["button", "submit", "reset"].includes(inputType);
				const childRole = childElement.getAttribute("role")?.trim().split(/\s+/)[0]?.toLocaleLowerCase();
				// A range reads its ARIA value text, then value, before the DOM value.
				const range = inputType === "range" || childRole === "slider" || childRole === "spinbutton";
				// A text field's value stands in for it; a checkbox's or radio's `value` ("on" by default) is not
				// text it shows, and an input button is named by its label before its value.
				const valueIsText =
					tag === "textarea" ||
					(tag === "input" &&
						!inputButton &&
						!["checkbox", "radio", "file", "hidden", "image"].includes(inputType));
				text += gap;
				// A nested field contributes its value, not its own label.
				if (range) {
					text += shown
						? childElement.getAttribute("aria-valuetext") ||
							childElement.getAttribute("aria-valuenow") ||
							(control.value ?? "")
						: "";
				} else if (tag === "select") {
					text += shown ? Array.from(control.selectedOptions ?? [], option => option.text).join(" ") : "";
				} else if (valueIsText) text += shown ? (control.value ?? "") : "";
				else if (labelledBy) text += shown ? labelledBy : "";
				else if (label) text += shown ? label : "";
				else if (inputType === "image") text += shown ? imageInputName(childElement) : "";
				else if (tag === "img" || tag === "area") {
					text += shown ? (childElement.getAttribute("alt") ?? "") : "";
				} else if (inputButton) {
					// Without a value, a submit or reset button shows the browser's default caption.
					const caption =
						normalizeSpace(control.value ?? "") ||
						(inputType === "submit" ? "Submit" : inputType === "reset" ? "Reset" : "");
					text += shown ? caption : "";
				} else if (tag !== "input") walk(childElement, visibility === "any" ? "any" : style.visibility);
				text += gap;
			}
		};
		walk(start, visibility);
		return text;
	};
	/** The host-language name of an element its descendants do not name: an optgroup's label, a fieldset's legend, a table's caption. */
	const nativeName = (element: Element, visited = new Set<Element>()): string => {
		const tag = element.tagName.toLocaleLowerCase();
		if (tag === "optgroup") return normalizeSpace(element.getAttribute("label") ?? "");
		if (tag !== "fieldset" && tag !== "table") return "";
		const caption = element.querySelector(
			tag === "fieldset" ? ":scope > legend" : ":scope > caption",
		) as unknown as Element | null;
		if (!caption) return "";
		// The caption or legend is named as an element in its own right: its references, then its label, then its text.
		return (
			idrefText(caption, visited) ||
			normalizeSpace(caption.getAttribute("aria-label") ?? "") ||
			normalizeSpace(contentText(caption, null, "visible", true, visited))
		);
	};
	/**
	 * Text of the elements an `aria-labelledby` names (a hidden target read whole), without following their own
	 * references. Each target is read as a node embedded in a label, so a control target gives its value and an image its
	 * alt, as its descendants would.
	 */
	const idrefText = (element: Element, visited = new Set<Element>()): string => {
		const labelledBy = element.getAttribute("aria-labelledby");
		if (!labelledBy || visited.has(element)) return "";
		visited.add(element);
		try {
			return normalizeSpace(
				labelledBy
					.split(/\s+/)
					.map(id => {
						const target = element.ownerDocument?.getElementById(id);
						if (!target) return "";
						// Hidden by visibility, `display: none` (its own or an ancestor's, which leaves its own computed display
						// untouched), or a `hidden`/`aria-hidden` ancestor: read the whole subtree. A `display: contents` target
						// has no box of its own, so the nearest ancestor with one decides whether it is rendered.
						const targetStyle = getComputedStyle(target);
						// Browser ancestors have the same element interface as the target.
						let box = target as Element | null;
						while (box && getComputedStyle(box).display === "contents") box = box.parentElement as Element | null;
						const rendered = box as unknown as { checkVisibility?: () => boolean } | null;
						const hidden =
							targetStyle.visibility !== "visible" ||
							targetStyle.display === "none" ||
							(typeof rendered?.checkVisibility === "function" && !rendered.checkVisibility()) ||
							target.closest("[hidden], [aria-hidden='true']") !== null;
						// A table, fieldset or optgroup target is named by its caption, legend or label, not its contents.
						const native = normalizeSpace(target.getAttribute("aria-label") ?? "")
							? ""
							: nativeName(target, visited);
						if (native) return native;
						const text = normalizeSpace(
							contentText(
								{ childNodes: [target] } as unknown as Element,
								null,
								hidden ? "any" : "visible",
								false,
								visited,
							),
						);
						// A target that yields no text is named by its tooltip, as the root of its own name computation.
						return text || normalizeSpace(target.getAttribute("title") ?? "");
					})
					.join(" "),
			);
		} finally {
			visited.delete(element);
		}
	};
	const accessibleName = (element: Element): string => {
		const labelledBy = idrefText(element);
		if (labelledBy) return labelledBy;
		const ariaLabel = normalizeSpace(element.getAttribute("aria-label") ?? "");
		if (ariaLabel) return ariaLabel;
		const native = nativeName(element);
		if (native) return native;
		// `<label>` names only the form controls it can label, so an optgroup in a labelled select keeps its own label
		// (or title) and a term inside a label keeps its own text.
		const tag = element.tagName.toLocaleLowerCase();
		const labelable =
			["button", "meter", "output", "progress", "select", "textarea"].includes(tag) ||
			(tag === "input" && element.getAttribute("type")?.toLocaleLowerCase() !== "hidden");
		if (labelable) {
			if (element.id) {
				for (const label of element.ownerDocument?.querySelectorAll("label") ?? []) {
					if (label.getAttribute("for") === element.id) {
						return normalizeSpace(contentText(label, element, "visible"));
					}
				}
			}
			const wrappingLabel = element.closest("label");
			if (wrappingLabel) return normalizeSpace(contentText(wrappingLabel, element, "visible"));
		}
		// An `<input>`'s type and value decide its name; other elements have neither.
		const input = tag === "input" ? (element as unknown as { type: string; value: string }) : null;
		const inputType = input?.type.toLocaleLowerCase();
		if (inputType === "image") return imageInputName(element);
		if (tag === "img" || tag === "area") {
			const alt = normalizeSpace(element.getAttribute("alt") ?? "");
			if (alt) return alt;
		}
		const content =
			inputType === "button" || inputType === "submit" || inputType === "reset"
				? normalizeSpace(input?.value ?? "") ||
					(inputType === "submit" ? "Submit" : inputType === "reset" ? "Reset" : "")
				: normalizeSpace(contentText(element, null, "visible"));
		if (content && namedByContent) return content;
		return normalizeSpace(
			element.getAttribute("title") ||
				element.getAttribute("placeholder") ||
				element.getAttribute("aria-placeholder") ||
				"",
		);
	};
	return Array.from(root.querySelectorAll("*")).filter(element => {
		const role = (element.getAttribute("role")?.trim().split(/\s+/)[0] ?? implicitRole(element))?.toLocaleLowerCase();
		if (role !== wantedRole && !(role === "img" && wantedRole === "image")) return false;
		if (wantedName === undefined) return true;
		const name = accessibleName(element).toLocaleLowerCase();
		return exact ? name === wantedName : name.includes(wantedName);
	});
}

/** Semantic selector prefixes (`label/`, `role/`, …) and their self-contained `queryAll` handlers. */
export const SEMANTIC_QUERY_HANDLERS = {
	label: queryByLabel,
	placeholder: queryByPlaceholder,
	testid: queryByTestId,
	alt: queryByAlt,
	title: queryByTitle,
	role: queryByRole,
} as const satisfies Record<string, (node: QueryNode, selector: string) => Element[]>;

/** Register the browser tool's semantic selector prefixes on a worker-local Puppeteer instance. */
export function registerSemanticQueryHandlers(puppeteer: typeof PuppeteerInstance): void {
	const Puppeteer = puppeteer.constructor as typeof PuppeteerClass;
	const registered = new Set(Puppeteer.customQueryHandlerNames());
	for (const name in SEMANTIC_QUERY_HANDLERS) {
		const queryAll = SEMANTIC_QUERY_HANDLERS[name as keyof typeof SEMANTIC_QUERY_HANDLERS];
		if (!registered.has(name)) Puppeteer.registerCustomQueryHandler(name, { queryAll });
	}
}
