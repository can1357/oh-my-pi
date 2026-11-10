import { sleepLong, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type {
	CustomQueryHandler,
	ElementHandle,
	Frame,
	default as PuppeteerInstance,
	Puppeteer as PuppeteerClass,
	WaitForSelectorOptions,
} from "puppeteer-core";
import { puppeteerTimeoutError } from "./launch";
import { isNavigatedContextError } from "./navigation";

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

/** The Tern kit's role and accessible-name rules, from {@link roleRules}. */
export interface RoleRules {
	/** The element's explicit role (its first token; `presentation` as `none`), else its implicit one. */
	role(element: Element): string | null;
	/** The element's accessible name. */
	name(element: Element): string;
	/** The text of the elements its `aria-describedby` names. */
	description(element: Element): string;
	/** The `role/` handler: `role[name="…" exact]` below `node`, open shadow roots included. */
	query(node: QueryNode, selector: string): Element[];
}

/**
 * Role and accessible-name rules computed by hand, for the Tern kit, whose WebKit page offers no accessibility tree
 * to ask; Chromium asks Chrome instead ({@link registerSemanticQueryHandlers}). The kit's `observe()` and its `role/`
 * selector both use them, so a name `observe()` reports selects the same element again. Serialized whole into the kit,
 * so it MUST stay self-contained. Each instance caches roles, so take a fresh one per pass over the page.
 *
 * The `role/` handler refuses anything else in the selector (a chained `>> role/…`, another attribute) rather than
 * ignoring it, since ignoring it would match the outer element; the grammar is {@link parseRoleSelector}'s, repeated
 * here because this function is serialized whole.
 */
export function roleRules(): RoleRules {
	const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();
	const hasLandmarkName = (element: Element): boolean =>
		Boolean(
			idrefText(element) ||
			normalizeSpace(element.getAttribute("aria-label") ?? "") ||
			normalizeSpace(element.getAttribute("title") ?? ""),
		);
	const parentAcrossShadowRoot = (element: Element): Element | null => {
		// Page parents and shadow hosts share the queried element's interface.
		const node = element as unknown as { parentElement: Element | null; getRootNode(): { host?: Element } };
		return node.parentElement ?? node.getRootNode().host ?? null;
	};
	const isScoped = (element: Element, includeMain: boolean): boolean => {
		for (let parent = parentAcrossShadowRoot(element); parent; parent = parentAcrossShadowRoot(parent)) {
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
		if (tag === "caption") return "caption";
		if (tag === "summary") return "button";
		if (tag === "a") return "generic";
		if (tag !== "input") {
			// The outermost editable element is a text box; plain containers are generic.
			const editable = element as unknown as { isContentEditable?: boolean };
			const parent = element.parentElement as unknown as { isContentEditable?: boolean } | null;
			if (editable.isContentEditable && !parent?.isContentEditable) return "textbox";
			return ["div", "span", "b", "i", "u", "small", "label"].includes(tag) ? "generic" : null;
		}
		const type = ((element as unknown as { type?: string }).type || "text").toLocaleLowerCase();
		if (type === "hidden") return null;
		if (type === "checkbox") return "checkbox";
		if (type === "radio") return "radio";
		if (type === "range") return "slider";
		if (["button", "submit", "reset", "image", "file", "color"].includes(type)) return "button";
		// A field with suggestions (`list`) is a combo box.
		if (element.hasAttribute("list")) return "combobox";
		if (type === "number") return "spinbutton";
		if (type === "search") return "searchbox";
		// Date and time fields too: the kit's observe() lists them as text boxes to fill.
		return "textbox";
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
	const namedByContent = (role: string | null): boolean =>
		/^(?:button|cell|checkbox|columnheader|gridcell|heading|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|row|rowheader|switch|tab|term|tooltip|treeitem)$/.test(
			role ?? "",
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
		start: Pick<Element, "childNodes"> & { shadowRoot?: Pick<Element, "childNodes"> | null },
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
				} else if (tag !== "input") {
					// An element with a shadow root shows that tree; a slot shows the nodes assigned to it, else its own.
					const host = childElement as unknown as {
						shadowRoot?: Element | null;
						assignedNodes?: (options: { flatten: boolean }) => Element[];
					};
					const assigned = tag === "slot" ? (host.assignedNodes?.({ flatten: true }) ?? []) : [];
					const slotted = assigned.length > 0 ? ({ childNodes: assigned } as unknown as Element) : null;
					walk(slotted ?? host.shadowRoot ?? childElement, visibility === "any" ? "any" : style.visibility);
				}
				text += gap;
			}
		};
		walk(start.shadowRoot ?? start, visibility);
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
	 * Text of the elements an `aria-labelledby` (or `attribute`) names (a hidden target read whole), without following
	 * their own references. Each target is read as a node embedded in a label, so a control target gives its value and an
	 * image its alt, as its descendants would.
	 */
	const idrefText = (element: Element, visited = new Set<Element>(), attribute = "aria-labelledby"): string => {
		const labelledBy = element.getAttribute(attribute);
		if (!labelledBy || visited.has(element)) return "";
		visited.add(element);
		try {
			return normalizeSpace(
				labelledBy
					.split(/\s+/)
					.map(id => {
						// An id names an element in the same tree: the shadow root around the element, else the document.
						const node = element as unknown as {
							getRootNode(): { getElementById?: (id: string) => Element | null };
						};
						const tree = node.getRootNode();
						const target = tree.getElementById?.(id) ?? element.ownerDocument?.getElementById(id);
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
		// Only the form controls a `<label>` can label have `labels`, so an optgroup in a labelled select keeps its own
		// label (or title) and a term inside a label keeps its own text. Every label of a field names it, in order.
		const labels = (element as unknown as { labels?: ArrayLike<Element> | null }).labels;
		if (labels && labels.length > 0) {
			const text = normalizeSpace(Array.from(labels, label => contentText(label, element, "visible")).join(" "));
			if (text) return text;
		}
		const tag = element.tagName.toLocaleLowerCase();
		// An `<input>`'s type and value decide its name; other elements have neither.
		const input = tag === "input" ? (element as unknown as { type: string; value: string }) : null;
		const inputType = input?.type.toLocaleLowerCase();
		if (inputType === "image") return imageInputName(element);
		if (tag === "img" || tag === "area") {
			const alt = normalizeSpace(element.getAttribute("alt") ?? "");
			if (alt) return alt;
		}
		// Content names only the roles named by it; reading it walks the subtree, so it is read only for those.
		if (namedByContent(roleOf(element))) {
			const content =
				inputType === "button" || inputType === "submit" || inputType === "reset"
					? normalizeSpace(input?.value ?? "") ||
						(inputType === "submit" ? "Submit" : inputType === "reset" ? "Reset" : "")
					: normalizeSpace(contentText(element, null, "visible"));
			if (content) return content;
		}
		return normalizeSpace(
			element.getAttribute("title") ||
				element.getAttribute("placeholder") ||
				element.getAttribute("aria-placeholder") ||
				"",
		);
	};
	const roleOf = (element: Element): string | null => {
		const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]?.toLocaleLowerCase();
		if (explicit) return explicit === "presentation" ? "none" : explicit;
		return implicitRole(element);
	};
	const query = (node: QueryNode, selector: string): Element[] => {
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
		// The ARIA synonyms: Chrome calls an image "image", and `presentation` is `none`.
		const aliases: Record<string, string> = { image: "img", presentation: "none" };
		const typedRole = parsed[1]!.toLocaleLowerCase();
		const wantedRole = aliases[typedRole] ?? typedRole;
		const nameText = parsed[2] ?? parsed[3] ?? parsed[4];
		const wantedName = nameText === undefined ? undefined : normalizeSpace(nameText).toLocaleLowerCase();
		const exact = parsed[5]?.toLocaleLowerCase() === "exact";
		const elements: Element[] = [];
		const visit = (scope: QueryRoot): void => {
			for (const element of Array.from(scope.querySelectorAll("*"))) {
				elements.push(element);
				const shadow = (element as unknown as { shadowRoot?: QueryRoot | null }).shadowRoot;
				if (shadow) visit(shadow);
			}
		};
		// A shadow host is searched through its own shadow tree too.
		const rootShadow = (node as unknown as { shadowRoot?: QueryRoot | null }).shadowRoot;
		if (rootShadow) visit(rootShadow);
		visit(node as unknown as QueryRoot);
		return elements.filter(element => {
			const role = roleOf(element);
			if ((role && (aliases[role] ?? role)) !== wantedRole) return false;
			if (wantedName === undefined) return true;
			const name = accessibleName(element).toLocaleLowerCase();
			return exact ? name === wantedName : name.includes(wantedName);
		});
	};
	return {
		role: roleOf,
		name: accessibleName,
		description: element => idrefText(element, new Set(), "aria-describedby"),
		query,
	};
}

/** Semantic selector prefixes (`label/`, …) and their self-contained `queryAll` handlers; `role/` is separate. */
export const SEMANTIC_QUERY_HANDLERS = {
	label: queryByLabel,
	placeholder: queryByPlaceholder,
	testid: queryByTestId,
	alt: queryByAlt,
	title: queryByTitle,
} as const satisfies Record<string, (node: QueryNode, selector: string) => Element[]>;

/** A parsed `role/` selector; the name filter is whitespace-collapsed and lower-cased, as names are compared. */
export interface RoleQuery {
	role: string;
	name?: string;
	exact: boolean;
}

/** Parse a `role/` selector body with the grammar {@link roleRules} reads in the Tern kit, refusing what it refuses. */
export function parseRoleSelector(selector: string): RoleQuery {
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
	const name = parsed[2] ?? parsed[3] ?? parsed[4];
	return {
		role: parsed[1]!.toLowerCase(),
		name: name === undefined ? undefined : name.replace(/\s+/g, " ").trim().toLowerCase(),
		exact: parsed[5] !== undefined,
	};
}

/** Wait between Chromium `role/` polls. */
const ROLE_POLL_MS = 100;

/**
 * Elements Chrome can give each role without a `role` attribute (HTML-AAM's implicit roles, as Chrome spells them).
 * It only narrows which elements Chrome is asked about, so it errs wide: a tag listed for a role it does not get costs
 * a lookup, a missing one loses a match. A role not listed (`alert`, `tab`, a misspelling) comes only from a `role`
 * attribute or a custom element's ElementInternals, so only those elements are asked about.
 */
const ROLE_TAGS: Record<string, string> = {
	abbr: "abbr",
	article: "article",
	audio: "audio",
	banner: "header",
	blockquote: "blockquote",
	button: "button, input, summary",
	canvas: "canvas",
	caption: "caption",
	cell: "td, th",
	checkbox: "input",
	code: "code",
	colorwell: "input",
	columnheader: "th, td",
	combobox: "input, select",
	complementary: "aside",
	contentinfo: "footer",
	date: "input",
	datetime: "input",
	definition: "dd",
	deletion: "del, s",
	descriptionlist: "dl",
	dialog: "dialog",
	disclosuretriangle: "summary",
	embeddedobject: "embed",
	emphasis: "em",
	figcaption: "figcaption",
	figure: "figure",
	form: "form",
	generic: "*",
	"graphics-document": "svg",
	"graphics-object": "svg *",
	"graphics-symbol": "svg *",
	gridcell: "td, th",
	group: "address, details, fieldset, hgroup, optgroup, svg g",
	heading: "h1, h2, h3, h4, h5, h6",
	iframe: "iframe",
	image: "img, svg, image",
	inputtime: "input",
	insertion: "ins",
	labeltext: "label",
	layouttable: "table",
	layouttablecell: "td, th",
	layouttablerow: "tr",
	legend: "legend",
	linebreak: "br",
	link: "a, area",
	list: "ul, ol, menu",
	listbox: "select, datalist",
	listitem: "li",
	main: "main",
	mark: "mark",
	math: "math",
	meter: "meter",
	navigation: "nav",
	none: "img",
	option: "option",
	paragraph: "p",
	pluginobject: "object",
	progressbar: "progress",
	radio: "input",
	region: "section",
	row: "tr",
	rowgroup: "thead, tbody, tfoot",
	rowheader: "th, td",
	ruby: "ruby",
	search: "search",
	searchbox: "input",
	sectionfooter: "footer",
	sectionheader: "header",
	separator: "hr",
	slider: "input",
	spinbutton: "input",
	status: "output",
	strong: "strong",
	subscript: "sub",
	superscript: "sup",
	svgroot: "svg",
	switch: "input",
	table: "table",
	term: "dfn, dt",
	textbox: "input, textarea",
	time: "time",
	video: "video",
};

/** Chrome's MathML roles (`MathMLFraction`, …) belong to the elements of a `<math>` tree. */
const MATHML_TAGS = "math, math *";

/** The role a selector names by its other ARIA spelling: Chrome calls an image "image", and `presentation` is `none`. */
const ROLE_SPELLINGS: Record<string, string> = { img: "image", presentation: "none" };

/** The `role` attribute values that give a role with two spellings. */
const ROLE_TOKENS: Record<string, readonly string[]> = { image: ["img", "image"], none: ["none", "presentation"] };

/**
 * Roles Chrome also reports under its own name: a table without data-table markup is a layout table to Chrome, and
 * still a table to HTML-AAM and to whoever reads the page.
 */
const ROLE_REPORTED_AS: Record<string, readonly string[]> = {
	table: ["layouttable"],
	row: ["layouttablerow"],
	cell: ["layouttablecell"],
};

/** Why Chrome leaves a presentational element out of the tree; `role/none` matches those elements. */
const PRESENTATIONAL_REASONS: Record<string, true> = { presentationalRole: true, emptyAlt: true };

/** `table[key]`, for a key typed into a selector: never a property every object inherits, such as `constructor`. */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The elements below `root` that match `selector`, plus every custom element (its ElementInternals can give it any
 * role, which the page cannot read back), in document order, each followed by the candidates inside its open shadow
 * root. A shadow host root is searched through its own shadow tree too. Runs in the page.
 */
function collectCandidates(root: unknown, selector: string, includeDocument: boolean): unknown[] {
	// A document, element or shadow root of this page; the tool's TypeScript config has no DOM library to name them.
	type Scope = {
		nodeType: number;
		querySelectorAll(selector: string): Iterable<Candidate>;
		shadowRoot?: Scope | null;
	};
	type Candidate = Scope & { localName: string; matches(selector: string): boolean };
	const found: Scope[] = [];
	const visit = (scope: Scope): void => {
		for (const element of scope.querySelectorAll("*")) {
			if (element.localName.includes("-") || element.matches(selector)) found.push(element);
			if (element.shadowRoot) visit(element.shadowRoot);
		}
	};
	const scope = root as Scope;
	if (includeDocument && scope.nodeType === 9) found.push(scope);
	if (scope.shadowRoot) visit(scope.shadowRoot);
	visit(scope);
	return found;
}

/** Elements Chrome is asked about in the first round trip while a `queryOne` looks for its first match. */
const ROLE_PROBE_FIRST = 32;
/** Most elements Chrome is asked about in one round trip; a `queryOne`'s rounds double up to it. */
const ROLE_PROBE_MAX = 512;

/**
 * Chromium's `role/` resolution: the elements below `root` whose role and accessible name Chrome computes as the
 * selector asks. Each candidate's own accessibility node is read with `Accessibility.getPartialAXTree`, which answers
 * at once even in a background tab. It searches the page and its open shadow roots, and leaves out what the tree
 * leaves out: hidden and `aria-hidden` elements. Stops after `limit` matches.
 */
async function queryRoleInAXTree(root: ElementHandle, query: RoleQuery, limit: number): Promise<ElementHandle[]> {
	const role = lookup(ROLE_SPELLINGS, query.role) ?? query.role;
	const reported = [role, ...(lookup(ROLE_REPORTED_AS, role) ?? [])];
	const tags = lookup(ROLE_TAGS, role) ?? (role.startsWith("mathml") ? MATHML_TAGS : undefined);
	const tokens = (lookup(ROLE_TOKENS, role) ?? [role]).map(token => `[role~=${JSON.stringify(token)} i]`).join(", ");
	const selector = tags ? `${tags}, ${tokens}` : tokens;
	const list = await root.realm.evaluateHandle(collectCandidates, root, selector, role === "rootwebarea");
	const client = root.frame.client;
	const matches: ElementHandle[] = [];
	try {
		const count = await list.evaluate(found => found.length);
		let batch = limit === 1 ? ROLE_PROBE_FIRST : ROLE_PROBE_MAX;
		for (
			let next = 0;
			next < count && matches.length < limit;
			next += batch, batch = Math.min(batch * 2, ROLE_PROBE_MAX)
		) {
			const slice = await list.evaluateHandle((found, start, end) => found.slice(start, end), next, next + batch);
			const probed: ElementHandle[] = [];
			try {
				for (const property of (await slice.getProperties()).values()) {
					const element = property.asElement();
					if (element) probed.push(element);
					else await property.dispose();
				}
			} finally {
				await slice.dispose();
			}
			let probeFailed = false;
			const nodes = await Promise.all(
				probed.map(candidate =>
					client
						.send("Accessibility.getPartialAXTree", {
							objectId: candidate.remoteObject().objectId,
							fetchRelatives: false,
						})
						// A candidate the page removed meanwhile matches nothing.
						.then(
							({ nodes }) => nodes[0],
							() => {
								probeFailed = true;
								return undefined;
							},
						),
				),
			);
			if (probeFailed) {
				try {
					// A removed candidate may be skipped, but a replaced document must reach the navigation retry.
					await root.evaluate(() => undefined);
				} catch (error) {
					await Promise.all(probed.map(candidate => candidate.dispose()));
					throw error;
				}
			}
			const rejected: ElementHandle[] = [];
			for (const [index, candidate] of probed.entries()) {
				const node = nodes[index];
				let matched =
					matches.length < limit &&
					node !== undefined &&
					// Chrome spells roles outside ARIA in CamelCase (`DescriptionList`), as `observe()` shows them.
					reported.includes(String(node.role?.value ?? "").toLowerCase()) &&
					(!node.ignored ||
						(role === "none" &&
							(node.ignoredReasons ?? []).every(reason => lookup(PRESENTATIONAL_REASONS, reason.name))));
				if (matched && query.name !== undefined) {
					const name = String(node!.name?.value ?? "")
						.replace(/\s+/g, " ")
						.trim()
						.toLowerCase();
					matched = query.exact ? name === query.name : name.includes(query.name);
				}
				(matched ? matches : rejected).push(candidate);
			}
			await Promise.all(rejected.map(candidate => candidate.dispose()));
		}
	} catch (error) {
		await Promise.all(matches.map(match => match.dispose()));
		throw error;
	} finally {
		await list.dispose();
	}
	return matches;
}

/**
 * Puppeteer's `waitFor` for Chromium `role/` selectors, polling the accessibility tree from Node: the first match, once
 * visible if `visible` is set; with `hidden`, null once there is no match or the first is hidden. Like Puppeteer's own,
 * the handle comes back in the frame's isolated realm.
 */
async function waitForRole(
	elementOrFrame: ElementHandle | Frame,
	selector: string,
	options: WaitForSelectorOptions,
): Promise<ElementHandle | null> {
	const query = parseRoleSelector(selector);
	const { visible = false, hidden = false, signal } = options;
	const frame = "frame" in elementOrFrame ? elementOrFrame.frame : elementOrFrame;
	const realm = frame.isolatedRealm();
	const timeout = options.timeout ?? frame.page().getDefaultTimeout();
	const deadline = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
	const timeoutError = puppeteerTimeoutError(`Waiting for selector \`${selector}\` failed`);
	timeoutError.cause = puppeteerTimeoutError(`Waiting failed: ${timeout}ms exceeded`);
	const pending = (async () => {
		const element = "frame" in elementOrFrame ? await realm.adoptHandle(elementOrFrame) : null;
		try {
			while (true) {
				signal?.throwIfAborted();
				let found: ElementHandle | undefined;
				try {
					// A navigation replaces the document, so read it anew on each poll.
					const root = element ?? ((await realm.evaluateHandle(() => document)) as unknown as ElementHandle);
					try {
						[found] = await queryRoleInAXTree(root, query, 1);
					} finally {
						if (root !== element) await root.dispose();
					}
					if (found && !hidden && (!visible || (await found.isVisible()))) return found;
					if (hidden && (!found || (await found.isHidden()))) {
						await found?.dispose();
						return null;
					}
				} catch (error) {
					await found?.dispose();
					// A replaced document leaves nothing to report until the next poll.
					if (element || !isNavigatedContextError(error)) throw error;
				}
				await found?.dispose();
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw timeoutError;
				await sleepLong(Math.min(ROLE_POLL_MS, remaining), signal);
			}
		} finally {
			await element?.dispose();
		}
	})();
	let found: ElementHandle | null | undefined;
	try {
		found = await (timeout > 0 ? withTimeout(pending, timeout, timeoutError, signal) : untilAborted(signal, pending));
		signal?.throwIfAborted();
		if (Date.now() >= deadline) throw timeoutError;
		return found;
	} catch (error) {
		if (found) await found.dispose();
		// CDP cannot cancel an in-flight probe; release any handle it returns after this wait has ended.
		else void pending.then(late => late?.dispose()).catch(() => {});
		throw error;
	}
}

/** Puppeteer's handler registry (`@internal` upstream, stripped from published types), as far as it is used here. */
interface QueryHandlerRegistry {
	get(name: string): object | undefined;
}

/**
 * Register the browser tool's semantic selector prefixes on a worker-local Puppeteer instance. `role/` resolves in
 * Node through Chrome's accessibility tree ({@link queryRoleInAXTree}); {@link roleRules} serves only the Tern kit.
 */
export function registerSemanticQueryHandlers(puppeteer: typeof PuppeteerInstance): void {
	const Puppeteer = puppeteer.constructor as typeof PuppeteerClass;
	const registered = new Set(Puppeteer.customQueryHandlerNames());
	for (const name in SEMANTIC_QUERY_HANDLERS) {
		const queryAll = SEMANTIC_QUERY_HANDLERS[name as keyof typeof SEMANTIC_QUERY_HANDLERS];
		if (!registered.has(name)) Puppeteer.registerCustomQueryHandler(name, { queryAll });
	}
	if (registered.has("role")) return;
	// The page-side half runs only inside a P-selector (`::-p-role(…)`), which cannot reach the accessibility tree.
	Puppeteer.registerCustomQueryHandler("role", {
		queryAll: () => {
			throw new Error('role/ selectors must be the whole selector, as in role/button[name="Save"]');
		},
	});
	// Registration builds a QueryHandler class whose static methods resolve `role/…` for $, $$ and waitForSelector.
	const registry = Reflect.get(Puppeteer, "customQueryHandlers") as QueryHandlerRegistry;
	Object.assign(registry.get("role")!, {
		async *queryAll(root: ElementHandle, selector: string) {
			yield* await queryRoleInAXTree(root, parseRoleSelector(selector), Number.POSITIVE_INFINITY);
		},
		async queryOne(root: ElementHandle, selector: string) {
			return (await queryRoleInAXTree(root, parseRoleSelector(selector), 1))[0] ?? null;
		},
		waitFor: waitForRole,
	});
}
