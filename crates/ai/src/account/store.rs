//! Durable secret-free account ownership, rejection, cooldown, rate, quota, and
//! affinity metadata.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt,
	path::{Path, PathBuf},
	str::FromStr,
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_catalog::{ProviderId, RouteId};
use omp_core::Str;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use super::{
	AccountRecord, CooldownReason, QuotaObservation, QuotaProvenance, QuotaState, QuotaWindowId,
	RateObservation, RateState, RateWindowId,
};
use crate::{
	call::AccountRoutingContext,
	id::{AccountId, OrganizationId, PrincipalId, ProjectId, RegionId, TenantId},
};

/// Identifies a durable affinity domain such as a conversation or workload.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AffinityScope(Str);

impl AffinityScope {
	/// Creates an affinity scope from stored text.
	pub fn new(value: impl Into<Str>) -> Self {
		Self(value.into())
	}

	/// Borrows the stable scope text.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

/// Durable affinity from a scope to an account and principal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountAffinity {
	/// Affinity domain.
	pub scope:      AffinityScope,
	/// Preferred account.
	pub account:    AccountId,
	/// Principal represented by the preferred account.
	pub principal:  PrincipalId,
	/// Time at which affinity was most recently selected.
	pub updated_at: SystemTime,
}

/// Durable non-rate, non-quota account cooldown.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedCooldown {
	/// Account held in cooldown.
	pub account: AccountId,
	/// Time at which the cooldown clears.
	pub until:   SystemTime,
	/// Typed reason for the cooldown.
	pub reason:  CooldownReason,
}

/// Durable evidence that one credential generation was rejected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedRejection {
	/// Rejected credential generation.
	pub generation:  u64,
	/// Time at which the generation was rejected.
	pub observed_at: SystemTime,
}

/// Complete persisted runtime state for one account.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PersistedAccountState {
	/// Current explicit cooldown, when one was stored.
	pub cooldown:  Option<PersistedCooldown>,
	/// Most recent rejected credential generation, when present.
	pub rejection: Option<PersistedRejection>,
	/// Independently reconstructed rate windows and partial receipts.
	pub rate:      RateState,
	/// Independently reconstructed quota windows and partial receipts.
	pub quota:     QuotaState,
}

/// Failure reading or writing secret-free account metadata.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AccountStateStoreError {
	/// SQLite rejected a schema, query, or transaction operation.
	#[error("account state database operation failed")]
	Database {
		/// Sanitized storage diagnostic.
		summary: Str,
	},
	/// A timestamp or counter cannot be represented losslessly by SQLite.
	#[error("account state value is out of range")]
	OutOfRange,
	/// A persisted enum value is not part of the current typed vocabulary.
	#[error("invalid persisted account state {field}")]
	InvalidVocabulary {
		/// Name of the persisted field containing the invalid value.
		field: &'static str,
		/// Unrecognized persisted vocabulary value.
		value: Str,
	},
	/// Existing static ownership does not match the attempted account record.
	#[error("account static ownership is immutable")]
	IdentityConflict,
}

impl From<rusqlite::Error> for AccountStateStoreError {
	fn from(error: rusqlite::Error) -> Self {
		Self::Database { summary: Str::new(error.to_string()) }
	}
}

/// Clone-cheap SQLite store for metadata that must outlive credential material.
#[derive(Clone)]
pub struct AccountStateStore {
	path:   PathBuf,
	writes: Arc<Mutex<()>>,
}

impl fmt::Debug for AccountStateStore {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("AccountStateStore")
			.field("path", &self.path)
			.finish_non_exhaustive()
	}
}

impl AccountStateStore {
	/// Opens the application database and creates namespaced account-state
	/// tables.
	pub fn open(path: impl Into<PathBuf>) -> Result<Self, AccountStateStoreError> {
		let store = Self { path: path.into(), writes: Arc::new(Mutex::new(())) };
		let mut connection = store.connection()?;
		migrate(&mut connection)?;
		Ok(store)
	}

