//! Typed component properties with allocation-free well-known slots.

use std::{str::FromStr, time::Duration};

use omp_core::{IntoStr, Str, sf};
use strum::{Display, EnumIter, EnumString};

use crate::{
	anim::Easing,
	context::Theme,
	frame::{Color, Style},
	markup::{Align, Border, Dim, Justify, TextWrap, Truncate, VAlign},
};

/// A parsed component property value at the dynamic markup boundary.
#[derive(Clone, Debug, PartialEq)]
pub enum PropValue {
	/// Boolean flag.
	Bool(bool),
	/// Unsigned cell count or angle.
	U16(u16),
	/// Unsigned application count or timestamp.
	U64(u64),
	/// Floating-point layout weight.
	F32(f32),
	/// Signed numeric field value.
	I64(i64),
	/// Resolved terminal color.
	Color(Color),
	/// Theme color token resolved at render time.
	Token(Str),
	/// A validated `start..end` ramp resolved by the renderer's theme.
	Gradient(Str),
	/// Cell or percentage dimension.
	Dim(Dim),
	/// Border glyph family.
	Border(Border),
	/// Horizontal alignment.
	Align(Align),
	/// Vertical alignment.
	VAlign(VAlign),
	/// Child distribution along the layout axis.
	Justify(Justify),
	/// Text wrapping mode.
	Wrap(TextWrap),
	/// Uninterpreted textual value.
	Str(Str),
	/// Easing curve for `anim` transitions.
	Easing(Easing),
}

#[derive(Clone, Debug, PartialEq)]
enum PropColor {
	Solid(Color),
	Token(Str),
	Gradient(Str),
}

#[derive(Clone, Debug, PartialEq)]
enum Number {
	U16(u16),
	F32(f32),
	I64(i64),
}

#[derive(Clone, Debug, PartialEq)]
enum Scalar {
	Bool(bool),
	U16(u16),
	U64(u64),
	F32(f32),
	I64(i64),
	Str(Str),
}

#[derive(Clone, Debug, PartialEq)]
enum Toggle<T> {
	Off,
	Flag(T),
	Value(T),
}

impl<T> Toggle<T> {
	const fn value(&self) -> Option<&T> {
		match self {
			Self::Off => None,
			Self::Flag(value) | Self::Value(value) => Some(value),
		}
	}
}

/// Value a toggle property assumes when written as a bare flag.
trait BareFlag: Sized {
	const ON: Self;
}

impl BareFlag for f32 {
	/// `grow` claims one share.
	const ON: Self = 1.0;
}

impl BareFlag for u16 {
	/// `lift` rises one row.
	const ON: Self = 1;
}

impl BareFlag for Truncate {
	/// `truncate` clips the tail.
	const ON: Self = Self::End;
}

impl BareFlag for Border {
	/// `guides` draws the square connector set.
	const ON: Self = Self::Square;
}

#[derive(Clone, Debug, PartialEq)]
enum WrapValue {
	Rows(bool),
	Text(TextWrap),
}

#[derive(Clone, Debug, PartialEq)]
enum FilterValue {
	Enabled(bool),
	Query(Str),
}

/// Property duration in whole milliseconds; a bare flag selects `DEFAULT`.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(transparent)]
struct Ms<const DEFAULT: u64>(Duration);

impl<const DEFAULT: u64> BareFlag for Ms<DEFAULT> {
	const ON: Self = Self(Duration::from_millis(DEFAULT));
}

impl<const DEFAULT: u64> From<Ms<DEFAULT>> for Duration {
	fn from(value: Ms<DEFAULT>) -> Self {
		value.0
	}
}

impl<const DEFAULT: u64> FromStr for Ms<DEFAULT> {
	type Err = ();

	/// Parses `250`, `250ms`, or `0.4s` into whole milliseconds.
	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let value = value.trim();
		let millis: u16 = if let Some(millis) = value.strip_suffix("ms") {
			millis.trim().parse().map_err(|_| ())?
		} else if let Some(seconds) = value.strip_suffix('s') {
			let seconds: f32 = seconds.trim().parse().map_err(|_| ())?;
			if !(0.0..=65.0).contains(&seconds) {
				return Err(());
			}
			(seconds * 1000.0).round() as u16
		} else {
			value.parse().map_err(|_| ())?
		};
		Ok(Self(Duration::from_millis(u64::from(millis))))
	}
}

/// Gradient direction wrapped into `0..360` screen degrees.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(transparent)]
struct Angle(u16);

impl From<Angle> for u16 {
	fn from(value: Angle) -> Self {
		value.0
	}
}

impl FromStr for Angle {
	type Err = ();

