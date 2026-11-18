//! Selecting text in an element's value through its `Text` interface.
//!
//! Selects text or places a caret without requesting focus or sending keys.
//! A nonempty native selection may replace PRIMARY (middle-click paste);
//! PRIMARY contents and ownership are not preserved. Read-back must confirm
//! unchanged text and focus. Subsequent typing and insertion retain their
//! editability, focus and toolkit restrictions.
//! Public offsets count UTF-16 code units; GTK's native offsets count Unicode
//! scalars, while Qt's already count UTF-16.

use atspi::proxy::text::TextProxy;

use super::*;
use crate::desktop::{
	ax::masked,
	control,
	text_range::{TextSelectRequest, Utf16Range, utf16_byte_range, utf16_slice},
	types::AxTextSelection,
};

/// How long a written selection has to show up in the read-back: a toolkit may
/// apply the write a moment after answering it.
const SELECTION_SETTLE_WAIT: Duration = Duration::from_millis(500);
/// How often the selection is read while it settles.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

fn failure(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("AT-SPI text selection: {error}"))
}

/// The units a toolkit counts its text offsets in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Units {
	/// GTK: one offset per Unicode scalar.
	Scalar,
	/// Qt: one offset per UTF-16 code unit.
	Utf16,
}

impl Units {
	/// The length of `value` in these units.
	fn len(self, value: &str) -> usize {
		match self {
			Self::Scalar => value.chars().count(),
			Self::Utf16 => value.encode_utf16().count(),
		}
	}

	/// `offset` in these units, in UTF-16 code units; `None` when it is past
	/// the end of `value` or inside a character.
	fn utf16(self, value: &str, offset: i32) -> Option<usize> {
		let offset = usize::try_from(offset).ok()?;
		match self {
			Self::Scalar => (offset <= value.chars().count())
				.then(|| value.chars().take(offset).map(char::len_utf16).sum()),
			Self::Utf16 => byte_offset(value, offset).map(|_| offset),
		}
	}

	/// `offset` UTF-16 code units into `value`, in these units; `None` when it
	/// is past the end or splits a surrogate pair.
	fn native(self, value: &str, offset: usize) -> Option<usize> {
		let byte = byte_offset(value, offset)?;
		Some(match self {
			Self::Scalar => value[..byte].chars().count(),
			Self::Utf16 => offset,
		})
	}
}

/// The UTF-8 byte offset of UTF-16 `offset` in `value`, when it starts a
/// character.
fn byte_offset(value: &str, offset: usize) -> Option<usize> {
	utf16_byte_range(value, Utf16Range { start: offset, length: 0 }).map(|bytes| bytes.start)
}

/// A range of the element's text in the units its toolkit counts, as its
/// `Text` interface takes its offsets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeRange {
	start: i32,
	end:   i32,
}

/// What the element's `Text` interface shows as selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shown {
	/// No selection: a caret at the offset.
	Caret(i32),
	/// One selection, from `start` to `end`.
	Selection(NativeRange),
}

impl Shown {
	/// The range this shows, in the toolkit's units; a caret is one of zero
	/// length.
	const fn range(self) -> NativeRange {
		match self {
			Self::Caret(offset) => NativeRange { start: offset, end: offset },
			Self::Selection(range) => range,
		}
	}

	/// What an error calls this, for a reader comparing it to the request.
	fn describe(self) -> String {
		match self {
			Self::Caret(offset) => format!("caret at {offset}"),
			Self::Selection(range) => format!("selection from {} to {}", range.start, range.end),
		}
	}
}

/// The one write that makes a shown selection `desired`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mutation {
	/// `AddSelection`: start a selection where there is no selection.
	Add(NativeRange),
	/// `SetSelection`: replace the one selection.
	Replace(NativeRange),
	/// `SetCaretOffset`: replace the selection with a caret.
	Caret(i32),
}

