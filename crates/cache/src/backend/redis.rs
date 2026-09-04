//! Redis exact-byte journal protocol.
//!
//! Atomic Lua scripts pair append/truncate with an expected byte length. This
//! is a fence against accidental second writers; the daemon remains the only
//! legitimate caller.

use std::error;

use thiserror::Error;

use super::ByteJournalStore;

const APPEND_SCRIPT: &str = r"local n=redis.call('STRLEN',KEYS[1]);if n~=tonumber(ARGV[1]) then return {-1,n} end;local next=redis.call('APPEND',KEYS[1],ARGV[2]);return {next,n}";
const TRUNCATE_SCRIPT: &str = r"local n=redis.call('STRLEN',KEYS[1]);local target=tonumber(ARGV[1]);if target>n then return {-1,n} end;if target==0 then redis.call('DEL',KEYS[1]);return {0,n} end;local value=redis.call('GETRANGE',KEYS[1],0,target-1);redis.call('SET',KEYS[1],value);return {target,n}";

/// Borrowed Redis command needed by the byte backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command<'a> {
	/// Read current string length.
	Length {
		/// Redis key.
		key: &'a str,
	},
	/// Read an inclusive byte range.
	Range {
		/// Redis key.
		key:   &'a str,
		/// Inclusive byte start.
		start: u64,
		/// Inclusive byte end.
		end:   u64,
	},
	/// Execute the fenced append script.
	Append {
		/// Redis key.
		key:      &'a str,
		/// Required current length.
		expected: u64,
		/// Exact bytes to append.
		bytes:    &'a [u8],
	},
	/// Execute the rollback truncate script.
	Truncate {
		/// Redis key.
		key: &'a str,
		/// Resulting byte length.
		len: u64,
	},
}

/// Redis reply normalized at the narrow transport boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
	/// Integer result.
	Integer(i64),
	/// Exact bulk bytes.
	Bytes(Vec<u8>),
	/// Script tuple `(resulting_length, observed_previous_length)`.
	Fenced {
		/// Result length, or a negative conflict sentinel.
		resulting: i64,
		/// Length observed before the script.
		observed:  u64,
	},
}

/// Minimal production transport seam; clients map their typed errors directly.
pub trait Transport {
	/// Typed client failure.
	type Error: error::Error + Send + Sync + 'static;

	/// Executes one normalized command.
	fn execute(&mut self, command: Command<'_>) -> Result<Reply, Self::Error>;
}

/// Redis journal protocol failure.
#[derive(Debug, Error)]
pub enum RedisError<E: error::Error + 'static> {
	/// Redis client operation failed.
	#[error("Redis journal transport failed")]
	Transport(#[source] E),
	/// Redis returned a reply of the wrong shape.
	#[error("Redis journal returned an unexpected reply")]
	UnexpectedReply,
	/// Another writer changed the key between fenced operations.
	#[error("Redis journal length fence conflicted: expected {expected}, observed {observed}")]
	Conflict {
		/// Expected pre-operation length.
		expected: u64,
		/// Actual pre-operation length.
		observed: u64,
	},
	/// A returned integer could not represent a byte length.
	#[error("Redis journal returned an invalid byte length")]
	InvalidLength,
}

/// Redis string-backed exact-byte journal.
pub struct RedisStore<T> {
	transport: T,
	key:       String,
	length:    Option<u64>,
}

impl<T> RedisStore<T> {
	/// Creates a store for one namespaced journal key.
	pub fn new(transport: T, key: impl Into<String>) -> Self {
		Self { transport, key: key.into(), length: None }
	}

	/// Returns the Lua append script for concrete client adapters.
	pub const fn append_script() -> &'static str {
		APPEND_SCRIPT
	}

	/// Returns the Lua rollback script for concrete client adapters.
	pub const fn truncate_script() -> &'static str {
		TRUNCATE_SCRIPT
	}

	/// Consumes the store and returns its transport.
	pub fn into_transport(self) -> T {
		self.transport
	}
}

impl<T: Transport> ByteJournalStore for RedisStore<T> {
	type Error = RedisError<T::Error>;

	fn len(&mut self) -> Result<u64, Self::Error> {
		if let Some(length) = self.length {
			return Ok(length);
		}
		let Reply::Integer(length) = self
			.transport
			.execute(Command::Length { key: &self.key })
			.map_err(RedisError::Transport)?
		else {
			return Err(RedisError::UnexpectedReply);
		};
		let length = u64::try_from(length).map_err(|_| RedisError::InvalidLength)?;
		self.length = Some(length);
		Ok(length)
	}

	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error> {
		if maximum == 0 {
			return Ok(Vec::new());
		}
		let end = offset.saturating_add(u64::try_from(maximum - 1).unwrap_or(u64::MAX));
		match self
			.transport
			.execute(Command::Range { key: &self.key, start: offset, end })
			.map_err(RedisError::Transport)?
		{
			Reply::Bytes(bytes) => Ok(bytes),
			_ => Err(RedisError::UnexpectedReply),
		}
	}

	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error> {
		let expected = self.len()?;
		let Reply::Fenced { resulting, observed } = self
			.transport
			.execute(Command::Append { key: &self.key, expected, bytes })
			.map_err(RedisError::Transport)?
		else {
			return Err(RedisError::UnexpectedReply);
		};
		if resulting < 0 {
			self.length = Some(observed);
			return Err(RedisError::Conflict { expected, observed });
		}
		let resulting = u64::try_from(resulting).map_err(|_| RedisError::InvalidLength)?;
		self.length = Some(resulting);
		Ok(resulting)
	}

	fn truncate(&mut self, len: u64) -> Result<(), Self::Error> {
		let Reply::Fenced { resulting, observed } = self
			.transport
			.execute(Command::Truncate { key: &self.key, len })
			.map_err(RedisError::Transport)?
		else {
			return Err(RedisError::UnexpectedReply);
		};
		if resulting < 0 {
			self.length = Some(observed);
			return Err(RedisError::Conflict { expected: len, observed });
		}
		self.length = Some(u64::try_from(resulting).map_err(|_| RedisError::InvalidLength)?);
		Ok(())
	}

	fn sync(&mut self) -> Result<(), Self::Error> {
		Ok(())
	}
}
