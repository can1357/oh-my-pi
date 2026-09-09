//! PostgreSQL, MySQL, and SQLite exact-byte journal protocol.

use std::error;

use strum::{Display, EnumString, IntoStaticStr};
use thiserror::Error;

use super::ByteJournalStore;

/// Supported SQL byte-store dialect.
#[derive(Debug, Clone, Copy, Display, EnumString, IntoStaticStr, PartialEq, Eq)]
#[strum(serialize_all = "snake_case")]
pub enum SqlDialect {
	/// PostgreSQL `bytea` storage.
	Postgres,
	/// MySQL `LONGBLOB` storage.
	Mysql,
	/// SQLite `BLOB` storage.
	Sqlite,
}

/// Borrowed transaction requested from a concrete SQL adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command<'a> {
	/// Ensure the journal table exists.
	Initialize {
		/// Dialect-specific DDL.
		ddl: &'static str,
	},
	/// Read the journal byte length.
	Length {
		/// Prepared SQL.
		sql: &'static str,
		/// Journal identifier.
		id:  &'a str,
	},
	/// Read a bounded byte range.
	Range {
		/// Prepared SQL.
		sql:     &'static str,
		/// Journal identifier.
		id:      &'a str,
		/// Zero-based byte offset.
		offset:  u64,
		/// Maximum returned bytes.
		maximum: usize,
	},
	/// Append bytes only if the expected length still matches.
	Append {
		/// Prepared SQL.
		sql:      &'static str,
		/// Journal identifier.
		id:       &'a str,
		/// Required current length.
		expected: u64,
		/// Exact bytes to append.
		bytes:    &'a [u8],
	},
	/// Roll back to an earlier byte length.
	Truncate {
		/// Prepared SQL.
		sql: &'static str,
		/// Journal identifier.
		id:  &'a str,
		/// Resulting byte length.
		len: u64,
	},
}

/// SQL reply normalized by an adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
	/// Mutation completed without a result row.
	Done,
	/// Integer query result.
	Length(u64),
	/// Exact byte query result.
	Bytes(Vec<u8>),
	/// Fenced mutation result.
	Fenced {
		/// Whether the length predicate admitted the mutation.
		applied:   bool,
		/// Resulting byte length.
		resulting: u64,
		/// Length observed before the mutation.
		observed:  u64,
	},
}

/// Minimal SQL adapter boundary used by all dialects.
pub trait Transport {
	/// Typed database failure.
	type Error: error::Error + Send + Sync + 'static;

