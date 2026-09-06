const LEGACY_ERROR_CODES = {
	DESKTOP_INVALID_OPTIONS: "InvalidTarget",
	DESKTOP_INVALID_ACTION: "InvalidTarget",
	DESKTOP_BACKEND_UNAVAILABLE: null,
	DESKTOP_PERMISSION_DENIED: "PermissionDenied",
	DESKTOP_CAPTURE_FAILED: "CaptureFailed",
	DESKTOP_INPUT_FAILED: "InputFailed",
	DESKTOP_DEADLINE_EXCEEDED: "Timeout",
	DESKTOP_LAYOUT_CHANGED: "InvalidCoordinateFrame",
	DESKTOP_COORDINATE_OUT_OF_BOUNDS: "InvalidCoordinateFrame",
	DESKTOP_SESSION_CLOSED: "Closed",
	DESKTOP_WORKER_FAILED: "Internal",
};

const ADAPTED_SESSION_CLASSES = new WeakMap();

function desktopError(code, message) {
	return new Error(`${code}: ${message}`);
}

function normalizeError(error, fallbackCode) {
	if (!(error instanceof Error)) return desktopError(fallbackCode, String(error));
	if (/^[A-Z][A-Za-z]+: /.test(error.message)) return error;

	const match = /^(DESKTOP_[A-Z_]+):\s*(.*)$/.exec(error.message);
	if (match === null) return desktopError(fallbackCode, error.message);
	const code = LEGACY_ERROR_CODES[match[1]] ?? fallbackCode;
	return desktopError(code, match[2]);
}

function normalizeCapabilities(capabilities) {
	return {
		...capabilities,
		ax: false,
		backgroundWindowInput: false,
		deliveryModes: ["foreground"],
		axPermission: "unavailable",
	};
}

