//! Temporary size probe.

macro_rules! probe {
	($($t:ty),* $(,)?) => {
		$( println!("{:>6}  {}", std::mem::size_of::<$t>(), stringify!($t)); )*
	};
}

#[test]
fn sizes() {
	probe!(
		omp_core::Str,
		Option<omp_core::Str>,
		omp_core::CowBytes<'static>,
		omp_core::Principal,
		omp_core::Provenance,
		tonic::Status,
		omp_journal::JournalError,
		omp_journal::gc::GcError,
		omp_tool::Effects,
		omp_tool::DocEffects,
		omp_tool::ExecEffects,
		omp_tool::Usd,
		omp_tool::PolicyDenied,
		omp_tool::ToolIdentity,
		omp_tool::Rev,
		omp_tool::ArgPath,
		omp_tool::ArgSpec,
		omp_tool::ArgSpecRegistryError,
		omp_tool::render::RenderRegistryError,
		omp_proto::env::v1::AdmitInvocation,
		omp_proto::thread::v1::Item,
		omp_proto::inference::v1::TurnError,
		omp_envd::exthost::services::ServiceError,
		omp_envd::exthost::services::ServiceKey,
		omp_envd::worker::HostKey,
		omp_envd::exthost::control::JournalControlError,
	);
}
