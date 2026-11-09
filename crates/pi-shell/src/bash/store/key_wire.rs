//! Frozen legacy key encoding. New state belongs to the snapshot vocabulary.

use std::{borrow::Cow, fmt};

use bstr::BStr;
use serde::{
	Deserialize, Deserializer, Serialize, Serializer,
	de::{Error, IntoDeserializer, Visitor},
};

use super::{JobId, Key, KeyBuf, MiscKey, OptId, TrapKey, Vpid, ZshOpt};

struct WireMisc(u32);

impl Serialize for WireMisc {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		if serializer.is_human_readable()
			&& let Some(known) = MiscKey::from_repr(self.0 as usize)
		{
			return known.serialize(serializer);
		}
		self.0.serialize(serializer)
	}
}

impl<'de> Deserialize<'de> for WireMisc {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		if !deserializer.is_human_readable() {
			return u32::deserialize(deserializer).map(Self);
		}
		struct HumanMisc;
		impl Visitor<'_> for HumanMisc {
			type Value = WireMisc;

			fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str("a known Misc name or an unknown numeric identifier")
			}

			fn visit_str<E: Error>(self, value: &str) -> Result<Self::Value, E> {
				MiscKey::deserialize(value.into_deserializer()).map(|known| WireMisc(known as u32))
			}

			fn visit_u64<E: Error>(self, value: u64) -> Result<Self::Value, E> {
				u32::try_from(value).map(WireMisc).map_err(E::custom)
			}

			fn visit_i64<E: Error>(self, value: i64) -> Result<Self::Value, E> {
				u32::try_from(value).map(WireMisc).map_err(E::custom)
			}
		}
		deserializer.deserialize_any(HumanMisc)
	}
}

// Keep these variant indices and payloads unchanged. Cow borrows every string
// while writing; decoding owns only strings the resulting KeyBuf must own.
#[derive(Serialize, Deserialize)]
enum WireKey<'a> {
	Var(Cow<'a, BStr>),
	Func(Cow<'a, BStr>),
	Alias(Cow<'a, BStr>),
	Opt(OptId),
	Trap(TrapKey),
	Job(JobId),
	Proc(Vpid),
	DirStack,
	CmdHash(Cow<'a, BStr>),
	Misc(WireMisc),
	Scope(u32),
	Local { depth: u32, name: Cow<'a, BStr> },
	ZshOpt(ZshOpt),
	ZshAlias { suffix: bool, name: Cow<'a, BStr> },
}

impl Serialize for KeyBuf {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		let wire = match self.as_key() {
			Key::Var(name) => WireKey::Var(Cow::Borrowed(name)),
			Key::Func(name) => WireKey::Func(Cow::Borrowed(name)),
			Key::Alias(name) => WireKey::Alias(Cow::Borrowed(name)),
			Key::Opt(id) => WireKey::Opt(id),
			Key::Trap(id) => WireKey::Trap(id),
			Key::Job(id) => WireKey::Job(id),
			Key::Proc(id) => WireKey::Proc(id),
			Key::DirStack => WireKey::DirStack,
			Key::CmdHash(name) => WireKey::CmdHash(Cow::Borrowed(name)),
			Key::Misc(id) => WireKey::Misc(WireMisc(id as u32)),
			Key::UnknownMisc(id) => WireKey::Misc(WireMisc(id)),
			Key::Scope(depth) => WireKey::Scope(depth),
			Key::Local { depth, name } => WireKey::Local { depth, name: Cow::Borrowed(name) },
			Key::ZshOpt(id) => WireKey::ZshOpt(id),
			Key::ZshAlias { suffix, name } => WireKey::ZshAlias { suffix, name: Cow::Borrowed(name) },
		};
		wire.serialize(serializer)
	}
}

impl<'de> Deserialize<'de> for KeyBuf {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		Ok(match WireKey::deserialize(deserializer)? {
			WireKey::Var(name) => Self::Var(name.into_owned()),
			WireKey::Func(name) => Self::Func(name.into_owned()),
			WireKey::Alias(name) => Self::Alias(name.into_owned()),
			WireKey::Opt(id) => Self::Opt(id),
			WireKey::Trap(id) => Self::Trap(id),
			WireKey::Job(id) => Self::Job(id),
			WireKey::Proc(id) => Self::Proc(id),
			WireKey::DirStack => Self::DirStack,
			WireKey::CmdHash(name) => Self::CmdHash(name.into_owned()),
			WireKey::Misc(WireMisc(id)) => match MiscKey::from_repr(id as usize) {
				Some(known) => Self::Misc(known),
				None => Self::UnknownMisc(id),
			},
			WireKey::Scope(depth) => Self::Scope(depth),
			WireKey::Local { depth, name } => Self::Local { depth, name: name.into_owned() },
			WireKey::ZshOpt(id) => Self::ZshOpt(id),
			WireKey::ZshAlias { suffix, name } => Self::ZshAlias { suffix, name: name.into_owned() },
		})
	}
}
