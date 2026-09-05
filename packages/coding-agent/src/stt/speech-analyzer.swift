import AVFAudio
import CoreMedia
import Foundation
import Speech

private enum SidecarError: LocalizedError {
    case usage
    case unavailable
    case unsupportedLocale(String)
    case assetUnavailable(String)
    case incompatibleAudioFormat
    case invalidAudioFrame
    case inputBackpressure

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: omp-speech-analyzer status [locale] | prepare [locale] | stream [locale]"
        case .unavailable:
            return "Apple SpeechAnalyzer is unavailable on this Mac. It requires macOS 26 or later."
        case .unsupportedLocale(let locale):
            return "Apple SpeechAnalyzer does not support locale \(locale)."
        case .assetUnavailable(let locale):
            return "The system-managed Apple speech asset for \(locale) could not be prepared."
        case .incompatibleAudioFormat:
            return "Apple SpeechAnalyzer did not accept 16 kHz mono Int16 audio."
        case .invalidAudioFrame:
            return "Could not allocate an Apple speech audio buffer."
        case .inputBackpressure:
            return "Apple SpeechAnalyzer could not consume microphone audio in real time."
        }
    }
}

private struct StatusOutput: Encodable {
    let success: Bool
    let available: Bool
    let supported: Bool
    let installed: Bool
    let locale: String?
    let displayName: String
    let systemManaged: Bool
    let error: String?

    enum CodingKeys: String, CodingKey {
        case success, available, supported, installed, locale, error
        case displayName = "display_name"
        case systemManaged = "system_managed"
    }
}

private struct StreamEvent: Encodable {
    let type: String
    let text: String?
    let index: Int?
    let locale: String?
    let error: String?

    init(type: String, text: String? = nil, index: Int? = nil, locale: String? = nil, error: String? = nil) {
        self.type = type
        self.text = text
        self.index = index
        self.locale = locale
        self.error = error
    }
}

private let lexicalCharacterSet: CharacterSet = {
    var set = CharacterSet.letters
    set.formUnion(.decimalDigits)
    return set
}()

private func hasLexicalContent(_ text: String) -> Bool {
    for scalar in text.unicodeScalars {
        if CharacterSet.whitespacesAndNewlines.contains(scalar) { continue }
        if lexicalCharacterSet.contains(scalar) { return true }
    }
    return false
}

