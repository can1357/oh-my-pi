//! Typed props of the selection kinds: the data-first `picker` sheet and the
//! `overlay` + `list` + `item` composition of a completion list anchored to
//! the caret, plus the pointer gestures Tern sends back for them.
//!
//! A picker carries its rows as data (`items`), names its selected row by
//! item id, and holds that row's preview as its children. Keys stay the
//! program's: Tern sends a row click as `select` (move the selection there
//! and preview it), a double click or Enter on a row as `activate` (choose
//! it), and an action-bar button as `action` with the button id.
//! [`Gesture::of`] folds the three into one shape.

use std::collections::BTreeMap;

use omp_core::Str;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use strum::{EnumString, IntoStaticStr};

use super::wire::{Event, Kind, Node};

/// Props of one node kind.
pub trait KindProps: Serialize {
	/// The kind these props belong to.
	const KIND: Kind;

	/// The node `id` of this kind with these props over `children`.
	fn node(&self, id: Str, children: Vec<Node>) -> Node {
		Node { id, k: Self::KIND, p: prop_map(self), c: children }
	}
}

/// Serializes typed props into a node's prop map. Absent fields are left out,
/// so the map never holds a `null`.
fn prop_map<T: Serialize + ?Sized>(props: &T) -> Map<String, Value> {
	match serde_json::to_value(props) {
		Ok(Value::Object(map)) => map,
		_ => Map::new(),
	}
}

/// Reads a node's props back as the typed props of its kind.
///
/// # Errors
/// Returns the decoding error when the props do not have that shape.
pub fn read<P: DeserializeOwned>(node: &Node) -> serde_json::Result<P> {
	serde_json::from_value(Value::Object(node.p.clone()))
}

/// How large the picker sheet is.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs, reason = "each variant is the wire size of the same name")]
pub enum PickerSize {
	Md,
	Lg,
	Screen,
}

/// How the picker lays its rows out.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs, reason = "each variant is the wire layout of the same name")]
pub enum PickerLayout {
	Rows,
	Cards,
	Timeline,
	Tree,
}

/// Where the selected row's preview (the picker's children) sits.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs, reason = "each variant is the wire placement of the same name")]
pub enum PickerPreview {
	Side,
	Below,
	None,
}

/// How a fact column formats its values.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnFormat {
	/// Plain text.
	Text,
	/// A number Tern groups and aligns.
	Num,
	/// A price.
	Price,
	/// A 0–1 bar.
	Bar,
	/// A compact age.
	Time,
	/// An age in ms at send, which Tern clocks.
	Elapsed,
	/// Dim text.
	Dim,
}

/// A right-aligned fact column.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PickerColumn {
	/// Column id: the key of each item's `facts`.
	pub id:     Str,
	/// Heading.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub head:   Option<Str>,
	/// Value format.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub format: Option<ColumnFormat>,
}

/// One value of a fact column.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Fact {
	/// A number (`num`, `bar`, `elapsed` columns).
	Num(f64),
	/// Text.
	Text(Str),
}

/// A role-style chip after a row's label.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PickerChip {
	/// Chip text.
	pub text: Str,
	/// Drawn as held (an explicit assignment).
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub on:   bool,
	/// Drawn hollow (an automatic fallback).
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub auto: bool,
}

/// One selectable picker row.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PickerItem {
	/// Row id, stable for as long as the row means the same thing; events name
	/// rows by it.
	pub id:     Str,
	/// Label.
	pub label:  Str,
	/// Second line or trailing dim text.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub detail: Option<Str>,
	/// The label is a machine string (a model id, a path).
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub mono:   bool,
	/// Values for the picker's `columns`, by column id.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub facts:  BTreeMap<Str, Fact>,
	/// Chips after the label.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub chips:  Vec<PickerChip>,
	/// Tooltip.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:  Option<Str>,
}

/// A program action an action-bar button runs, sent back as `action.act`.
#[derive(Clone, Copy, Debug, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum PickerAct {
	/// Choose the selected row (Enter).
	Confirm,
	/// Close without choosing (Esc, the backdrop, the head's close button).
	Close,
	/// Close without choosing.
	Cancel,
}

