//! Observer-local active-account usage cache for the status band.
//!
//! Provider work starts behind [`Services::active_account_usage`]. This module
//! only polls the returned receiver, so neither status layout nor paint can
//! perform provider I/O.

use std::time::Duration;

use crate::{
	overlays::services::{
		AccountIdentity, ActiveAccountUsage, ActiveUsageRequest, Pending, ServiceError, Services,
	},
	status_band::AccountUsage,
};

/// Retained usage for the exact account serving the live provider/model route.
#[derive(Default)]
pub struct AccountUsageCache {
	request:     Option<ActiveUsageRequest>,
	identity:    Option<AccountIdentity>,
	usage:       Option<AccountUsage>,
	fetched_at:  Option<Duration>,
	pending:     Option<Pending<Option<ActiveAccountUsage>>>,
	unavailable: bool,
}

impl AccountUsageCache {
	/// Status usage cache lifetime.
	pub const REFRESH: Duration = Duration::from_secs(5 * 60);
	/// Poll cadence while the application runtime owns an in-flight fetch.
	pub const SETTLE_POLL: Duration = Duration::from_millis(100);

	/// Returns the cached presentation snapshot.
	#[must_use]
	pub const fn usage(&self) -> Option<&AccountUsage> {
		self.usage.as_ref()
	}

	/// Returns the exact account identity attached to the cached snapshot.
	#[must_use]
	pub const fn identity(&self) -> Option<&AccountIdentity> {
		self.identity.as_ref()
	}

	/// Drops all cached and in-flight state.
	///
	/// Hosts call this after account login, logout, pin, or provider reset so a
	/// sibling account's quota cannot remain visible until the normal TTL.
	pub fn invalidate(&mut self) {
		self.request = None;
		self.identity = None;
		self.usage = None;
		self.fetched_at = None;
		self.pending = None;
		self.unavailable = false;
	}

	/// Advances the non-blocking refresh lifecycle for `request`.
	///
	/// Returns `true` when the visible snapshot changed. A provider/model
	/// switch clears the old snapshot before launching its replacement. Late
	/// deliveries from the old route are disconnected and cannot overwrite the
	/// new route.
	pub fn poll(
		&mut self,
		services: &dyn Services,
		request: ActiveUsageRequest,
		now: Duration,
	) -> bool {
		let mut changed = false;
		if self.request.as_ref() != Some(&request) {
			changed = self.usage.take().is_some();
			self.identity = None;
			self.fetched_at = None;
			self.pending = None;
			self.unavailable = false;
			self.request = Some(request.clone());
		}

		if let Some(pending) = &self.pending {
			match pending.try_recv() {
				Ok(Ok(Some(snapshot))) => {
					self.pending = None;
					self.fetched_at = Some(now);
					if snapshot.request == request
						&& snapshot.identity.provider == request.provider
						&& !snapshot.identity.account.is_empty()
					{
						let next = AccountUsage {
							tier:      snapshot.tier,
							five_hour: snapshot.five_hour,
							daily:     snapshot.daily,
							seven_day: snapshot.seven_day,
							monthly:   snapshot.monthly,
						};
						changed |= self.usage.as_ref() != Some(&next)
							|| self.identity.as_ref() != Some(&snapshot.identity);
						self.identity = Some(snapshot.identity);
						self.usage = Some(next);
					} else {
						changed |= self.usage.take().is_some();
						self.identity = None;
					}
				},
				Ok(Ok(None)) => {
					self.pending = None;
					self.fetched_at = Some(now);
					changed |= self.usage.take().is_some();
					self.identity = None;
				},
				Ok(Err(_)) | Err(flume::TryRecvError::Disconnected) => {
					// A transient refresh failure preserves a valid cache
					// but advances the TTL so paint activity cannot create a retry
					// storm.
					self.pending = None;
					self.fetched_at = Some(now);
				},
				Err(flume::TryRecvError::Empty) => return changed,
			}
		}

		if self.pending.is_some() || self.unavailable {
			return changed;
		}
		let due = self
			.fetched_at
			.is_none_or(|fetched| now.saturating_sub(fetched) >= Self::REFRESH);
		if !due {
			return changed;
		}
		match services.active_account_usage(request) {
			Ok(pending) => self.pending = Some(pending),
			Err(ServiceError::Unavailable(_)) => self.unavailable = true,
			Err(_) => self.fetched_at = Some(now),
		}
		changed
	}

	/// Presentation-clock instant when [`Self::poll`] next needs to run.
	#[must_use]
	pub fn next_wake(&self, now: Duration) -> Option<Duration> {
		if self.unavailable {
			return None;
		}
		if self.pending.is_some() {
			return Some(now + Self::SETTLE_POLL);
		}
		Some(
			self
				.fetched_at
				.map_or(now, |fetched| fetched + Self::REFRESH),
		)
	}
}
