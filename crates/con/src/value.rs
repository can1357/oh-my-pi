//! Typed console values and the static type descriptors that constrain them.
//!
//! The console is typed at the *variable*, not the token: scripts carry
//! untyped words, and the target's [`TypeSpec`] decides how a word parses.
//! Enum variables store their canonical variant name as [`Value::Enum`], while
//! the script and replication forms remain human-readable.

use std::fmt;

use omp_core::{
	Str,
	time::{Duration, DurationUnit},
};
use serde::{Deserialize, Serialize, de};
use strum::{Display, IntoStaticStr};

/// Base shape of a [`Value`] or of a [`TypeSpec`].
///
/// `Enum` is the runtime and specification tag for constrained string values.
#[derive(Clone, Copy, Debug, Display, Eq, Hash, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum ValueKind {
	/// `true` / `false` (scripts also accept `1` / `0`).
	Bool,
	/// 64-bit signed integer.
	Int,
	/// 64-bit float.
	Float,
	/// UTF-8 string.
	Str,
	/// Time span: `90s`, `250ms`, `2h`, or `never`.
	Duration,
	/// Enum variant, stored as its canonical name.
	Enum,
	/// Homogeneous list, `[a b c]` in scripts.
	List,
	/// Key/value block, `{key value ...}` in scripts.
	Kv,
}

/// A time span value: finite (`90s`, `250ms`, `2h`) or `never`.
///
/// `Never` means "no bound" — the first-class spelling of what sentinel
/// numbers (`-1`, `0`) encode in ad-hoc timeout settings. Finite spans reuse
/// [`omp_core::time::Duration`], so the unit a user wrote is preserved
/// (`90s` stays `90s`, not `1.5m`). Ordering treats `Never` as greater than
/// every finite span; equality compares elapsed time (`1s == 1000ms`). The
/// wire and dump form is the parse form (`Display`/`FromStr` round-trip).
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Span {
	/// A bounded span.
	Finite(Duration),
	/// No bound ("never"). Greater than every finite span.
	Never,
}

impl Span {
	/// The unbounded span.
	pub const NEVER: Self = Self::Never;

	/// Finite span in milliseconds.
	#[must_use]
	pub const fn millis(value: u64) -> Self {
		Self::Finite(Duration::new(value, DurationUnit::Milliseconds))
	}

	/// Finite span in seconds.
	#[must_use]
	pub const fn secs(value: u64) -> Self {
		Self::Finite(Duration::new(value, DurationUnit::Seconds))
	}

	/// Whether this span is `never`.
	#[must_use]
	pub const fn is_never(self) -> bool {
		matches!(self, Self::Never)
	}

	/// The finite duration, if any.
	#[must_use]
	pub const fn as_finite(self) -> Option<Duration> {
		match self {
			Self::Finite(d) => Some(d),
			Self::Never => None,
		}
	}

	/// Standard-library duration; `None` for `never` (no deadline).
	///
	/// # Panics
	/// On magnitudes exceeding [`std::time::Duration`] (u64 seconds — not
	/// reachable from parsed input in practice).
	#[must_use]
	pub fn to_std(self) -> Option<std::time::Duration> {
		self
			.as_finite()
			.map(|d| d.to_std().expect("span magnitude fits std duration"))
	}
}

impl std::str::FromStr for Span {
	type Err = omp_core::DurationError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		if value.eq_ignore_ascii_case("never") {
			return Ok(Self::Never);
		}
		value.parse::<Duration>().map(Self::Finite)
	}
}

impl fmt::Display for Span {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Finite(d) => write!(f, "{d}"),
			Self::Never => f.write_str("never"),
		}
	}
}

impl Serialize for Span {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.collect_str(self)
	}
}

impl<'de> Deserialize<'de> for Span {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		let text = <&str>::deserialize(deserializer)?;
		text.parse().map_err(de::Error::custom)
	}
}

/// Ordered key/value block — the script literal `{key value ...}`.
///
/// Keys are not deduplicated; repeated keys are preserved in order (the
/// `KeyValues` convention for expressing arrays of named records).
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Kv(pub Vec<(Str, Value)>);

impl Kv {
	/// Empty block.
	#[must_use]
	pub const fn new() -> Self {
		Self(Vec::new())
	}

