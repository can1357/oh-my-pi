//! Authenticated work-pool transition producer.
//!
//! Pool scheduling owns ordinary job settlement. This module publishes one
//! display-only IRC observation for each accepted transition without creating a
//! second result-delivery path.

use std::{
	sync::Arc,
	time::{SystemTime, SystemTimeError, UNIX_EPOCH},
};

use omp_agent::{EnvEvent, SessionAuthority, SessionEndpoint, SessionRole, Up};
use omp_core::{FastHashMap, FastHashSet, Str, Ulid, sf};
use omp_journal::data::{IrcDirection, IrcTraffic, WorkpoolMode, WorkpoolObservation};
use parking_lot::Mutex;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// Receipt proving that a preceding transition came from this producer.
///
/// Callers cannot construct or mutate receipts. The producer's semantic
/// transition methods are the only way to create
/// `reply_to`, so a pool cannot spoof a thread owned by another pool or an
/// earlier session binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkpoolReceipt {
	producer: Ulid,
	id:       Str,
}

impl WorkpoolReceipt {
	/// Stable transition identity suitable for diagnostics and tests.
	#[must_use]
	pub fn id(&self) -> &str {
		self.id.as_str()
	}
}

/// One producer-sealed transition which may be retried after mailbox pressure.
///
/// Successful delivery is idempotent for the lifetime of the producer. A
/// failed `try_deliver` does not consume the staged transition.
#[derive(Clone)]
pub struct StagedWorkpoolObservation {
	producer: Ulid,
	id:       Str,
	mode:     WorkpoolMode,
	target:   SessionEndpoint,
	body:     Str,
	reply_to: Option<Str>,
}

#[derive(Default)]
struct ProducerState {
	last_timestamp_ms:   u64,
	delivered:           FastHashSet<Str>,
	result_observations: FastHashSet<Str>,
	results:             FastHashSet<Str>,
	terminal:            Option<WorkpoolMode>,
}

/// Process-local registry of uniquely named producer bindings.
///
/// This is a disposable routing index, not durable pool state. Session reset
/// replaces a stale binding; replay remains the authority for observations
/// already committed to the owner's DOM.
pub struct WorkpoolRegistry {
	authority: Arc<dyn SessionAuthority>,
	pools:     Mutex<FastHashMap<(Str, Str), Arc<WorkpoolProducer>>>,
}

impl WorkpoolRegistry {
	/// Creates an empty registry over the live session authority.
	#[must_use]
	pub fn new(authority: Arc<dyn SessionAuthority>) -> Self {
		Self { authority, pools: Mutex::default() }
	}

	/// Creates one uniquely named pool producer for an owner.
	pub fn create(
		&self,
		owner: &str,
		pool: Str,
	) -> Result<Arc<WorkpoolProducer>, WorkpoolProducerError> {
		let producer = Arc::new(WorkpoolProducer::bind(Arc::clone(&self.authority), owner, pool)?);
		let key = (producer.owner.id.clone(), producer.pool.clone());
		let mut pools = self.pools.lock();
		if let Some(current) = pools.get(&key)
			&& current.ensure_live_owner().is_ok()
		{
			return Err(WorkpoolProducerError::Duplicate { owner: key.0, pool: key.1 });
		}
		pools.insert(key, Arc::clone(&producer));
		Ok(producer)
	}

	/// Looks up a live producer by stable owner id and pool name.
	#[must_use]
	pub fn get(&self, owner: &str, pool: &str) -> Option<Arc<WorkpoolProducer>> {
		self
			.pools
			.lock()
			.iter()
			.find(|((candidate_owner, candidate_pool), producer)| {
				candidate_owner.as_str() == owner
					&& candidate_pool.as_str() == pool
					&& producer.ensure_live_owner().is_ok()
			})
			.map(|(_, producer)| Arc::clone(producer))
	}

	/// Forgets every disposable producer owned by a retired session.
	pub fn release_owner(&self, owner: &str) {
		self
			.pools
			.lock()
			.retain(|(candidate, _), _| candidate.as_str() != owner);
	}
}

