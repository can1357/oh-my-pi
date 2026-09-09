use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicU8, Ordering},
	},
	time::{Duration, Instant},
};

use anyhow::{Error, Result};
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum AbortReason {
	Unknown = 1,
	Timeout = 2,
	Signal  = 3,
	User    = 4,
}

impl TryFrom<u8> for AbortReason {
	type Error = ();

	fn try_from(value: u8) -> std::result::Result<Self, ()> {
		match value {
			0 => Err(()),
			2 => Ok(Self::Timeout),
			3 => Ok(Self::Signal),
			4 => Ok(Self::User),
			_ => Ok(Self::Unknown),
		}
	}
}

#[derive(Default)]
struct Flag {
	reason:   AtomicU8,
	notifier: Notify,
}

impl Flag {
	fn cause(&self) -> Option<AbortReason> {
		self.reason.load(Ordering::Relaxed).try_into().ok()
	}

	async fn wait(&self) -> AbortReason {
		if let Some(reason) = self.cause() {
			return reason;
		}
		let notifier = self.notifier.notified();
		if let Some(reason) = self.cause() {
			return reason;
		}
		notifier.await;
		self.cause().unwrap_or(AbortReason::Unknown)
	}

	fn abort(&self, reason: AbortReason) {
		let old = self.reason.swap(reason as u8, Ordering::SeqCst);
		if old == 0 {
			self.notifier.notify_waiters();
		}
	}
}

#[derive(Clone, Default)]
pub struct CancelToken {
	deadline: Option<Instant>,
	flag:     Option<Arc<Flag>>,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	#[must_use]
	pub fn new(timeout_ms: Option<u32>) -> Self {
		Self::with_timeout(timeout_ms.map(|ms| Duration::from_millis(u64::from(ms))))
	}

	#[must_use]
	pub fn with_timeout(timeout: Option<Duration>) -> Self {
		Self { deadline: timeout.map(|duration| Instant::now() + duration), flag: None }
	}

	pub fn heartbeat(&self) -> Result<()> {
		if let Some(flag) = &self.flag
			&& let Some(reason) = flag.cause()
		{
			return Err(Error::msg(format!("Aborted: {reason:?}")));
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return Err(Error::msg("Aborted: Timeout"));
		}
		Ok(())
	}

	pub async fn wait(&self) -> AbortReason {
		if let Some(flag) = self.flag.as_ref().and_then(|flag| flag.cause()) {
			return flag;
		}

		let by_flag = async {
			let Some(flag) = self.flag.as_ref() else {
				return std::future::pending().await;
			};
			flag.wait().await
		};

		let by_timeout = async {
			let Some(deadline) = self.deadline else {
				return std::future::pending().await;
			};
			tokio::time::sleep_until(deadline.into()).await;
			AbortReason::Timeout
		};

		tokio::select! {
			reason = by_flag => reason,
			reason = by_timeout => reason,
		}
	}

	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.flag.as_ref().map(Arc::downgrade))
	}

	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(Some(Arc::downgrade(self.flag.get_or_insert_default())))
	}

	#[must_use]
	pub fn aborted(&self) -> bool {
		if let Some(flag) = &self.flag
			&& flag.cause().is_some()
		{
			return true;
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return true;
		}
		false
	}
}

#[derive(Clone, Default)]
pub struct AbortToken(Option<Weak<Flag>>);

impl AbortToken {
	pub fn abort(&self, reason: AbortReason) {
		if let Some(flag) = &self.0
			&& let Some(flag) = flag.upgrade()
		{
			flag.abort(reason);
		}
	}
}
