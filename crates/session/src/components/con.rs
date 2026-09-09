use omp_core::Str;
use omp_dom::{Dom, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::{Entry, EntryId, Kind};
use thiserror::Error;

use crate::{Component, Draft};

const ORIGIN: &str = "origin";

/// One durable `<meta><con><var>` value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConWrite {
	/// Canonical convar name.
	pub name:   Str,
	/// Script-form typed value.
	pub value:  Str,
	/// Write provenance.
	pub origin: Str,
}

/// Failure to address the journal-backed convar subtree.
#[derive(Debug, Error)]
pub enum ConComponentError {
	/// The fixed `<meta><con>` component is absent.
	#[error("session DOM has no <meta><con> component")]
	MissingCon,
	/// More than one node claims a canonical convar name.
	#[error("session DOM contains duplicate convar `{name}`")]
	DuplicateVar {
		/// Duplicated canonical name.
		name: Str,
	},
}

/// Reads all complete convar elements in DOM order.
#[must_use]
pub fn con_writes(dom: &Dom) -> Vec<ConWrite> {
	let Some(con) = con_handle(dom) else {
		return Vec::new();
	};
	let name_key = PropKey::Known(PropId::Name);
	let value_key = PropKey::Known(PropId::Value);
	let origin_key = PropKey::Custom(Str::new_static(ORIGIN));
	dom.children(con)
		.iter()
		.filter_map(|handle| {
			let node = dom.get(*handle)?;
			if node.tag != Tag::Known(KnownTag::Var) {
				return None;
			}
			Some(ConWrite {
				name:   node.prop(&name_key)?.as_str()?.into(),
				value:  node.prop(&value_key)?.as_str()?.into(),
				origin: node.prop(&origin_key)?.as_str()?.into(),
			})
		})
		.collect()
}

/// Builds the `patch@1` transaction for one session convar write.
///
/// The fixed `<con>` container is created by the genesis fold. Existing vars
/// are updated in place so handles remain stable across replay.
pub fn con_write_txn(
	dom: &Dom,
	cause: EntryId,
	write: &ConWrite,
) -> Result<Txn, ConComponentError> {
	let con = con_handle(dom).ok_or(ConComponentError::MissingCon)?;
	let name_key = PropKey::Known(PropId::Name);
	let value_key = PropKey::Known(PropId::Value);
	let origin_key = PropKey::Custom(Str::new_static(ORIGIN));
	let matches: Vec<_> = dom
		.children(con)
		.iter()
		.copied()
		.filter(|handle| {
			dom.get(*handle).is_some_and(|node| {
				node.tag == Tag::Known(KnownTag::Var)
					&& node.prop(&name_key).and_then(Value::as_str) == Some(write.name.as_str())
			})
		})
		.collect();
	if matches.len() > 1 {
		return Err(ConComponentError::DuplicateVar { name: write.name.clone() });
	}
	let ops = if let Some(handle) = matches.first().copied() {
		vec![
			Op::Set { h: handle, prop: value_key, value: Value::Str(write.value.clone()) },
			Op::Set { h: handle, prop: origin_key, value: Value::Str(write.origin.clone()) },
		]
	} else {
		let after = dom.children(con).last().copied();
		let node = NodeSpec::new(KnownTag::Var)
			.with_prop(name_key, Value::Str(write.name.clone()))
			.with_prop(value_key, Value::Str(write.value.clone()))
			.with_prop(origin_key, Value::Str(write.origin.clone()));
		vec![Op::Ins { parent: con, after, node }]
	};
	Ok(Txn { cause, label: Some(Str::new_static("con.write")), ops })
}

fn con_handle(dom: &Dom) -> Option<omp_dom::Handle> {
	dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Con))
	})
}

/// Declares the `<meta><con>` component boundary.
///
/// Session convars are ordinary `patch@1` operations. The genesis fold owns
/// the fixed container and replay applies its DOM operations verbatim.
pub struct ConComponent;

impl Component for ConComponent {
	fn interested(&self, _kind: &Kind) -> bool {
		false
	}

	fn apply(&mut self, _entry: &Entry, _dom: &Dom, _draft: &mut Draft) {}
}
