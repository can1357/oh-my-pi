//! Storage-authority-owned persistent MCP definition cache.

use std::{collections::BTreeMap, path::Path, time::Duration};

use bytes::Bytes;
use omp_core::{ExposeSecret as _, SecretString};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension as _, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

/// Definition lifetime: thirty days.
pub const MCP_DEFINITION_TTL: Duration = Duration::from_hours(720);
const SCHEMA_VERSION: i64 = 1;
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS mcp_cache_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL
);
INSERT OR IGNORE INTO mcp_cache_meta(singleton, schema_version) VALUES (1, 1);
CREATE TABLE IF NOT EXISTS mcp_definitions (
  server_name TEXT NOT NULL,
  config_sha256 BLOB NOT NULL CHECK (length(config_sha256) = 32),
  definitions_json BLOB NOT NULL,
  stored_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(server_name, config_sha256)
);
CREATE INDEX IF NOT EXISTS mcp_definitions_expiry ON mcp_definitions(expires_at_ms);
";

/// One live cache record returned only for an exact server/config digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CachedDefinitions {
	/// Canonical JSON array of advertised definitions.
	pub definitions_json: Bytes,
	/// Storage-authority timestamp.
	pub stored_at_ms:     u64,
	/// Expiry timestamp.
	pub expires_at_ms:    u64,
}

/// MCP definition cache failure.
#[derive(Debug, thiserror::Error)]
pub enum McpCacheError {
	/// SQLite authority failed.
	#[error(transparent)]
	Database(#[from] rusqlite::Error),
	/// Configuration or definition JSON is malformed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// Definitions were not a JSON array.
	#[error("MCP cached definitions must be a JSON array")]
	DefinitionsNotArray,
	/// Server name is empty, oversized, or contains control characters.
	#[error("MCP cache server name is invalid")]
	InvalidServerName,
	/// Timestamp cannot be represented by SQLite.
	#[error("MCP cache timestamp is out of range")]
	InvalidTimestamp,
	/// On-disk schema does not match this crate.
	#[error("MCP cache schema version is unsupported")]
	UnsupportedSchema,
}

/// SQLite WAL cache whose writes are serialized by immediate transactions.
pub struct McpDefinitionCache {
	connection: Mutex<Connection>,
}

impl McpDefinitionCache {
	/// Opens or creates the storage-authority cache.
	pub fn open(path: impl AsRef<Path>) -> Result<Self, McpCacheError> {
		let connection = Connection::open(path)?;
		connection.busy_timeout(Duration::from_secs(5))?;
		connection.pragma_update(None, "journal_mode", "WAL")?;
		connection.pragma_update(None, "synchronous", "FULL")?;
		connection.execute_batch(SCHEMA)?;
		let version = connection.query_row(
			"SELECT schema_version FROM mcp_cache_meta WHERE singleton = 1",
			[],
			|row| row.get::<_, i64>(0),
		)?;
		if version != SCHEMA_VERSION {
			return Err(McpCacheError::UnsupportedSchema);
		}
		Ok(Self { connection: Mutex::new(connection) })
	}

	/// Loads definitions only when the canonical configuration hash matches and
	/// the thirty-day TTL has not elapsed. Expired records are removed in the
	/// same authority transaction.
	pub fn get(
		&self,
		server_name: &str,
		config_json: &[u8],
		now_ms: u64,
	) -> Result<Option<CachedDefinitions>, McpCacheError> {
		validate_server_name(server_name)?;
		let digest = config_digest(config_json)?;
		let now = sql_time(now_ms)?;
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute("DELETE FROM mcp_definitions WHERE expires_at_ms <= ?1", [now])?;
		let row = transaction
			.query_row(
				"SELECT definitions_json, stored_at_ms, expires_at_ms FROM mcp_definitions
				 WHERE server_name = ?1 AND config_sha256 = ?2",
				params![server_name, digest.as_slice()],
				|row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, u64>(1)?, row.get::<_, u64>(2)?)),
			)
			.optional()?;
		let Some((definitions_json, stored_at_ms, expires_at_ms)) = row else {
			transaction.commit()?;
			return Ok(None);
		};
		let valid = serde_json::from_slice::<Value>(&definitions_json)
			.is_ok_and(|definitions| definitions.is_array());
		if !valid {
			transaction.execute(
				"DELETE FROM mcp_definitions WHERE server_name = ?1 AND config_sha256 = ?2",
				params![server_name, digest.as_slice()],
			)?;
			transaction.commit()?;
			return Ok(None);
		}
		transaction.commit()?;
		Ok(Some(CachedDefinitions {
			definitions_json: Bytes::from(definitions_json),
			stored_at_ms,
			expires_at_ms,
		}))
	}

	/// Atomically replaces one server's cached definition generation.
	pub fn put(
		&self,
		server_name: &str,
		config_json: &[u8],
		definitions_json: &[u8],
		now_ms: u64,
	) -> Result<[u8; 32], McpCacheError> {
		validate_server_name(server_name)?;
		let digest = config_digest(config_json)?;
		let definitions: Value = serde_json::from_slice(definitions_json)?;
		if !definitions.is_array() {
			return Err(McpCacheError::DefinitionsNotArray);
		}
		let stored = sql_time(now_ms)?;
		let expires_at_ms = now_ms
			.checked_add(
				u64::try_from(MCP_DEFINITION_TTL.as_millis())
					.map_err(|_| McpCacheError::InvalidTimestamp)?,
			)
			.ok_or(McpCacheError::InvalidTimestamp)?;
		let expires = sql_time(expires_at_ms)?;
		let mut connection = self.connection.lock();
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute(
			"DELETE FROM mcp_definitions WHERE server_name = ?1 AND config_sha256 != ?2",
			params![server_name, digest.as_slice()],
		)?;
		transaction.execute(
			"INSERT INTO mcp_definitions(
			 server_name, config_sha256, definitions_json, stored_at_ms, expires_at_ms
			 ) VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(server_name, config_sha256) DO UPDATE SET
			 definitions_json = excluded.definitions_json,
			 stored_at_ms = excluded.stored_at_ms,
			 expires_at_ms = excluded.expires_at_ms",
			params![server_name, digest.as_slice(), definitions_json, stored, expires],
		)?;
		transaction.commit()?;
		Ok(digest)
	}

	/// Removes all definitions owned by a server.
	pub fn remove_server(&self, server_name: &str) -> Result<bool, McpCacheError> {
		validate_server_name(server_name)?;
		let changed = self
			.connection
			.lock()
			.execute("DELETE FROM mcp_definitions WHERE server_name = ?1", [server_name])?;
		Ok(changed != 0)
	}
}

