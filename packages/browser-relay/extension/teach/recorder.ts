import { OVERLAY_HOST_TAG, type TeachCommand, type TeachEvent } from "../messages";
import { nameFor, roleFor, selectorFor } from "./element";

const ACTIONABLE = "button, a[href], input, label, select, textarea, summary, [role], [contenteditable]";
const TYPING_IDLE_MS = 450;

declare global {
	var __ompTeachRecorder: true | undefined;
}

type Step = TeachEvent["step"];

function visibleText(element: Element): string {
	const style = getComputedStyle(element);
	if (style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return "";
	if (style.display !== "contents" && element.getClientRects().length === 0) return "";
	return element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
}

function targetFor(event: Event): Element | undefined {
	let first: Element | undefined;
	let actionable: Element | undefined;
	for (const item of event.composedPath()) {
		if (!(item instanceof Element)) continue;
		if (item.localName === OVERLAY_HOST_TAG) return undefined;
		first ??= item;
		if (!actionable && item.matches(ACTIONABLE)) actionable = item;
	}
	return actionable ?? first;
}

function describe(kind: Step["kind"], element: Element): Step {
	const root = element.getRootNode();
	const scope = root instanceof ShadowRoot ? root : document;
	return {
		kind,
		url: location.href,
		title: document.title,
		role: roleFor(element),
		name: nameFor(element, scope, (target, includeHidden) => {
			if (includeHidden) return target.textContent ?? "";
			return target instanceof Element ? visibleText(target) : "";
		}),
		selector: selectorFor(element, scope, CSS.escape),
		text:
			(visibleText(element).trim() || (element.parentElement ? visibleText(element.parentElement) : ""))
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120) || undefined,
		viewport: { width: innerWidth, height: innerHeight },
		at: Date.now(),
	};
}

function privateInput(element: HTMLInputElement): boolean {
	return element.type === "password" || element.type === "hidden" || /\b(?:current|new)-password\b/.test(element.autocomplete);
}

function typingValue(element: Element): string | undefined {
	if (element instanceof HTMLInputElement) {
		if (privateInput(element)) return undefined;
		switch (element.type) {
			case "text":
			case "search":
			case "email":
			case "url":
			case "tel":
			case "number":
				return element.value;
			default:
				return undefined;
		}
	}
	if (element instanceof HTMLTextAreaElement) return element.value;
	if (element instanceof HTMLElement && element.isContentEditable) return element.innerText;
	return undefined;
}

function selectionValue(element: Element): string | undefined {
	if (element instanceof HTMLSelectElement) {
		return element.multiple ? Array.from(element.selectedOptions, option => option.value).join("\n") : element.value;
	}
	if (element instanceof HTMLInputElement) {
		if (privateInput(element)) return undefined;
		switch (element.type) {
			case "checkbox":
			case "radio":
				return element.checked ? element.value : "";
			case "date":
			case "datetime-local":
			case "month":
			case "week":
			case "time":
			case "color":
			case "range":
				return element.value;
		}
	}
	return undefined;
}

function install(): void {
	let listeners: AbortController | undefined;
	let pending: { element: Element; step: Step; timer: number } | undefined;
	const delivery = new Set<Promise<unknown>>();

	function send(step: Step): void {
		const message: TeachEvent = { omp: "teach-step", step };
		const sent = chrome.runtime.sendMessage(message).catch(() => undefined);
		delivery.add(sent);
		void sent.then(() => delivery.delete(sent));
	}

	function flush(): void {
		if (!pending) return;
		const { timer, element, step } = pending;
		pending = undefined;
		clearTimeout(timer);
		if (!(element instanceof HTMLInputElement) || !privateInput(element)) send(step);
	}

	function type(event: Event): void {
		if (!event.isTrusted || (event instanceof InputEvent && event.isComposing)) return;
		const element = targetFor(event);
		if (!element) return;
		const value = typingValue(element);
		if (value === undefined) return;
		if (pending && pending.element !== element) flush();
		if (pending) {
			clearTimeout(pending.timer);
			pending.step.value = value;
			pending.step.at = Date.now();
			pending.timer = window.setTimeout(flush, TYPING_IDLE_MS);
		} else {
			const step = describe("type", element);
			step.value = value;
			pending = { element, step, timer: window.setTimeout(flush, TYPING_IDLE_MS) };
		}
	}

	function click(event: MouseEvent): void {
		if (!event.isTrusted) return;
		const target = targetFor(event);
		if (!target) return;
		flush();
		send({ ...describe("click", target), x: event.clientX, y: event.clientY });
	}

	function change(event: Event): void {
		if (!event.isTrusted) return;
		const target = targetFor(event);
		if (!target) return;
		flush();
		const value = selectionValue(target);
		if (value !== undefined) send({ ...describe("select", target), value });
	}

	function key(event: KeyboardEvent): void {
		if (!event.isTrusted || event.isComposing || event.repeat) return;
		if (event.key !== "Enter" && event.key !== "Escape" && event.key !== "Tab") return;
		const target = targetFor(event);
		if (!target) return;
		flush();
		send({ ...describe("key", target), key: event.key });
	}

	function submit(event: SubmitEvent): void {
		if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return;
		flush();
		// The preceding click/key already describes a user-operated submit control.
		if (!event.submitter) send({ ...describe("key", event.target), key: "Enter" });
	}

	chrome.runtime.onMessage.addListener((message: TeachCommand, _sender, respond) => {
		if (message?.omp !== "teach") return false;
		if (message.op === "start") {
			if (!listeners) {
				listeners = new AbortController();
				const options = { capture: true, signal: listeners.signal };
				document.addEventListener("click", click, options);
				document.addEventListener("input", type, options);
				document.addEventListener("compositionend", type, options);
				document.addEventListener("change", change, options);
				document.addEventListener("keydown", key, options);
				document.addEventListener("submit", submit, options);
				window.addEventListener("pagehide", flush, options);
			}
			respond(true);
			return false;
		}
		if (message.op === "stop") {
			listeners?.abort();
			listeners = undefined;
			flush();
			void Promise.allSettled(delivery).then(() => respond(true));
			return true;
		}
		return false;
	});
}

if (!globalThis.__ompTeachRecorder) {
	globalThis.__ompTeachRecorder = true;
	install();
}
