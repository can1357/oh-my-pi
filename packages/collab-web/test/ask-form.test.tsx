import { afterEach, describe, expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { parseHtmlForm, type ChoiceField } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AskForm, choiceSubmissionError } from "../src/components/shell/AskForm";

const saved = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	saved.clear();
});

describe("guest Ask form", () => {
	it("rejects Other matching a disabled choice but accepts a checked value", () => {
		const field = parseHtmlForm(
			'<form><input type="checkbox" name="pick" value="a"><input type="checkbox" name="pick" value="b" disabled></form>',
		).fields[0] as ChoiceField;
		expect(choiceSubmissionError(field, "a")).toBeUndefined();
		expect(choiceSubmissionError(field, " a ")).toBeUndefined();
		expect(choiceSubmissionError(field, " b ")).toBe("Other must not match a disabled option");
		expect(choiceSubmissionError(field, "new")).toBeUndefined();
	});

	it("exposes required choice groups and text controls", () => {
		const html = renderToStaticMarkup(
			<AskForm
				html={'<form><input type="radio" name="pick" value="a" required><input name="text" required></form>'}
				onSubmit={() => {}}
			/>,
		);
		const document = parseHTML(html).document;
		expect(document.querySelector('input[type="radio"][name="ask-choice-0"]')?.getAttribute("aria-required")).toBe(
			"true",
		);
		expect(document.querySelector("#ask-field-1")?.getAttribute("aria-required")).toBe("true");
	});

	it("uses the section heading as the accessible name of its first matching choice", () => {
		const html = renderToStaticMarkup(
			<AskForm
				html={
					'<form><fieldset><legend>Database</legend><label><input type="radio" name="db" value="sqlite" required>SQLite</label><label><input type="radio" name="db" value="pg">Postgres</label></fieldset></form>'
				}
				onSubmit={() => {}}
			/>,
		);
		expect(html.match(/Database/g)).toHaveLength(1);
		expect(html).toContain('<h3 id="ask-section-0">');
		expect(html).toContain('aria-labelledby="ask-section-0"');
		expect(html).toContain(" *");
	});

	it("does not use an unsupported media notice as a choice question", () => {
		const source =
			'<form><p>Choose a database</p><iframe></iframe><input type="radio" name="db" value="a"><input type="radio" name="db" value="b"></form>';
		const html = renderToStaticMarkup(<AskForm html={source} onSubmit={() => {}} />);
		const document = parseHTML(html).document;
		expect(document.querySelector("legend")?.textContent).toBe("Choose a database");
		expect(html).toContain("Media not supported");
	});

	it("renders sections, content, defaults and disabled choices in order without executing markup", () => {
		const html = renderToStaticMarkup(
			<AskForm
				html={
					'<form><fieldset><legend>First</legend><p>Before</p><label>Name<input name="name" value="Jane"></label><p>After</p><label><input type="checkbox" name="pick" value="a" checked>A</label><label><input type="checkbox" name="pick" value="b" disabled>B</label><img src="javascript:alert(1)" alt="diagram"><svg onload="alert(2)"><title>chart</title></svg><script>alert(3)</script></fieldset></form>'
				}
				onSubmit={() => {}}
			/>,
		);
		expect(html.indexOf("First")).toBeLessThan(html.indexOf("Before"));
		expect(html.indexOf("Before")).toBeLessThan(html.indexOf("Name"));
		expect(html.indexOf("Name")).toBeLessThan(html.indexOf("After"));
		expect(html).toContain('value="Jane"');
		expect(html).toContain('checked=""');
		expect(html).toContain('disabled=""');
		expect(html).toContain("Media not supported: diagram");
		expect(html).toContain("Media not supported: chart");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onload");
	});

	it("does not load remote, local, or unsupported images", () => {
		const html = renderToStaticMarkup(
			<AskForm
				html={
					'<form><img src="https://example.com/picture.png" alt="remote"><img src="http://127.0.0.1/admin" alt="loopback"><img src="http://192.168.1.1/" alt="network"><img src="data:image/png;base64,YWJj" alt="inline"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg data"><img src="file:///secret.png" alt="local"><video src="https://example.com/movie"></video></form>'
				}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain("Media not supported: remote");
		expect(html).toContain("Media not supported: loopback");
		expect(html).toContain("Media not supported: network");
		expect(html).toContain('src="data:image/png;base64,YWJj"');
		expect(html).toContain("Media not supported: svg data");
		expect(html).toContain("Media not supported: local");
		expect(html).not.toContain("https://example.com/picture");
		expect(html).not.toContain("http://127.0.0.1");
		expect(html).not.toContain("http://192.168.1.1");
		expect(html).not.toContain("file:///secret");
		expect(html).not.toContain("<video");
	});

	it("reveals Other without moving radio focus and submits its entered answer", async () => {
		const window = parseHTML('<html><body><div id="root"></div></body></html>');
		const globals: Record<string, unknown> = {
			window,
			document: window.document,
			navigator: window.navigator,
			Node: window.Node,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			HTMLIFrameElement: window.HTMLIFrameElement,
			SVGElement: window.SVGElement,
			Event: window.Event,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		for (const [name, value] of Object.entries(globals)) {
			saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
		}
		const prototype = window.HTMLElement.prototype;
		const scrollIntoView = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
		Object.defineProperty(prototype, "scrollIntoView", { configurable: true, value: () => {} });
		try {
			const container = window.document.getElementById("root")!;
			root = createRoot(container as unknown as Element);
			const answers: unknown[] = [];
			await act(async () =>
				root!.render(
					<AskForm
						html={
							'<form><label><input type="radio" name="pick" value="a">A</label><label><input type="radio" name="pick" value="b">B</label></form>'
						}
						onSubmit={value => answers.push(value)}
					/>,
				),
			);
			const choices = container.querySelectorAll('input[type="radio"]');
			const firstChoice = choices[0]! as InstanceType<typeof window.HTMLElement>;
			const otherChoice = choices[2]! as InstanceType<typeof window.HTMLElement>;
			await act(async () => {
				otherChoice.focus();
				otherChoice.checked = true;
				otherChoice.click();
			});
			expect(window.document.activeElement).toBe(otherChoice);

			// The parser DOM does not implement native radio arrow-key navigation.
			await act(async () => {
				firstChoice.focus();
				firstChoice.checked = true;
				firstChoice.click();
			});
			expect(window.document.activeElement).toBe(firstChoice);
			expect(container.querySelector('input[aria-label$=": Other"]')).toBeNull();
			await act(async () => {
				otherChoice.focus();
				otherChoice.checked = true;
				otherChoice.click();
			});
			const other = container.querySelector('input[aria-label$=": Other"]')! as InstanceType<
				typeof window.HTMLElement
			>;
			expect(window.document.activeElement).toBe(otherChoice);

			// The parser DOM has no layout or native input events.
			other.type = "text";
			Object.assign(other, { attachEvent: () => {}, detachEvent: () => {} });
			other.focus();
			expect(window.document.activeElement).toBe(other);
			await act(async () => {
				other.dispatchEvent(new window.Event("focusin", { bubbles: true }));
				other.value = "My answer";
				other.dispatchEvent(new window.Event("input", { bubbles: true }));
				other.dispatchEvent(new window.Event("keyup", { bubbles: true }));
			});
			expect(other.value).toBe("My answer");
			await act(async () =>
				container
					.querySelector("form")!
					.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
			);
			expect(answers).toEqual([{ fields: [{ checked: [], other: "My answer" }] }]);
			other.dispatchEvent(new window.Event("focusout", { bubbles: true }));
		} finally {
			if (scrollIntoView) Object.defineProperty(prototype, "scrollIntoView", scrollIntoView);
			else Reflect.deleteProperty(prototype, "scrollIntoView");
		}
	});

	it("focuses the first invalid field on each submission", async () => {
		const window = parseHTML('<html><body><div id="root"></div></body></html>');
		const globals: Record<string, unknown> = {
			window,
			document: window.document,
			navigator: window.navigator,
			Node: window.Node,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			HTMLIFrameElement: window.HTMLIFrameElement,
			SVGElement: window.SVGElement,
			Event: window.Event,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		for (const [name, value] of Object.entries(globals)) {
			saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
		}
		const prototype = window.HTMLElement.prototype;
		const originalScroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
		Object.defineProperty(prototype, "scrollIntoView", { configurable: true, value: () => {} });
		try {
			const container = window.document.getElementById("root")!;
			root = createRoot(container as unknown as Element);
			const render = async (key: string, html: string) =>
				act(async () => root!.render(<AskForm key={key} html={html} onSubmit={() => {}} />));
			const submit = async () =>
				act(async () =>
					container
						.querySelector("form")!
						.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
				);
			await render(
				"text",
				'<form><p>Long content</p><input name="first" required><input name="second" required></form>',
			);
			const first = container.querySelector("#ask-field-0")! as InstanceType<typeof window.HTMLElement>;
			Object.assign(first, { attachEvent: () => {}, detachEvent: () => {} });
			await submit();
			expect(window.document.activeElement).toBe(first);
			await submit();
			expect(window.document.activeElement).toBe(first);

			await render(
				"choice",
				'<form><p>Long content</p><fieldset><legend>Choose one</legend><label><input type="radio" name="pick" disabled required>Disabled</label><label><input type="radio" name="pick" required>Enabled</label></fieldset></form>',
			);
			await submit();
			const enabled = container.querySelectorAll('input[type="radio"]')[1]!;
			expect(window.document.activeElement).toBe(enabled);
			const group = container.querySelector("fieldset")!;
			const headingId = group.getAttribute("aria-labelledby");
			expect(window.document.getElementById(headingId!)?.textContent).toContain("Choose one");
			expect(window.document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toContain(
				"Required",
			);

			const otherChoice = container.querySelectorAll('input[type="radio"]')[2]! as InstanceType<
				typeof window.HTMLElement
			>;
			await act(async () => {
				otherChoice.focus();
				otherChoice.checked = true;
				otherChoice.click();
			});
			const other = container.querySelector('input[aria-label$=": Other"]')! as InstanceType<
				typeof window.HTMLElement
			>;
			Object.assign(other, { attachEvent: () => {}, detachEvent: () => {} });
			expect(window.document.activeElement).toBe(otherChoice);
			await submit();
			expect(window.document.activeElement).toBe(other);
			expect(other.getAttribute("aria-invalid")).toBe("true");
			const errorId = other.getAttribute("aria-describedby");
			expect(errorId).toBe("ask-field-0-error");
			expect(window.document.getElementById(errorId!)?.textContent).toContain("Required");
			await submit();
			expect(window.document.activeElement).toBe(other);
			expect(other.getAttribute("aria-describedby")).toBe(errorId);

			await render(
				"unfocusable",
				'<form><fieldset><legend>Pick a value</legend><select name="pick" required><option value="x" disabled>X</option></select></fieldset></form>',
			);
			await submit();
			expect(container.querySelector(".sh-form-error")?.textContent).toContain("Required");
			const invalidGroup = container.querySelector("fieldset")!;
			expect(window.document.getElementById(invalidGroup.getAttribute("aria-labelledby")!)?.textContent).toContain(
				"Pick a value",
			);
			expect(window.document.getElementById(invalidGroup.getAttribute("aria-describedby")!)?.textContent).toContain(
				"Required",
			);
		} finally {
			if (originalScroll) Object.defineProperty(prototype, "scrollIntoView", originalScroll);
			else Reflect.deleteProperty(prototype, "scrollIntoView");
		}
	});

	it("submits typed defaults and blocks invalid fields", async () => {
		const window = parseHTML('<html><body><div id="root"></div></body></html>');
		const globals: Record<string, unknown> = {
			window,
			document: window.document,
			navigator: window.navigator,
			Node: window.Node,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			HTMLIFrameElement: window.HTMLIFrameElement,
			SVGElement: window.SVGElement,
			Event: window.Event,
			IS_REACT_ACT_ENVIRONMENT: true,
		};
		for (const [name, value] of Object.entries(globals)) {
			saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
		}
		const container = window.document.getElementById("root")!;
		root = createRoot(container as unknown as Element);
		const answers: unknown[] = [];
		await act(async () =>
			root!.render(
				<AskForm
					html={
						'<form><input type="hidden" name="token" value="x"><label>Count<input type="number" name="count" value="4" min="2"></label><label><input type="checkbox" name="pick" value="a" checked>A</label><label><input type="checkbox" name="pick" value="b">B</label><input name="count" value="second"><input value="unnamed"></form>'
					}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers).toEqual([{ fields: ["4", { checked: [0] }, "second", "unnamed"] }]);
		await act(async () =>
			root!.render(
				<AskForm
					key="radio"
					html={
						'<form><label><input type="radio" name="target" value="first" checked>First</label><label><input type="radio" name="target" value="last" checked>Last</label><label><input type="radio" name="target" value="disabled" checked disabled>Disabled</label></form>'
					}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		const radios = (container as unknown as HTMLElement).querySelectorAll<HTMLInputElement>('input[type="radio"]');
		expect(radios[0]!.checked).toBe(false);
		expect(radios[1]!.checked).toBe(false);
		expect(radios[2]!.checked).toBe(true);
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers[1]).toEqual({ fields: [{ checked: [] }] });
		await act(async () =>
			root!.render(
				<AskForm
					key="invalid"
					html={
						'<form><label>Count<input name="count" type="number" min="2" value="1"></label><label>Name<input name="name" required></label></form>'
					}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		Object.assign(container.querySelector("#ask-field-0")!, { attachEvent: () => {}, detachEvent: () => {} });
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers).toHaveLength(2);
		expect(container.textContent).toContain("Must be at least 2");
		expect(container.textContent).toContain("Required");
		await act(async () =>
			root!.render(
				<AskForm
					key="duplicate"
					html={
						'<form><input name="draft" value="keep me"><label><input type="checkbox" name="pick" value="same" checked>A</label><label><input type="checkbox" name="pick" value="same" checked>B</label></form>'
					}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers[2]).toEqual({ fields: ["keep me", { checked: [0, 1] }] });
		await act(async () =>
			root!.render(
				<AskForm
					key="duplicate"
					html={
						'<form><input name="draft" value="keep me"><label><input type="checkbox" name="pick" value="same" checked>A</label><label><input type="checkbox" name="pick" value="same" checked>B</label></form>'
					}
					rejected
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		expect(container.textContent).toContain("Please review your answers and submit again");
		expect((container as unknown as HTMLElement).querySelector<HTMLInputElement>("#ask-field-0")!.value).toBe(
			"keep me",
		);
		await act(async () =>
			root!.render(
				<AskForm
					key="range"
					html={
						'<form><input type="range" name="range" min="1" max="5"><input name="required" required value="ok"><input type="date" name="date" value="invalid-date"><input type="time" name="time" value="invalid-time"></form>'
					}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		const range = (container as unknown as HTMLElement).querySelector<HTMLInputElement>("#ask-field-0")!;
		expect(range.type).toBe("text");
		expect(range.value).toBe("");
		expect(
			(container as unknown as HTMLElement)
				.querySelector<HTMLInputElement>("#ask-field-1")!
				.getAttribute("aria-required"),
		).toBe("true");
		const date = (container as unknown as HTMLElement).querySelector<HTMLInputElement>("#ask-field-2")!;
		const time = (container as unknown as HTMLElement).querySelector<HTMLInputElement>("#ask-field-3")!;
		expect([date.type, date.value, time.type, time.value]).toEqual(["text", "invalid-date", "text", "invalid-time"]);
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers[3]).toEqual({ fields: ["", "ok", "invalid-date", "invalid-time"] });
		await act(async () =>
			root!.render(
				<AskForm
					key="large"
					html={`<form><textarea name="answer">${"x".repeat(1_048_576)}</textarea></form>`}
					onSubmit={value => answers.push(value)}
				/>,
			),
		);
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers).toHaveLength(4);
		expect(container.textContent).toContain("Answer is too large to send");
		const media =
			'<form><input name="before" value="one"><canvas aria-label="drawing"><input name="nested" value="two"></canvas><input name="after" value="three"></form>';
		expect(parseHtmlForm(media).fields.map(field => field.name)).toEqual(["before", "nested", "after"]);
		await act(async () => root!.render(<AskForm key="media" html={media} onSubmit={value => answers.push(value)} />));
		expect(container.textContent).toContain("Media not supported: drawing");
		expect(container.querySelector("canvas")).toBeNull();
		await act(async () =>
			container
				.querySelector("form")!
				.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
		);
		expect(answers[4]).toEqual({ fields: ["one", "two", "three"] });
	});
});