impl Mutation {
	/// The write that turns `shown` into `desired`.
	const fn chosen(desired: Shown, shown: Shown) -> Self {
		match desired {
			Shown::Caret(offset) => Self::Caret(offset),
			Shown::Selection(range) => match shown {
				Shown::Caret(_) => Self::Add(range),
				Shown::Selection(_) => Self::Replace(range),
			},
		}
	}

	const fn name(self) -> &'static str {
		match self {
			Self::Add(_) => "AddSelection",
			Self::Replace(_) => "SetSelection",
			Self::Caret(_) => "SetCaretOffset",
		}
	}
}

/// The element's whole text and the character count its app reports for it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
	value: String,
	count: i32,
}

impl Snapshot {
	/// Whether `self` holds the same text and count as `other`.
	fn same(&self, other: &Self) -> bool {
		self.value == other.value && self.count == other.count
	}
}

/// One live read of the element.
struct Readback {
	text:    Snapshot,
	shown:   Shown,
	focused: bool,
}

/// Makes the one selection write `request` names, then reads the selection
/// back and returns it.
///
/// `attempted` is set before that write is awaited, so a caller that sees it
/// set knows a failure may still have changed the element's selection.
pub(super) async fn select(
	connection: &zbus::Connection,
	object: &ObjectRefOwned,
	request: &TextSelectRequest,
	attempted: &mut bool,
) -> CoreResult<AxTextSelection> {
	let name = object
		.name()
		.ok_or_else(|| failure("the object has no bus name"))?
		.clone();
	let accessible = object
		.as_accessible_proxy(connection)
		.await
		.map_err(failure)?;
	let interfaces = accessible.get_interfaces().await.map_err(failure)?;
	if !interfaces.contains(atspi::Interface::Text) {
		return Err(DesktopError::ax_failed(
			"the element has no Text interface, so it holds no text to select; nothing was selected",
		));
	}
	let role = accessible.get_role().await.map_err(failure)?;
	if role == Role::PasswordText {
		return Err(DesktopError::ax_failed(
			"the element is a password field, whose text is never read; nothing was selected",
		));
	}
	let Some((toolkit, _)) = app_toolkit(connection, &accessible).await else {
		return Err(DesktopError::ax_failed(
			"its application does not report its toolkit, so the unit of its text offsets is \
			 unknown; nothing was selected",
		));
	};
	let units = if toolkit.eq_ignore_ascii_case("gtk") {
		Units::Scalar
	} else if toolkit.eq_ignore_ascii_case("qt") {
		Units::Utf16
	} else {
		return Err(DesktopError::ax_failed(format!(
			"toolkit {toolkit:?} counts text offsets in no unit this can place (GTK counts Unicode \
			 scalars, Qt UTF-16 code units); nothing was selected"
		)));
	};
	let text = text_proxy(connection, &name, object)
		.await
		.map_err(failure)?;
	let focused = read_focus(&accessible).await?;
	let before = snapshot(&text, units).await?;
	let previous = shown(&text).await?;
	let wanted = request.locate(&before.value)?;
	// The result reports these, so refuse a range the public API cannot hold
	// before anything is written.
	public(wanted.start)?;
	public(wanted.length)?;
	let native = native_range(&before.value, wanted, units)?;
	let desired = if native.start == native.end {
		Shown::Caret(native.start)
	} else {
		Shown::Selection(native)
	};
	// The app's own selection must lie on its text's characters: one that does
	// not would make the write land somewhere the request does not name.
	if utf16_range(&before.value, units, previous.range()).is_none() {
		return Err(DesktopError::ax_failed(format!(
			"its current {} does not lie on the characters of its text, so replacing it is unsafe; \
			 nothing was selected",
			previous.describe()
		)));
	}
	if previous != desired {
		let mutation = Mutation::chosen(desired, previous);
		// A run cancelled before the write leaves the caret as the user's.
		control::check()?;
		*attempted = true;
		write(&text, mutation).await?;
		settle(&text, desired).await?;
	}
	// Read focus last: an app can change it while answering the text read-back.
	let after = Readback {
		text:    snapshot(&text, units).await?,
		shown:   shown(&text).await?,
		focused: read_focus(&accessible).await?,
	};
	finish(after, &before, units, focused, desired, wanted)
}