private actor LineEmitter {
    func emit(_ event: StreamEvent) {
        guard let data = try? JSONEncoder().encode(event) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

private actor TranscriptCollector {
    private var segments: [String] = []

    func append(_ text: String) -> Int {
        let index = segments.count
        segments.append(text)
        return index
    }

    func joined() -> String {
        segments.joined(separator: " ")
    }
}

@available(macOS 26.0, *)
@main
private struct OmpSpeechAnalyzer {
    private static let displayName = "Apple SpeechAnalyzer"
    private static let readChunkBytes = 64 * 1024
    private static let inputFrameBytes = MemoryLayout<Float>.size
    private static let defaultLocaleIdentifiers = [
        "en": "en_US",
        "es": "es_ES",
        "fr": "fr_FR",
        "de": "de_DE",
        "pt": "pt_PT",
        "ja": "ja_JP",
        "ko": "ko_KR",
        "hi": "hi_IN",
        "zh-Hans": "zh_CN",
        "zh-Hant": "zh_TW",
    ]

    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        let command = arguments.first ?? ""
        let requestedLocale = arguments.count > 1 ? arguments[1] : "auto"

        do {
            switch command {
            case "status":
                await printStatus(requestedLocale: requestedLocale)
            case "prepare":
                let locale = try await resolveLocale(requestedLocale)
                try await ensureAsset(for: locale)
                writeJSON(StatusOutput(
                    success: true,
                    available: true,
                    supported: true,
                    installed: true,
                    locale: locale.identifier,
                    displayName: displayName,
                    systemManaged: true,
                    error: nil
                ))
            case "stream":
                let locale = try await resolveLocale(requestedLocale)
                try await stream(locale: locale)
            default:
                throw SidecarError.usage
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? "Apple speech recognition failed."
            if command == "stream" {
                await LineEmitter().emit(StreamEvent(type: "error", error: message))
            } else {
                writeJSON(StatusOutput(
                    success: false,
                    available: false,
                    supported: false,
                    installed: false,
                    locale: nil,
                    displayName: displayName,
                    systemManaged: true,
                    error: message
                ))
            }
            Foundation.exit(1)
        }
    }

    private static func printStatus(requestedLocale: String) async {
        guard SpeechTranscriber.isAvailable else {
            writeJSON(StatusOutput(
                success: true,
                available: false,
                supported: false,
                installed: false,
                locale: nil,
                displayName: displayName,
                systemManaged: true,
                error: SidecarError.unavailable.errorDescription
            ))
            return
        }

        do {
            let locale = try await resolveLocale(requestedLocale)
            let installed = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
            writeJSON(StatusOutput(
                success: true,
                available: true,
                supported: true,
                installed: installed.contains(locale.identifier),
                locale: locale.identifier,
                displayName: displayName,
                systemManaged: true,
                error: nil
            ))
        } catch SidecarError.unsupportedLocale(let locale) {
            writeJSON(StatusOutput(
                success: true,
                available: true,
                supported: false,
                installed: false,
                locale: nil,
                displayName: displayName,
                systemManaged: true,
                error: SidecarError.unsupportedLocale(locale).errorDescription
            ))
        } catch {
            writeJSON(StatusOutput(
                success: false,
                available: true,
                supported: false,
                installed: false,
                locale: nil,
                displayName: displayName,
                systemManaged: true,
                error: (error as? LocalizedError)?.errorDescription ?? "Apple speech status failed."
            ))
        }
    }

    private static func resolveLocale(_ requested: String) async throws -> Locale {
        guard SpeechTranscriber.isAvailable else { throw SidecarError.unavailable }
        let candidate: Locale
        if requested.isEmpty || requested.lowercased() == "auto" {
            candidate = Locale.current
        } else {
            candidate = Locale(identifier: defaultLocaleIdentifiers[requested] ?? requested)
        }
        guard let resolved = await SpeechTranscriber.supportedLocale(equivalentTo: candidate) else {
            throw SidecarError.unsupportedLocale(requested)
        }
        let supported = await Set(SpeechTranscriber.supportedLocales.map(\.identifier))
        guard supported.contains(resolved.identifier) else {
            throw SidecarError.unsupportedLocale(requested)
        }
        return resolved
    }

    private static func ensureAsset(for locale: Locale) async throws {
        let installed = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
        if installed.contains(locale.identifier) { return }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
            throw SidecarError.assetUnavailable(locale.identifier)
        }
        try await request.downloadAndInstall()

        let installedAfterDownload = await Set(SpeechTranscriber.installedLocales.map(\.identifier))
        guard installedAfterDownload.contains(locale.identifier) else {
            throw SidecarError.assetUnavailable(locale.identifier)
        }
    }

    private static func stream(locale: Locale) async throws {
        try await ensureAsset(for: locale)

        let transcriber = SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults],
            attributeOptions: [.audioTimeRange, .transcriptionConfidence]
        )
        let modules: [any SpeechModule] = [transcriber]
        let requestedFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        )
        guard let requestedFormat,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(
                  compatibleWith: modules,
                  considering: requestedFormat
              ),
              format.sampleRate == 16_000,
              format.channelCount == 1,
              format.commonFormat == .pcmFormatInt16 else {
            throw SidecarError.incompatibleAudioFormat
        }

        let analyzer = SpeechAnalyzer(
            modules: modules,
            options: .init(priority: .userInitiated, modelRetention: .whileInUse)
        )
        try await analyzer.prepareToAnalyze(in: format)

        let (input, continuation) = AsyncStream<AnalyzerInput>.makeStream(
            bufferingPolicy: .bufferingOldest(64)
        )
        let emitter = LineEmitter()
        let collector = TranscriptCollector()
        let results = Task {
            try await forwardResults(transcriber, emitter: emitter, collector: collector)
        }
        let analysis = Task {
            try await analyzer.start(inputSequence: input)
        }

        await emitter.emit(StreamEvent(type: "ready", locale: locale.identifier))
        do {
            var pending = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: readChunkBytes), !chunk.isEmpty {
                pending.append(chunk)
                let completeBytes = pending.count - (pending.count % inputFrameBytes)
                guard completeBytes > 0 else { continue }
                let block = Data(pending.prefix(completeBytes))
                pending.removeFirst(completeBytes)
                let frameCount = completeBytes / inputFrameBytes
                let yielded = continuation.yield(AnalyzerInput(
                    buffer: try makeMonoBuffer(from: block, frameCount: frameCount, format: format)
                ))
                switch yielded {
                case .enqueued:
                    break
                case .dropped, .terminated:
                    throw SidecarError.inputBackpressure
                @unknown default:
                    throw SidecarError.inputBackpressure
                }
            }
            guard pending.isEmpty else { throw SidecarError.invalidAudioFrame }

            continuation.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            try await analysis.value
            try await results.value
            await emitter.emit(StreamEvent(type: "done", text: await collector.joined()))
        } catch {
            continuation.finish()
            analysis.cancel()
            results.cancel()
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }

    private static func forwardResults(
        _ transcriber: SpeechTranscriber,
        emitter: LineEmitter,
        collector: TranscriptCollector
    ) async throws {
        var seenFinals: Set<String> = []
        for try await result in transcriber.results {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, hasLexicalContent(text) else { continue }
            if result.isFinal {
                let identity = "\(result.range.start.value):\(result.range.duration.value):\(text)"
                guard seenFinals.insert(identity).inserted else { continue }
                let index = await collector.append(text)
                await emitter.emit(StreamEvent(type: "segment", text: text, index: index))
            } else {
                await emitter.emit(StreamEvent(type: "partial", text: text))
            }
        }
    }

    private static func makeMonoBuffer(
        from floatData: Data,
        frameCount: Int,
        format: AVAudioFormat
    ) throws -> AVAudioPCMBuffer {
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)
        ), let samples = buffer.int16ChannelData?[0] else {
            throw SidecarError.invalidAudioFrame
        }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        floatData.withUnsafeBytes { raw in
            for frame in 0..<frameCount {
                let value = raw.loadUnaligned(fromByteOffset: frame * MemoryLayout<Float>.size, as: Float.self)
                let finite = value.isFinite ? value : 0
                let clamped = min(1, max(-1, finite))
                let scaled = clamped >= 0 ? clamped * 32_767 : clamped * 32_768
                samples[frame] = Int16(scaled)
            }
        }
        return buffer
    }

    private static func writeJSON<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}
