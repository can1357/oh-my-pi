/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `forms/form-field`, `forms/text-field`, `forms/select-field`, `forms/form`
 * corpus: the reusable form controls driven by keys and host calls.
 */
import {
	type FieldFrame,
	Form,
	FormModel,
	SelectField,
	SelectFieldModel,
	TextField,
	TextFieldModel,
} from "../../../src/ui/forms";
import { corpusSuite, type Driver, type Mounted } from "../setup/harness";

const ITEMS = (n: number) =>
	Array.from({ length: n }, (_, i) => ({
		value: `v${i}`,
		label: i === 2 ? "日本語のラベル" : `Option ${i}`,
		description: i % 2 ? `desc ${i} with a longer tail to wrap or truncate` : undefined,
	}));

/** Clicks address rows of the screen painted at width 40 (the old `routeMouse` coordinates). */
const click = (row: number) => (driver: Driver) => driver.mouse(row, 2, { button: "left", action: "press" }, 40);

corpusSuite({
	dir: "forms/form-field",
	mount(caseName) {
		const field = new TextFieldModel();
		let frame: FieldFrame = {};
		const steps: Record<string, (driver: Driver) => void> = {};
		if (caseName === "all-slots-focused") {
			field.setValue("hello");
			field.setFocused(true);
			frame = {
				label: "Name",
				description: "Your full name, as it appears on the passport",
				details: [
					{ spans: [{ s: "accent", t: "detail one" }], wrap: true },
					{ spans: [{ t: "detail two   with tab" }], wrap: true },
				],
				previewLabel: "Preview:",
				preview: { spans: [{ t: "preview body" }], wrap: true },
				hint: "Enter to confirm · Esc to cancel",
				summary: [{ spans: [{ t: "summary row" }], wrap: true }],
				footer: { spans: [{ t: "footer text" }], wrap: true, pad: 1 },
				leadingSpace: true,
			};
			steps["error multi-line with tab"] = () => field.setError("Bad value:\nline two\twith tab");
			steps["long error (300 x)"] = () => field.setError("x".repeat(300));
			steps["error cleared"] = () => field.setError(undefined);
			steps.unfocused = () => field.setFocused(false);
			steps["paste 'pasted'"] = driver => driver.paste("pasted");
			steps["ignore tight layout"] = () => {};
		} else if (caseName === "minimal") {
			frame = { spaceBeforeControl: false, spaceAfterControl: false };
			steps["error 'oops'"] = () => field.setError("oops");
		} else if (caseName === "description-only") {
			frame = { description: "only description", previewLabel: "ignored without preview", hint: "", label: "" };
		} else if (caseName === "preview-without-preview-label") {
			frame = { label: "Label", preview: { spans: [{ t: "p" }], wrap: true } };
		}
		return { view: () => <TextField {...frame} model={field} />, steps };
	},
});

corpusSuite({
	dir: "forms/text-field",
	mount(caseName) {
		const events: string[] = [];
		if (caseName === "validated-token") {
			const field = new TextFieldModel({
				empty: "reject",
				validate: v => (v.startsWith("bad") ? `invalid: ${v}` : undefined),
				onSubmit: v => void events.push(`submit ${JSON.stringify(v)}`),
				onCancel: () => void events.push("cancel"),
				focused: true,
			});
			return {
				view: () => <TextField label="Token" prompt="Key: " promptStyle="dim" hint="type" model={field} />,
				events: () => events.splice(0),
				steps: {
					"setValue 'bad again'": () => field.setValue("bad again"),
					"submit()": () => field.submit(),
					"setValue ''": () => field.setValue(""),
					"click row 3": click(3),
				},
			};
		}
		const field = new TextFieldModel({
			secret: true,
			initialValue: "s3cr3t",
			onSubmit: () => {
				events.push("submit (throws)");
				throw new Error("submit failed\nbadly");
			},
			onCancel: () => void events.push("cancel"),
			focused: true,
		});
		return { view: () => <TextField model={field} />, events: () => events.splice(0) };
	},
});

corpusSuite({
	dir: "forms/select-field",
	mount(caseName): Mounted {
		const events: string[] = [];
		if (caseName === "with-preview") {
			let previewState = 0;
			const field = new SelectFieldModel({
				items: ITEMS(6),
				currentValue: "v2",
				maxVisible: 4,
				onSelectionChange: v => {
					previewState++;
					events.push(`selectionChange ${v}`);
				},
				onSubmit: v => {
					events.push(`submit ${v}`);
					if (v === "v4") throw new Error("cannot pick v4");
				},
				onCancel: () => void events.push("cancel"),
			});
			return {
				view: () => (
					<SelectField
						label="Pick one"
						description="choose wisely"
						previewLabel="Preview:"
						preview={() => (field.selected(), { spans: [{ t: `preview #${previewState}` }] })}
						model={field}
					/>
				),
				events: () => events.splice(0),
				steps: {
					"native select v1": driver => void driver.emit({ type: "select", key: "list", item: "v1" }),
					"click row 6": click(6),
				},
			};
		}
		const field = new SelectFieldModel({
			items: ITEMS(20),
			onSubmit: v => void events.push(`submit ${v}`),
			onCancel: () => void events.push("cancel"),
		});
		return {
			view: () => <SelectField label="Many" model={field} />,
			events: () => events.splice(0),
			steps: { "native select v3": driver => void driver.emit({ type: "select", key: "", item: "v3" }) },
		};
	},
});

corpusSuite({
	dir: "forms/form",
	mount(caseName) {
		const events: string[] = [];
		if (caseName === "empty") {
			const model = new FormModel({ fields: [], onCancel: () => {} });
			return { view: () => <Form model={model} fields={[]} /> };
		}
		const first = new TextFieldModel({
			onSubmit: v => void events.push(`submit First ${JSON.stringify(v)}`),
			onCancel: () => void events.push("cancel First"),
		});
		const second = new TextFieldModel({
			onSubmit: v => void events.push(`submit Second ${JSON.stringify(v)}`),
			onCancel: () => void events.push("cancel Second"),
		});
		const model = new FormModel({
			fields: [first, second],
			onCancel: () => void events.push("cancel form"),
			focused: true,
		});
		return {
			view: () => <Form model={model} fields={[{ label: "First" }, { label: "Second", description: "desc" }]} />,
			events: () => events.splice(0),
			steps: {
				unfocused: () => model.setFocused(false),
				focused: () => model.setFocused(true),
				"paste 'pp'": driver => driver.paste("pp"),
				"click second field (row 8)": click(8),
				"click first field (row 2)": click(2),
			},
		};
	},
});