async fn read_focus(accessible: &AccessibleProxy<'_>) -> CoreResult<bool> {
	let states = accessible.get_state().await.map_err(failure)?;
	if states.contains(State::Defunct) {
		return Err(DesktopError::stale_ref("the element no longer exists"));
	}
	if !state_enabled(states) {
		return Err(DesktopError::ax_failed(
			"the element is disabled, so its text cannot be read or selected",
		));
	}
	Ok(states.contains(State::Focused))
}

/// Reads the element's whole text, and requires its app's character count to
/// match it in the toolkit's own units: a count of something shorter than the
/// text, or one that changes under the read, would place every offset wrong.
async fn snapshot(text: &TextProxy<'_>, units: Units) -> CoreResult<Snapshot> {
	let count = text.character_count().await.map_err(failure)?;
	if count < 0 {
		return Err(DesktopError::ax_failed(format!(
			"its application reports a character count of {count}; refusing to select text there"
		)));
	}
	let value = text.get_text(0, -1).await.map_err(failure)?;
	let again = text.character_count().await.map_err(failure)?;
	if again != count {
		return Err(DesktopError::ax_failed(format!(
			"its character count changed from {count} to {again} while its text was read; refusing \
			 to select text in an element that is changing"
		)));
	}
	if masked(&value) {
		return Err(DesktopError::ax_failed(
			"its text reads back masked, so a selection in it cannot be checked; refusing to select \
			 text there",
		));
	}
	let length = units.len(&value);
	if usize::try_from(count).ok() != Some(length) {
		return Err(DesktopError::ax_failed(format!(
			"its application reports {count} characters but its text holds {length} by this \
			 toolkit's own count (GTK counts Unicode scalars, Qt UTF-16 code units), so its offsets \
			 cannot be placed; refusing to select text there"
		)));
	}
	Ok(Snapshot { value, count })
}

/// Reads the element's selection, or its caret when it has none.
async fn shown(text: &TextProxy<'_>) -> CoreResult<Shown> {
	let selections = text.get_n_selections().await.map_err(failure)?;
	if selections < 0 {
		return Err(DesktopError::ax_failed(format!(
			"its application reports {selections} selections, which is not a count; refusing to \
			 touch its selection"
		)));
	}
	if selections == 0 {
		let caret = text.caret_offset().await.map_err(failure)?;
		if caret < 0 {
			return Err(DesktopError::ax_failed(format!(
				"its caret reads at {caret}, which is not an offset; refusing to touch its selection"
			)));
		}
		return Ok(Shown::Caret(caret));
	}
	if selections > 1 {
		return Err(DesktopError::ax_failed(format!(
			"its application reports {selections} selections; replacing them would lose the user's \
			 selection, so nothing was selected"
		)));
	}
	let (from, to) = text.get_selection(0).await.map_err(failure)?;
	if from < 0 || to < 0 {
		return Err(DesktopError::ax_failed(format!(
			"its selection reads from {from} to {to}, which is not an offset; refusing to touch its \
			 selection"
		)));
	}
	Ok(Shown::Selection(NativeRange { start: from.min(to), end: from.max(to) }))
}

