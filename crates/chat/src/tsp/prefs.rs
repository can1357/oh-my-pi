//! Typed props of Tern's data-first `prefs` sheet and the values its `change`
//! events carry (ADR 0041 phase 3).
//!
//! A `prefs` node is a leaf: its pages, sections, rows and typed controls all
//! ride in props, and Tern draws a native settings window from them. Keys stay
//! the program's, so the sheet also mirrors the keyboard focus and the editor
//! the program has open.

use omp_core::Str;
use omp_tui::tsp::wire::{Kind, Node};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::typed_props;

/// Id of the one `prefs` sheet a surface holds; Tern names it in the `change`
/// and `action` events it sends back.
pub const PREFS_ID: &str = "prefs";

const fn is_false(value: &bool) -> bool {
	!*value
}

/// One page in the sheet's navigation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrefsPage {
	/// Page id, sent back by the `page` action.
	pub id:      Str,
	/// Navigation label.
	pub label:   Str,
	/// Symbolic icon name.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub icon:    Option<Str>,
	/// Rows on the page that differ from their default.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub changed: Option<u32>,
}

/// One option of a `choice` or `multi` control.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrefsOption {
	/// Value sent back in a `change` event.
	pub value:  Str,
	/// Option label.
	pub label:  Str,
	/// Option description.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub detail: Option<Str>,
}

/// How a `choice` control draws its options.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChoiceStyle {
	/// Tern picks: few short options segment, the rest open a menu.
	Auto,
	/// Always a menu (described options, live-previewed settings).
	Menu,
}

/// A row's typed control.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum PrefsControl {
	/// On/off; a `change` carries a boolean.
	Switch {
		/// Current state.
		on: bool,
	},
	/// One of a closed set; a `change` carries the option value.
	Choice {
		/// Current value.
		value:   Str,
		/// The options, in order.
		options: Vec<PrefsOption>,
		/// How the options draw.
		style:   ChoiceStyle,
		/// Labels are the raw values: draw them monospaced.
		#[serde(skip_serializing_if = "is_false")]
		mono:    bool,
	},
	/// Free text; a `change` carries the new text.
	Text {
		/// Current value (masked when `secret`).
		value:  Str,
		/// The value is a secret.
		#[serde(skip_serializing_if = "is_false")]
		secret: bool,
	},
	/// A subset of a closed set; a `change` carries the selected values.
	Multi {
		/// Selected values, in order.
		values:  Vec<Str>,
		/// The options, in order.
		options: Vec<PrefsOption>,
		/// The selection order matters.
		#[serde(skip_serializing_if = "is_false")]
		ordered: bool,
	},
	/// A button: clicking sends the `act` action with the row id as value.
	Action {
		/// Button label.
		label: Str,
		/// Action name.
		act:   Str,
	},
}

/// One settings row.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefsRow {
	/// Row id, sent back as a `change` event's `item`.
	pub id:            Str,
	/// Row label.
	pub label:         Str,
	/// Description under the label.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub hint:          Option<Str>,
	/// Warning under the label.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub warning:       Option<Str>,
	/// The value differs from the default.
	#[serde(skip_serializing_if = "is_false")]
	pub changed:       bool,
	/// The default as the control names it (the changed dot's title).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub default_label: Option<Str>,
	/// The typed control.
	pub control:       PrefsControl,
}

/// A titled group of rows.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PrefsSection {
	/// Section id.
	pub id:    Str,
	/// Section heading.
	pub title: Str,
	/// Search results: the page this section belongs to.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub page:  Option<Str>,
	/// The rows, in order.
	pub rows:  Vec<PrefsRow>,
}

/// The row whose control the program has open for editing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PrefsEditing {
	/// Row id.
	pub row:    Str,
	/// A text row's draft (masked when secret).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub draft:  Option<Str>,
	/// The draft's caret, a UTF-16 offset.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cursor: Option<u32>,
	/// A choice or multi row's highlighted option.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub option: Option<Str>,
}

/// A whole `prefs` sheet.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PrefsSheet {
	/// Window title.
	pub title:    Str,
	/// Every page.
	pub pages:    Vec<PrefsPage>,
	/// The page shown.
	pub page:     Str,
	/// The program's search text; non-empty shows search results.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub query:    Option<Str>,
	/// The search caret, a UTF-16 offset into `query`.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cursor:   Option<u32>,
	/// The sections of the page shown (or the search results).
	pub sections: Vec<PrefsSection>,
	/// The row (or section) with keyboard focus.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub focus:    Option<Str>,
	/// The control open for editing.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub editing:  Option<PrefsEditing>,
}

impl PrefsSheet {
	/// The sheet as its `prefs` node.
	#[must_use]
	pub fn node(&self) -> Node {
		Node { id: Str::new_static(PREFS_ID), k: Kind::Prefs, p: typed_props(self), c: Vec::new() }
	}
}

/// The value of a `prefs` `change` event; a `null` value is a reset to the
/// default and decodes as `None`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum PrefsValue {
	/// A `switch` row's new state.
	Switch(bool),
	/// A `choice` row's option value or a `text` row's new text.
	Text(Str),
	/// A `multi` row's selected values.
	List(Vec<Str>),
}

impl PrefsValue {
	/// Decodes an event value: `Ok(None)` is a reset to the default.
	///
	/// # Errors
	/// Returns the decoding error for a value no prefs control sends (a
	/// number, an object).
	pub fn decode(value: &Value) -> Result<Option<Self>, serde_json::Error> {
		Option::<Self>::deserialize(value)
	}
}
