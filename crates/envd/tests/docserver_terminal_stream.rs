//! Integration tests for terminal event stream continuity.

use omp_envd::docserver::client::terminal_event_channel;

#[tokio::test]
async fn continuity_error_discards_every_later_event() {
	let (sender, receiver) = terminal_event_channel::<u8, u64>();
	sender.send(Ok(1)).expect("first event");
	sender.send(Err(7)).expect("lag error");
	sender.send(Ok(2)).expect("buffered post-gap event");

	assert_eq!(receiver.next_event().await, Some(Ok(1)));
	assert_eq!(receiver.next_event().await, Some(Err(7)));
	assert!(receiver.is_terminal());
	assert_eq!(receiver.next_event().await, None);
}