	/// Returns the backing application database path for constructor wiring.
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Atomically upserts non-secret static account ownership and exact eligible
	/// routes.
	///
	/// Returns the persisted generation, which never regresses when stale
	/// discovery metadata is replayed.
	pub fn upsert_account(&self, record: &AccountRecord) -> Result<u64, AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let existing = transaction
			.query_row(
				"SELECT principal_id, provider_id FROM account_state_accounts WHERE account_id = ?1",
				[record.account.as_str()],
				|row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
			)
			.optional()?;
		if existing.as_ref().is_some_and(|(principal, provider)| {
			principal != record.principal.as_str() || provider != record.provider.as_str()
		}) {
			return Err(AccountStateStoreError::IdentityConflict);
		}
		transaction.execute(
			"INSERT INTO account_state_accounts (
			 account_id, principal_id, provider_id, enabled, credential_generation,
			 project_id, tenant_id, organization_id, region_id
			) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
			ON CONFLICT(account_id) DO UPDATE SET
			 enabled = excluded.enabled,
			 credential_generation = MAX(account_state_accounts.credential_generation, \
			 excluded.credential_generation),
			 project_id = excluded.project_id,
			 tenant_id = excluded.tenant_id,
			 organization_id = excluded.organization_id,
			 region_id = excluded.region_id",
			params![
				record.account.as_str(),
				record.principal.as_str(),
				record.provider.as_str(),
				record.enabled,
				i64::try_from(record.credential_generation)
					.map_err(|_| AccountStateStoreError::OutOfRange)?,
				record.routing.project.as_ref().map(|id| id.as_str()),
				record.routing.tenant.as_ref().map(|id| id.as_str()),
				record.routing.organization.as_ref().map(|id| id.as_str()),
				record.routing.region.as_ref().map(|id| id.as_str()),
			],
		)?;
		transaction.execute("DELETE FROM account_state_account_routes WHERE account_id = ?1", [
			record.account.as_str(),
		])?;
		for route in &record.routes {
			transaction.execute(
				"INSERT INTO account_state_account_routes (account_id, route_id) VALUES (?1, ?2)",
				params![record.account.as_str(), route.as_str()],
			)?;
		}
		let generation = transaction.query_row(
			"SELECT credential_generation FROM account_state_accounts WHERE account_id = ?1",
			[record.account.as_str()],
			|row| row.get::<_, i64>(0),
		)?;
		transaction.execute(
			"DELETE FROM account_state_rejections
			 WHERE account_id = ?1 AND generation < ?2",
			params![record.account.as_str(), generation],
		)?;
		transaction.commit()?;
		u64::try_from(generation).map_err(|_| AccountStateStoreError::OutOfRange)
	}

	/// Loads every static account record in stable account-ID order.
	pub fn load_accounts(&self) -> Result<Vec<AccountRecord>, AccountStateStoreError> {
		let connection = self.connection()?;
		let mut routes = BTreeMap::<AccountId, BTreeSet<RouteId>>::new();
		let mut statement = connection.prepare(
			"SELECT account_id, route_id FROM account_state_account_routes ORDER BY account_id, \
			 route_id",
		)?;
		let rows =
			statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
		for row in rows {
			let (account, route) = row?;
			routes
				.entry(AccountId::new(account))
				.or_default()
				.insert(RouteId::from(route));
		}
		drop(statement);
		let mut statement = connection.prepare(
			"SELECT account_id, principal_id, provider_id, enabled, credential_generation,
			 project_id, tenant_id, organization_id, region_id
			 FROM account_state_accounts ORDER BY account_id",
		)?;
		let rows = statement.query_map([], |row| {
			Ok((
				row.get::<_, String>(0)?,
				row.get::<_, String>(1)?,
				row.get::<_, String>(2)?,
				row.get::<_, bool>(3)?,
				row.get::<_, i64>(4)?,
				row.get::<_, Option<String>>(5)?,
				row.get::<_, Option<String>>(6)?,
				row.get::<_, Option<String>>(7)?,
				row.get::<_, Option<String>>(8)?,
			))
		})?;
		let mut records = Vec::new();
		for row in rows {
			let (
				account,
				principal,
				provider,
				enabled,
				generation,
				project,
				tenant,
				organization,
				region,
			) = row?;
			let account = AccountId::new(account);
			records.push(AccountRecord {
				routes: routes.remove(&account).unwrap_or_default(),
				account,
				principal: PrincipalId::new(principal),
				provider: ProviderId::from(provider),
				enabled,
				credential_generation: u64::try_from(generation)
					.map_err(|_| AccountStateStoreError::OutOfRange)?,
				routing: AccountRoutingContext {
					account:               None,
					principal:             None,
					credential_generation: None,
					project:               project.map(ProjectId::new),
					tenant:                tenant.map(TenantId::new),
					organization:          organization.map(OrganizationId::new),
					region:                region.map(RegionId::new),
				},
			});
		}
		Ok(records)
	}

	/// Updates only credential generation after proving stable principal
	/// ownership.
	pub fn update_generation(
		&self,
		account: &AccountId<str>,
		principal: &PrincipalId<str>,
		generation: u64,
	) -> Result<bool, AccountStateStoreError> {
		let generation = i64::try_from(generation).map_err(|_| AccountStateStoreError::OutOfRange)?;
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let changed = transaction.execute(
			"UPDATE account_state_accounts SET credential_generation = ?3
			 WHERE account_id = ?1 AND principal_id = ?2 AND credential_generation <= ?3",
			params![account.as_str(), principal.as_str(), generation],
		)?;
		if changed != 0 {
			transaction.execute(
				"DELETE FROM account_state_rejections
				 WHERE account_id = ?1 AND generation < ?2",
				params![account.as_str(), generation],
			)?;
		}
		transaction.commit()?;
		Ok(changed != 0)
	}

	/// Records a rejected generation monotonically without changing account
	/// ownership.
	pub fn save_rejection(
		&self,
		account: &AccountId<str>,
		rejection: &PersistedRejection,
	) -> Result<(), AccountStateStoreError> {
		let generation =
			i64::try_from(rejection.generation).map_err(|_| AccountStateStoreError::OutOfRange)?;
		let _guard = self.writes.lock();
		self.connection()?.execute(
			"INSERT INTO account_state_rejections (account_id, generation, observed_at_ms)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT(account_id) DO UPDATE SET
			 generation = excluded.generation,
			 observed_at_ms = excluded.observed_at_ms
			 WHERE excluded.generation >= account_state_rejections.generation",
			params![account.as_str(), generation, to_millis(rejection.observed_at)?],
		)?;
		Ok(())
	}

	/// Enables or disables a static account record without touching accounting
	/// history.
	pub fn set_account_enabled(
		&self,
		account: &AccountId<str>,
		enabled: bool,
	) -> Result<bool, AccountStateStoreError> {
		let _guard = self.writes.lock();
		let changed = self.connection()?.execute(
			"UPDATE account_state_accounts SET enabled = ?2 WHERE account_id = ?1",
			params![account.as_str(), enabled],
		)?;
		Ok(changed != 0)
	}

	/// Loads rejection, cooldown, and every rate/quota partial receipt for one
	/// account.
	pub fn load_account(
		&self,
		account: &AccountId<str>,
	) -> Result<PersistedAccountState, AccountStateStoreError> {
		let connection = self.connection()?;
		let cooldown = connection
			.query_row(
				"SELECT until_ms, reason FROM account_state_cooldowns WHERE account_id = ?1",
				[account.as_str()],
				|row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
			)
			.optional()?
			.map(|(until_ms, reason)| {
				Ok::<PersistedCooldown, AccountStateStoreError>(PersistedCooldown {
					account: account.to_owned(),
					until:   from_millis(until_ms)?,
					reason:  CooldownReason::from_str(&reason).map_err(|_| {
						AccountStateStoreError::InvalidVocabulary {
							field: "cooldown reason",
							value: Str::new(reason),
						}
					})?,
				})
			})
			.transpose()?;
		let rejection = connection
			.query_row(
				"SELECT generation, observed_at_ms FROM account_state_rejections WHERE account_id = ?1",
				[account.as_str()],
				|row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
			)
			.optional()?
			.map(|(generation, observed_at)| {
				Ok::<PersistedRejection, AccountStateStoreError>(PersistedRejection {
					generation:  u64::try_from(generation)
						.map_err(|_| AccountStateStoreError::OutOfRange)?,
					observed_at: from_millis(observed_at)?,
				})
			})
			.transpose()?;

		let mut rate = RateState::default();
		let mut statement = connection.prepare(
			"SELECT window_id, limit_value, remaining_value, reset_at_ms, retry_at_ms, observed_at_ms
			 FROM account_state_rate_receipts WHERE account_id = ?1 ORDER BY receipt_id",
		)?;
		let rows = statement.query_map([account.as_str()], |row| {
			Ok((
				row.get::<_, String>(0)?,
				row.get::<_, Option<i64>>(1)?,
				row.get::<_, Option<i64>>(2)?,
				row.get::<_, Option<i64>>(3)?,
				row.get::<_, Option<i64>>(4)?,
				row.get::<_, i64>(5)?,
			))
		})?;
		for row in rows {
			let (window, limit, remaining, reset_at, retry_at, observed_at) = row?;
			rate.apply(RateObservation {
				window:      RateWindowId::new(window),
				limit:       optional_u64(limit)?,
				remaining:   optional_u64(remaining)?,
				reset_at:    optional_time(reset_at)?,
				retry_at:    optional_time(retry_at)?,
				observed_at: from_millis(observed_at)?,
			});
		}
		drop(statement);

		let mut quota = QuotaState::default();
		let mut statement = connection.prepare(
			"SELECT window_id, consumed_value, remaining_value, limit_value, reset_at_ms,
			 exhausted, provenance, observed_at_ms
			 FROM account_state_quota_receipts WHERE account_id = ?1 ORDER BY receipt_id",
		)?;
		let rows = statement.query_map([account.as_str()], |row| {
			Ok((
				row.get::<_, String>(0)?,
				row.get::<_, Option<i64>>(1)?,
				row.get::<_, Option<i64>>(2)?,
				row.get::<_, Option<i64>>(3)?,
				row.get::<_, Option<i64>>(4)?,
				row.get::<_, Option<bool>>(5)?,
				row.get::<_, String>(6)?,
				row.get::<_, i64>(7)?,
			))
		})?;
		for row in rows {
			let (window, consumed, remaining, limit, reset_at, exhausted, provenance, observed_at) =
				row?;
			quota.apply(QuotaObservation {
				window: QuotaWindowId::new(window),
				consumed: optional_u64(consumed)?,
				remaining: optional_u64(remaining)?,
				limit: optional_u64(limit)?,
				reset_at: optional_time(reset_at)?,
				exhausted,
				provenance: QuotaProvenance::from_str(&provenance).map_err(|_| {
					AccountStateStoreError::InvalidVocabulary {
						field: "quota provenance",
						value: Str::new(provenance),
					}
				})?,
				observed_at: from_millis(observed_at)?,
			});
		}
		Ok(PersistedAccountState { cooldown, rejection, rate, quota })
	}

	/// Atomically upserts an explicit cooldown without touching credential
	/// tables.
	pub fn save_cooldown(&self, cooldown: &PersistedCooldown) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute(
			"INSERT INTO account_state_cooldowns (account_id, until_ms, reason) VALUES (?1, ?2, ?3)
			 ON CONFLICT(account_id) DO UPDATE SET until_ms = excluded.until_ms, reason = excluded.reason",
			params![
				cooldown.account.as_str(),
				to_millis(cooldown.until)?,
				cooldown.reason.to_string()
			],
		)?;
		transaction.commit()?;
		Ok(())
	}

	/// Removes only the explicit cooldown for an account.
	pub fn clear_cooldown(&self, account: &AccountId<str>) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		self
			.connection()?
			.execute(
				"DELETE FROM account_state_cooldowns WHERE account_id = ?1",
				[account.as_str()],
			)?;
		Ok(())
	}

	/// Invalidates durable rate and quota observations without touching account
	/// ownership, credentials, affinities, or rejection history.
	pub fn invalidate_usage(
		&self,
		provider: Option<&ProviderId<str>>,
		account: Option<&AccountId<str>>,
	) -> Result<usize, AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let (rate, quota) = if let Some(account) = account {
			(
				transaction
					.execute("DELETE FROM account_state_rate_receipts WHERE account_id = ?1", [
						account.as_str(),
					])?,
				transaction
					.execute("DELETE FROM account_state_quota_receipts WHERE account_id = ?1", [
						account.as_str(),
					])?,
			)
		} else if let Some(provider) = provider {
			(
				transaction.execute(
					"DELETE FROM account_state_rate_receipts
					 WHERE account_id IN (
						SELECT account_id FROM account_state_accounts WHERE provider_id = ?1
					 )",
					[provider.as_str()],
				)?,
				transaction.execute(
					"DELETE FROM account_state_quota_receipts
					 WHERE account_id IN (
						SELECT account_id FROM account_state_accounts WHERE provider_id = ?1
					 )",
					[provider.as_str()],
				)?,
			)
		} else {
			(
				transaction.execute("DELETE FROM account_state_rate_receipts", [])?,
				transaction.execute("DELETE FROM account_state_quota_receipts", [])?,
			)
		};
		transaction.commit()?;
		Ok(rate.saturating_add(quota))
	}

	/// Appends one partial rate receipt atomically.
	pub fn append_rate(
		&self,
		account: &AccountId<str>,
		observation: &RateObservation,
	) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute(
			"INSERT INTO account_state_rate_receipts
			 (account_id, window_id, limit_value, remaining_value, reset_at_ms, retry_at_ms, observed_at_ms)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
			params![
				account.as_str(),
				observation.window.as_str(),
				optional_i64(observation.limit)?,
				optional_i64(observation.remaining)?,
				optional_millis(observation.reset_at)?,
				optional_millis(observation.retry_at)?,
				to_millis(observation.observed_at)?,
			],
		)?;
		transaction.commit()?;
		Ok(())
	}

	/// Clears selected durable rate windows for one account, or every window
	/// when the selection is empty.
	pub fn clear_rate(
		&self,
		account: &AccountId<str>,
		scopes: &[Str],
	) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		if scopes.is_empty() {
			transaction.execute("DELETE FROM account_state_rate_receipts WHERE account_id = ?1", [
				account.as_str(),
			])?;
		} else {
			for scope in scopes {
				transaction.execute(
					"DELETE FROM account_state_rate_receipts
					 WHERE account_id = ?1 AND window_id = ?2",
					params![account.as_str(), scope.as_str()],
				)?;
			}
		}
		transaction.commit()?;
		Ok(())
	}

	/// Appends one partial quota receipt atomically.
	pub fn append_quota(
		&self,
		account: &AccountId<str>,
		observation: &QuotaObservation,
	) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute(
			"INSERT INTO account_state_quota_receipts
			 (account_id, window_id, consumed_value, remaining_value, limit_value, reset_at_ms,
			  exhausted, provenance, observed_at_ms)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
			params![
				account.as_str(),
				observation.window.as_str(),
				optional_i64(observation.consumed)?,
				optional_i64(observation.remaining)?,
				optional_i64(observation.limit)?,
				optional_millis(observation.reset_at)?,
				observation.exhausted,
				observation.provenance.to_string(),
				to_millis(observation.observed_at)?,
			],
		)?;
		transaction.commit()?;
		Ok(())
	}

	/// Atomically records durable account/principal affinity.
	pub fn save_affinity(&self, affinity: &AccountAffinity) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		let owns_principal = transaction.query_row(
			"SELECT EXISTS(
				SELECT 1 FROM account_state_accounts
				WHERE account_id = ?1 AND principal_id = ?2
			)",
			params![affinity.account.as_str(), affinity.principal.as_str()],
			|row| row.get::<_, bool>(0),
		)?;
		if !owns_principal {
			return Err(AccountStateStoreError::IdentityConflict);
		}
		transaction.execute(
			"INSERT INTO account_state_affinity (scope, account_id, principal_id, updated_at_ms)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(scope) DO UPDATE SET account_id = excluded.account_id,
			 principal_id = excluded.principal_id, updated_at_ms = excluded.updated_at_ms",
			params![
				affinity.scope.as_str(),
				affinity.account.as_str(),
				affinity.principal.as_str(),
				to_millis(affinity.updated_at)?
			],
		)?;
		transaction.commit()?;
		Ok(())
	}

	/// Loads durable affinity for one scope.
	pub fn affinity(
		&self,
		scope: &AffinityScope,
	) -> Result<Option<AccountAffinity>, AccountStateStoreError> {
		let connection = self.connection()?;
		connection
			.query_row(
				"SELECT account_id, principal_id, updated_at_ms FROM account_state_affinity WHERE \
				 scope = ?1",
				[scope.as_str()],
				|row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
			)
			.optional()?
			.map(|(account, principal, updated_at)| {
				Ok::<AccountAffinity, AccountStateStoreError>(AccountAffinity {
					scope:      scope.clone(),
					account:    AccountId::new(account),
					principal:  PrincipalId::new(principal),
					updated_at: from_millis(updated_at)?,
				})
			})
			.transpose()
	}

	/// Explicitly purges secret-free account state; credential removal never
	/// calls this.
	pub fn purge_account(&self, account: &AccountId<str>) -> Result<(), AccountStateStoreError> {
		let _guard = self.writes.lock();
		let mut connection = self.connection()?;
		let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
		transaction.execute("DELETE FROM account_state_cooldowns WHERE account_id = ?1", [
			account.as_str(),
		])?;
		transaction.execute("DELETE FROM account_state_rejections WHERE account_id = ?1", [
			account.as_str(),
		])?;
		transaction.execute("DELETE FROM account_state_rate_receipts WHERE account_id = ?1", [
			account.as_str(),
		])?;
		transaction.execute("DELETE FROM account_state_quota_receipts WHERE account_id = ?1", [
			account.as_str(),
		])?;
		transaction
			.execute("DELETE FROM account_state_affinity WHERE account_id = ?1", [account.as_str()])?;
		transaction.execute("DELETE FROM account_state_account_routes WHERE account_id = ?1", [
			account.as_str(),
		])?;
		transaction
			.execute("DELETE FROM account_state_accounts WHERE account_id = ?1", [account.as_str()])?;
		transaction.commit()?;
		Ok(())
	}

	fn connection(&self) -> Result<Connection, AccountStateStoreError> {
		let connection = Connection::open(&self.path)?;
		connection.busy_timeout(Duration::from_secs(5))?;
		connection.pragma_update(None, "foreign_keys", true)?;
		connection.pragma_update(None, "journal_mode", "WAL")?;
		Ok(connection)
	}
}