	/// Parses `90`, `-90`, or `270deg`.
	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let value = value.trim();
		let value = value.strip_suffix("deg").unwrap_or(value);
		let degrees: i32 = value.parse().map_err(|_| ())?;
		Ok(Self(degrees.rem_euclid(360) as u16))
	}
}

macro_rules! define_prop_getter {
	($field:ident[ref $type:ty; $doc:literal]) => {
		#[doc = $doc]
		pub const fn $field(&self) -> Option<&$type> {
			self.$field.as_ref()
		}
	};
	($field:ident[copy $type:ty; $doc:literal]) => {
		#[doc = $doc]
		pub const fn $field(&self) -> Option<$type> {
			self.$field
		}
	};
	($field:ident[default $type:ty = $default:expr; $doc:literal]) => {
		#[doc = $doc]
		pub fn $field(&self) -> $type {
			self.$field.map_or($default, Into::into)
		}
	};
	($field:ident[toggle $type:ty; $doc:literal]) => {
		#[doc = $doc]
		pub fn $field(&self) -> Option<$type> {
			self
				.$field
				.as_ref()
				.and_then(Toggle::value)
				.copied()
				.map(Into::into)
		}
	};
	($field:ident[toggle_default $type:ty = $default:expr; $doc:literal]) => {
		#[doc = $doc]
		pub fn $field(&self) -> $type {
			self
				.$field
				.as_ref()
				.and_then(Toggle::value)
				.copied()
				.map_or($default, Into::into)
		}
	};
}

macro_rules! define_props {
	(
		$(
			$(#[$meta:meta])*
			$variant:ident($name:literal)
			$(@ $setter:ident)?
			$(=> $field:ident: $type:ty $([$($getter:tt)+])?)?;
		)+
	) => {
		/// A well-known component property used by markup and dynamic updates.
		#[repr(u8)]
		#[derive(Clone, Copy, Debug, Eq, PartialEq, Display, EnumIter, EnumString)]
		pub enum Prop {
			$(
				$(#[$meta])*
				#[strum(serialize = $name)]
				$variant,
			)+
		}

		/// Component attributes with one concrete slot per well-known property.
		#[derive(Clone, Debug, Default)]
		pub struct Props {
			$($(	$field: Option<$type>,)?)+
			rest: Vec<(Str, PropValue)>,
		}

		impl Props {
			$($($(define_prop_getter!($field [$($getter)+]);)?)?)+

			fn value(&self, prop: Prop) -> Option<PropValue> {
				match prop {
					$($(Prop::$variant => self.$field.as_ref().map(ToPropValue::to_prop_value),)?)+
					$($(Prop::$variant => {
						let _ = stringify!($setter);
						None
					},)?)+
				}
			}

			const fn contains_known(&self, prop: Prop) -> bool {
				match prop {
					$($(Prop::$variant => self.$field.is_some(),)?)+
					$($(Prop::$variant => {
						let _ = stringify!($setter);
						false
					},)?)+
				}
			}

			fn store(&mut self, prop: Prop, value: PropValue) -> Result<(), PropError> {
				match prop {
					$($(
						Prop::$variant => {
							self.$field = Some(<$type as FromPropValue>::from_prop(prop, value)?);
							Ok(())
						},
					)?)+
					$($(Prop::$variant => self.$setter(value),)?)+
				}
			}

			fn clear(&mut self, prop: Prop) {
				match prop {
					$($(Prop::$variant => self.$field = None,)?)+
					$($(Prop::$variant => {
						let _ = stringify!($setter);
					},)?)+
				}
			}
		}
	};
}

omp_vocab::for_each_prop! { define_props }

/// A property value rejected by the key-aware parser.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("bad value {value:?} for property {prop:?}")]
pub struct PropError {
	pub prop:  Prop,
	pub value: Str,
}

trait ToPropValue {
	fn to_prop_value(&self) -> PropValue;
}

macro_rules! to_prop_value {
	($type:ty, $variant:ident) => {
		impl ToPropValue for $type {
			fn to_prop_value(&self) -> PropValue {
				PropValue::$variant(self.clone())
			}
		}
	};
}

to_prop_value!(Color, Color);
to_prop_value!(bool, Bool);
to_prop_value!(u16, U16);
to_prop_value!(u64, U64);
to_prop_value!(f32, F32);
to_prop_value!(i64, I64);
to_prop_value!(Str, Str);
to_prop_value!(Dim, Dim);
to_prop_value!(Border, Border);
to_prop_value!(Align, Align);
to_prop_value!(VAlign, VAlign);
to_prop_value!(Justify, Justify);
to_prop_value!(TextWrap, Wrap);
to_prop_value!(Easing, Easing);

impl ToPropValue for PropColor {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::Solid(value) => PropValue::Color(*value),
			Self::Token(value) => PropValue::Token(value.clone()),
			Self::Gradient(value) => PropValue::Gradient(value.clone()),
		}
	}
}