	/// First value stored under `key`, if any.
	#[must_use]
	pub fn get(&self, key: &str) -> Option<&Value> {
		self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
	}

	/// Number of entries.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether the block has no entries.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Iterate entries in declaration order.
	pub fn iter(&self) -> impl DoubleEndedIterator<Item = (&Str, &Value)> + '_ {
		self.0.iter().map(|(k, v)| (k, v))
	}
}

/// A dynamically typed console value.
///
/// This is the storage, wire (replication [`Patch`](crate::Patch)), and dump
/// representation. Every value renders to a script literal that parses back
/// to an equal value ([`fmt::Display`]).
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum Value {
	/// Boolean flag.
	Bool(bool),
	/// Integer.
	Int(i64),
	/// Float.
	Float(f64),
	/// String.
	Str(Str),
	/// Declared enum variant.
	Enum(Str),
	/// Time span (`90s`, `never`).
	Duration(Span),
	/// Homogeneous list.
	List(Vec<Self>),
	/// Key/value block.
	Kv(Kv),
}

impl Value {
	/// Runtime shape tag.
	#[must_use]
	pub const fn kind(&self) -> ValueKind {
		match self {
			Self::Bool(_) => ValueKind::Bool,
			Self::Int(_) => ValueKind::Int,
			Self::Float(_) => ValueKind::Float,
			Self::Str(_) => ValueKind::Str,
			Self::Enum(_) => ValueKind::Enum,
			Self::Duration(_) => ValueKind::Duration,
			Self::List(_) => ValueKind::List,
			Self::Kv(_) => ValueKind::Kv,
		}
	}

	/// Boolean payload, if this is a `Bool`.
	#[must_use]
	pub const fn as_bool(&self) -> Option<bool> {
		match self {
			Self::Bool(b) => Some(*b),
			_ => None,
		}
	}

	/// Integer payload, if this is an `Int`.
	#[must_use]
	pub const fn as_int(&self) -> Option<i64> {
		match self {
			Self::Int(i) => Some(*i),
			_ => None,
		}
	}

	/// Float payload, if this is a `Float`.
	#[must_use]
	pub const fn as_float(&self) -> Option<f64> {
		match self {
			Self::Float(f) => Some(*f),
			_ => None,
		}
	}

	/// String payload, if this is a `Str`.
	#[must_use]
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Self::Str(s) | Self::Enum(s) => Some(s.as_str()),
			_ => None,
		}
	}

	/// List payload, if this is a `List`.
	#[must_use]
	pub fn as_list(&self) -> Option<&[Self]> {
		match self {
			Self::List(v) => Some(v),
			_ => None,
		}
	}

	/// Block payload, if this is a `Kv`.
	#[must_use]
	pub const fn as_kv(&self) -> Option<&Kv> {
		match self {
			Self::Kv(kv) => Some(kv),
			_ => None,
		}
	}

	/// Span payload, if this is a `Duration`.
	#[must_use]
	pub const fn as_span(&self) -> Option<Span> {
		match self {
			Self::Duration(s) => Some(*s),
			_ => None,
		}
	}
}

/// Whether `text` can appear as a bare (unquoted) word in a script.
pub fn is_bare_word(text: &str) -> bool {
	!text.is_empty()
		&& !text.contains(['"', ';', '{', '}', '[', ']', '\\'])
		&& !text.contains("//")
		&& !text.chars().any(char::is_whitespace)
}

/// Write `text` as a script atom, quoting and escaping when required.
pub fn write_atom(f: &mut impl fmt::Write, text: &str) -> fmt::Result {
	if is_bare_word(text) {
		return f.write_str(text);
	}
	f.write_char('"')?;
	for ch in text.chars() {
		match ch {
			'"' => f.write_str("\\\"")?,
			'\\' => f.write_str("\\\\")?,
			'\n' => f.write_str("\\n")?,
			'\t' => f.write_str("\\t")?,
			_ => f.write_char(ch)?,
		}
	}
	f.write_char('"')
}