fn migrate(connection: &mut Connection) -> Result<(), AccountStateStoreError> {
	let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
	transaction.execute_batch(
		"CREATE TABLE IF NOT EXISTS account_state_accounts (
			account_id TEXT PRIMARY KEY NOT NULL,
			principal_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			enabled INTEGER NOT NULL,
			credential_generation INTEGER NOT NULL,
			project_id TEXT,
			tenant_id TEXT,
			organization_id TEXT,
			region_id TEXT
		);
		CREATE INDEX IF NOT EXISTS account_state_accounts_provider
			ON account_state_accounts(provider_id, account_id);
		CREATE TABLE IF NOT EXISTS account_state_account_routes (
			account_id TEXT NOT NULL,
			route_id TEXT NOT NULL,
			PRIMARY KEY(account_id, route_id)
		);
		CREATE INDEX IF NOT EXISTS account_state_routes_route
			ON account_state_account_routes(route_id, account_id);
		CREATE TABLE IF NOT EXISTS account_state_cooldowns (
			account_id TEXT PRIMARY KEY NOT NULL,
			until_ms INTEGER NOT NULL,
			reason TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS account_state_rejections (
			account_id TEXT PRIMARY KEY NOT NULL,
			generation INTEGER NOT NULL,
			observed_at_ms INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS account_state_rate_receipts (
			receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL,
			window_id TEXT NOT NULL,
			limit_value INTEGER,
			remaining_value INTEGER,
			reset_at_ms INTEGER,
			retry_at_ms INTEGER,
			observed_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS account_state_rate_account
			ON account_state_rate_receipts(account_id, receipt_id);
		CREATE TABLE IF NOT EXISTS account_state_quota_receipts (
			receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
			account_id TEXT NOT NULL,
			window_id TEXT NOT NULL,
			consumed_value INTEGER,
			remaining_value INTEGER,
			limit_value INTEGER,
			reset_at_ms INTEGER,
			exhausted INTEGER,
			provenance TEXT NOT NULL,
			observed_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS account_state_quota_account
			ON account_state_quota_receipts(account_id, receipt_id);
		CREATE TABLE IF NOT EXISTS account_state_affinity (
			scope TEXT PRIMARY KEY NOT NULL,
			account_id TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			updated_at_ms INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS account_state_affinity_account
			ON account_state_affinity(account_id);",
	)?;
	transaction.commit()?;
	Ok(())
}

fn to_millis(time: SystemTime) -> Result<i64, AccountStateStoreError> {
	let millis = time
		.duration_since(UNIX_EPOCH)
		.map_err(|_| AccountStateStoreError::OutOfRange)?
		.as_millis();
	i64::try_from(millis).map_err(|_| AccountStateStoreError::OutOfRange)
}

fn from_millis(millis: i64) -> Result<SystemTime, AccountStateStoreError> {
	let millis = u64::try_from(millis).map_err(|_| AccountStateStoreError::OutOfRange)?;
	UNIX_EPOCH
		.checked_add(Duration::from_millis(millis))
		.ok_or(AccountStateStoreError::OutOfRange)
}

fn optional_millis(time: Option<SystemTime>) -> Result<Option<i64>, AccountStateStoreError> {
	time.map(to_millis).transpose()
}

fn optional_time(millis: Option<i64>) -> Result<Option<SystemTime>, AccountStateStoreError> {
	millis.map(from_millis).transpose()
}

fn optional_i64(value: Option<u64>) -> Result<Option<i64>, AccountStateStoreError> {
	value
		.map(|value| i64::try_from(value).map_err(|_| AccountStateStoreError::OutOfRange))
		.transpose()
}

fn optional_u64(value: Option<i64>) -> Result<Option<u64>, AccountStateStoreError> {
	value
		.map(|value| u64::try_from(value).map_err(|_| AccountStateStoreError::OutOfRange))
		.transpose()
}