impl ToPropValue for Number {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::U16(value) => PropValue::U16(*value),
			Self::F32(value) => PropValue::F32(*value),
			Self::I64(value) => PropValue::I64(*value),
		}
	}
}

impl ToPropValue for Scalar {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::Bool(value) => PropValue::Bool(*value),
			Self::U16(value) => PropValue::U16(*value),
			Self::U64(value) => PropValue::U64(*value),
			Self::F32(value) => PropValue::F32(*value),
			Self::I64(value) => PropValue::I64(*value),
			Self::Str(value) => PropValue::Str(value.clone()),
		}
	}
}

impl<T: ToPropValue> ToPropValue for Toggle<T> {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::Off => PropValue::Bool(false),
			Self::Flag(_) => PropValue::Bool(true),
			Self::Value(value) => value.to_prop_value(),
		}
	}
}

impl ToPropValue for WrapValue {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::Rows(value) => PropValue::Bool(*value),
			Self::Text(value) => PropValue::Wrap(*value),
		}
	}
}

impl ToPropValue for FilterValue {
	fn to_prop_value(&self) -> PropValue {
		match self {
			Self::Enabled(value) => PropValue::Bool(*value),
			Self::Query(value) => PropValue::Str(value.clone()),
		}
	}
}

impl ToPropValue for Truncate {
	fn to_prop_value(&self) -> PropValue {
		PropValue::Str(Str::new_static((*self).into()))
	}
}

impl ToPropValue for Angle {
	fn to_prop_value(&self) -> PropValue {
		PropValue::U16(self.0)
	}
}

impl<const DEFAULT: u64> ToPropValue for Ms<DEFAULT> {
	fn to_prop_value(&self) -> PropValue {
		let millis = u16::try_from(self.0.as_millis()).expect("property durations fit in u16");
		PropValue::U16(millis)
	}
}

impl Props {
	/// Creates an empty property collection.
	pub fn new() -> Self {
		Self::default()
	}

