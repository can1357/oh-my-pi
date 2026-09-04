//! Stdio entry point for the isolated Mnemopi embedding worker.

use std::{env, io};

use omp_core::Str;
use omp_memory::embedding::{
	protocol::{InboundFrame, LogLevel, MAX_FRAME_BYTES, OutboundFrame},
	worker::EmbeddingWorker,
};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, Stdout, stdin, stdout};

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
	let generation = env::var("OMP_MEMORY_WORKER_GENERATION")
		.ok()
		.and_then(|value| value.parse::<u64>().ok())
		.unwrap_or(0);
	let mut input = BufReader::new(stdin());
	let mut output = stdout();
	let mut worker = EmbeddingWorker::new();
	let mut frame = Vec::new();
	loop {
		frame.clear();
		let bytes = input.read_until(b'\n', &mut frame).await?;
		if bytes == 0 {
			return Ok(());
		}
		if frame.len() > MAX_FRAME_BYTES + 1 {
			write_frame(&mut output, &OutboundFrame::Log {
				level:   LogLevel::Error,
				message: Str::new_static("embedding input frame exceeded limit"),
			})
			.await?;
			continue;
		}
		if frame.last() == Some(&b'\n') {
			frame.pop();
		}
		let inbound = if let Ok(inbound) = serde_json::from_slice::<InboundFrame>(&frame) {
			inbound
		} else {
			write_frame(&mut output, &OutboundFrame::Log {
				level:   LogLevel::Error,
				message: Str::new_static("embedding input frame was invalid JSON"),
			})
			.await?;
			continue;
		};
		for response in worker.handle(inbound, generation) {
			write_frame(&mut output, &response).await?;
		}
	}
}

async fn write_frame(output: &mut Stdout, frame: &OutboundFrame) -> io::Result<()> {
	let encoded = serde_json::to_vec(frame).map_err(io::Error::other)?;
	output.write_all(&encoded).await?;
	output.write_all(b"\n").await?;
	output.flush().await
}