/// Display-only transition producer bound to one authenticated pool owner.
///
/// The binding captures the owner's exact mailbox generation. Every stage and
/// delivery re-authenticates both owner and target against the live authority.
/// Replacing a controller during `/new`, `/resume`, or `/fork` therefore makes
/// the old producer stale instead of allowing it to write into the new session.
pub struct WorkpoolProducer {
	authority: Arc<dyn SessionAuthority>,
	owner:     SessionEndpoint,
	pool:      Str,
	from:      Str,
	producer:  Ulid,
	state:     Mutex<ProducerState>,
}

impl WorkpoolProducer {
	/// Binds a nonempty pool name to the exact live owner endpoint.
	fn bind(
		authority: Arc<dyn SessionAuthority>,
		owner: &str,
		pool: Str,
	) -> Result<Self, WorkpoolProducerError> {
		let pool = Str::new(pool.trim());
		if pool.is_empty() {
			return Err(WorkpoolProducerError::EmptyPool);
		}
		let owner = authority
			.lookup(owner)
			.ok_or_else(|| WorkpoolProducerError::OwnerUnavailable { id: Str::new(owner) })?;
		Ok(Self {
			authority,
			owner,
			from: sf!("pool:{pool}"),
			pool,
			producer: Ulid::generate(),
			state: Mutex::new(ProducerState::default()),
		})
	}

