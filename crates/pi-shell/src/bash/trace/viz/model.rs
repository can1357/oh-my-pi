//! Stable presentation boundary. Syntax identities are engine identities, not
//! display ids.
use std::{fmt, str::FromStr};

use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{Error, Visitor},
};

use crate::bash::{syntax::NodeId, trace::State};

/// Opaque renderer identity preserving the engine's unit and canonical node
/// IDs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
pub struct NodeKey {
	/// Index of the actual trace unit.
	pub unit:   u32,
	/// Zero for engine syntax; other values identify native-parsed literal
	/// sources.
	pub source: u32,
	/// Unmodified node identity from the canonical parser.
	pub node:   NodeId,
}
impl NodeKey {
	/// Identify an actual compiled unit's canonical node.
	pub const fn engine(unit: u32, node: NodeId) -> Self {
		Self { unit, source: 0, node }
	}

	/// Identify a canonical node within a native syntax source.
	pub const fn nested(unit: u32, source: u32, node: NodeId) -> Self {
		Self { unit, source, node }
	}
}
impl fmt::Display for NodeKey {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let mut buffer = fmt::NumBuffer::new();
		f.write_str(self.unit.format_into(&mut buffer))?;
		f.write_str(":")?;
		f.write_str(self.source.format_into(&mut buffer))?;
		f.write_str(":")?;
		f.write_str(self.node.0.format_into(&mut buffer))
	}
}
impl FromStr for NodeKey {
	type Err = &'static str;

	fn from_str(s: &str) -> Result<Self, Self::Err> {
		let mut p = s.split(':');
		let mut next = || {
			let component = p.next().ok_or("missing node identity component")?;
			if component.is_empty() || !component.bytes().all(|byte| byte.is_ascii_digit()) {
				return Err("invalid node identity component");
			}
			component
				.parse::<u32>()
				.map_err(|_| "invalid node identity component")
		};
		let key = Self { unit: next()?, source: next()?, node: NodeId(next()?) };
		if p.next().is_some() {
			return Err("extra node identity component");
		}
		Ok(key)
	}
}
impl Serialize for NodeKey {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		s.collect_str(self)
	}
}
impl<'de> Deserialize<'de> for NodeKey {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		struct KeyVisitor;
		impl Visitor<'_> for KeyVisitor {
			type Value = NodeKey;

			fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str("a native unit:source:node identity")
			}

			fn visit_str<E: Error>(self, value: &str) -> Result<Self::Value, E> {
				value.parse().map_err(E::custom)
			}
		}
		d.deserialize_str(KeyVisitor)
	}
}

/// Source-preserving Raw or Python-like Pseudo presentation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
	/// Original source with native execution decoration.
	Raw,
	/// Canonical syntax rendered as Python-like control flow.
	#[default]
	Pseudo,
}
/// Independent non-executing transformations requested by the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Layers {
	/// Syntax colors; structural chips remain when disabled.
	pub color:   bool,
	/// Substitute statically proven constants, never guessed runtime values.
	pub inline:  bool,
	/// Fold recognized shell idioms into readable operations.
	pub idioms:  bool,
	/// Annotate heuristic side effects.
	pub effects: bool,
	/// Reveal literal embedded programs and documents.
	pub unwrap:  bool,
}
impl Default for Layers {
	fn default() -> Self {
		Self { color: true, inline: true, idioms: true, effects: true, unwrap: true }
	}
}
/// Display controls and a real journal cursor, shared by live and stored
/// traces.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Options {
	/// Requested source representation.
	pub view:           View,
	/// Enabled semantic layers.
	pub layers:         Layers,
	/// Include the Raw counterpart beside Pseudo.
	pub split:          bool,
	/// Number of retained events to apply; absent means live.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub cursor:         Option<usize>,
	/// Stable event identity, taking precedence over a potentially evicted
	/// cursor index.
	#[serde(skip_serializing)]
	pub cursor_seq:     Option<u64>,
	/// UI playback state; native presentation never advances its own timer.
	pub playing:        bool,
	/// UI playback speed multiplier.
	pub speed:          f64,
	/// Source selection for the inspector.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub selected_node:  Option<NodeKey>,
	/// Native source identities whose inspection detail is expanded.
	pub expanded_nodes: Vec<NodeKey>,
}
impl Default for Options {
	fn default() -> Self {
		Self {
			view:           View::Pseudo,
			layers:         Layers::default(),
			split:          false,
			cursor:         None,
			cursor_seq:     None,
			playing:        false,
			speed:          1.0,
			selected_node:  None,
			expanded_nodes: Vec::new(),
		}
	}
}
/// One physical-line token, with separate source and execution identities.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
	pub text:           String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub active:         Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub state:          Option<State>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub executed_at_ns: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub execution_seq:  Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub style:          Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub node:           Option<NodeKey>,
	/// Actual command owning state and completion; `node` remains the
	/// source-token identity.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub execution_node: Option<NodeKey>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub range:          Option<[u32; 2]>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub tip:            Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub expanded:       Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub language:       Option<String>,
}
/// Heuristic side-effect warning; never a guarantee of safety or completeness.
#[derive(Clone, Debug, Serialize)]
pub struct Effect {
	pub kind:  EffectKind,
	pub glyph: String,
	pub label: String,
	pub why:   String,
}
/// Renderer categories for heuristic shell effects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectKind {
	Network,
	Write,
	Destructive,
	Secret,
	Privilege,
	Background,
}
/// Latest observed setter, retaining only proven scope and source provenance.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
	pub name:        String,
	pub value:       String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub full_length: Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub scope:       Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub scope_id:    Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub node:        Option<NodeKey>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub range:       Option<[u32; 2]>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub setter_seq:  Option<u64>,
}
/// One physical presentation line; source ranges use outer-script UTF-16
/// coordinates.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
	pub id:             String,
	pub depth:          u32,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub node:           Option<NodeKey>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub range:          Option<[u32; 2]>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub active:         Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub role:           Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub state:          Option<State>,
	pub segments:       Vec<Segment>,
	pub effects:        Vec<Effect>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub executed_at_ns: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub execution_seq:  Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub meta:           Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub detail:         Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub annotations:    Option<Vec<Watch>>,
}
/// Applied bounded journal prefix and its run-relative clock.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
	pub length:      usize,
	pub cursor:      usize,
	pub elapsed_ns:  u64,
	pub duration_ns: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub trimmed:     Option<bool>,
}
/// Complete semantic frame consumed by ANSI and GUI hosts without shell
/// interpretation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presentation {
	pub preferences: Options,
	pub rows:        Vec<Row>,
	/// Raw counterpart only for Pseudo split; empty for an unrequested pane.
	pub original:    Vec<Row>,
	pub output:      String,
	pub running:     bool,
	pub executing:   bool,
	pub watches:     Vec<Watch>,
	pub timeline:    Timeline,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub message:     Option<String>,
}

#[cfg(test)]
mod identity_tests {
	use super::*;
	#[test]
	fn opaque_keys_roundtrip_canonical_engine_identity() {
		let key = NodeKey::engine(12, NodeId(99));
		assert_eq!(key.to_string(), "12:0:99");
		assert_eq!(serde_json::to_string(&key).unwrap(), "\"12:0:99\"");
		assert_eq!(serde_json::from_str::<NodeKey>("\"12:0:99\"").unwrap(), key);
		for value in ["12:99", "12:0:99:1", "-1:0:0", "+1:0:0", "1:0:4294967296", "1:0: 1", "1::1"] {
			assert!(value.parse::<NodeKey>().is_err(), "{value}");
		}
	}
}
