use super::run;

#[tokio::test]
async fn realtime_signal_bounds_reach_the_builtin_without_signalling() {
	let max = libc::SIGRTMAX();
	let max_arg = format!("-{max}");
	let past_max_arg = format!("-{}", max + 1);
	assert_eq!(run(&[&max_arg]).await, 1);
	assert_eq!(run(&[&past_max_arg]).await, 2);
}
