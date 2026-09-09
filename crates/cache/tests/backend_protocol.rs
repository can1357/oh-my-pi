//! Byte-target protocol tests without live Redis or SQL servers.

use std::{collections::VecDeque, convert::Infallible};

use omp_cache::backend::{
	ByteJournalStore, DaemonWriter, MemoryStore,
	redis::{Command as RedisCommand, RedisStore, Reply as RedisReply, Transport as RedisTransport},
	sql::{
		Command as SqlCommand, Reply as SqlReply, SqlDialect, SqlStore, Transport as SqlTransport,
	},
};

struct RedisFake {
	replies: VecDeque<RedisReply>,
	ops:     Vec<&'static str>,
}

impl RedisTransport for RedisFake {
	type Error = Infallible;

	fn execute(&mut self, command: RedisCommand<'_>) -> Result<RedisReply, Self::Error> {
		self.ops.push(match command {
			RedisCommand::Length { .. } => "length",
			RedisCommand::Range { .. } => "range",
			RedisCommand::Append { .. } => "append",
			RedisCommand::Truncate { .. } => "truncate",
		});
		Ok(self.replies.pop_front().expect("scripted Redis reply"))
	}
}

#[test]
fn memory_and_redis_use_identical_append_rollback_shape() {
	let mut memory = DaemonWriter::new(MemoryStore::new());
	assert_eq!(memory.append(b"v4\n").expect("memory append"), 3);
	assert_eq!(memory.store().as_bytes(), b"v4\n");

	let fake = RedisFake {
		replies: VecDeque::from([
			RedisReply::Integer(0),
			RedisReply::Fenced { resulting: 3, observed: 0 },
			RedisReply::Bytes(b"v4\n".to_vec()),
			RedisReply::Fenced { resulting: 0, observed: 3 },
		]),
		ops:     Vec::new(),
	};
	let mut redis = RedisStore::new(fake, "omp:sessions:test");
	assert_eq!(redis.append(b"v4\n").expect("fenced append"), 3);
	assert_eq!(redis.read(0, 3).expect("range"), b"v4\n");
	redis.truncate(0).expect("rollback");
	let fake = redis.into_transport();
	assert_eq!(fake.ops, ["length", "append", "range", "truncate"]);
	assert!(RedisStore::<RedisFake>::append_script().contains("STRLEN"));
	assert!(RedisStore::<RedisFake>::truncate_script().contains("GETRANGE"));
}

struct SqlFake {
	replies: VecDeque<SqlReply>,
	ops:     Vec<&'static str>,
}

impl SqlTransport for SqlFake {
	type Error = Infallible;

	fn execute(&mut self, command: SqlCommand<'_>) -> Result<SqlReply, Self::Error> {
		self.ops.push(match command {
			SqlCommand::Initialize { .. } => "initialize",
			SqlCommand::Length { .. } => "length",
			SqlCommand::Range { .. } => "range",
			SqlCommand::Append { .. } => "append",
			SqlCommand::Truncate { .. } => "truncate",
		});
		Ok(self.replies.pop_front().expect("scripted SQL reply"))
	}
}

#[test]
fn every_sql_dialect_has_fenced_byte_queries() {
	for dialect in [SqlDialect::Postgres, SqlDialect::Mysql, SqlDialect::Sqlite] {
		let fake = SqlFake {
			replies: VecDeque::from([
				SqlReply::Done,
				SqlReply::Length(0),
				SqlReply::Fenced { applied: true, resulting: 3, observed: 0 },
				SqlReply::Fenced { applied: true, resulting: 0, observed: 3 },
			]),
			ops:     Vec::new(),
		};
		let mut store = SqlStore::open(fake, dialect, "session").expect("initialize dialect");
		assert_eq!(store.append(b"v4\n").expect("append"), 3);
		store.truncate(0).expect("truncate");
		let statements = store.statements();
		assert!(statements[3].contains("omp_session_files"));
		assert!(statements[4].contains("omp_session_files"));
	}
}