impl fmt::Display for Value {
	/// Renders the script literal form; `parse(format!("{v}"))` round-trips.
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Bool(b) => write!(f, "{b}"),
			Self::Int(i) => write!(f, "{i}"),
			Self::Float(x) => write!(f, "{x}"),
			Self::Str(s) => write_atom(f, s.as_str()),
			Self::Enum(s) => write_atom(f, s.as_str()),
			Self::Duration(s) => write!(f, "{s}"),
			Self::List(items) => {
				f.write_str("[")?;
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						f.write_str(" ")?;
					}
					write!(f, "{item}")?;
				}
				f.write_str("]")
			},
			Self::Kv(kv) => {
				f.write_str("{")?;
				for (i, (k, v)) in kv.iter().enumerate() {
					if i > 0 {
						f.write_str(" ")?;
					}
					write_atom(f, k.as_str())?;
					f.write_str(" ")?;
					write!(f, "{v}")?;
				}
				f.write_str("}")
			},
		}
	}
}

/// Static descriptor of a variable or command-argument type.
///
/// Descriptors usually come from [`ConType::SPEC`]. Owned dynamic console
/// specs borrow these immutable type descriptors while the registry owns all
/// runtime names, documentation, defaults, and handlers.
#[derive(Debug)]
pub struct TypeSpec {
	/// Base shape.
	pub kind:        ValueKind,
	/// Element descriptor when `kind == List`.
	pub elem:        Option<&'static Self>,
	/// Variant names in declaration order when `kind == Enum`.
	pub variants:    &'static [&'static str],
	/// Rejects `never` when `kind == Duration` (finite-only spans).
	pub finite_only: bool,
}

impl TypeSpec {
	/// Descriptor for [`ValueKind::Bool`].
	pub const BOOL: &'static Self = &Self {
		kind:        ValueKind::Bool,
		elem:        None,
		variants:    &[],
		finite_only: false,
	};
	/// Descriptor for [`ValueKind::Duration`].
	pub const DURATION: &'static Self = &Self {
		kind:        ValueKind::Duration,
		elem:        None,
		variants:    &[],
		finite_only: false,
	};
	/// Finite-only [`ValueKind::Duration`] descriptor (rejects `never`).
	pub const DURATION_FINITE: &'static Self = &Self {
		kind:        ValueKind::Duration,
		elem:        None,
		variants:    &[],
		finite_only: true,
	};
	/// Descriptor for [`ValueKind::Float`].
	pub const FLOAT: &'static Self = &Self {
		kind:        ValueKind::Float,
		elem:        None,
		variants:    &[],
		finite_only: false,
	};
	/// Descriptor for [`ValueKind::Int`].
	pub const INT: &'static Self = &Self {
		kind:        ValueKind::Int,
		elem:        None,
		variants:    &[],
		finite_only: false,
	};
	/// Descriptor for [`ValueKind::Kv`].
	pub const KV: &'static Self =
		&Self { kind: ValueKind::Kv, elem: None, variants: &[], finite_only: false };
	/// Descriptor for [`ValueKind::Str`].
	pub const STR: &'static Self = &Self {
		kind:        ValueKind::Str,
		elem:        None,
		variants:    &[],
		finite_only: false,
	};

	/// Whether `value` structurally conforms to this descriptor (kind match,
	/// enum membership, element conformance).
	#[must_use]
	pub fn conforms(&self, value: &Value) -> bool {
		match self.kind {
			ValueKind::Enum => match value.as_str() {
				Some(s) => self.variants.contains(&s),
				None => false,
			},
			ValueKind::Duration => match value.as_span() {
				Some(span) => !(self.finite_only && span.is_never()),
				None => false,
			},
			ValueKind::List => match value.as_list() {
				Some(items) => {
					let elem = self.elem.unwrap_or(Self::STR);
					items.iter().all(|v| elem.conforms(v))
				},
				None => false,
			},
			kind => value.kind() == kind,
		}
	}
}

/// Rust ⇄ console type bridge: gives a type its [`TypeSpec`] and its
/// [`Value`] conversions. Implemented for primitives, [`Str`], `Vec<T>`,
/// [`Kv`], and — via [`con_enum!`](crate::con_enum) — strum-derived enums.
pub trait ConType: Sized {
	/// Static descriptor for this type.
	const SPEC: &'static TypeSpec;

