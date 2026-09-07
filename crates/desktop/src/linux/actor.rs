use std::{
	sync::{LazyLock, mpsc},
	thread,
};

use atspi::ObjectRefOwned;
use flume::{Receiver, Sender};
#[cfg(feature = "wayland-pipewire")]
use image::RgbaImage;

#[cfg(feature = "wayland-pipewire")]
use super::wayland::capture::capture as capture_frame;
use super::{ax::ActorAx, wayland::libei::ActorLibei};
use crate::{
	ax::{AxHandle, AxProps},
	backend::{AxBackend, PointerEvent},
	error::{CoreResult, DesktopError},
	keys::KeyName,
	types::DesktopWindow,
};

type Reply<T> = Sender<CoreResult<T>>;

enum Command {
	AxInit(Reply<()>),
	AxWindows(Reply<Vec<DesktopWindow>>),
	AxWindowRoot(DesktopWindow, Reply<AxHandle>),
	AxProps(ObjectRefOwned, Reply<AxProps>),
	AxChildren(ObjectRefOwned, Reply<Vec<AxHandle>>),
	AxParent(ObjectRefOwned, Reply<Option<AxHandle>>),
	AxPerform(ObjectRefOwned, String, Reply<()>),
	AxSetValue(ObjectRefOwned, String, Reply<()>),
	AxFocus(ObjectRefOwned, Reply<()>),
	AxElementAt(f64, f64, Reply<Option<AxHandle>>),
	AxFocusedElement(Reply<Option<AxHandle>>),
	AxAttributes(ObjectRefOwned, Reply<Vec<(String, String)>>),
	#[cfg(feature = "wayland-pipewire")]
	Capture(Reply<RgbaImage>),
	LibeiInit(Reply<()>),
	LibeiPointer(PointerEvent, Reply<()>),
	LibeiTypeText(String, Reply<()>),
	LibeiKeyChord(Vec<KeyName>, Reply<()>),
	LibeiClose,
}

struct DesktopActor {
	tx: Sender<Command>,
}

static DESKTOP_ACTOR: LazyLock<Result<DesktopActor, String>> = LazyLock::new(|| {
	let (tx, rx) = flume::unbounded();
	let (ready_tx, ready_rx) = mpsc::sync_channel(1);
	thread::Builder::new()
		.name("omp-desktop".to_string())
		.spawn(move || run(rx, ready_tx))
		.map_err(|err| format!("desktop actor thread: {err}"))?;
	ready_rx
		.recv()
		.map_err(|_| "desktop actor exited during startup".to_string())??;
	Ok(DesktopActor { tx })
});

fn sender() -> CoreResult<&'static Sender<Command>> {
	DESKTOP_ACTOR
		.as_ref()
		.map(|actor| &actor.tx)
		.map_err(|err| DesktopError::internal(err.clone()))
}

fn request<T>(make: impl FnOnce(Reply<T>) -> Command) -> CoreResult<T> {
	let (reply_tx, reply_rx) = flume::bounded(1);
	sender()?
		.send(make(reply_tx))
		.map_err(|_| DesktopError::internal("desktop actor stopped"))?;
	reply_rx
		.recv()
		.map_err(|_| DesktopError::internal("desktop actor dropped a reply"))?
}