/// A button of the picker's action bar.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PickerAction {
	/// Sent back as `action.act`.
	pub id:      Str,
	/// Button label.
	pub label:   Str,
	/// Keycaps the program binds to it.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub keys:    Vec<Str>,
	/// The primary button.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub primary: bool,
	/// Right-aligned (close, help).
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub end:     bool,
}

impl PickerAction {
	/// The primary button choosing the selected row, bound to Enter.
	#[must_use]
	pub fn confirm(label: &'static str) -> Self {
		Self {
			id:      Str::new_static(PickerAct::Confirm.into()),
			label:   Str::new_static(label),
			keys:    vec![Str::new_static("enter")],
			primary: true,
			end:     false,
		}
	}

	/// The right-aligned `Close esc` every picker ends with.
	#[must_use]
	pub fn close() -> Self {
		Self {
			id:      Str::new_static(PickerAct::Close.into()),
			label:   Str::new_static("Close"),
			keys:    vec![Str::new_static("esc")],
			primary: false,
			end:     true,
		}
	}
}

/// Props of a data-first `picker` sheet. Its children are the selected row's
/// preview; a picker in `layer` is itself the modal sheet.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct PickerProps {
	/// What is being picked ("Models").
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub title:       Option<Str>,
	/// Named icon of the head.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub icon:        Option<Str>,
	/// Plural noun for counts and empty copy ("models").
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub noun:        Option<Str>,
	/// Sheet size.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub size:        Option<PickerSize>,
	/// Row layout.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub layout:      Option<PickerLayout>,
	/// The program's search text; the keys that edit it stay the program's.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub query:       Option<Str>,
	/// Search field placeholder.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub placeholder: Option<Str>,
	/// Fact columns.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub columns:     Vec<PickerColumn>,
	/// The catalogue, by row id.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub items:       Vec<PickerItem>,
	/// The row ids shown, in order, after the program's filtering; absent shows
	/// every item in `items` order.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub order:       Option<Vec<Str>>,
	/// Id of the selected row.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub selected:    Option<Str>,
	/// Rows in use now (the current model).
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub current:     Vec<Str>,
	/// Rows before filtering, for the head count.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub total:       Option<u32>,
	/// Where the preview sits.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub preview:     Option<PickerPreview>,
	/// The action bar.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub actions:     Vec<PickerAction>,
	/// Text shown when nothing is listed.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub empty:       Option<Str>,
}

impl KindProps for PickerProps {
	const KIND: Kind = Kind::Picker;
}

/// Where an `overlay` sits against the pane.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs, reason = "each variant is the wire edge of the same name")]
pub enum OverlayEdge {
	Center,
	Top,
	Bottom,
}

/// What an `overlay` is anchored to.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OverlayAnchor {
	/// The caret of the `editor` or `input` node with this id: a completion
	/// list follows the caret as Tern lays the text out.
	Caret {
		/// The text node's id.
		caret: Str,
	},
	/// A pane edge.
	Edge(OverlayEdge),
}

/// Props of an `overlay` node.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct OverlayProps {
	/// Anchor.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub anchor: Option<OverlayAnchor>,
	/// Semantic role (`omp.autocomplete`).
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub role:   Option<Str>,
}

impl KindProps for OverlayProps {
	const KIND: Kind = Kind::Overlay;
}

/// A height cap in text lines.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Lines {
	/// Lines.
	pub lines: u32,
}

/// Props of a `list` node; its children are `item` nodes.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ListProps {
	/// Id of the selected `item` child.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub selected: Option<Str>,
	/// Height cap; Tern scrolls the rest.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub max:      Option<Lines>,
}

impl KindProps for ListProps {
	const KIND: Kind = Kind::List;
}

/// Props of an `item` node.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ItemProps {
	/// Label.
	pub label:  Str,
	/// Trailing detail.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub detail: Option<Str>,
}

impl KindProps for ItemProps {
	const KIND: Kind = Kind::Item;
}

