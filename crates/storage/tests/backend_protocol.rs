//! Byte-target protocol tests without live Redis or SQL servers.

use std::{convert::Infallible, sync::Arc};

use omp_storage::{
	backend::{
		ByteJournalStore, FileStore, MemoryStore,
		redis::{
			Command as RedisCommand, RedisError, RedisStore, Reply as RedisReply,
			Transport as RedisTransport,
		},
		sql::{
			Command as SqlCommand, Reply as SqlReply, SqlDialect, SqlError, SqlStore,
			Transport as SqlTransport,
		},
	},
	testing::assert_byte_journal_contract,
};
use parking_lot::Mutex;
use tempfile::tempdir;

#[derive(Clone, Copy, Debug, PartialEq)]
enum RedisOp {
	Length,
	Range,
	Append,
	Truncate,
}

impl From<&RedisCommand<'_>> for RedisOp {
	fn from(command: &RedisCommand<'_>) -> Self {
		match *command {
			RedisCommand::Length { .. } => Self::Length,
			RedisCommand::Range { .. } => Self::Range,
			RedisCommand::Append { .. } => Self::Append,
			RedisCommand::Truncate { .. } => Self::Truncate,
		}
	}
}

#[derive(Default)]
struct RedisFake {
	bytes: Arc<Mutex<Vec<u8>>>,
	ops:   Arc<Mutex<Vec<RedisOp>>>,
}

impl RedisTransport for RedisFake {
	type Error = Infallible;

	fn execute(&mut self, command: RedisCommand<'_>) -> Result<RedisReply, Self::Error> {
		self.ops.lock().push(RedisOp::from(&command));
		let mut bytes = self.bytes.lock();
		Ok(match command {
			RedisCommand::Length { .. } => RedisReply::Integer(
				i64::try_from(bytes.len()).expect("memory journal length fits in i64"),
			),
			RedisCommand::Range { start, end, .. } => {
				let start = usize::try_from(start)
					.unwrap_or(usize::MAX)
					.min(bytes.len());
				let end_exclusive = usize::try_from(end.saturating_add(1))
					.unwrap_or(usize::MAX)
					.min(bytes.len())
					.max(start);
				RedisReply::Bytes(bytes[start..end_exclusive].to_vec())
			},
			RedisCommand::Append { expected, bytes: data, .. } => {
				let observed = u64::try_from(bytes.len()).expect("memory journal length fits in u64");
				if observed != expected {
					RedisReply::Fenced { resulting: -1, observed }
				} else {
					bytes.extend_from_slice(data);
					RedisReply::Fenced {
						resulting: i64::try_from(bytes.len()).expect("length fits in i64"),
						observed,
					}
				}
			},
			RedisCommand::Truncate { len, .. } => {
				let observed = u64::try_from(bytes.len()).expect("memory journal length fits in u64");
				if len > observed {
					RedisReply::Fenced { resulting: -1, observed }
				} else {
					bytes.truncate(usize::try_from(len).unwrap_or(usize::MAX));
					RedisReply::Fenced {
						resulting: i64::try_from(len).expect("length fits in i64"),
						observed,
					}
				}
			},
		})
	}
}

#[derive(Default)]
struct SqlFake {
	bytes: Arc<Mutex<Vec<u8>>>,
}

impl SqlTransport for SqlFake {
	type Error = Infallible;

	fn execute(&mut self, command: SqlCommand<'_>) -> Result<SqlReply, Self::Error> {
		let mut bytes = self.bytes.lock();
		Ok(match command {
			SqlCommand::Initialize { .. } => SqlReply::Done,
			SqlCommand::Length { .. } => {
				SqlReply::Length(u64::try_from(bytes.len()).expect("memory journal length fits in u64"))
			},
			SqlCommand::Range { offset, maximum, .. } => {
				let start = usize::try_from(offset)
					.unwrap_or(usize::MAX)
					.min(bytes.len());
				let end = start.saturating_add(maximum).min(bytes.len());
				SqlReply::Bytes(bytes[start..end].to_vec())
			},
			SqlCommand::Append { expected, bytes: data, .. } => {
				let observed = u64::try_from(bytes.len()).expect("memory journal length fits in u64");
				if observed != expected {
					SqlReply::Fenced { applied: false, resulting: observed, observed }
				} else {
					bytes.extend_from_slice(data);
					let resulting =
						u64::try_from(bytes.len()).expect("memory journal length fits in u64");
					SqlReply::Fenced { applied: true, resulting, observed }
				}
			},
			SqlCommand::Truncate { len, .. } => {
				let observed = u64::try_from(bytes.len()).expect("memory journal length fits in u64");
				if len > observed {
					SqlReply::Fenced { applied: false, resulting: observed, observed }
				} else {
					bytes.truncate(usize::try_from(len).unwrap_or(usize::MAX));
					SqlReply::Fenced { applied: true, resulting: len, observed }
				}
			},
		})
	}
}

