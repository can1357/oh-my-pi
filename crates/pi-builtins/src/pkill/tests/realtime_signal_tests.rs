use super::run;

#[tokio::test]
async fn realtime_signal_bounds_reach_the_builtin_without_signalling() {
	let max = libc::SIGRTMAX();
	assert_eq!(u8::from(run(&format!("-{max}")).await.exit_code), 1);
	assert_eq!(u8::from(run(&format!("-{}", max + 1)).await.exit_code), 2);
}
