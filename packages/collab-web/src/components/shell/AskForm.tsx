import { ENVELOPE_HEADER_LENGTH, type CollabFormField, type CollabFormResponse } from "@oh-my-pi/pi-wire";
import {
	choiceValue,
	fieldError,
	fieldQuestions,
	OTHER_LABEL,
	textValue,
} from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import {
	type ChoiceField,
	type FormBlock,
	type FormField,
	type FormSpan,
	parseHtmlForm,
	spansText,
} from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { type FormEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";

const RELAY_FRAME_LIMIT_BYTES = 1_048_576;
const SEALED_FRAME_OVERHEAD_BYTES = ENVELOPE_HEADER_LENGTH + 12 + 16;

type FieldState = { text: string; checked: Set<number>; otherSelected: boolean; other: string };

function Spans({ spans }: { spans: FormSpan[] }): ReactNode {
	return spans.map((span, index) => {
		if (span.style === "strong") return <strong key={index}>{span.text}</strong>;
		if (span.style === "em") return <em key={index}>{span.text}</em>;
		if (span.style === "code") return <code key={index}>{span.text}</code>;
		return <span key={index}>{span.text}</span>;
	});
}

function FormImage({ src, alt }: { src: string; alt: string }): ReactNode {
	const [failed, setFailed] = useState(false);
	const safe = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src);
	if (!safe || failed) return <p className="sh-form-media">Media not supported{alt ? `: ${alt}` : ""}</p>;
	return (
		<img className="sh-form-image" src={src} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
	);
}

function OtherInput({
	label,
	errorId,
	value,
	onChange,
}: {
	label: string;
	errorId?: string;
	value: string;
	onChange(value: string): void;
}): ReactNode {
	const ref = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		const input = ref.current;
		if (!input) return;
		const reveal = () => {
			if (document.activeElement === input) input.scrollIntoView({ block: "nearest", inline: "nearest" });
		};
		input.scrollIntoView({ block: "nearest", inline: "nearest" });
		window.addEventListener("resize", reveal);
		window.visualViewport?.addEventListener("resize", reveal);
		return () => {
			window.removeEventListener("resize", reveal);
			window.visualViewport?.removeEventListener("resize", reveal);
		};
	}, []);
	return (
		<input
			ref={ref}
			aria-label={label}
			aria-invalid={!!errorId}
			aria-describedby={errorId}
			value={value}
			onChange={e => onChange(e.target.value)}
		/>
	);
}

export function choiceSubmissionError(field: ChoiceField, other?: string): string | undefined {
	const value = other?.trim();
	if (
		value &&
		!field.options.some(option => !option.disabled && option.value === value) &&
		field.options.some(option => option.disabled && option.value === value)
	) {
		return "Other must not match a disabled option";
	}
	return undefined;
}