/// `wanted`, converted from public UTF-16 units to the toolkit's own.
fn native_range(value: &str, wanted: Utf16Range, units: Units) -> CoreResult<NativeRange> {
	let outside = || {
		DesktopError::ax_failed(
			"the requested range does not lie on the element's characters; nothing was selected",
		)
	};
	let stop = wanted
		.start
		.checked_add(wanted.length)
		.ok_or_else(outside)?;
	let start = units.native(value, wanted.start).ok_or_else(outside)?;
	let stop = units.native(value, stop).ok_or_else(outside)?;
	let to_i32 = |offset: usize| {
		i32::try_from(offset).map_err(|_| {
			DesktopError::ax_failed(format!(
				"offset {offset} is beyond the range a toolkit's text offsets hold; nothing was \
				 selected"
			))
		})
	};
	Ok(NativeRange { start: to_i32(start)?, end: to_i32(stop)? })
}

/// `native`, converted to public UTF-16 units; `None` when it does not lie on
/// the element's characters.
fn utf16_range(value: &str, units: Units, native: NativeRange) -> Option<Utf16Range> {
	let start = units.utf16(value, native.start)?;
	let end = units.utf16(value, native.end)?;
	Some(Utf16Range { start, length: end.checked_sub(start)? })
}

/// Makes the one mutation, and requires the toolkit to answer true; the answer
/// is not taken as proof, as [`settle`] reads the selection back.
async fn write(text: &TextProxy<'_>, mutation: Mutation) -> CoreResult<()> {
	let answer = match mutation {
		Mutation::Add(range) => text.add_selection(range.start, range.end).await,
		Mutation::Replace(range) => text.set_selection(0, range.start, range.end).await,
		Mutation::Caret(offset) => text.set_caret_offset(offset).await,
	};
	if !answer.map_err(failure)? {
		return Err(DesktopError::ax_failed(format!(
			"AT-SPI answered {} with false, so whether its selection changed is unknown",
			mutation.name()
		)));
	}
	Ok(())
}

/// Reads the element's selection until it shows `desired`, for as long as
/// [`SELECTION_SETTLE_WAIT`].
async fn settle(text: &TextProxy<'_>, desired: Shown) -> CoreResult<()> {
	let deadline = tokio::time::Instant::now() + SELECTION_SETTLE_WAIT;
	while shown(text).await? != desired {
		if tokio::time::Instant::now() >= deadline {
			return Ok(());
		}
		tokio::time::sleep(POLL_INTERVAL).await;
	}
	Ok(())
}

/// Requires the element to hold the same text and focus as before, and to show
/// exactly `desired`, and returns the selection.
fn finish(
	after: Readback,
	before: &Snapshot,
	units: Units,
	focused: bool,
	desired: Shown,
	wanted: Utf16Range,
) -> CoreResult<AxTextSelection> {
	if !after.text.same(before) {
		return Err(DesktopError::ax_failed(
			"the element's text changed while its selection was set, so the selection no longer \
			 covers the requested text; inspect the element before typing",
		));
	}
	if after.focused != focused {
		return Err(DesktopError::ax_failed(format!(
			"the element's focus changed while selecting (it was {} and now reads {}), so typing \
			 would not reach its text; inspect the app before typing",
			focused, after.focused
		)));
	}
	// A caret is only a caret: a zero-length selection still hides the user's
	// selection, which a following type would replace differently.
	let actual = utf16_range(&before.value, units, after.shown.range());
	if after.shown != desired || actual != Some(wanted) {
		let shown = after.shown.describe();
		return Err(DesktopError::ax_failed(format!(
			"asked to select UTF-16 {} length {} but the element reads back its {shown}; a following \
			 type would not replace the requested text",
			wanted.start, wanted.length
		)));
	}
	let selected = utf16_slice(&before.value, wanted)
		.ok_or_else(|| DesktopError::internal("the selection is not a range of the text"))?;
	Ok(AxTextSelection {
		start:   public(wanted.start)?,
		length:  public(wanted.length)?,
		text:    selected.to_owned(),
		focused: after.focused,
	})
}

/// A UTF-16 offset as the public API reports it.
fn public(units: usize) -> CoreResult<u32> {
	u32::try_from(units).map_err(|_| DesktopError::internal("selection offset exceeds u32"))
}

#[cfg(test)]
mod tests;
