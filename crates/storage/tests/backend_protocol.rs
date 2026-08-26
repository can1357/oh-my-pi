//! Byte-target protocol tests without live Redis or SQL servers.

use std::{
	collections::VecDeque,
	convert::Infallible,
	future::Future,
	task::{Context, Poll, Waker},
};

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
use tempfile::tempdir;

fn block_on<T>(future: impl Future<Output = T>) -> T {
	let mut future = std::pin::pin!(future);
	match future
		.as_mut()
		.poll(&mut Context::from_waker(Waker::noop()))
	{
		Poll::Ready(value) => value,
		Poll::Pending => panic!("byte journal contract future parked"),
	}
}

#[derive(Default)]
struct RedisFake {
	bytes:          Vec<u8>,
	forced_replies: VecDeque<RedisReply>,
}

impl RedisTransport for RedisFake {
	type Error = Infallible;

	fn execute(&mut self, command: RedisCommand<'_>) -> Result<RedisReply, Self::Error> {
		if matches!(command, RedisCommand::Append { .. })
			&& let Some(reply) = self.forced_replies.pop_front()
		{
			return Ok(reply);
		}
		Ok(match command {
			RedisCommand::Length { .. } => {
				RedisReply::Integer(i64::try_from(self.bytes.len()).expect("length fits in i64"))
			},
			RedisCommand::Range { start, end, .. } => {
				let start = usize::try_from(start)
					.unwrap_or(usize::MAX)
					.min(self.bytes.len());
				let end_exclusive = usize::try_from(end.saturating_add(1))
					.unwrap_or(usize::MAX)
					.min(self.bytes.len())
					.max(start);
				RedisReply::Bytes(self.bytes[start..end_exclusive].to_vec())
			},
			RedisCommand::Append { expected, bytes, .. } => {
				let observed =
					u64::try_from(self.bytes.len()).expect("memory journal length fits in u64");
				if observed != expected {
					RedisReply::Fenced { resulting: -1, observed }
				} else {
					self.bytes.extend_from_slice(bytes);
					RedisReply::Fenced {
						resulting: i64::try_from(self.bytes.len()).expect("length fits in i64"),
						observed,
					}
				}
			},
			RedisCommand::Truncate { len, .. } => {
				let observed =
					u64::try_from(self.bytes.len()).expect("memory journal length fits in u64");
				if len > observed {
					RedisReply::Fenced { resulting: -1, observed }
				} else {
					self
						.bytes
						.truncate(usize::try_from(len).unwrap_or(usize::MAX));
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
	bytes:          Vec<u8>,
	forced_replies: VecDeque<SqlReply>,
}

impl SqlTransport for SqlFake {
	type Error = Infallible;

	fn execute(&mut self, command: SqlCommand<'_>) -> Result<SqlReply, Self::Error> {
		if matches!(command, SqlCommand::Append { .. })
			&& let Some(reply) = self.forced_replies.pop_front()
		{
			return Ok(reply);
		}
		Ok(match command {
			SqlCommand::Initialize { .. } => SqlReply::Done,
			SqlCommand::Length { .. } => SqlReply::Length(
				u64::try_from(self.bytes.len()).expect("memory journal length fits in u64"),
			),
			SqlCommand::Range { offset, maximum, .. } => {
				let start = usize::try_from(offset)
					.unwrap_or(usize::MAX)
					.min(self.bytes.len());
				let end = start.saturating_add(maximum).min(self.bytes.len());
				SqlReply::Bytes(self.bytes[start..end].to_vec())
			},
			SqlCommand::Append { expected, bytes, .. } => {
				let observed =
					u64::try_from(self.bytes.len()).expect("memory journal length fits in u64");
				if observed != expected {
					SqlReply::Fenced { applied: false, resulting: observed, observed }
				} else {
					self.bytes.extend_from_slice(bytes);
					let resulting =
						u64::try_from(self.bytes.len()).expect("memory journal length fits in u64");
					SqlReply::Fenced { applied: true, resulting, observed }
				}
			},
			SqlCommand::Truncate { len, .. } => {
				let observed =
					u64::try_from(self.bytes.len()).expect("memory journal length fits in u64");
				if len > observed {
					SqlReply::Fenced { applied: false, resulting: observed, observed }
				} else {
					self
						.bytes
						.truncate(usize::try_from(len).unwrap_or(usize::MAX));
					SqlReply::Fenced { applied: true, resulting: len, observed }
				}
			},
		})
	}
}

#[test]
fn memory_store_satisfies_byte_journal_contract() {
	block_on(assert_byte_journal_contract(MemoryStore::new()));
}

#[test]
fn file_store_satisfies_byte_journal_contract() {
	let directory = tempdir().expect("temporary directory");
	let store = FileStore::open(directory.path().join("journal.bin")).expect("open file store");
	block_on(assert_byte_journal_contract(store));
}

#[test]
fn redis_store_satisfies_byte_journal_contract() {
	block_on(assert_byte_journal_contract(RedisStore::new(
		RedisFake::default(),
		"omp:sessions:test",
	)));
	assert!(RedisStore::<RedisFake>::append_script().contains("STRLEN"));
	assert!(RedisStore::<RedisFake>::truncate_script().contains("GETRANGE"));

	let fake = RedisFake {
		bytes:          b"v4\n".to_vec(),
		forced_replies: VecDeque::from([RedisReply::Fenced { resulting: -1, observed: 9 }]),
	};
	let mut store = RedisStore::new(fake, "omp:sessions:conflict");
	assert!(matches!(store.append(b"more"), Err(RedisError::Conflict { expected: 3, observed: 9 })));
	let fake = store.into_transport();
	assert_eq!(fake.bytes, b"v4\n", "conflict leaves bytes unchanged");
	assert!(fake.forced_replies.is_empty());
}

#[test]
fn sql_store_satisfies_byte_journal_contract() {
	let store = SqlStore::open(SqlFake::default(), SqlDialect::Sqlite, "session")
		.expect("initialize dialect");
	block_on(assert_byte_journal_contract(store));

	let fake = SqlFake {
		bytes:          b"v4\n".to_vec(),
		forced_replies: VecDeque::from([SqlReply::Fenced {
			applied:   false,
			resulting: 9,
			observed:  9,
		}]),
	};
	let mut store =
		SqlStore::open(fake, SqlDialect::Sqlite, "conflict").expect("initialize conflict store");
	assert!(matches!(store.append(b"more"), Err(SqlError::Conflict { expected: 3, observed: 9 })));
	assert_eq!(
		store.read(0, 9).expect("read after conflict"),
		b"v4\n",
		"conflict leaves bytes unchanged"
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
