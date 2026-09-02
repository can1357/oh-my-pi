import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, OAuthAccess } from "@oh-my-pi/pi-ai";
import {
	getCodexAttestationProvider,
	setCodexAttestationProvider,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { CODEX_BASE_URL, OPENAI_HEADER_VALUES, OPENAI_HEADERS, URL_PATHS } from "@oh-my-pi/pi-catalog/wire/codex";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodexSttTranscriber, type SttTranscriberContext } from "@oh-my-pi/pi-coding-agent/stt";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const ACCESS: OAuthAccess = {
	accessToken: "header.payload.signature",
	accountId: "account-id",
};

function makeContext(
	getOAuthAccess: NonNullable<SttTranscriberContext["authStorage"]>["getOAuthAccess"],
): SttTranscriberContext {
	const authStorage = {
		hasAuth: vi.fn().mockReturnValue(true),
		getOAuthAccess,
	} as unknown as AuthStorage;
	return {
		authStorage,
		sessionId: "speech-session",
		signal: new AbortController().signal,
	};
}

const callbacks = {
	onPartial: vi.fn(),
	onSegment: vi.fn(),
	onDurationWarning: vi.fn(),
	onStatus: vi.fn(),
	onError: vi.fn(),
};

describe("CodexSttTranscriber", () => {
	it("sends the Codex transcription wire contract for the selected OAuth account", async () => {
		const getOAuthAccess = vi.fn().mockResolvedValue(ACCESS);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ text: "transcribed" }), { status: 200 }));
		const transcriber = new CodexSttTranscriber({ fetch: fetchMock });
		const context = makeContext(getOAuthAccess);
		const session = await transcriber.createSession(context, callbacks);
		session.pushAudio(new Float32Array([0.25, -0.25]));
		await expect(session.stop()).resolves.toBe("transcribed");
		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "speech-session", {
			signal: expect.any(AbortSignal),
		});
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${CODEX_BASE_URL}${URL_PATHS.TRANSCRIBE}`);
		expect(init.method).toBe("POST");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${ACCESS.accessToken}`);
		expect(headers[OPENAI_HEADERS.ACCOUNT_ID]).toBe("account-id");
		expect(headers[OPENAI_HEADERS.ORIGINATOR]).toBe(OPENAI_HEADER_VALUES.CODEX_DESKTOP.NAME);
		expect(headers["User-Agent"]).toBe(OPENAI_HEADER_VALUES.CODEX_DESKTOP.USER_AGENT);
		expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=----codex-transcribe-/);
		const body = init.body as Uint8Array;
		expect(headers["Content-Length"]).toBe(String(body.byteLength));
		const bodyText = new TextDecoder().decode(body);
		expect(bodyText).toContain('Content-Disposition: form-data; name="file"; filename="codex.wav"');
		expect(bodyText).toContain("Content-Type: audio/wav\r\n\r\nRIFF");
		expect(bodyText).toContain("WAVEfmt ");
		await session.dispose();
	});

	it("sends the workspace residency header for region-pinned enterprise tokens", async () => {
		const payload = { "https://api.openai.com/auth": { chatgpt_data_residency: "eu" } };
		const access: OAuthAccess = {
			accessToken: `h.${Buffer.from(JSON.stringify(payload)).toString("base64")}.s`,
			accountId: "account-id",
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ text: "transcribed" }), { status: 200 }));
		const transcriber = new CodexSttTranscriber({ fetch: fetchMock });
		const session = await transcriber.createSession(makeContext(vi.fn().mockResolvedValue(access)), callbacks);
		session.pushAudio(new Float32Array([0.25, -0.25]));
		await expect(session.stop()).resolves.toBe("transcribed");
		const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
		expect(init.headers["x-openai-internal-codex-residency"]).toBe("eu");
		await session.dispose();
	});

	it("sends the current Codex DeviceCheck attestation", async () => {
		const previousProvider = getCodexAttestationProvider();
		setCodexAttestationProvider(async () => "attestation-envelope");
		try {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(new Response(JSON.stringify({ text: "transcribed" }), { status: 200 }));
			const session = await new CodexSttTranscriber({ fetch: fetchMock }).createSession(
				makeContext(vi.fn().mockResolvedValue(ACCESS)),
				callbacks,
			);
			session.pushAudio(new Float32Array([0.25]));
			await expect(session.stop()).resolves.toBe("transcribed");
			const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
			expect(init.headers[OPENAI_HEADERS.ATTESTATION]).toBe("attestation-envelope");
			await session.dispose();
		} finally {
			setCodexAttestationProvider(previousProvider);
		}
	});

	it("rejects before recording when no Codex account is configured", async () => {
		const transcriber = new CodexSttTranscriber();
		await expect(transcriber.createSession(makeContext(vi.fn().mockResolvedValue(null)), callbacks)).rejects.toThrow(
			"OpenAI Codex authentication required. Run /login.",
		);
	});
});

describe("STTController Codex selection", () => {
	let state: SettingsTestState | undefined;

	beforeEach(async () => {
		state = await beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.transcriber", "codex");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		vi.restoreAllMocks();
	});

	it("does not start microphone capture when Codex session creation fails", async () => {
		const createCapture = vi.fn();
		const controller = new STTController({
			createCapture,
			modelRegistry: { authStorage: {} } as unknown as ModelRegistry,
			createTranscriber: () => ({
				id: "codex",
				label: "OpenAI Codex",
				description: "",
				createSession: async () => {
					throw new Error("OpenAI Codex authentication required. Run /login.");
				},
			}),
		});
		const showWarning = vi.fn();
		await controller.toggle(
			{
				insertText: vi.fn(),
				setVolatileText: vi.fn(),
				clearVolatileText: vi.fn(),
				commitVolatileText: vi.fn(),
				submit: vi.fn(),
				deleteBeforeCursor: vi.fn(),
			},
			{ showWarning, showStatus: vi.fn(), onStateChange: vi.fn() },
		);
		expect(showWarning).toHaveBeenCalledWith("OpenAI Codex authentication required. Run /login.");
		expect(createCapture).not.toHaveBeenCalled();
		controller.dispose();
	});
});