fn run(rx: Receiver<Command>, ready: mpsc::SyncSender<Result<(), String>>) {
	let mut ax = match ActorAx::new() {
		Ok(ax) => ax,
		Err(err) => {
			let _ = ready.send(Err(err.to_string()));
			return;
		},
	};
	let _ = ready.send(Ok(()));
	let mut libei = None;
	let mut libei_clients = 0usize;
	while let Ok(command) = ax.runtime().block_on(rx.recv_async()) {
		match command {
			Command::AxInit(reply) => send_reply(reply, ax.init()),
			Command::AxWindows(reply) => send_reply(reply, ax.windows()),
			Command::AxWindowRoot(window, reply) => send_reply(reply, ax.window_root(&window)),
			Command::AxProps(object, reply) => send_reply(reply, ax.props(&AxHandle::AtSpi(object))),
			Command::AxChildren(object, reply) => {
				send_reply(reply, ax.children(&AxHandle::AtSpi(object)));
			},
			Command::AxParent(object, reply) => {
				send_reply(reply, ax.parent(&AxHandle::AtSpi(object)));
			},
			Command::AxPerform(object, action, reply) => {
				send_reply(reply, ax.perform(&AxHandle::AtSpi(object), &action));
			},
			Command::AxSetValue(object, value, reply) => {
				send_reply(reply, ax.set_value(&AxHandle::AtSpi(object), &value));
			},
			Command::AxFocus(object, reply) => {
				send_reply(reply, ax.focus(&AxHandle::AtSpi(object)));
			},
			Command::AxElementAt(x, y, reply) => send_reply(reply, ax.element_at(x, y)),
			Command::AxFocusedElement(reply) => send_reply(reply, ax.focused_element()),
			Command::AxAttributes(object, reply) => {
				send_reply(reply, ax.attributes(&AxHandle::AtSpi(object)));
			},
			#[cfg(feature = "wayland-pipewire")]
			Command::Capture(reply) => {
				send_reply(reply, capture_frame(ax.runtime()));
			},
			Command::LibeiInit(reply) => {
				let result = if libei.is_some() {
					libei_clients = libei_clients.saturating_add(1);
					Ok(())
				} else {
					ActorLibei::new(ax.runtime()).map(|input| {
						libei = Some(input);
						libei_clients = 1;
					})
				};
				send_reply(reply, result);
			},
			Command::LibeiPointer(event, reply) => send_reply(
				reply,
				libei
					.as_mut()
					.ok_or_else(libei_not_initialized)
					.and_then(|input| input.pointer(event)),
			),
			Command::LibeiTypeText(text, reply) => send_reply(
				reply,
				libei
					.as_mut()
					.ok_or_else(libei_not_initialized)
					.and_then(|input| input.type_text(&text)),
			),
			Command::LibeiKeyChord(keys, reply) => send_reply(
				reply,
				libei
					.as_mut()
					.ok_or_else(libei_not_initialized)
					.and_then(|input| input.key_chord(&keys)),
			),
			Command::LibeiClose => {
				libei_clients = libei_clients.saturating_sub(1);
				if libei_clients == 0
					&& let Some(input) = libei.take()
				{
					input.close(ax.runtime());
				}
			},
		}
	}
}

fn send_reply<T>(reply: Reply<T>, result: CoreResult<T>) {
	let _ = reply.send(result);
}

fn libei_not_initialized() -> DesktopError {
	DesktopError::input_failed("libei actor is not initialized")
}

pub(super) fn ax_init() -> CoreResult<()> {
	request(Command::AxInit)
}
pub(super) fn ax_windows() -> CoreResult<Vec<DesktopWindow>> {
	request(Command::AxWindows)
}
pub(super) fn ax_window_root(window: DesktopWindow) -> CoreResult<AxHandle> {
	request(|reply| Command::AxWindowRoot(window, reply))
}
pub(super) fn ax_props(object: ObjectRefOwned) -> CoreResult<AxProps> {
	request(|reply| Command::AxProps(object, reply))
}
pub(super) fn ax_children(object: ObjectRefOwned) -> CoreResult<Vec<AxHandle>> {
	request(|reply| Command::AxChildren(object, reply))
}
pub(super) fn ax_parent(object: ObjectRefOwned) -> CoreResult<Option<AxHandle>> {
	request(|reply| Command::AxParent(object, reply))
}
pub(super) fn ax_perform(object: ObjectRefOwned, action: String) -> CoreResult<()> {
	request(|reply| Command::AxPerform(object, action, reply))
}
pub(super) fn ax_set_value(object: ObjectRefOwned, value: String) -> CoreResult<()> {
	request(|reply| Command::AxSetValue(object, value, reply))
}
pub(super) fn ax_focus(object: ObjectRefOwned) -> CoreResult<()> {
	request(|reply| Command::AxFocus(object, reply))
}
pub(super) fn ax_element_at(x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
	request(|reply| Command::AxElementAt(x, y, reply))
}
pub(super) fn ax_focused_element() -> CoreResult<Option<AxHandle>> {
	request(Command::AxFocusedElement)
}
pub(super) fn ax_attributes(object: ObjectRefOwned) -> CoreResult<Vec<(String, String)>> {
	request(|reply| Command::AxAttributes(object, reply))
}
#[cfg(feature = "wayland-pipewire")]
pub(super) fn capture() -> CoreResult<RgbaImage> {
	request(Command::Capture)
}
pub(super) fn libei_init() -> CoreResult<()> {
	request(Command::LibeiInit)
}
pub(super) fn libei_pointer(event: PointerEvent) -> CoreResult<()> {
	request(|reply| Command::LibeiPointer(event, reply))
}
pub(super) fn libei_type_text(text: String) -> CoreResult<()> {
	request(|reply| Command::LibeiTypeText(text, reply))
}
pub(super) fn libei_key_chord(keys: Vec<KeyName>) -> CoreResult<()> {
	request(|reply| Command::LibeiKeyChord(keys, reply))
}
pub(super) fn libei_close() {
	if let Ok(tx) = sender() {
		let _ = tx.send(Command::LibeiClose);
	}
}