	/// Wrap into a dynamic value. Must produce a value that
	/// [`TypeSpec::conforms`] accepts against [`Self::SPEC`].
	fn into_value(self) -> Value;

	/// Extract from a dynamic value; `None` on shape mismatch.
	fn from_value(value: &Value) -> Option<Self>;
}

impl ConType for bool {
	const SPEC: &'static TypeSpec = TypeSpec::BOOL;

	fn into_value(self) -> Value {
		Value::Bool(self)
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_bool()
	}
}

macro_rules! int_con_type {
	($($ty:ty),+) => {$(
		impl ConType for $ty {
			const SPEC: &'static TypeSpec = TypeSpec::INT;

			fn into_value(self) -> Value {
				Value::Int(self as i64)
			}

			fn from_value(value: &Value) -> Option<Self> {
				value.as_int().and_then(|i| <$ty>::try_from(i).ok())
			}
		}
	)+};
}
int_con_type!(i8, i16, i32, i64, u8, u16, u32);

impl ConType for f64 {
	const SPEC: &'static TypeSpec = TypeSpec::FLOAT;

	fn into_value(self) -> Value {
		Value::Float(self)
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_float()
	}
}

impl ConType for f32 {
	const SPEC: &'static TypeSpec = TypeSpec::FLOAT;

	fn into_value(self) -> Value {
		Value::Float(f64::from(self))
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_float().map(|f| f as Self)
	}
}

impl ConType for Str {
	const SPEC: &'static TypeSpec = TypeSpec::STR;

	fn into_value(self) -> Value {
		Value::Str(self)
	}

	fn from_value(value: &Value) -> Option<Self> {
		match value {
			Value::Str(s) => Some(s.clone()),
			_ => None,
		}
	}
}

impl<T: ConType> ConType for Vec<T> {
	const SPEC: &'static TypeSpec = &TypeSpec {
		kind:        ValueKind::List,
		elem:        Some(T::SPEC),
		variants:    &[],
		finite_only: false,
	};

	fn into_value(self) -> Value {
		Value::List(self.into_iter().map(ConType::into_value).collect())
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_list()?.iter().map(T::from_value).collect()
	}
}

impl ConType for Kv {
	const SPEC: &'static TypeSpec = TypeSpec::KV;

	fn into_value(self) -> Value {
		Value::Kv(self)
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_kv().cloned()
	}
}
impl ConType for Span {
	const SPEC: &'static TypeSpec = TypeSpec::DURATION;

	fn into_value(self) -> Value {
		Value::Duration(self)
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_span()
	}
}

/// Finite-only duration vars: typing a var as [`omp_core::time::Duration`]
/// rejects `never` at the parse boundary.
impl ConType for Duration {
	const SPEC: &'static TypeSpec = TypeSpec::DURATION_FINITE;

	fn into_value(self) -> Value {
		Value::Duration(Span::Finite(self))
	}

	fn from_value(value: &Value) -> Option<Self> {
		value.as_span()?.as_finite()
	}
}

/// Implements [`ConType`] for a strum-derived fieldless enum, making it
/// usable as a var/argument type with automatic variant completion.
///
/// The enum must derive `Copy`, `strum::VariantNames`, `strum::EnumString`,
/// and `strum::IntoStaticStr`.
///
/// ```ignore
/// #[derive(Clone, Copy, strum::VariantNames, strum::EnumString, strum::IntoStaticStr)]
/// #[strum(serialize_all = "lowercase")]
/// enum BotSkill { Easy, Normal, Hard }
/// omp_con::con_enum!(BotSkill);
/// ```
#[macro_export]
macro_rules! con_enum {
	($ty:ty) => {
		impl $crate::ConType for $ty {
			const SPEC: &'static $crate::TypeSpec = &$crate::TypeSpec {
				kind:        $crate::ValueKind::Enum,
				elem:        None,
				variants:    <$ty as $crate::__private::strum::VariantNames>::VARIANTS,
				finite_only: false,
			};

			fn into_value(self) -> $crate::Value {
				let name: &'static str = self.into();
				$crate::Value::Enum($crate::__private::Str::new_static(name))
			}

			fn from_value(value: &$crate::Value) -> Option<Self> {
				value.as_str()?.parse().ok()
			}
		}
	};
}