/// Computes the SHA-256 of stable JSON: object keys are sorted recursively
/// while array order remains significant.
pub fn config_digest(config_json: &[u8]) -> Result<[u8; 32], McpCacheError> {
	let value: Value = serde_json::from_slice(config_json)?;
	let canonical = canonical_json(&value)?;
	Ok(Sha256::digest(canonical.expose_secret().as_bytes()).into())
}

fn canonical_json(value: &Value) -> Result<SecretString, serde_json::Error> {
	fn stable(value: &Value) -> Value {
		match value {
			Value::Array(values) => Value::Array(values.iter().map(stable).collect()),
			Value::Object(values) => {
				let sorted = values
					.iter()
					.map(|(key, value)| (key.clone(), stable(value)))
					.collect::<BTreeMap<_, _>>();
				Value::Object(sorted.into_iter().collect())
			},
			other => other.clone(),
		}
	}
	serde_json::to_string(&stable(value)).map(SecretString::from)
}

fn validate_server_name(server_name: &str) -> Result<(), McpCacheError> {
	if server_name.is_empty() || server_name.len() > 100 || server_name.chars().any(char::is_control)
	{
		return Err(McpCacheError::InvalidServerName);
	}
	Ok(())
}

fn sql_time(value: u64) -> Result<i64, McpCacheError> {
	i64::try_from(value).map_err(|_| McpCacheError::InvalidTimestamp)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn restart_ttl_and_config_keying() {
		let directory = tempfile::tempdir().expect("cache directory");
		let path = directory.path().join("mcp.sqlite3");
		let first = br#"{"url":"https://mcp.example","headers":{"b":"2","a":"1"}}"#;
		let reordered = br#"{"headers":{"a":"1","b":"2"},"url":"https://mcp.example"}"#;
		let changed = br#"{"url":"https://other.example"}"#;
		{
			let cache = McpDefinitionCache::open(&path).expect("open cache");
			cache
				.put("alpha", first, br#"[{"name":"tool"}]"#, 1_000)
				.expect("put");
			assert!(cache.get("alpha", reordered, 1_001).expect("get").is_some());
			assert!(cache.get("alpha", changed, 1_001).expect("get").is_none());
		}
		let cache = McpDefinitionCache::open(&path).expect("reopen cache");
		assert!(
			cache
				.get("alpha", first, 2_000)
				.expect("restart get")
				.is_some()
		);
		let expired = 1_000 + u64::try_from(MCP_DEFINITION_TTL.as_millis()).expect("ttl");
		assert!(
			cache
				.get("alpha", first, expired)
				.expect("expired get")
				.is_none()
		);
	}

	#[test]
	fn replacement_invalidates_other_config_generations() {
		let directory = tempfile::tempdir().expect("cache directory");
		let cache =
			McpDefinitionCache::open(directory.path().join("mcp.sqlite3")).expect("open cache");
		let first = br#"{"url":"https://one.example"}"#;
		let second = br#"{"url":"https://two.example"}"#;
		cache
			.put("alpha", first, br#"[{"name":"old"}]"#, 1_000)
			.expect("first generation");
		cache
			.put("alpha", second, br#"[{"name":"new"}]"#, 2_000)
			.expect("second generation");
		assert!(cache.get("alpha", first, 2_001).expect("old get").is_none());
		assert_eq!(
			cache
				.get("alpha", second, 2_001)
				.expect("new get")
				.expect("new generation")
				.definitions_json,
			Bytes::from_static(br#"[{"name":"new"}]"#)
		);
	}

	#[test]
	fn malformed_persisted_payload_is_invalidated_on_read() {
		let directory = tempfile::tempdir().expect("cache directory");
		let cache =
			McpDefinitionCache::open(directory.path().join("mcp.sqlite3")).expect("open cache");
		let config = br#"{"url":"https://one.example"}"#;
		cache
			.put("alpha", config, br#"[{"name":"tool"}]"#, 1_000)
			.expect("valid generation");
		cache
			.connection
			.lock()
			.execute(
				"UPDATE mcp_definitions SET definitions_json = ?1 WHERE server_name = ?2",
				params![b"{broken".as_slice(), "alpha"],
			)
			.expect("corrupt fixture");
		assert!(
			cache
				.get("alpha", config, 1_001)
				.expect("corrupt get")
				.is_none()
		);
		let remaining = cache
			.connection
			.lock()
			.query_row("SELECT count(*) FROM mcp_definitions", [], |row| row.get::<_, u64>(0))
			.expect("remaining rows");
		assert_eq!(remaining, 0);
	}
}
