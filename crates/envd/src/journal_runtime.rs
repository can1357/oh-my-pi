//! Durable scheduled-delivery ownership for one environment.

use std::sync::Arc;

use super::{
	schedules::{ScheduleDeliveryBackend, open_durable_scheduler_unbound},
	server::EnvdError,
};

/// Environment-owned durable scheduler lifetime.
#[derive(Clone)]
pub(crate) struct DurableScheduleActor {
	schedules: super::schedules::DurableScheduleHandle,
}

impl DurableScheduleActor {
	/// Opens the durable scheduler without installing a delivery backend yet.
	pub(crate) fn spawn(state_dir: &std::path::Path) -> Result<Self, EnvdError> {
		let schedules = open_durable_scheduler_unbound(&state_dir.join("agent-schedules.sqlite"))?;
		Ok(Self { schedules })
	}

	/// Installs scheduled-delivery ownership.
	pub(crate) async fn bind_schedule_delivery(
		&self,
		backend: Arc<dyn ScheduleDeliveryBackend>,
	) -> Result<(), EnvdError> {
		Ok(self.schedules.bind_delivery(backend).await?)
	}
}