function legacyPoint(point) {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

function captureCapsKey(caps) {
	return `${caps?.maxWidth ?? ""}:${caps?.maxHeight ?? ""}`;
}

function legacyButton(button) {
	return button === "middle" ? "wheel" : button;
}
function sourceDimensions(capture) {
	if (capture.sourceWidth !== undefined && capture.sourceHeight !== undefined) {
		return { sourceWidth: capture.sourceWidth, sourceHeight: capture.sourceHeight };
	}
	const displays = Array.isArray(capture.displays) ? capture.displays : [];
	if (displays.length === 0) {
		return { sourceWidth: capture.width, sourceHeight: capture.height };
	}
	const minX = Math.min(...displays.map(display => display.x));
	const minY = Math.min(...displays.map(display => display.y));
	const maxX = Math.max(...displays.map(display => display.x + display.width));
	const maxY = Math.max(...displays.map(display => display.y + display.height));
	const nativeScale = Math.max(1, ...displays.map(display => display.scale ?? 1));
	return {
		sourceWidth: Math.max(1, Math.round((maxX - minX) * nativeScale)),
		sourceHeight: Math.max(1, Math.round((maxY - minY) * nativeScale)),
	};
}

function frameSignature(capture) {
	return JSON.stringify({
		target: capture.target,
		width: capture.width,
		height: capture.height,
		displays: capture.displays?.map(display => ({
			id: display.id,
			x: display.x,
			y: display.y,
			width: display.width,
			height: display.height,
			scale: display.scale,
			pixelX: display.pixelX,
			pixelY: display.pixelY,
			pixelWidth: display.pixelWidth,
			pixelHeight: display.pixelHeight,
		})),
	});
}

/**
 * Adapt the pre-parity desktop addon ABI used by pull-request CI artifacts to
 * the current session contract. Released addons exposed capture/execute/close;
 * current addons already expose the complete API and pass through unchanged.
 */
export function adaptDesktopSession(NativeDesktopSession) {
	if (typeof NativeDesktopSession !== "function") return NativeDesktopSession;
	if (typeof NativeDesktopSession?.prototype?.click === "function") return NativeDesktopSession;
	const cached = ADAPTED_SESSION_CLASSES.get(NativeDesktopSession);
	if (cached) return cached;

	class DesktopSession {
		#native;
		#nativeDesktopSession;
		#options;
		#sessions;
		#closed = false;
		#capturedTargets = new Map();

		constructor(options) {
			try {
				this.#nativeDesktopSession = NativeDesktopSession;
				this.#options = options;
				this.#native = new NativeDesktopSession(options);
				this.#sessions = new Map([[captureCapsKey(), this.#native]]);
			} catch (error) {
				throw normalizeError(error, "Internal");
			}
		}

		get capabilities() {
			return normalizeCapabilities(this.#native.capabilities);
		}

		#ensureOpen() {
			if (this.#closed) throw desktopError("Closed", "desktop session is closed");
		}

		#nativeForCapturedTarget(target) {
			const capture = this.#capturedTargets.get(target);
			if (capture) return capture.native;
			throw desktopError(
				"InvalidCoordinateFrame",
				`no capture of '${target}' yet — take a screenshot of this target first`,
			);
		}

		#sessionForCapture(caps) {
			const key = captureCapsKey(caps);
			const existing = this.#sessions.get(key);
			if (existing) return existing;
			try {
				const native = new this.#nativeDesktopSession({
					...this.#options,
					maxWidth: caps?.maxWidth,
					maxHeight: caps?.maxHeight,
				});
				this.#sessions.set(key, native);
				return native;
			} catch (error) {
				throw normalizeError(error, "CaptureFailed");
			}
		}

		#ensureForeground(target, options) {
			if (options?.deliveryMode !== "foreground" && (target !== "desktop" || options?.deliveryMode !== undefined)) {
				throw desktopError(
					"BackgroundUnavailable",
					"the installed native addon supports foreground input only",
				);
			}
		}

		async #execute(actions, target, native = this.#native, fallbackCode = "InputFailed") {
			try {
				const capture = await native.execute(Array.isArray(actions) ? actions : [actions], target);
				const previous = this.#capturedTargets.get(target);
				if (capture && previous?.native === native && frameSignature(capture) !== previous.signature) {
					this.#capturedTargets.delete(target);
				}
			} catch (error) {
				throw normalizeError(error, fallbackCode);
			}
		}

		async listDisplays() {
			this.#ensureOpen();
			throw desktopError("CaptureFailed", "the installed native addon does not expose display enumeration");
		}

		async listWindows() {
			this.#ensureOpen();
			if (typeof this.#native.listWindows !== "function") {
				throw desktopError("CaptureFailed", "the installed native addon does not expose window enumeration");
			}
			try {
				return await this.#native.listWindows();
			} catch (error) {
				throw normalizeError(error, "CaptureFailed");
			}
		}

		async capture(target, caps) {
			this.#ensureOpen();
			if (target !== "desktop" && !/^\d+$/.test(target)) {
				throw desktopError("InvalidTarget", `invalid window target '${target}'`);
			}
			if (target !== "desktop" && typeof this.#native.listWindows !== "function") {
				throw desktopError("CaptureFailed", "the installed native addon does not support window capture");
			}
			try {
				const native = this.#sessionForCapture(caps);
				const capture = await native.capture(target);
				const adapted = { ...capture, ...sourceDimensions(capture), target };
				this.#capturedTargets.set(target, { native, signature: frameSignature(adapted) });
				return adapted;
			} catch (error) {
				throw normalizeError(error, "CaptureFailed");
			}
		}

		async click(target, x, y, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			const native = this.#nativeForCapturedTarget(target);
			const count = Math.max(1, options?.count ?? 1);
			const button = legacyButton(options?.button ?? "left");
			const point = { x: Math.round(x), y: Math.round(y), keys: options?.modifiers ?? [] };
			const actions =
				count === 2 && button === "left"
					? [{ type: "double_click", ...point }]
					: Array.from({ length: count }, () => ({ type: "click", ...point, button }));
			await this.#execute(actions, target, native);
		}

		async moveMouse(target, x, y, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			await this.#execute(
				{ type: "move", x: Math.round(x), y: Math.round(y), keys: options?.modifiers ?? [] },
				target,
				this.#nativeForCapturedTarget(target),
			);
		}

		async drag(target, path, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			await this.#execute(
				{ type: "drag", path: path.map(legacyPoint), keys: options?.modifiers ?? [] },
				target,
				this.#nativeForCapturedTarget(target),
			);
		}

		async scroll(target, x, y, dx, dy, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			await this.#execute(
				{
					type: "scroll",
					x: Math.round(x),
					y: Math.round(y),
					scroll_x: Math.round(dx),
					scroll_y: Math.round(dy),
					keys: options?.modifiers ?? [],
				},
				target,
				this.#nativeForCapturedTarget(target),
			);
		}

		async typeText(target, text, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			await this.#execute({ type: "type", text }, target, this.#capturedTargets.get(target)?.native ?? this.#native);
		}

		async keyChord(target, keys, options) {
			this.#ensureOpen();
			this.#ensureForeground(target, options);
			await this.#execute({ type: "keypress", keys }, target, this.#capturedTargets.get(target)?.native ?? this.#native);
		}

		async raiseWindow() {
			this.#ensureOpen();
			throw desktopError("BackgroundUnavailable", "the installed native addon does not support window control");
		}

		async axSnapshot() {
			this.#ensureOpen();
			throw desktopError("AxUnsupported", "accessibility is unavailable in the installed native addon");
		}

		async axQuery() {
			return this.axSnapshot();
		}

		async axElementAt() {
			return this.axSnapshot();
		}

		async axFocused() {
			return this.axSnapshot();
		}

		async axNode() {
			return this.axSnapshot();
		}

		async axAttributes() {
			return this.axSnapshot();
		}

		async axChildren() {
			return this.axSnapshot();
		}

		async axParent() {
			return this.axSnapshot();
		}

		async axPerform() {
			return this.axSnapshot();
		}

		async axSetValue() {
			return this.axSnapshot();
		}

		async axFocus() {
			return this.axSnapshot();
		}

		async axClick() {
			return this.axSnapshot();
		}

		async close() {
			if (this.#closed) return;
			this.#closed = true;
			try {
				await Promise.all([...this.#sessions.values()].map(native => native.close()));
			} catch (error) {
				throw normalizeError(error, "Internal");
			}
		}
	}

	ADAPTED_SESSION_CLASSES.set(NativeDesktopSession, DesktopSession);
	return DesktopSession;
}
