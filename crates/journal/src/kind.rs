//! Closed journal kind vocabulary and versioned kind parsing.

use std::{fmt, num::ParseIntError, str::FromStr};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};
use thiserror::Error;

/// Genesis journal metadata.
pub const JOURNAL: &str = "journal";
/// Explicit turn boundary.
pub const TURN_START: &str = "turn.start";
/// User message.
pub const MSG_USER: &str = "msg.user";
/// Assistant message start.
pub const MSG_ASSISTANT_START: &str = "msg.assistant.start";
/// Append-only text stream delta.
pub const STREAM: &str = "stream";
/// Assistant message completion.
pub const MSG_ASSISTANT_END: &str = "msg.assistant.end";
/// Tool invocation.
pub const TOOL_CALL: &str = "tool.call";
/// Tool progress update.
pub const TOOL_UPDATE: &str = "tool.update";
/// Tool terminal result.
pub const TOOL_RESULT: &str = "tool.result";
/// Turn token and cost receipt.
pub const TURN_RECEIPT: &str = "turn.receipt";
/// Atomic DOM operation batch.
pub const PATCH: &str = "patch";
/// Context compaction boundary.
pub const COMPACTION: &str = "compaction";

/// The closed set of journal event names in revision 1.
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	Serialize,
	Deserialize,
	Display,
	EnumString,
	IntoStaticStr,
)]
pub enum KindName {
	/// `journal@1`.
	#[serde(rename = "journal")]
	#[strum(to_string = "journal")]
	Journal,
	/// `turn.start@1`.
	#[serde(rename = "turn.start")]
	#[strum(to_string = "turn.start")]
	TurnStart,
	/// `msg.user@1`.
	#[serde(rename = "msg.user")]
	#[strum(to_string = "msg.user")]
	MsgUser,
	/// `msg.assistant.start@1`.
	#[serde(rename = "msg.assistant.start")]
	#[strum(to_string = "msg.assistant.start")]
	MsgAssistantStart,
	/// `stream@1`.
	#[serde(rename = "stream")]
	#[strum(to_string = "stream")]
	Stream,
	/// `msg.assistant.end@1`.
	#[serde(rename = "msg.assistant.end")]
	#[strum(to_string = "msg.assistant.end")]
	MsgAssistantEnd,
	/// `tool.call@1`.
	#[serde(rename = "tool.call")]
	#[strum(to_string = "tool.call")]
	ToolCall,
	/// `tool.update@1`.
	#[serde(rename = "tool.update")]
	#[strum(to_string = "tool.update")]
	ToolUpdate,
	/// `tool.result@1`.
	#[serde(rename = "tool.result")]
	#[strum(to_string = "tool.result")]
	ToolResult,
	/// `turn.receipt@1`.
	#[serde(rename = "turn.receipt")]
	#[strum(to_string = "turn.receipt")]
	TurnReceipt,
	/// `patch@1`.
	#[serde(rename = "patch")]
	#[strum(to_string = "patch")]
	Patch,
	/// `compaction@1`.
	#[serde(rename = "compaction")]
	#[strum(to_string = "compaction")]
	Compaction,
}

/// A versioned journal entry kind.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Kind {
	/// Event name.
	pub name: Str,
	/// Schema revision.
	pub rev:  u32,
}

impl Kind {
	/// Constructs a versioned kind after validating its name and revision.
	pub fn new(name: impl Into<Str>, rev: u32) -> Result<Self, KindError> {
		let name = name.into();
		if !valid_name(name.as_str()) {
			return Err(KindError::InvalidName);
		}
		if rev == 0 {
			return Err(KindError::ZeroRevision);
		}
		Ok(Self { name, rev })
	}

	/// Constructs a known revision-1 kind.
	#[must_use]
	pub fn known(name: KindName) -> Self {
		let name: &'static str = name.into();
		Self { name: Str::new_static(name), rev: 1 }
	}

	/// Returns whether this is a member of the closed revision-1 vocabulary.
	#[must_use]
	pub fn is_known(&self) -> bool {
		self.rev == 1 && self.name.as_str().parse::<KindName>().is_ok()
	}
}

impl fmt::Display for Kind {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}@{}", self.name, self.rev)
	}
}

impl FromStr for Kind {
	type Err = KindError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let (name, revision) = value.rsplit_once('@').ok_or(KindError::MissingSeparator)?;
		let rev = revision
			.parse()
			.map_err(|source| KindError::InvalidRevision { source })?;
		Self::new(name, rev)
	}
}

/// Failure to parse or construct a [`Kind`].
#[derive(Debug, Error)]
pub enum KindError {
	/// The `@` separator is absent.
	#[error("kind is missing the `@` revision separator")]
	MissingSeparator,
	/// The name violates the dotted segment grammar.
	#[error("kind name is invalid")]
	InvalidName,
	/// The revision is not an unsigned 32-bit integer.
	#[error("kind revision is invalid")]
	InvalidRevision {
		/// Integer parse failure.
		#[source]
		source: ParseIntError,
	},
	/// Revision zero is reserved.
	#[error("kind revision must be nonzero")]
	ZeroRevision,
}

fn valid_name(name: &str) -> bool {
	!name.is_empty()
		&& name.split('.').all(|segment| {
			let mut bytes = segment.bytes();
			bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic())
				&& bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
		})
}