	/// Returns this collection with a known property assigned.
	///
	/// # Panics
	///
	/// Panics when `value` is invalid for the selected property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		self.set(prop, value);
		self
	}

	/// Assigns a known property.
	///
	/// # Panics
	///
	/// Panics when `value` is invalid for the selected property.
	pub fn set(&mut self, prop: Prop, value: impl Into<PropValue>) {
		if let Err(error) = self.try_set(prop, value.into()) {
			panic!("{error}")
		}
	}

	/// Validates and assigns a known property.
	///
	/// # Errors
	///
	/// Returns `PropError` when `value` is incompatible with the selected
	/// typed slot.
	pub fn try_set(&mut self, prop: Prop, value: PropValue) -> Result<(), PropError> {
		self.store(prop, value)
	}

	/// Returns the canonical dynamic value assigned to a known property.
	pub fn get(&self, prop: Prop) -> Option<PropValue> {
		self.value(prop)
	}

	/// Reports whether a known property has an assigned value.
	pub const fn contains(&self, prop: Prop) -> bool {
		self.contains_known(prop)
	}

	/// Removes a known property, restoring its unset default.
	pub fn unset(&mut self, prop: Prop) {
		self.clear(prop);
	}

	/// Formats a known property value using its markup representation.
	pub fn get_str(&self, prop: Prop) -> Option<Str> {
		self.get(prop).map(|value| display_value(&value))
	}

	/// Returns this collection with a custom property assigned.
	pub fn with_custom(mut self, name: impl IntoStr, value: impl Into<PropValue>) -> Self {
		self.set_custom(name, value);
		self
	}

	/// Assigns or replaces a custom property.
	pub fn set_custom(&mut self, name: impl IntoStr, value: impl Into<PropValue>) {
		let name = name.into_str();
		let value = value.into();
		if let Some((_, stored)) = self.rest.iter_mut().find(|(key, _)| key == &name) {
			*stored = value;
		} else {
			self.rest.push((name, value));
		}
	}

	/// Returns a custom property by its literal name.
	pub fn custom(&self, name: &str) -> Option<&PropValue> {
		self
			.rest
			.iter()
			.find(|(key, _)| key == name)
			.map(|(_, value)| value)
	}

	/// Returns either a known or custom property by markup name.
	pub fn named(&self, name: &str) -> Option<PropValue> {
		Self::prop_of(name)
			.and_then(|prop| self.get(prop))
			.or_else(|| self.custom(name).cloned())
	}

	/// Resolves a markup attribute name to its well-known property.
	pub fn prop_of(name: &str) -> Option<Prop> {
		name.parse().ok()
	}

	/// Returns vertical and horizontal padding, defaulting to zero.
	pub fn pad(&self) -> (u16, u16) {
		(self.pad_y.unwrap_or(0), self.pad_x.unwrap_or(0))
	}

	/// Returns the minimum width when represented as an unsigned cell count.
	pub const fn min(&self) -> Option<u16> {
		match self.min {
			Some(Number::U16(value)) => Some(value),
			_ => None,
		}
	}

	/// Returns the maximum width when represented as an unsigned cell count.
	pub const fn max(&self) -> Option<u16> {
		match self.max {
			Some(Number::U16(value)) => Some(value),
			_ => None,
		}
	}

	/// Returns the text wrapping mode, defaulting to word boundaries.
	pub const fn text_wrap(&self) -> TextWrap {
		match self.wrap {
			Some(WrapValue::Text(value)) => value,
			_ => TextWrap::Word,
		}
	}

	/// Reports whether hover styling or elevation is declared.
	pub(crate) fn hover_decorated(&self) -> bool {
		self.hover.is_some() || self.lift() > 0
	}

	/// Returns a gradient payload for a color-bearing property.
	pub(crate) const fn gradient_of(&self, prop: Prop) -> Option<&Str> {
		match self.color_slot(prop) {
			Some(PropColor::Gradient(value)) => Some(value),
			_ => None,
		}
	}

	/// Reports whether a boolean or bare-flag property is enabled.
	pub fn flag(&self, prop: Prop) -> bool {
		matches!(self.value(prop), Some(PropValue::Bool(true)))
	}

	/// Returns the borrowed textual payload of a property.
	pub const fn str_of(&self, prop: Prop) -> Option<&Str> {
		match prop {
			Prop::Title => self.title.as_ref(),
			Prop::Footer => self.footer.as_ref(),
			Prop::Overflow => self.overflow.as_ref(),
			Prop::Sep => self.sep.as_ref(),
			Prop::Id => self.id.as_ref(),
			Prop::When => self.when.as_ref(),
			Prop::Value => match self.value.as_ref() {
				Some(Scalar::Str(value)) => Some(value),
				_ => None,
			},
			Prop::Key => self.key.as_ref(),
			Prop::Options => self.options.as_ref(),
			Prop::Variant => self.variant.as_ref(),
			Prop::Label => self.label.as_ref(),
			Prop::Numbering => self.numbering.as_ref(),
			Prop::Prefix => self.prefix.as_ref(),
			Prop::Annotation => self.annotation.as_ref(),
			Prop::Action => self.action.as_ref(),
			Prop::Desc => self.desc.as_ref(),
			Prop::Kind => self.kind.as_ref(),
			Prop::Filter => match self.filter.as_ref() {
				Some(FilterValue::Query(value)) => Some(value),
				_ => None,
			},
			Prop::Match => self.match_pattern.as_ref(),
			Prop::Src => self.src.as_ref(),
			Prop::Href => self.href.as_ref(),
			Prop::Path => self.path.as_ref(),
			Prop::Icon => self.icon.as_ref(),
			Prop::Badge => self.badge.as_ref(),
			Prop::Placeholder => self.placeholder.as_ref(),
			Prop::Status => self.status.as_ref(),
			Prop::Zone => self.zone.as_ref(),
			_ => None,
		}
	}

	/// Resolves colors and text attributes into a render style.
	///
	/// `color` acts as a foreground alias when `fg` is absent, so glyph-like
	/// nodes (`<icon color=err/>`, `<spinner color=accent/>`) take coloring
	/// attributes directly. Components that give `color` a richer meaning
	/// (button tint, tree-node accents) read the slot themselves and bypass
	/// this alias.
	pub fn style(&self, theme: &Theme) -> Style {
		let mut style = Style::new();
		if let Some(color) = self.foreground(theme) {
			style = style.fg(color);
		}
		let background = if self.bg.is_some() {
			self.color(Prop::Bg, theme)
		} else {
			self.color(Prop::On, theme)
		};
		if let Some(color) = background {
			style = style.bg(color);
		}
		if self.bold == Some(true) {
			style = style.bold();
		}
		if self.dim == Some(true) {
			style = style.dim();
		}
		if self.italic == Some(true) {
			style = style.italic();
		}
		if self.underline == Some(true) {
			style = style.underline();
		}
		if self.undercurl == Some(true) {
			style = style.undercurl();
		}
		if self.reverse == Some(true) {
			style = style.reverse();
		}
		if self.strike == Some(true) {
			style = style.strikethrough();
		}
		if let Some(href) = self.href.as_deref() {
			style = style.link(href);
		}
		style
	}

	/// Resolves the border color from either supported attribute name.
	pub fn edge(&self, theme: &Theme) -> Option<Color> {
		self
			.color(Prop::Bc, theme)
			.or_else(|| self.color(Prop::Edge, theme))
	}

	/// Resolves the effective foreground: `fg` when set (even as a gradient,
	/// which resolves to `None` here and is ramped by the renderer), else the
	/// `color` alias.
	pub fn foreground(&self, theme: &Theme) -> Option<Color> {
		if self.fg.is_some() {
			self.color(Prop::Fg, theme)
		} else {
			self.color(Prop::Color, theme)
		}
	}

	/// Whether an explicit foreground (`fg` or its `color` alias) is
	/// configured, so themed fallbacks know to stand down.
	pub const fn has_foreground(&self) -> bool {
		self.fg.is_some() || self.color.is_some()
	}

	const fn color_slot(&self, prop: Prop) -> Option<&PropColor> {
		match prop {
			Prop::Fg => self.fg.as_ref(),
			Prop::Bg => self.bg.as_ref(),
			Prop::On => self.on.as_ref(),
			Prop::Bc => self.bc.as_ref(),
			Prop::Edge => self.edge.as_ref(),
			Prop::Hover => self.hover.as_ref(),
			Prop::Color => self.color.as_ref(),
			Prop::AnnotationColor => self.annotation_color.as_ref(),
			Prop::ActionColor => self.action_color.as_ref(),
			_ => None,
		}
	}

	/// Resolves a color-bearing property against the active theme.
	pub fn color(&self, prop: Prop, theme: &Theme) -> Option<Color> {
		match self.color_slot(prop)? {
			PropColor::Solid(value) => Some(*value),
			PropColor::Token(value) => theme.token(value),
			PropColor::Gradient(_) => None,
		}
	}

	fn set_pad(&mut self, value: PropValue) -> Result<(), PropError> {
		let (y, x) = match value {
			PropValue::U16(value) => (value, value),
			PropValue::Str(value) => {
				let mut parts = value.split_whitespace();
				let y = parts
					.next()
					.map_or(Ok(0), str::parse)
					.map_err(|_| PropError { prop: Prop::Pad, value: value.clone() })?;
				let x = parts
					.next()
					.map_or(Ok(y), str::parse)
					.map_err(|_| PropError { prop: Prop::Pad, value: value.clone() })?;
				if parts.next().is_some() {
					return Err(PropError { prop: Prop::Pad, value });
				}
				(y, x)
			},
			value => return Err(bad_value(Prop::Pad, &value)),
		};
		self.pad_y = Some(y);
		self.pad_x = Some(x);
		Ok(())
	}
}