	/// Seals a newly admitted worker transition.
	pub fn spawned(
		&self,
		target: &str,
		body: Str,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Spawned, target, body, None)
	}

	/// Seals work assigned immediately to an idle worker.
	pub fn dispatched(
		&self,
		target: &str,
		body: Str,
		reply_to: &WorkpoolReceipt,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Dispatched, target, body, Some(reply_to))
	}

	/// Seals work queued behind an occupied worker.
	pub fn queued(
		&self,
		target: &str,
		body: Str,
		reply_to: &WorkpoolReceipt,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Queued, target, body, Some(reply_to))
	}

	/// Seals a queued group beginning its follow-up turn.
	pub fn batch(
		&self,
		target: &str,
		body: Str,
		reply_to: &WorkpoolReceipt,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Batch, target, body, Some(reply_to))
	}

	/// Seals the pool's successful aggregate completion.
	pub fn completed(
		&self,
		body: Str,
		reply_to: &WorkpoolReceipt,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Completed, self.owner.id.as_str(), body, Some(reply_to))
	}

	/// Seals one transition after authenticating its target and optional parent.
	///
	/// Worker transitions must address a direct child of the pool owner. Pool
	/// completion and cancellation address the owner itself. This mirrors the
	/// runtime topology rather than trusting presentation aliases supplied by a
	/// caller.
	fn stage(
		&self,
		mode: WorkpoolMode,
		target: &str,
		body: Str,
		reply_to: Option<&WorkpoolReceipt>,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.ensure_live_owner()?;
		if let Some(mode) = self.state.lock().terminal {
			return Err(WorkpoolProducerError::Closed { pool: self.pool.clone(), mode });
		}
		let target = self
			.authority
			.lookup(target)
			.ok_or_else(|| WorkpoolProducerError::TargetUnavailable { id: Str::new(target) })?;
		self.authenticate_target(mode, &target)?;
		let reply_to = match reply_to {
			Some(receipt) if receipt.producer == self.producer => Some(receipt.id.clone()),
			Some(_) => return Err(WorkpoolProducerError::ForeignReply { pool: self.pool.clone() }),
			None => None,
		};
		Ok(StagedWorkpoolObservation {
			producer: self.producer,
			id: Str::new(Ulid::generate().to_string()),
			mode,
			target,
			body,
			reply_to,
		})
	}

	/// Delivers one typed observation, or reports a retryable full mailbox.
	///
	/// A successful retry of the same staged transition returns the original
	/// receipt without emitting a duplicate. Observation delivery never emits
	/// `Up::Peer`; the ordinary aggregate job result remains owned by the shared
	/// job-delivery transaction.
	pub fn try_deliver(
		&self,
		staged: &StagedWorkpoolObservation,
	) -> Result<WorkpoolReceipt, WorkpoolProducerError> {
		if staged.producer != self.producer {
			return Err(WorkpoolProducerError::StaleTransition { pool: self.pool.clone() });
		}
		let owner = self.ensure_live_owner()?;
		self.ensure_live_target(staged.mode, &staged.target)?;
		let mut state = self.state.lock();
		if state.delivered.contains(&staged.id) {
			return Ok(WorkpoolReceipt { producer: self.producer, id: staged.id.clone() });
		}
		if let Some(mode) = state.terminal {
			return Err(WorkpoolProducerError::Closed { pool: self.pool.clone(), mode });
		}
		let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
		let now = u64::try_from(now).unwrap_or(u64::MAX);
		let next = state
			.last_timestamp_ms
			.checked_add(1)
			.ok_or_else(|| WorkpoolProducerError::TimestampExhausted { pool: self.pool.clone() })?;
		let timestamp_ms = now.max(next);
		let payload = IrcTraffic::from(WorkpoolObservation {
			pool: self.pool.clone(),
			from: self.from.clone(),
			to: staged.target.name.clone(),
			body: staged.body.clone(),
			mode: staged.mode,
			reply_to: staged.reply_to.clone(),
			timestamp_ms,
		});
		match owner
			.up
			.try_send(Up::Env(EnvEvent::IrcTraffic { payload: Arc::new(payload) }))
		{
			Ok(()) => {
				state.last_timestamp_ms = timestamp_ms;
				state.delivered.insert(staged.id.clone());
				if matches!(staged.mode, WorkpoolMode::Completed | WorkpoolMode::Cancelled) {
					state.terminal = Some(staged.mode);
				}
				Ok(WorkpoolReceipt { producer: self.producer, id: staged.id.clone() })
			},
			Err(flume::TrySendError::Full(_)) => {
				Err(WorkpoolProducerError::MailboxFull { owner: owner.id })
			},
			Err(flume::TrySendError::Disconnected(_)) => {
				Err(WorkpoolProducerError::OwnerDisconnected { owner: owner.id })
			},
		}
	}

	/// Delivers one worker's ordinary batch result to the pool owner.
	///
	/// The authenticated worker remains the ordinary sender and the producer
	/// receipt becomes `reply_to`. The receipt is also the exactly-once key.
	/// Both mailbox writes honor backpressure asynchronously; the observation
	/// phase is remembered separately so cancellation between the two writes
	/// can never duplicate the card when delivery resumes.
	pub async fn deliver_result_once(
		&self,
		worker: &str,
		body: Str,
		reply_to: &WorkpoolReceipt,
		cancel: &CancellationToken,
	) -> Result<(), WorkpoolProducerError> {
		let owner = self.ensure_live_owner()?;
		if reply_to.producer != self.producer {
			return Err(WorkpoolProducerError::ForeignReply { pool: self.pool.clone() });
		}
		let target = self
			.authority
			.lookup(worker)
			.ok_or_else(|| WorkpoolProducerError::TargetUnavailable { id: Str::new(worker) })?;
		self.authenticate_target(WorkpoolMode::Batch, &target)?;
		let (already_observed, timestamp_ms) = {
			let state = self.state.lock();
			if state.results.contains(&reply_to.id) {
				return Ok(());
			}
			if let Some(mode) = state.terminal {
				return Err(WorkpoolProducerError::Closed { pool: self.pool.clone(), mode });
			}
			let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
			let now = u64::try_from(now).unwrap_or(u64::MAX);
			let next = state
				.last_timestamp_ms
				.checked_add(1)
				.ok_or_else(|| WorkpoolProducerError::TimestampExhausted { pool: self.pool.clone() })?;
			(state.result_observations.contains(&reply_to.id), now.max(next))
		};
		if !already_observed {
			let incoming = IrcTraffic {
				direction: IrcDirection::Incoming,
				from: Some(target.name.clone()),
				to: Some(owner.name.clone()),
				body: body.clone(),
				reply_to: Some(reply_to.id.clone()),
				pool: None,
				mode: None,
				timestamp_ms,
			};
			tokio::select! {
				biased;
				() = cancel.cancelled() => {
					return Err(WorkpoolProducerError::DeliveryCancelled { pool: self.pool.clone() });
				},
				result = owner.up.send_async(Up::Env(EnvEvent::IrcTraffic {
					payload: Arc::new(incoming),
				})) => {
					result.map_err(|_| WorkpoolProducerError::OwnerDisconnected {
						owner: owner.id.clone(),
					})?;
				},
			}
			let mut state = self.state.lock();
			state.last_timestamp_ms = timestamp_ms;
			state.result_observations.insert(reply_to.id.clone());
		}
		tokio::select! {
			biased;
			() = cancel.cancelled() => {
				return Err(WorkpoolProducerError::DeliveryCancelled { pool: self.pool.clone() });
			},
			result = owner.up.send_async(Up::Peer(body.clone())) => {
				result.map_err(|_| WorkpoolProducerError::OwnerDisconnected {
					owner: owner.id.clone(),
				})?;
			},
		}
		self.state.lock().results.insert(reply_to.id.clone());
		if let Some(main) = self.authority.relay_target(&target, &owner) {
			let relay = IrcTraffic {
				direction: IrcDirection::Relay,
				from: Some(target.name),
				to: Some(owner.name),
				body,
				reply_to: Some(reply_to.id.clone()),
				pool: None,
				mode: None,
				timestamp_ms,
			};
			let _ = main
				.up
				.try_send(Up::Env(EnvEvent::IrcTraffic { payload: Arc::new(relay) }));
		}
		Ok(())
	}

	/// Seals the terminal cancellation transition for retryable delivery.
	pub(crate) fn cancelled(
		&self,
		body: Str,
		reply_to: Option<&WorkpoolReceipt>,
	) -> Result<StagedWorkpoolObservation, WorkpoolProducerError> {
		self.stage(WorkpoolMode::Cancelled, self.owner.id.as_str(), body, reply_to)
	}

	/// Publishes the terminal cancellation transition, then permanently fences
	/// later work from this producer.
	pub fn cancel(
		&self,
		body: Str,
		reply_to: Option<&WorkpoolReceipt>,
	) -> Result<WorkpoolReceipt, WorkpoolProducerError> {
		let staged = self.cancelled(body, reply_to)?;
		self.try_deliver(&staged)
	}

	fn ensure_live_owner(&self) -> Result<SessionEndpoint, WorkpoolProducerError> {
		let live = self
			.authority
			.lookup(self.owner.id.as_str())
			.ok_or_else(|| WorkpoolProducerError::OwnerUnavailable { id: self.owner.id.clone() })?;
		if !same_endpoint(&live, &self.owner) {
			return Err(WorkpoolProducerError::StaleOwner { id: self.owner.id.clone() });
		}
		Ok(live)
	}

	fn ensure_live_target(
		&self,
		mode: WorkpoolMode,
		staged: &SessionEndpoint,
	) -> Result<(), WorkpoolProducerError> {
		let live = self
			.authority
			.lookup(staged.id.as_str())
			.ok_or_else(|| WorkpoolProducerError::TargetUnavailable { id: staged.id.clone() })?;
		if !same_endpoint(&live, staged) {
			return Err(WorkpoolProducerError::StaleTarget { id: staged.id.clone() });
		}
		self.authenticate_target(mode, &live)
	}

	fn authenticate_target(
		&self,
		mode: WorkpoolMode,
		target: &SessionEndpoint,
	) -> Result<(), WorkpoolProducerError> {
		let terminal = matches!(mode, WorkpoolMode::Completed | WorkpoolMode::Cancelled);
		let valid = if terminal {
			target.id == self.owner.id && same_endpoint(target, &self.owner)
		} else {
			target.topology.role == SessionRole::Child
				&& target.topology.parent_id.as_deref() == Some(self.owner.id.as_str())
				&& target.topology.main_id == self.owner.topology.main_id
		};
		if valid {
			Ok(())
		} else {
			Err(WorkpoolProducerError::InvalidTarget {
				pool:   self.pool.clone(),
				target: target.id.clone(),
			})
		}
	}
}

