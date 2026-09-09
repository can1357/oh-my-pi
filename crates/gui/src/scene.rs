//! The host contract: a scene produces frames and routes input.

use std::{ops::Range, path::Path, time::Duration};

use omp_core::Str;
use omp_tui::{
	Appearance, Frame, Key, Layer, MouseReport, Size,
	paste::{Clipboard, ClipboardRead, ClipboardReadOutcome, ClipboardWriteOutcome},
};
use smallvec::SmallVec;

/// What one paint of a scene looks like to the host.
///
/// It combines the retained document frame (taller than the viewport when
/// scrollback exists) with declarative viewport-anchored layers, exactly as a
/// terminal renderer would composite.
pub struct SceneFrame<'a> {
	/// The document grid; the tail `viewport.height` rows are live.
	pub frame:       &'a Frame,
	/// Viewport dimensions in cells.
	pub viewport:    Size,
	/// Document-tail rows owned by an editing widget (the composer); the
	/// host routes plain pointer gestures there to the scene instead of
	/// starting host text selection. A fully interactive scene (welcome
	/// card) claims every row.
	pub editor_rows: u16,
	/// Z-ordered layers resolved against the viewport at paint time.
	pub layers:      SmallVec<Layer<'a>, 4>,
}

/// Post-event effect a scene requests from the host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Effect {
	/// Not handled; the host may apply its own fallback.
	Ignored,
	/// Handled; repaint at the next tick.
	Consumed,
	/// The application asked to exit.
	Quit,
	/// Read the system clipboard (images preferred, or text only) and
	/// deliver the typed result to [`Scene::clipboard`].
	Clipboard(ClipboardRead),
	/// Write text to the system clipboard; the host performs the write
	/// detached so a slow CLI fallback never blocks the event loop.
	SetClipboard(Str),
}

/// One host-driven application: retained state, a render pass, input routing.
pub trait Scene {
	/// Updates the cell viewport. `settled` distinguishes the final geometry
	/// of a resize gesture from its intermediate drag steps, letting the
	/// scene trade full relayout for cheap previews mid-gesture.
	fn resize(&mut self, viewport: Size, settled: bool);

	/// Produces the current frame and layers.
	fn render(&mut self) -> SceneFrame<'_>;

	/// Routes one key press.
	fn key(&mut self, key: Key) -> Effect;

	/// Routes one mouse report in viewport cell coordinates.
	fn mouse(&mut self, report: MouseReport) -> Effect;

	/// Routes clipboard text; `raw` inserts verbatim without attachment
	/// staging or drop classification.
	fn paste(&mut self, text: &str, raw: bool) -> Effect;

	/// Shows or replaces native input-method marked text at the editing
	/// caret. `selection` is byte-indexed within `text`; `None` hides the
	/// marked-text caret until the next preedit event.
	fn ime_preedit(&mut self, _text: &str, _selection: Option<Range<usize>>) -> Effect {
		Effect::Ignored
	}

	/// Commits one native input-method segment. The default preserves the
	/// former character-key path for generic scenes; editors override this
	/// to make the whole segment one undo unit.
	fn ime_commit(&mut self, text: &str) -> Effect {
		let mut result = Effect::Ignored;
		for character in text.chars() {
			match self.key(Key::Char(character)) {
				Effect::Quit => return Effect::Quit,
				Effect::Ignored => {},
				effect => result = effect,
			}
		}
		result
	}

	/// Notifies the scene when its native window gains or loses focus.
	fn focus(&mut self, _focused: bool) -> Effect {
		Effect::Ignored
	}

	/// Applies the native window's current light/dark appearance.
	fn appearance(&mut self, _appearance: Appearance) -> Effect {
		Effect::Ignored
	}

	/// Routes files dropped from the desktop through the same typed path as
	/// file-manager clipboard payloads. The borrowed path list is
	/// materialized once at this host boundary.
	fn drop_files(&mut self, paths: &[&Path]) -> Effect {
		let paths = paths
			.iter()
			.map(|path| Str::new(path.to_string_lossy()))
			.collect();
		self.clipboard(ClipboardReadOutcome::Payload(Clipboard::Paths(paths)), false)
	}

	/// Routes one typed system-clipboard result.
	///
	/// Chat scenes override this to surface non-payload outcomes as notices.
	/// The default preserves the generic scene host's image/file flattening.
	fn clipboard(&mut self, outcome: ClipboardReadOutcome, raw: bool) -> Effect {
		let text = match outcome {
			ClipboardReadOutcome::Payload(Clipboard::Text(text)) => text,
			ClipboardReadOutcome::Payload(Clipboard::Image(image)) => {
				let Ok(path) = image.persist() else {
					return Effect::Ignored;
				};
				path.display().to_string()
			},
			ClipboardReadOutcome::Payload(Clipboard::Paths(paths)) => {
				let mut joined = String::new();
				for path in &paths {
					if !joined.is_empty() {
						joined.push(' ');
					}
					joined.push('"');
					joined.push_str(path);
					joined.push('"');
				}
				joined
			},
			ClipboardReadOutcome::Empty
			| ClipboardReadOutcome::PermissionDenied
			| ClipboardReadOutcome::UnsupportedFormat
			| ClipboardReadOutcome::ReadFailure => return Effect::Ignored,
		};
		self.paste(&text, raw)
	}

	/// Routes one typed system-clipboard write result.
	///
	/// Chat scenes override this to surface success, permission, availability,
	/// and backend-failure notices. Other actors may deliberately ignore it.
	fn clipboard_write(&mut self, _outcome: ClipboardWriteOutcome) -> Effect {
		Effect::Ignored
	}

	/// Pumps host-external state before the next paint.
	///
	/// Channel-driven scenes use this to request repaint, clipboard, or exit
	/// effects without waiting for a user input event.
	fn poll(&mut self) -> Effect {
		Effect::Ignored
	}

	/// Repaint cadence while the scene animates.
	fn tick(&self) -> Duration;
}