export function AskForm({
	html,
	reqId = Number.MAX_SAFE_INTEGER,
	onSubmit,
	pending = false,
	rejected = false,
}: {
	html: string;
	reqId?: number;
	onSubmit: (data: CollabFormResponse) => void;
	pending?: boolean;
	rejected?: boolean;
}): ReactNode {
	const [{ form, questions }] = useState(() => {
		const original = parseHtmlForm(html);
		const display = parseHtmlForm(html, { mediaNotices: true });
		const originalQuestions = fieldQuestions(original);
		if (display.fields.length !== original.fields.length) throw new Error("Form field order differs");
		const questions = new Map(
			display.fields.map((field, index) => {
				const source = original.fields[index]!;
				const question = originalQuestions.get(source);
				if (field.kind !== source.kind || field.name !== source.name || question === undefined)
					throw new Error("Form field order differs");
				return [field, question] as const;
			}),
		);
		return { form: display, questions };
	});
	const [states, setStates] = useState<FieldState[]>(() =>
		form.fields.map(field => {
			const checked = new Set<number>();
			if (field.kind === "choice") {
				field.options.forEach((option, index) => {
					if (!option.checked) return;
					if (!field.multi) checked.clear();
					checked.add(index);
				});
			}
			return {
				text: field.kind === "text" ? field.value : "",
				checked,
				otherSelected: false,
				other: "",
			};
		}),
	);
	const [errors, setErrors] = useState<Record<number, string>>({});
	const [sizeError, setSizeError] = useState(false);
	const fieldRefs = useRef<(HTMLDivElement | null)[]>([]);
	const invalidToReveal = useRef<number | null>(null);
	const revealedField = useRef<{ heading: HTMLElement | null; wrapper: HTMLElement; target: HTMLElement } | null>(
		null,
	);
	useLayoutEffect(() => {
		const reveal = () => {
			const field = revealedField.current;
			if (!field || document.activeElement !== field.target) return;
			field.heading?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			field.wrapper.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			field.target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		};
		window.addEventListener("resize", reveal);
		window.visualViewport?.addEventListener("resize", reveal);
		return () => {
			window.removeEventListener("resize", reveal);
			window.visualViewport?.removeEventListener("resize", reveal);
		};
	}, []);
	useLayoutEffect(() => {
		const index = invalidToReveal.current;
		invalidToReveal.current = null;
		if (index === null) return;
		const wrapper = fieldRefs.current[index];
		if (!wrapper) return;
		const headingId = wrapper.querySelector("fieldset")?.getAttribute("aria-labelledby");
		const heading = headingId ? document.getElementById(headingId) : null;
		const field = form.fields[index]!;
		const target =
			field.kind === "text"
				? wrapper.querySelector<HTMLElement>("input, textarea")
				: ((states[index]!.otherSelected ? wrapper.querySelector<HTMLElement>(".sh-form-other > input") : null) ??
					wrapper.querySelector<HTMLElement>("input:not([disabled])"));
		if (target) {
			revealedField.current = { heading, wrapper, target };
			target.focus({ preventScroll: true });
			heading?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			wrapper.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		} else {
			revealedField.current = null;
			heading?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			wrapper.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			wrapper
				.querySelector<HTMLElement>(".sh-form-error")
				?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
		}
	}, [errors, form, states]);
	const update = (index: number, patch: Partial<FieldState>) => {
		setSizeError(false);
		setStates(current => current.map((state, i) => (i === index ? { ...state, ...patch } : state)));
		setErrors(current => {
			const next = { ...current };
			delete next[index];
			return next;
		});
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (pending) return;
		const fields: CollabFormField[] = [];
		const next: Record<number, string> = {};
		form.fields.forEach((field, index) => {
			const state = states[index]!;
			const value =
				field.kind === "text"
					? textValue(field, state.text)
					: choiceValue(field, state.checked, state.otherSelected ? state.other : undefined);
			fields.push(
				field.kind === "text"
					? state.text
					: {
							checked: [...state.checked].filter(option => !field.options[option]?.disabled),
							...(state.otherSelected ? { other: state.other } : {}),
						},
			);
			const error =
				fieldError(field, value) ??
				(field.kind === "choice" && state.otherSelected ? choiceSubmissionError(field, state.other) : undefined);
			if (error) next[index] = error;
		});
		const firstInvalid = form.fields.findIndex((_, index) => next[index] !== undefined);
		invalidToReveal.current = firstInvalid === -1 ? null : firstInvalid;
		setErrors(next);
		const data: CollabFormResponse = { fields };
		if (Object.keys(next).length === 0) {
			const frame = JSON.stringify({ t: "ui-response", reqId, value: data });
			if (new TextEncoder().encode(frame).byteLength + SEALED_FRAME_OVERHEAD_BYTES > RELAY_FRAME_LIMIT_BYTES) {
				setSizeError(true);
				return;
			}
			onSubmit(data);
		}
	};
	const renderChoice = (field: ChoiceField, state: FieldState, index: number) => {
		const select = (optionIndex: number, checked: boolean) => {
			const next = field.multi ? new Set(state.checked) : new Set<number>();
			if (checked) next.add(optionIndex);
			else next.delete(optionIndex);
			update(index, { checked: next, ...(!field.multi && checked ? { otherSelected: false } : {}) });
		};
		return (
			<div className="sh-form-choices">
				{field.options.map((option, optionIndex) => (
					<label key={optionIndex} className="sh-form-choice">
						<input
							type={field.multi ? "checkbox" : "radio"}
							name={`ask-choice-${index}`}
							aria-required={field.required || undefined}
							checked={state.checked.has(optionIndex)}
							disabled={option.disabled}
							onChange={e => select(optionIndex, e.target.checked)}
						/>
						<Spans spans={option.label} />
					</label>
				))}
				{field.other && (
					<div className="sh-form-other">
						<label className="sh-form-choice">
							<input
								type={field.multi ? "checkbox" : "radio"}
								name={`ask-choice-${index}`}
								aria-required={field.required || undefined}
								checked={state.otherSelected}
								onChange={e =>
									update(index, {
										otherSelected: e.target.checked,
										...(!field.multi && e.target.checked ? { checked: new Set<number>() } : {}),
									})
								}
							/>
							{OTHER_LABEL}
						</label>
						{state.otherSelected && (
							<OtherInput
								label={`${questions.get(field) ?? field.name}: ${OTHER_LABEL}`}
								errorId={errors[index] ? `ask-field-${index}-error` : undefined}
								value={state.other}
								onChange={other => update(index, { other })}
							/>
						)}
					</div>
				)}
			</div>
		);
	};
	const renderField = (field: FormField, blockIndex: number, headingId?: string) => {
		const index = form.fields.indexOf(field);
		const state = states[index]!;
		const label = spansText(field.label) || questions.get(field) || field.name || "Answer";
		const id = `ask-field-${index}`;
		return (
			<div
				className="sh-form-field"
				key={blockIndex}
				ref={element => {
					fieldRefs.current[index] = element;
				}}
			>
				{field.kind === "choice" ? (
					<fieldset aria-labelledby={headingId} aria-describedby={errors[index] ? `${id}-error` : undefined}>
						{!headingId && (
							<legend>
								{label}
								{field.required ? " *" : ""}
							</legend>
						)}
						{renderChoice(field, state, index)}
					</fieldset>
				) : (
					<>
						<label htmlFor={id}>
							<Spans spans={field.label} />
							{!field.label.length && label}
							{field.required ? " *" : ""}
						</label>
						{field.multiline ? (
							<textarea
								id={id}
								value={state.text}
								placeholder={field.placeholder}
								rows={field.rows}
								aria-required={field.required || undefined}
								aria-invalid={!!errors[index]}
								aria-describedby={errors[index] ? `${id}-error` : undefined}
								onChange={e => update(index, { text: e.target.value })}
							/>
						) : (
							<input
								id={id}
								type={["text", "password", "email", "url", "tel"].includes(field.type) ? field.type : "text"}
								value={state.text}
								inputMode={field.type === "range" || field.type === "number" ? "decimal" : undefined}
								placeholder={field.placeholder}
								min={field.min}
								max={field.max}
								minLength={field.minLength}
								maxLength={field.maxLength}
								aria-required={field.required || undefined}
								aria-invalid={!!errors[index]}
								aria-describedby={errors[index] ? `${id}-error` : undefined}
								onChange={e => update(index, { text: e.target.value })}
							/>
						)}
					</>
				)}
				{errors[index] && (
					<div id={`${id}-error`} className="sh-form-error" role="alert">
						{errors[index]}
					</div>
				)}
			</div>
		);
	};
	const renderBlock = (block: FormBlock, index: number, headingId?: string): ReactNode => {
		switch (block.kind) {
			case "field":
				return renderField(block.field, index, headingId);
			case "text":
				return block.heading ? (
					<h3 key={index}>
						<Spans spans={block.spans} />
					</h3>
				) : (
					<p key={index}>
						<Spans spans={block.spans} />
					</p>
				);
			case "pre":
				return <pre key={index}>{block.text}</pre>;
			case "list": {
				const items = block.items.map((item, i) => (
					<li key={i}>
						<Spans spans={item} />
					</li>
				));
				return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
			}
			case "table":
				return (
					<div className="sh-form-table" key={index}>
						<table>
							<tbody>
								{block.rows.map((row, i) => (
									<tr key={i}>
										{row.map((cell, j) =>
											i < block.headerRows ? (
												<th key={j}>
													<Spans spans={cell} />
												</th>
											) : (
												<td key={j}>
													<Spans spans={cell} />
												</td>
											),
										)}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				);
			case "image":
				return <FormImage key={index} src={block.src} alt={block.alt} />;
			case "svg":
				return (
					<p key={index} className="sh-form-media">
						Media not supported{block.alt ? `: ${block.alt}` : ""}
					</p>
				);
		}
	};
	return (
		<form className="sh-form" noValidate onSubmit={submit}>
			<div className="sh-form-content">
				{form.sections.map((section, index) => {
					const first = section.blocks[0];
					const sharedHeading =
						first?.kind === "field" &&
						first.field.kind === "choice" &&
						spansText(section.title).trim() !== "" &&
						(spansText(first.field.label) || questions.get(first.field)) === spansText(section.title);
					const headingId = sharedHeading ? `ask-section-${index}` : undefined;
					return (
						<section key={index} className="sh-form-section">
							{section.title.length > 0 && (
								<h3 id={headingId}>
									<Spans spans={section.title} />
									{sharedHeading && first?.kind === "field" && first.field.required ? " *" : ""}
								</h3>
							)}
							{section.blocks.map((block, blockIndex) =>
								renderBlock(block, blockIndex, blockIndex === 0 ? headingId : undefined),
							)}
						</section>
					);
				})}
			</div>
			{sizeError && (
				<div className="sh-form-error" role="alert">
					Answer is too large to send. Shorten it and try again.
				</div>
			)}
			{rejected && (
				<div className="sh-form-error" role="alert">
					Please review your answers and submit again.
				</div>
			)}
			<div className="sh-composer-actions sh-ask-actions">
				<button type="submit" className="sh-btn" disabled={pending}>
					{pending ? "Submitting…" : "Submit"}
				</button>
			</div>
		</form>
	);
}