fn same_endpoint(left: &SessionEndpoint, right: &SessionEndpoint) -> bool {
	left.id == right.id
		&& left.name == right.name
		&& left.up.same_channel(&right.up)
		&& left.topology == right.topology
}

/// Typed work-pool observation production failure.
#[derive(Debug, Error)]
pub enum WorkpoolProducerError {
	/// The owner already has a live producer with this pool name.
	#[error("workpool `{pool}` already exists for owner `{owner}`")]
	Duplicate {
		/// Stable owner identity.
		owner: Str,
		/// Stable pool identity.
		pool:  Str,
	},
	/// Pool identity was empty after trimming.
	#[error("workpool name is empty")]
	EmptyPool,
	/// The owner is no longer registered.
	#[error("workpool owner `{id}` is unavailable")]
	OwnerUnavailable {
		/// Stable owner identity.
		id: Str,
	},
	/// The owner id now points at a different controller generation.
	#[error("workpool owner `{id}` changed session generation")]
	StaleOwner {
		/// Stable owner identity.
		id: Str,
	},
	/// The target is no longer registered.
	#[error("workpool target `{id}` is unavailable")]
	TargetUnavailable {
		/// Stable target identity.
		id: Str,
	},
	/// The target id now points at a different controller generation.
	#[error("workpool target `{id}` changed session generation")]
	StaleTarget {
		/// Stable target identity.
		id: Str,
	},
	/// The target is not a direct worker of this pool owner.
	#[error("workpool `{pool}` cannot address unrelated target `{target}`")]
	InvalidTarget {
		/// Stable pool identity.
		pool:   Str,
		/// Rejected target identity.
		target: Str,
	},
	/// A receipt from another producer was supplied as thread ancestry.
	#[error("workpool `{pool}` cannot reply to a foreign transition")]
	ForeignReply {
		/// Stable pool identity.
		pool: Str,
	},
	/// A staged transition belongs to an obsolete producer.
	#[error("workpool `{pool}` transition belongs to a stale producer")]
	StaleTransition {
		/// Stable pool identity.
		pool: Str,
	},
	/// The pool has already crossed its completion or cancellation boundary.
	#[error("workpool `{pool}` is closed after `{mode}`")]
	Closed {
		/// Stable pool identity.
		pool: Str,
		/// Terminal transition already delivered.
		mode: WorkpoolMode,
	},
	/// Owner mailbox backpressure requires retrying the same staged transition.
	#[error("workpool owner `{owner}` mailbox is full")]
	MailboxFull {
		/// Stable owner identity.
		owner: Str,
	},
	/// Batch-result delivery was cancelled while waiting for mailbox capacity.
	#[error("workpool `{pool}` result delivery was cancelled")]
	DeliveryCancelled {
		/// Pool whose delivery stopped.
		pool: Str,
	},
	/// Owner mailbox disconnected before the transition could be observed.
	#[error("workpool owner `{owner}` mailbox is disconnected")]
	OwnerDisconnected {
		/// Stable owner identity.
		owner: Str,
	},
	/// No larger monotonic millisecond value can be represented.
	#[error("workpool `{pool}` exhausted its timestamp sequence")]
	TimestampExhausted {
		/// Stable pool identity.
		pool: Str,
	},
	/// System clock is unavailable.
	#[error("system clock predates the Unix epoch")]
	Clock(#[from] SystemTimeError),
}
