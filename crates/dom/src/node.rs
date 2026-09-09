use core::fmt;

use omp_core::Str;
use serde::{
	Deserialize, Deserializer, Serialize,
	de::{
		self, MapAccess, SeqAccess, Visitor,
		value::{MapAccessDeserializer, SeqAccessDeserializer},
	},
};
use serde_json::value::RawValue;
use smallvec::SmallVec;

use crate::{Handle, PropKey, Tag};

/// A property value stored in the session tree.
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum Value {
	/// JSON null.
	Null,
	/// A Boolean scalar.
	Bool(bool),
	/// A signed integer scalar.
	Int(i64),
	/// A finite floating-point scalar.
	Float(f64),
	/// Text.
	Str(Str),
	/// Structured JSON retained without normalization.
	Json(Box<RawValue>),
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
	type Value = Value;

	fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("a JSON scalar, array, or object")
	}

	fn visit_unit<E>(self) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Null)
	}

	fn visit_none<E>(self) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Null)
	}

	fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Bool(value))
	}

	fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Int(value))
	}

	fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		i64::try_from(value)
			.map(Value::Int)
			.or_else(|_| Ok(Value::Float(value as f64)))
	}

	fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Float(value))
	}

	fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Str(Str::new(value)))
	}

	fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Str(Str::new(value)))
	}

	fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
	where
		E: de::Error,
	{
		Ok(Value::Str(Str::new(value)))
	}

	fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
	where
		A: MapAccess<'de>,
	{
		let value = serde_json::Value::deserialize(MapAccessDeserializer::new(map))?;
		serde_json::value::to_raw_value(&value)
			.map(Value::Json)
			.map_err(de::Error::custom)
	}

	fn visit_seq<A>(self, seq: A) -> Result<Self::Value, A::Error>
	where
		A: SeqAccess<'de>,
	{
		let value = serde_json::Value::deserialize(SeqAccessDeserializer::new(seq))?;
		serde_json::value::to_raw_value(&value)
			.map(Value::Json)
			.map_err(de::Error::custom)
	}
}

impl<'de> Deserialize<'de> for Value {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		deserializer.deserialize_any(ValueVisitor)
	}
}

impl PartialEq for Value {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Null, Self::Null) => true,
			(Self::Bool(left), Self::Bool(right)) => left == right,
			(Self::Int(left), Self::Int(right)) => left == right,
			(Self::Float(left), Self::Float(right)) => left == right,
			(Self::Str(left), Self::Str(right)) => left == right,
			(Self::Json(left), Self::Json(right)) => left.get() == right.get(),
			_ => false,
		}
	}
}

impl Value {
	/// Returns this value as text when it is a string.
	#[must_use]
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Self::Str(value) => Some(value.as_str()),
			_ => None,
		}
	}
}

/// Node data supplied to an insertion operation.
///
/// A handle is intentionally absent: [`crate::Dom::apply`] mints it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct NodeSpec {
	/// Element name.
	pub tag:     Tag,
	/// Ordered properties.
	#[serde(default, skip_serializing_if = "SmallVec::is_empty")]
	pub props:   SmallVec<(PropKey, Value), 4>,
	/// Optional text content.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub content: Option<Str>,
}

impl NodeSpec {
	/// Creates an empty node specification for `tag`.
	#[must_use]
	pub fn new(tag: impl Into<Tag>) -> Self {
		Self { tag: tag.into(), props: SmallVec::new(), content: None }
	}

	/// Adds or replaces one property.
	#[must_use]
	pub fn with_prop(mut self, key: impl Into<PropKey>, value: Value) -> Self {
		let key = key.into();
		if let Some((_, current)) = self
			.props
			.iter_mut()
			.find(|(candidate, _)| *candidate == key)
		{
			*current = value;
		} else {
			self.props.push((key, value));
		}
		self
	}

	/// Sets text content.
	#[must_use]
	pub fn with_content(mut self, content: impl Into<Str>) -> Self {
		self.content = Some(content.into());
		self
	}
}

/// A materialized DOM node.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Node {
	/// Element name.
	pub tag:     Tag,
	/// Ordered properties.
	pub props:   SmallVec<(PropKey, Value), 4>,
	/// Ordered child handles.
	pub kids:    Vec<Handle>,
	/// Optional text content.
	pub content: Option<Str>,
}

impl Node {
	/// Returns a property value.
	#[must_use]
	pub fn prop(&self, key: &PropKey) -> Option<&Value> {
		self
			.props
			.iter()
			.find(|(candidate, _)| candidate == key)
			.map(|(_, value)| value)
	}

	pub(crate) fn from_spec(spec: NodeSpec) -> Self {
		Self { tag: spec.tag, props: spec.props, kids: Vec::new(), content: spec.content }
	}

	pub(crate) fn set_prop(&mut self, key: PropKey, value: Value) {
		if let Some((_, current)) = self
			.props
			.iter_mut()
			.find(|(candidate, _)| *candidate == key)
		{
			*current = value;
		} else {
			self.props.push((key, value));
		}
	}
}