	/// Executes one prepared operation.
	fn execute(&mut self, command: Command<'_>) -> Result<Reply, Self::Error>;
}

/// SQL journal protocol failure.
#[derive(Debug, Error)]
pub enum SqlError<E: error::Error + 'static> {
	/// Database adapter operation failed.
	#[error("SQL journal transport failed")]
	Transport(#[source] E),
	/// Adapter returned the wrong result shape.
	#[error("SQL journal returned an unexpected reply")]
	UnexpectedReply,
	/// Another writer violated the daemon's length fence.
	#[error("SQL journal length fence conflicted: expected {expected}, observed {observed}")]
	Conflict {
		/// Expected pre-operation length.
		expected: u64,
		/// Actual pre-operation length.
		observed: u64,
	},
}

#[derive(Debug, Clone, Copy)]
struct Queries {
	ddl:      &'static str,
	length:   &'static str,
	range:    &'static str,
	append:   &'static str,
	truncate: &'static str,
}

const POSTGRES: Queries = Queries {
	ddl:      "CREATE TABLE IF NOT EXISTS omp_session_files(id TEXT PRIMARY KEY, content BYTEA NOT \
	           NULL, updated_at BIGINT NOT NULL DEFAULT 0)",
	length:   "SELECT COALESCE(octet_length(content),0) FROM omp_session_files WHERE id=$1",
	range:    "SELECT substring(content FROM $2 + 1 FOR $3) FROM omp_session_files WHERE id=$1",
	append:   "INSERT INTO omp_session_files(id,content) VALUES($1,$3) ON CONFLICT(id) DO UPDATE \
	           SET content=omp_session_files.content || EXCLUDED.content WHERE \
	           octet_length(omp_session_files.content)=$2 RETURNING octet_length(content)",
	truncate: "UPDATE omp_session_files SET content=substring(content FROM 1 FOR $2) WHERE id=$1 \
	           AND octet_length(content)>=$2 RETURNING octet_length(content)",
};
const MYSQL: Queries = Queries {
	ddl:      "CREATE TABLE IF NOT EXISTS omp_session_files(id VARCHAR(255) PRIMARY KEY, content \
	           LONGBLOB NOT NULL, updated_at BIGINT NOT NULL DEFAULT 0)",
	length:   "SELECT COALESCE(OCTET_LENGTH(content),0) FROM omp_session_files WHERE id=?",
	range:    "SELECT SUBSTRING(content, ? + 1, ?) FROM omp_session_files WHERE id=?",
	append:   "INSERT INTO omp_session_files(id,content) VALUES(?,?) ON DUPLICATE KEY UPDATE \
	           content=IF(OCTET_LENGTH(content)=?,CONCAT(content,VALUES(content)),content)",
	truncate: "UPDATE omp_session_files SET content=LEFT(content,?) WHERE id=? AND \
	           OCTET_LENGTH(content)>=?",
};
const SQLITE: Queries = Queries {
	ddl:      "CREATE TABLE IF NOT EXISTS omp_session_files(id TEXT PRIMARY KEY, content BLOB NOT \
	           NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
	length:   "SELECT COALESCE(length(content),0) FROM omp_session_files WHERE id=?1",
	range:    "SELECT substr(content, ?2 + 1, ?3) FROM omp_session_files WHERE id=?1",
	append:   "INSERT INTO omp_session_files(id,content) VALUES(?1,?3) ON CONFLICT(id) DO UPDATE \
	           SET content=content || excluded.content WHERE length(content)=?2 RETURNING \
	           length(content)",
	truncate: "UPDATE omp_session_files SET content=substr(content,1,?2) WHERE id=?1 AND \
	           length(content)>=?2 RETURNING length(content)",
};

const fn queries(dialect: SqlDialect) -> Queries {
	match dialect {
		SqlDialect::Postgres => POSTGRES,
		SqlDialect::Mysql => MYSQL,
		SqlDialect::Sqlite => SQLITE,
	}
}

/// SQL table-backed exact-byte journal.
pub struct SqlStore<T> {
	transport: T,
	id:        String,
	queries:   Queries,
	length:    Option<u64>,
}

impl<T: Transport> SqlStore<T> {
	/// Initializes the dialect table and binds one journal identifier.
	pub fn open(
		mut transport: T,
		dialect: SqlDialect,
		id: impl Into<String>,
	) -> Result<Self, SqlError<T::Error>> {
		let queries = queries(dialect);
		match transport
			.execute(Command::Initialize { ddl: queries.ddl })
			.map_err(SqlError::Transport)?
		{
			Reply::Done => Ok(Self { transport, id: id.into(), queries, length: None }),
			_ => Err(SqlError::UnexpectedReply),
		}
	}

	/// Returns the selected prepared SQL, primarily for adapter verification.
	pub const fn statements(&self) -> [&'static str; 5] {
		[
			self.queries.ddl,
			self.queries.length,
			self.queries.range,
			self.queries.append,
			self.queries.truncate,
		]
	}
}

impl<T: Transport> ByteJournalStore for SqlStore<T> {
	type Error = SqlError<T::Error>;

	fn len(&mut self) -> Result<u64, Self::Error> {
		if let Some(length) = self.length {
			return Ok(length);
		}
		let Reply::Length(length) = self
			.transport
			.execute(Command::Length { sql: self.queries.length, id: &self.id })
			.map_err(SqlError::Transport)?
		else {
			return Err(SqlError::UnexpectedReply);
		};
		self.length = Some(length);
		Ok(length)
	}

	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error> {
		match self
			.transport
			.execute(Command::Range { sql: self.queries.range, id: &self.id, offset, maximum })
			.map_err(SqlError::Transport)?
		{
			Reply::Bytes(bytes) => Ok(bytes),
			_ => Err(SqlError::UnexpectedReply),
		}
	}

	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error> {
		let expected = self.len()?;
		let Reply::Fenced { applied, resulting, observed } = self
			.transport
			.execute(Command::Append { sql: self.queries.append, id: &self.id, expected, bytes })
			.map_err(SqlError::Transport)?
		else {
			return Err(SqlError::UnexpectedReply);
		};
		if !applied {
			self.length = Some(observed);
			return Err(SqlError::Conflict { expected, observed });
		}
		self.length = Some(resulting);
		Ok(resulting)
	}

	fn truncate(&mut self, len: u64) -> Result<(), Self::Error> {
		let Reply::Fenced { applied, resulting, observed } = self
			.transport
			.execute(Command::Truncate { sql: self.queries.truncate, id: &self.id, len })
			.map_err(SqlError::Transport)?
		else {
			return Err(SqlError::UnexpectedReply);
		};
		if !applied {
			self.length = Some(observed);
			return Err(SqlError::Conflict { expected: len, observed });
		}
		self.length = Some(resulting);
		Ok(())
	}

	fn sync(&mut self) -> Result<(), Self::Error> {
		Ok(())
	}
}
