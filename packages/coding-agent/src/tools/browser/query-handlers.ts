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
 * accessible name.
 */
export function queryByRole(node: QueryNode, selector: string): Element[] {
	const root = node as unknown as QueryRoot;
	const roleMatch = /^\s*([^\s[]+)/.exec(selector);
	const wantedRole = (roleMatch?.[1] ?? "").toLocaleLowerCase();
	const nameMatch = /\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(exact))?\s*\]/i.exec(selector);
	const normalizeSpace = (value: string): string => value.replace(/\s+/g, " ").trim();
	const nameText = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
	const wantedName = nameText === undefined ? undefined : normalizeSpace(nameText).toLocaleLowerCase();
	const exact = nameMatch?.[4]?.toLocaleLowerCase() === "exact";
	const implicitRole = (element: Element): string | null => {
		const tag = element.tagName.toLocaleLowerCase();
		if (tag === "a" && element.hasAttribute("href")) return "link";
		if (tag === "button") return "button";
		if (tag === "textarea") return "textbox";
		if (tag === "select") {
			const select = element as unknown as { multiple: boolean; size: number };
			return select.multiple || select.size > 1 ? "listbox" : "combobox";
		}
		if (tag === "option") return "option";
		if (tag === "img") return "img";
		if (tag === "ul" || tag === "ol") return "list";
		if (tag === "li") return "listitem";
		if (tag === "nav") return "navigation";
		if (tag === "main") return "main";
		if (tag === "form") return "form";
		if (tag === "article") return "article";
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
	// Roles named by their content, so `title` names them only when the content is empty.
	const namedByContent =
		/^(?:button|cell|checkbox|columnheader|gridcell|heading|link|menuitem|menuitemcheckbox|menuitemradio|option|radio|row|rowheader|switch|tab|tooltip|treeitem)$/.test(
			wantedRole,
		);
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
				const labelledBy = followRefs ? idrefText(childElement) : "";
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
				else if (tag === "img") text += shown ? (childElement.getAttribute("alt") ?? "") : "";
				else if (inputButton) text += shown ? (control.value ?? "") : "";
				else if (tag !== "input") walk(childElement, visibility === "any" ? "any" : style.visibility);
				text += gap;
			}
		};
		walk(start, visibility);
		return text;
	};
	/** Text of the elements an `aria-labelledby` names (a hidden target read whole), without following their own references. */
	const idrefText = (element: Element): string => {
		const labelledBy = element.getAttribute("aria-labelledby");
		if (!labelledBy) return "";
		return normalizeSpace(
			labelledBy
				.split(/\s+/)
				.map(id => {
					const target = element.ownerDocument?.getElementById(id);
					if (!target) return "";
					// Hidden by visibility, `display: none`, or a `hidden`/`aria-hidden` ancestor: read the whole subtree.
					const targetStyle = getComputedStyle(target);
					const hidden =
						targetStyle.visibility !== "visible" ||
						targetStyle.display === "none" ||
						target.closest("[hidden], [aria-hidden='true']") !== null;
					return contentText(target, null, hidden ? "any" : "visible", false);
				})
				.join(" "),
		);
	};
	const accessibleName = (element: Element): string => {
		const ariaLabel = normalizeSpace(element.getAttribute("aria-label") ?? "");
		if (ariaLabel) return ariaLabel;
		const labelledBy = idrefText(element);
		if (labelledBy) return labelledBy;
		if (element.id) {
			for (const label of element.ownerDocument?.querySelectorAll("label") ?? []) {
				if (label.getAttribute("for") === element.id) {
					return normalizeSpace(contentText(label, element, "visible"));
				}
			}
		}
		const wrappingLabel = element.closest("label");
		if (wrappingLabel) return normalizeSpace(contentText(wrappingLabel, element, "visible"));
		const tag = element.tagName.toLocaleLowerCase();
		// An `<input>`'s type and value decide its name; other elements have neither.
		const input = tag === "input" ? (element as unknown as { type: string; value: string }) : null;
		const inputType = input?.type.toLocaleLowerCase();
		if (tag === "img" || tag === "area" || inputType === "image") {
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
				content,
		);
	};
	return Array.from(root.querySelectorAll("*")).filter(element => {
		const role = (element.getAttribute("role")?.trim().split(/\s+/)[0] ?? implicitRole(element))?.toLocaleLowerCase();
		if (role !== wantedRole) return false;
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
