//! Layered key→value bags feeding template rendering.

use omp_core::{IntoStr, Str};
use omp_dom::Dom;

use crate::Value;

/// An ordered bag of template props.
///
/// Backed by a persistent map: cloning is O(1), and [`Props::overlay`]
/// builds subagent bags by structural sharing instead of copying. Iteration
/// is key-ordered, keeping renders deterministic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Props {
	map: im::OrdMap<Str, Value>,
}

impl Props {
	/// Creates an empty bag.
	pub fn new() -> Self {
		Self::default()
	}

	/// Inserts or replaces a prop.
	pub fn set(&mut self, key: impl IntoStr, value: impl Into<Value>) {
		self.map.insert(key.into_str(), value.into());
	}

	/// Looks up a top-level prop.
	pub fn get(&self, key: &str) -> Option<&Value> {
		self.map.get(key)
	}

	/// Child-wins shallow merge: every top-level key present in `patch`
	/// replaces the parent value wholesale — nested maps and lists are NOT
	/// deep-merged. Shallow by design: a patch key is an intentional,
	/// self-contained override, never a partial edit of parent structure.
	/// Costs O(|patch| · log |parent|) thanks to structural sharing.
	pub fn overlay(&self, patch: &Self) -> Self {
		// `union` resolves conflicts by map size, not operand order; the
		// explicit chooser keeps the patch value deterministically.
		Self {
			map: patch
				.map
				.clone()
				.union_with(self.map.clone(), |patch_value, _parent| patch_value),
		}
	}

	/// Binds this value bag to the authoritative session DOM for one render.
	///
	/// The returned view borrows both inputs; no DOM snapshot, serialization,
	/// or string round-trip is performed.
	#[must_use]
	pub const fn with_dom<'a>(&'a self, dom: &'a Dom) -> ScopedProps<'a> {
		ScopedProps { values: self, dom }
	}

	/// Iterates props in key order.
	pub fn iter(&self) -> impl Iterator<Item = (&Str, &Value)> + '_ {
		self.map.iter()
	}

	/// Number of top-level props.
	pub fn len(&self) -> usize {
		self.map.len()
	}

	/// Whether the bag holds no props.
	pub fn is_empty(&self) -> bool {
		self.map.is_empty()
	}
}

/// A render-scoped prop view carrying a borrowed session DOM.
///
/// Templates access the tree only through the registered `select` and
/// `count` functions. The DOM cannot escape the render lifetime.
#[derive(Clone, Copy)]
pub struct ScopedProps<'a> {
	pub(crate) values: &'a Props,
	pub(crate) dom:    &'a Dom,
}

impl ScopedProps<'_> {
	/// Returns the ordinary template values in this render scope.
	#[must_use]
	pub const fn values(&self) -> &Props {
		self.values
	}

	/// Returns the authoritative session tree bound to this render scope.
	#[must_use]
	pub const fn dom(&self) -> &Dom {
		self.dom
	}
}

impl From<Props> for Value {
	fn from(props: Props) -> Self {
		Self::Map(props.map)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::map;

	#[test]
	fn overlay_is_child_wins_and_shallow() {
		let mut parent = Props::new();
		parent.set("a", 1);
		parent.set("b", 2);
		parent.set("nested", map! { "x" => 1, "y" => 2 });
		let mut patch = Props::new();
		patch.set("b", 3);
		patch.set("nested", map! { "x" => 9 });
		let merged = parent.overlay(&patch);
		assert_eq!(merged.get("a"), Some(&Value::Int(1)));
		assert_eq!(merged.get("b"), Some(&Value::Int(3)));
		// Top-level key replaces wholesale: parent's `y` is gone.
		assert_eq!(merged.get("nested"), Some(&map! { "x" => 9 }));
		// Sources are untouched.
		assert_eq!(parent.get("b"), Some(&Value::Int(2)));
		assert_eq!(patch.len(), 2);
	}

	#[test]
	fn iteration_is_key_ordered() {
		let mut props = Props::new();
		props.set("zeta", 1);
		props.set("alpha", 2);
		props.set("mid", 3);
		let keys: Vec<&str> = props.iter().map(|(key, _)| key.as_str()).collect();
		assert_eq!(keys, ["alpha", "mid", "zeta"]);
	}
}