/// Converts a dynamic [`PropValue`] into a typed slot; string forms delegate
/// to the slot type's [`FromStr`].
trait FromPropValue: Sized {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError>;
}

/// Accepts the slot's exact [`PropValue`] variant plus the string form via
/// [`FromStr`].
macro_rules! from_prop_value {
	($type:ty, $variant:ident) => {
		impl FromPropValue for $type {
			fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
				match value {
					PropValue::$variant(value) => Ok(value),
					PropValue::Str(value) => parse_as(prop, value),
					value => Err(bad_value(prop, &value)),
				}
			}
		}
	};
}

from_prop_value!(u16, U16);
from_prop_value!(u64, U64);
from_prop_value!(f32, F32);
from_prop_value!(Border, Border);
from_prop_value!(Align, Align);
from_prop_value!(VAlign, VAlign);
from_prop_value!(Justify, Justify);
from_prop_value!(TextWrap, Wrap);
from_prop_value!(Easing, Easing);

impl FromPropValue for bool {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			// Bare attribute presence; explicit strings must spell a bool.
			PropValue::Bool(value) => Ok(value),
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Str {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Str(value) => Ok(value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for i64 {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::U16(value) => Ok(Self::from(value)),
			PropValue::I64(value) => Ok(value),
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Dim {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Dim(value) => Ok(value),
			PropValue::U16(value) => Ok(Self::Cells(value)),
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Truncate {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Angle {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::U16(value) => Ok(Self(value % 360)),
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl<const DEFAULT: u64> FromPropValue for Ms<DEFAULT> {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::U16(value) => Ok(Self(Duration::from_millis(u64::from(value)))),
			PropValue::Str(value) => parse_as(prop, value),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Number {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::U16(value) => Ok(Self::U16(value)),
			PropValue::F32(value) => Ok(Self::F32(value)),
			PropValue::I64(value) => Ok(Self::I64(value)),
			PropValue::Str(value) => parse_as(prop, value).map(Self::U16),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for Scalar {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Bool(value) => Ok(Self::Bool(value)),
			PropValue::U16(value) => Ok(Self::U16(value)),
			PropValue::U64(value) => Ok(Self::U64(value)),
			PropValue::F32(value) => Ok(Self::F32(value)),
			PropValue::I64(value) => Ok(Self::I64(value)),
			PropValue::Str(value) => Ok(Self::Str(value)),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for PropColor {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Color(value) => Ok(Self::Solid(value)),
			PropValue::Token(value) => Ok(Self::Token(value)),
			PropValue::Gradient(value) => Ok(Self::Gradient(value)),
			PropValue::Str(value) if is_gradient(&value) => Ok(Self::Gradient(value)),
			PropValue::Str(value) if is_theme_token(&value) => Ok(Self::Token(value)),
			PropValue::Str(value) => Color::parse(&value)
				.map(Self::Solid)
				.ok_or_else(|| PropError { prop, value }),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl FromPropValue for WrapValue {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Bool(value) => Ok(Self::Rows(value)),
			value => TextWrap::from_prop(prop, value).map(Self::Text),
		}
	}
}

impl FromPropValue for FilterValue {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Bool(value) => Ok(Self::Enabled(value)),
			PropValue::Str(value) => Ok(Self::Query(value)),
			value => Err(bad_value(prop, &value)),
		}
	}
}

impl<T: BareFlag + FromPropValue> FromPropValue for Toggle<T> {
	fn from_prop(prop: Prop, value: PropValue) -> Result<Self, PropError> {
		match value {
			PropValue::Bool(false) => Ok(Self::Off),
			PropValue::Bool(true) => Ok(Self::Flag(T::ON)),
			value => T::from_prop(prop, value).map(Self::Value),
		}
	}
}

fn parse_as<T: FromStr>(prop: Prop, value: Str) -> Result<T, PropError> {
	value.parse().map_err(|_| PropError { prop, value })
}

fn bad_value(prop: Prop, value: &PropValue) -> PropError {
	PropError { prop, value: display_value(value) }
}

fn is_theme_token(value: &str) -> bool {
	Theme::is_token(value)
}

fn is_gradient(value: &str) -> bool {
	let Some((start, end)) = value.split_once("..") else {
		return false;
	};
	is_color(start) && is_color(end)
}

fn is_color(value: &str) -> bool {
	is_theme_token(value) || Color::parse(value).is_some()
}

fn display_value(value: &PropValue) -> Str {
	match value {
		PropValue::Bool(value) => Str::new(if *value { "true" } else { "false" }),
		PropValue::U16(value) => Str::from(value.to_string()),
		PropValue::U64(value) => Str::from(value.to_string()),
		PropValue::F32(value) => Str::from(value.to_string()),
		PropValue::I64(value) => Str::from(value.to_string()),
		PropValue::Color(Color::Default) => sf!("default"),
		PropValue::Color(Color::Indexed(value)) => Str::from(value.to_string()),
		PropValue::Color(Color::Rgb(r, g, b)) => Str::from(format!("#{r:02x}{g:02x}{b:02x}")),
		PropValue::Token(value) | PropValue::Gradient(value) | PropValue::Str(value) => value.clone(),
		PropValue::Easing(value) => sf!((*value).into()),
		PropValue::Dim(Dim::Cells(value)) => Str::from(value.to_string()),
		PropValue::Dim(Dim::Pct(value)) => Str::from(format!("{value}%")),
		PropValue::Border(value) => sf!((*value).into()),
		PropValue::Align(value) => sf!((*value).into()),
		PropValue::VAlign(value) => sf!((*value).into()),
		PropValue::Justify(value) => sf!((*value).into()),
		PropValue::Wrap(value) => sf!((*value).into()),
	}
}

macro_rules! from_value {
	($type:ty, $variant:ident) => {
		impl From<$type> for PropValue {
			fn from(value: $type) -> Self {
				Self::$variant(value)
			}
		}
	};
}
from_value!(Color, Color);
from_value!(bool, Bool);
from_value!(u16, U16);
from_value!(u64, U64);
from_value!(f32, F32);
from_value!(i64, I64);
from_value!(Str, Str);
from_value!(Dim, Dim);
from_value!(Border, Border);
from_value!(Align, Align);
from_value!(VAlign, VAlign);
from_value!(Justify, Justify);
from_value!(Easing, Easing);
impl From<&str> for PropValue {
	fn from(value: &str) -> Self {
		Self::Str(Str::new(value))
	}
}
/// Millisecond count for `ms`-valued props, saturating at `u64::MAX`.
impl From<Duration> for PropValue {
	fn from(value: Duration) -> Self {
		Self::U64(u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
	}
}
impl From<String> for PropValue {
	fn from(value: String) -> Self {
		Self::Str(value.into())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn known_values_parse_at_set_time() {
		assert_eq!(
			Props::new().with(Prop::Fg, "blue").get(Prop::Fg),
			Some(PropValue::Color(Color::Rgb(0, 0, 255)))
		);
		assert_eq!(
			Props::new().with(Prop::Fg, "accent").get(Prop::Fg),
			Some(PropValue::Token(Str::new("accent")))
		);
		assert_eq!(
			Props::new().with(Prop::Title, "x").get(Prop::Title),
			Some(PropValue::Str(Str::new("x")))
		);
	}

	#[test]
	fn control_and_editor_props_keep_typed_storage() {
		let props = Props::new()
			.with(Prop::Variant, "pill")
			.with(Prop::Active, true)
			.with(Prop::Color, "ok")
			.with(Prop::Checked, false)
			.with(Prop::Limit, "72")
			.with(Prop::Rail, true)
			.with(Prop::MaxRows, "8")
			.with(Prop::Overflow, "rows")
			.with(Prop::Sep, " · ")
			.with(Prop::Numbering, "roman")
			.with(Prop::Selected, true)
			.with(Prop::Compact, true)
			.with(Prop::MaxDepth, "4")
			.with(Prop::MaxChars, "80")
			.with(Prop::TruncateFrom, "start")
			.with(Prop::Numbers, true)
			.with(Prop::Start, "42")
			.with(Prop::Ms, "1000")
			.with(Prop::Added, "2")
			.with(Prop::Removed, "3")
			.with(Prop::Ops, "4")
			.with(Prop::Minimap, true);
		assert_eq!(props.get(Prop::Variant), Some(PropValue::Str(Str::new("pill"))));
		assert_eq!(props.get(Prop::Active), Some(PropValue::Bool(true)));
		assert_eq!(props.get(Prop::Color), Some(PropValue::Token(Str::new("ok"))));
		assert_eq!(props.get(Prop::Checked), Some(PropValue::Bool(false)));
		assert_eq!(props.get(Prop::Limit), Some(PropValue::U16(72)));
		assert_eq!(props.get(Prop::Rail), Some(PropValue::Bool(true)));
		assert_eq!(props.get(Prop::MaxRows), Some(PropValue::U16(8)));
		assert_eq!(props.overflow().map(Str::as_str), Some("rows"));
		assert_eq!(props.sep().map(Str::as_str), Some(" · "));
		assert_eq!(props.str_of(Prop::Numbering).map(Str::as_str), Some("roman"));
		assert!(props.selected());
		assert!(props.compact());
		assert_eq!(props.max_depth(), Some(4));
		assert_eq!(props.max_chars(), Some(80));
		assert_eq!(props.truncate_from(), Truncate::Start);
		assert!(props.numbers());
		assert_eq!(props.start(), 42);
		assert_eq!(props.ms(), Some(1000));
		assert_eq!(props.added(), Some(2));
		assert_eq!(props.removed(), Some(3));
		assert_eq!(props.ops(), Some(4));
		assert_eq!(props.get(Prop::Minimap), Some(PropValue::Bool(true)));
	}

	#[test]
	fn gradients_and_angles_use_standard_color_properties() {
		let props = Props::new()
			.with(Prop::Bg, "accent..info")
			.with(Prop::Fg, "#000000..#ffffff")
			.with(Prop::Angle, "-90deg");
		assert_eq!(props.get(Prop::Bg), Some(PropValue::Gradient(Str::new("accent..info"))));
		assert_eq!(props.get(Prop::Fg), Some(PropValue::Gradient(Str::new("#000000..#ffffff"))));
		assert_eq!(props.angle(), 270);
		assert!(Props::prop_of("gradient").is_none());
		assert!(Props::prop_of("dir").is_none());
	}

	#[test]
	#[should_panic(expected = "nosuch")]
	fn invalid_known_value_panics() {
		let _ = Props::new().with(Prop::Fg, "nosuch");
	}

	#[test]
	fn invalid_known_value_is_fallible() {
		let mut props = Props::new();
		assert!(props.try_set(Prop::Fg, PropValue::from("nosuch")).is_err());
	}

	#[test]
	fn values_format_and_customs_round_trip() {
		let props = Props::new()
			.with(Prop::Gap, 2_u16)
			.with_custom("data-x", "1");
		assert_eq!(props.get_str(Prop::Gap).as_deref(), Some("2"));
		assert_eq!(props.custom("data-x"), Some(&PropValue::Str(Str::new("1"))));
		assert_eq!(props.named("data-x"), props.custom("data-x").cloned());
	}

	#[test]
	fn style_resolves_tokens_at_read_time() {
		let theme = Theme { accent: Color::Rgb(1, 2, 3), ..Theme::default() };
		let props = Props::new().with(Prop::Fg, "accent").with(Prop::Bold, true);
		assert_eq!(props.style(&theme).foreground_color(), Color::Rgb(1, 2, 3));
		assert_eq!(props.get(Prop::Bold), Some(PropValue::Bool(true)));
		assert!(props.flag(Prop::Bold));
		assert!(!Props::new().with(Prop::Bold, false).flag(Prop::Bold));
	}
	#[test]
	fn color_aliases_the_foreground_only_when_fg_is_absent() {
		let theme = Theme::default();
		let alias = Props::new().with(Prop::Color, "#010203");
		assert_eq!(alias.style(&theme).foreground_color(), Color::Rgb(1, 2, 3));
		assert!(alias.has_foreground());
		let both = Props::new()
			.with(Prop::Fg, "#040506")
			.with(Prop::Color, "#010203");
		assert_eq!(both.style(&theme).foreground_color(), Color::Rgb(4, 5, 6));
		assert_eq!(Props::new().foreground(&theme), None);
		assert!(!Props::new().has_foreground());
	}

	#[test]
	fn anim_props_parse_durations_and_easing() {
		let mut props = Props::new();
		props.set(Prop::Anim, "150ms");
		assert_eq!(props.anim(), Some(Duration::from_millis(150)));
		props.set(Prop::Anim, "0.4s");
		assert_eq!(props.anim(), Some(Duration::from_millis(400)));
		props.set(Prop::Anim, "250");
		assert_eq!(props.anim(), Some(Duration::from_millis(250)));
		props.set(Prop::Spin, "2s");
		assert_eq!(props.spin(), Some(Duration::from_millis(2000)));
		props.set(Prop::Shimmer, "1.5s");
		assert_eq!(props.shimmer(), Some(Duration::from_millis(1500)));
		props.set(Prop::Reveal, "500ms");
		assert_eq!(props.reveal(), Some(Duration::from_millis(500)));

		// Bare flags pick the documented defaults; absence disables.
		let bare = Props::new()
			.with(Prop::Anim, true)
			.with(Prop::Spin, true)
			.with(Prop::Shimmer, true)
			.with(Prop::Reveal, true);
		assert_eq!(bare.anim(), Some(Duration::from_millis(200)));
		assert_eq!(bare.spin(), Some(Duration::from_millis(3000)));
		assert_eq!(bare.shimmer(), Some(Duration::from_millis(2000)));
		assert_eq!(bare.reveal(), Some(Duration::from_millis(250)));
		assert_eq!(Props::new().reveal(), None);
		assert_eq!(Props::new().anim(), None);

		// Easing defaults to ease-out and parses every token.
		assert_eq!(props.ease(), Easing::EaseOut);
		props.set(Prop::Ease, "in-out");
		assert_eq!(props.ease(), Easing::EaseInOut);
		assert_eq!(props.get_str(Prop::Ease).as_deref(), Some("in-out"));
		assert!(
			props
				.try_set(Prop::Ease, PropValue::from("bouncy"))
				.is_err()
		);
		assert!(props.try_set(Prop::Anim, PropValue::from("fast")).is_err());
		assert!(props.try_set(Prop::Spin, PropValue::from("99s")).is_err());
	}

	#[test]
	fn catalog_names_and_values_round_trip() {
		use strum::IntoEnumIterator as _;
		for prop in Prop::iter() {
			let name = prop.to_string();
			assert_eq!(name.parse(), Ok(prop));
		}
	}

	#[test]
	fn typed_slots_validate_values_and_expand_padding() {
		let mut props = Props::new();
		assert!(
			props
				.try_set(Prop::Gap, PropValue::Color(Color::Default))
				.is_err()
		);
		props.set(Prop::Pad, "2 3");
		assert_eq!(props.pad(), (2, 3));
		assert_eq!(props.get(Prop::PadY), Some(PropValue::U16(2)));
		assert_eq!(props.get(Prop::PadX), Some(PropValue::U16(3)));
	}

	#[test]
	fn step_slot_accepts_only_integers() {
		let mut props = Props::new();
		props.set(Prop::Step, 2_u16);
		assert_eq!(props.get(Prop::Step), Some(PropValue::I64(2)));
		props.set(Prop::Step, -3_i64);
		assert_eq!(props.get(Prop::Step), Some(PropValue::I64(-3)));
		assert!(props.try_set(Prop::Step, PropValue::F32(0.5)).is_err());
	}

	#[test]
	fn bool_slots_parse_explicit_strings_strictly() {
		// Bare flag and explicit spellings.
		assert!(Props::new().with(Prop::Mask, true).flag(Prop::Mask));
		assert!(Props::new().with(Prop::Mask, "true").flag(Prop::Mask));
		assert!(!Props::new().with(Prop::Mask, "false").flag(Prop::Mask));
		// Arbitrary text no longer reads as presence.
		assert!(
			Props::new()
				.try_set(Prop::Mask, PropValue::from("nope"))
				.is_err()
		);
	}
}