#[test]
fn memory_store_satisfies_byte_journal_contract() {
	assert_byte_journal_contract(MemoryStore::new());
}

#[test]
fn file_store_satisfies_byte_journal_contract() {
	let directory = tempdir().expect("temporary directory");
	let store = FileStore::open(directory.path().join("journal.bin")).expect("open file store");
	assert_byte_journal_contract(store);
}

#[test]
fn redis_store_satisfies_byte_journal_contract() {
	let shared_ops = Arc::new(Mutex::new(Vec::new()));
	let fake = RedisFake { bytes: Arc::new(Mutex::new(Vec::new())), ops: Arc::clone(&shared_ops) };
	assert_byte_journal_contract(RedisStore::new(fake, "omp:sessions:test"));
	assert!(RedisStore::<RedisFake>::append_script().contains("STRLEN"));
	assert!(RedisStore::<RedisFake>::truncate_script().contains("GETRANGE"));
	assert_eq!(
		*shared_ops.lock(),
		vec![
			RedisOp::Length,
			RedisOp::Append,
			RedisOp::Append,
			RedisOp::Range,
			RedisOp::Truncate,
			RedisOp::Range,
		],
		"Redis cached length avoids redundant remote length calls"
	);

	let shared_bytes = Arc::new(Mutex::new(b"v4\n".to_vec()));
	let fake =
		RedisFake { bytes: Arc::clone(&shared_bytes), ops: Arc::new(Mutex::new(Vec::new())) };
	let mut store = RedisStore::new(fake, "omp:sessions:conflict");
	assert_eq!(store.len().expect("initial length"), 3, "store caches the pre-race length");

	*shared_bytes.lock() = b"v4\nremote".to_vec();
	assert!(matches!(store.append(b"more"), Err(RedisError::Conflict { expected: 3, observed: 9 })));
	assert_eq!(
		*store.into_transport().bytes.lock(),
		b"v4\nremote",
		"conflict leaves remote bytes unchanged"
	);
}

#[test]
fn sql_store_satisfies_byte_journal_contract() {
	let store = SqlStore::open(SqlFake::default(), SqlDialect::Sqlite, "session")
		.expect("initialize dialect");
	assert_byte_journal_contract(store);

	let shared_bytes = Arc::new(Mutex::new(b"v4\n".to_vec()));
	let fake = SqlFake { bytes: Arc::clone(&shared_bytes) };
	let mut store =
		SqlStore::open(fake, SqlDialect::Sqlite, "conflict").expect("initialize conflict store");
	assert_eq!(store.len().expect("initial length"), 3, "store caches the pre-race length");

	*shared_bytes.lock() = b"v4\nremote".to_vec();
	assert!(matches!(store.append(b"more"), Err(SqlError::Conflict { expected: 3, observed: 9 })));
	assert_eq!(
		store.read(0, 9).expect("read after conflict"),
		b"v4\nremote",
		"conflict leaves remote bytes unchanged"
	);
}

#[test]
fn every_sql_dialect_has_fenced_byte_queries() {
	for dialect in [SqlDialect::Postgres, SqlDialect::Mysql, SqlDialect::Sqlite] {
		let store =
			SqlStore::open(SqlFake::default(), dialect, "session").expect("initialize dialect");
		let statements = store.statements();
		assert!(statements[3].contains("omp_session_files"));
		assert!(statements[4].contains("omp_session_files"));
	}
}