/// Props of a `text` node, the plain run a preview is made of.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TextProps {
	/// The text.
	pub text: Str,
}

impl KindProps for TextProps {
	const KIND: Kind = Kind::Text;
}

/// What a pointer gesture on a picker or a list asks for (v1 `pickerEvent`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Gesture {
	/// A row was clicked: move the selection there and preview it.
	Select(Str),
	/// A row was double-clicked or entered: choose it.
	Activate(Str),
	/// An action-bar button ran.
	Act(PickerAct),
}

impl Gesture {
	/// The id of the node `event` addresses and the gesture it carries;
	/// `None` for any other event and for an action this build does not know.
	#[must_use]
	pub fn of(event: &Event) -> Option<(&Str, Self)> {
		match event {
			Event::Select { id, item, .. } => Some((id, Self::Select(item.clone()))),
			Event::Activate { id, item, .. } => Some((id, Self::Activate(item.clone()))),
			Event::Action { id, act, .. } => Some((id, Self::Act(act.parse().ok()?))),
			_ => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use serde_json::json;

	use super::{
		Gesture, KindProps as _, OverlayAnchor, OverlayProps, PickerAct, PickerAction, PickerItem,
		PickerProps, read,
	};
	use crate::tsp::wire::{Event, Kind};

	#[test]
	fn absent_props_are_left_out_and_anchors_take_the_wire_shape() {
		let overlay = OverlayProps {
			anchor: Some(OverlayAnchor::Caret { caret: Str::new_static("composer") }),
			role:   None,
		}
		.node(Str::new_static("complete"), Vec::new());
		assert_eq!(overlay.k, Kind::Overlay);
		assert_eq!(
			serde_json::to_value(&overlay.p).unwrap(),
			json!({"anchor": {"caret": "composer"}})
		);

		let picker = PickerProps {
			items: vec![PickerItem {
				id:     Str::new_static("a"),
				label:  Str::new_static("A"),
				detail: None,
				mono:   false,
				facts:  Default::default(),
				chips:  Vec::new(),
				title:  None,
			}],
			selected: Some(Str::new_static("a")),
			actions: vec![PickerAction::confirm("Select"), PickerAction::close()],
			..PickerProps::default()
		}
		.node(Str::new_static("p"), Vec::new());
		assert_eq!(
			serde_json::to_value(&picker.p).unwrap(),
			json!({
				"items": [{"id": "a", "label": "A"}],
				"selected": "a",
				"actions": [
					{"id": "confirm", "label": "Select", "keys": ["enter"], "primary": true},
					{"id": "close", "label": "Close", "keys": ["esc"], "end": true},
				],
			}),
			"the action ids are what `Gesture::of` parses back"
		);
		let back: PickerProps = read(&picker).expect("the props read back");
		assert_eq!(back.selected.as_deref(), Some("a"));
	}

	#[test]
	fn gestures_fold_select_activate_and_known_actions_only() {
		let sf = Str::new_static("s");
		let id = Str::new_static("p");
		let select =
			Event::Select { sf: sf.clone(), id: id.clone(), item: "x".into(), values: None };
		assert_eq!(Gesture::of(&select), Some((&id, Gesture::Select("x".into()))));
		let activate = Event::Activate {
			sf:     sf.clone(),
			id:     id.clone(),
			item:   "x".into(),
			values: None,
		};
		assert_eq!(Gesture::of(&activate), Some((&id, Gesture::Activate("x".into()))));
		let action = |act: &'static str| Event::Action {
			sf:     sf.clone(),
			id:     id.clone(),
			act:    Str::new_static(act),
			value:  None,
			mods:   Vec::new(),
			values: None,
		};
		assert_eq!(Gesture::of(&action("confirm")), Some((&id, Gesture::Act(PickerAct::Confirm))));
		assert_eq!(Gesture::of(&action("close")), Some((&id, Gesture::Act(PickerAct::Close))));
		assert_eq!(Gesture::of(&action("refresh")), None, "an unknown action is no gesture");
		assert_eq!(Gesture::of(&Event::Theme { dark: true }), None);
	}
}
