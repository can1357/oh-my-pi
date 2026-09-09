use core::{fmt, str::FromStr as _};

use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{self, IgnoredAny, SeqAccess, Visitor},
	ser::SerializeTuple,
};
use strum::{EnumString, IntoStaticStr};

use crate::{Handle, NodeSpec, PropKey, Value};

#[derive(Clone, Copy, EnumString, IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
enum OpCode {
	Ins,
	Rm,
	Set,
	Mv,
}

/// Mutation of an append-only text stream.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamOp {
	/// Bind a new stream to a text property.
	Open,
	/// Append one text delta.
	Append,
	/// Materialize and unbind the stream.
	Close,
}

/// One atomic session-tree operation.
///
/// The wire representation is one of the four closed ADR 0003 arrays.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
	/// Insert a newly minted node under `parent` after an optional sibling.
	Ins {
		/// Existing parent.
		parent: Handle,
		/// Existing sibling after which to insert, or the first position.
		after:  Option<Handle>,
		/// Data for the minted node.
		node:   NodeSpec,
	},
	/// Remove a non-root node and its subtree.
	Rm(Handle),
	/// Set one property.
	Set {
		/// Target node.
		h:     Handle,
		/// Property to set.
		prop:  PropKey,
		/// Replacement value.
		value: Value,
	},
	/// Move a node under a new parent after an optional sibling.
	Mv {
		/// Node to move.
		h:      Handle,
		/// New parent.
		parent: Handle,
		/// Existing sibling after which to insert, or the first position.
		after:  Option<Handle>,
	},
}

impl Serialize for Op {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		match self {
			Self::Ins { parent, after, node } => {
				let mut tuple = serializer.serialize_tuple(4)?;
				tuple.serialize_element(<&'static str>::from(OpCode::Ins))?;
				tuple.serialize_element(parent)?;
				tuple.serialize_element(after)?;
				tuple.serialize_element(node)?;
				tuple.end()
			},
			Self::Rm(handle) => {
				let mut tuple = serializer.serialize_tuple(2)?;
				tuple.serialize_element(<&'static str>::from(OpCode::Rm))?;
				tuple.serialize_element(handle)?;
				tuple.end()
			},
			Self::Set { h, prop, value } => {
				let mut tuple = serializer.serialize_tuple(4)?;
				tuple.serialize_element(<&'static str>::from(OpCode::Set))?;
				tuple.serialize_element(h)?;
				tuple.serialize_element(prop)?;
				tuple.serialize_element(value)?;
				tuple.end()
			},
			Self::Mv { h, parent, after } => {
				let mut tuple = serializer.serialize_tuple(4)?;
				tuple.serialize_element(<&'static str>::from(OpCode::Mv))?;
				tuple.serialize_element(h)?;
				tuple.serialize_element(parent)?;
				tuple.serialize_element(after)?;
				tuple.end()
			},
		}
	}
}

struct OpVisitor;

impl<'de> Visitor<'de> for OpVisitor {
	type Value = Op;

	fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("an ADR 0003 DOM operation array")
	}

	fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
	where
		A: SeqAccess<'de>,
	{
		let name: &str = seq
			.next_element()?
			.ok_or_else(|| de::Error::invalid_length(0, &self))?;
		let code = OpCode::from_str(name)
			.map_err(|_| de::Error::unknown_variant(name, &["ins", "rm", "set", "mv"]))?;
		let op = match code {
			OpCode::Ins => Op::Ins {
				parent: next(&mut seq, 1, &self)?,
				after:  next(&mut seq, 2, &self)?,
				node:   next(&mut seq, 3, &self)?,
			},
			OpCode::Rm => Op::Rm(next(&mut seq, 1, &self)?),
			OpCode::Set => Op::Set {
				h:     next(&mut seq, 1, &self)?,
				prop:  next(&mut seq, 2, &self)?,
				value: next(&mut seq, 3, &self)?,
			},
			OpCode::Mv => Op::Mv {
				h:      next(&mut seq, 1, &self)?,
				parent: next(&mut seq, 2, &self)?,
				after:  next(&mut seq, 3, &self)?,
			},
		};
		if seq.next_element::<IgnoredAny>()?.is_some() {
			return Err(de::Error::custom("DOM operation array has trailing elements"));
		}
		Ok(op)
	}
}

fn next<'de, A, T>(seq: &mut A, index: usize, expected: &dyn de::Expected) -> Result<T, A::Error>
where
	A: SeqAccess<'de>,
	T: Deserialize<'de>,
{
	seq.next_element()?
		.ok_or_else(|| de::Error::invalid_length(index, expected))
}

impl<'de> Deserialize<'de> for Op {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		deserializer.deserialize_seq(OpVisitor)
	}
}
