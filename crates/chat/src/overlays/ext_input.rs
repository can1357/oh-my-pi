//! Extension text prompts (`omp.ui.input` / `omp.ui.editor` requests): one
//! titled
//! field the user fills and submits. The reply travels the `ask` path
//! (`PanelEvent::Ask` → `HostCommand::AskAnswer`), so the application pairs
//! it with the waiting extension request by the dialog id exactly like a
//! tool's `ask` dialog.

use std::time::Duration;

use omp_core::Str;
use omp_tools::ask::Selection;
use omp_tui::{
	Frame, Key, Prop, Size, Ui, UiContext, UiEvent,
	components::{EditInput, EditorPane},
	dom,
};

use super::{Panel, PanelAnchor, PanelEvent};

/// Answer id carried back for the single field.
pub const FIELD: &str = "value";
const INPUT_ID: &str = "ext-input";
const EDITOR_ID: &str = "ext-editor";
const EDITOR_PANE_ID: &str = "ext-editor-pane";
const INPUT_HINT: &str = "Enter submit · Esc cancel";
const EDITOR_HINT: &str = "Enter newline · Ctrl+Enter submit · Esc cancel";
/// Editor rows before the pane scrolls.
const EDITOR_ROWS: u16 = 8;

/// What the dialog asks for.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputSpec {
	/// Dialog title.
	pub title:       Str,
	/// Placeholder shown while the field is empty.
	pub placeholder: Str,
	/// Initial text.
	pub prefill:     Str,
	/// Obscure typed characters (secrets).
	pub mask:        bool,
	/// Multi-line editor instead of a one-line field.
	pub multiline:   bool,
}

/// Retained extension text prompt.
pub struct InputDialog {
	id:    Str,
	spec:  InputSpec,
	ui:    Ui,
	ctx:   UiContext,
	width: u16,
	text:  Str,
}

impl InputDialog {
	/// Opens the dialog answering extension request `id`.
	#[must_use]
	pub fn open(id: Str, spec: InputSpec, viewport: Size, ctx: &UiContext) -> Self {
		let mut dialog = Self {
			id,
			text: spec.prefill.clone(),
			spec,
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			width: viewport.width,
		};
		dialog.rebuild();
		dialog
	}

	/// The dialog's request id, for tests and the debug `values` op.
	#[must_use]
	pub fn request_id(&self) -> &str {
		&self.id
	}

	fn rebuild(&mut self) {
		let title = self.spec.title.clone();
		let hint = if self.spec.multiline {
			EDITOR_HINT
		} else {
			INPUT_HINT
		};
		let placeholder = self.spec.placeholder.clone();
		let value = self.text.clone();
		let mask = self.spec.mask;
		let field = if self.spec.multiline {
			let editor = EditorPane::new().with(Prop::Id, EDITOR_PANE_ID).input(
				EditInput::new()
					.with(Prop::Id, EDITOR_ID)
					.with(Prop::Value, value)
					.with(Prop::Rail, true)
					.with(Prop::Placeholder, placeholder)
					.with(Prop::MaxRows, EDITOR_ROWS),
			);
			dom! { <col>{editor}</col> }
		} else {
			dom! {
				<col>
					<input id={INPUT_ID} value={value} placeholder={placeholder} mask={mask} submit/>
				</col>
			}
		};
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					{field}
					<hr border=round/>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	fn current_text(&self) -> Str {
		let id = if self.spec.multiline {
			EDITOR_ID
		} else {
			INPUT_ID
		};
		self
			.ui
			.values()
			.get(id)
			.and_then(serde_json::Value::as_str)
			.map_or_else(|| self.text.clone(), Str::new)
	}

	fn submit(&mut self) -> PanelEvent {
		let text = self.current_text();
		PanelEvent::Ask {
			id:      self.id.clone(),
			answers: Some(vec![Selection {
				id:           Str::new_static(FIELD),
				selected:     Vec::new(),
				custom_input: Some(text),
				note:         None,
				timed_out:    false,
			}]),
		}
	}

	fn cancel(&self) -> PanelEvent {
		PanelEvent::Ask { id: self.id.clone(), answers: None }
	}
}

impl Panel for InputDialog {
	fn id(&self) -> &'static str {
		super::ask::ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => return self.cancel(),
			Key::FollowUp if self.spec.multiline => return self.submit(),
			_ => {},
		}
		match self.ui.handle_key(key) {
			UiEvent::Submit => self.submit(),
			UiEvent::Cancel => self.cancel(),
			UiEvent::Changed { value, .. } => {
				self.text = value;
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if let UiEvent::Changed { value, .. } = self.ui.handle_paste(text) {
			self.text = value;
		}
		PanelEvent::Consumed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.width = viewport.width;
			self.text = self.current_text();
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, _now: Duration) -> bool {
		false
	}
}

#[cfg(test)]
mod tests {
	use omp_tui::frame_text;

	use super::*;

	fn spec(multiline: bool, mask: bool) -> InputSpec {
		InputSpec {
			title: Str::new_static("API key"),
			placeholder: Str::new_static("sk-…"),
			prefill: Str::default(),
			mask,
			multiline,
		}
	}

	fn dialog(spec: InputSpec) -> InputDialog {
		InputDialog::open(
			Str::new_static("ext:1"),
			spec,
			Size { width: 60, height: 20 },
			&UiContext::default(),
		)
	}

	#[test]
	fn typed_text_submits_as_the_custom_answer_for_the_request_id() {
		let mut dialog = dialog(spec(false, false));
		for ch in "hunter2".chars() {
			assert_eq!(dialog.key(Key::Char(ch)), PanelEvent::Consumed);
		}
		let event = dialog.key(Key::Enter);
		let PanelEvent::Ask { id, answers: Some(answers) } = event else {
			panic!("submit answers the request: {event:?}");
		};
		assert_eq!(id.as_str(), "ext:1");
		assert_eq!(answers.len(), 1);
		assert_eq!(answers[0].id.as_str(), FIELD);
		assert_eq!(answers[0].custom_input.as_deref(), Some("hunter2"));
	}

	#[test]
	fn escape_dismisses_without_an_answer() {
		let mut dialog = dialog(spec(false, false));
		assert_eq!(dialog.key(Key::Esc), PanelEvent::Ask {
			id:      Str::new_static("ext:1"),
			answers: None,
		});
	}

	#[test]
	fn masked_input_never_paints_the_secret() {
		let mut dialog = dialog(spec(false, true));
		for ch in "hunter2".chars() {
			dialog.key(Key::Char(ch));
		}
		let text = frame_text(dialog.frame(Size { width: 60, height: 20 }));
		assert!(!text.contains("hunter2"), "secret leaked into the frame:\n{text}");
		assert!(text.contains("•••••••"), "mask glyphs shown:\n{text}");
	}

	#[test]
	fn multiline_editor_submits_on_the_followup_chord() {
		let mut dialog = dialog(spec(true, false));
		for ch in "line one".chars() {
			dialog.key(Key::Char(ch));
		}
		dialog.key(Key::Enter);
		for ch in "line two".chars() {
			dialog.key(Key::Char(ch));
		}
		let event = dialog.key(Key::FollowUp);
		let PanelEvent::Ask { answers: Some(answers), .. } = event else {
			panic!("ctrl+enter submits: {event:?}");
		};
		assert_eq!(answers[0].custom_input.as_deref(), Some("line one\nline two"));
	}
}
