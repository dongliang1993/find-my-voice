import AVFoundation
import Foundation

// stdin: 24 kHz, mono, signed 16-bit little-endian PCM. stdout: JSON events only.
let outputLock = NSLock()
func emit(_ event: [String: Any]) {
    outputLock.lock()
    defer { outputLock.unlock() }
    if let data = try? JSONSerialization.data(withJSONObject: event) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

do {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    let stateLock = NSLock()
    var rendered = false
    var nonSilentFrames: UInt64 = 0
    var peak: Float = 0
    let outputFormat = engine.mainMixerNode.outputFormat(forBus: 0)
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 512, format: outputFormat) { buffer, _ in
        guard let samples = buffer.floatChannelData?[0] else { return }
        var localPeak: Float = 0
        var audible: UInt64 = 0
        for i in 0..<Int(buffer.frameLength) {
            let value = abs(samples[i])
            localPeak = max(localPeak, value)
            if value > 0.00001 { audible += 1 }
        }
        stateLock.lock()
        peak = max(peak, localPeak)
        nonSilentFrames += audible
        let first = !rendered && audible > 0
        if first { rendered = true }
        stateLock.unlock()
        if first { emit(["event": "first_render", "output_sample_rate": outputFormat.sampleRate]) }
    }
    try engine.start()
    player.play()
    emit(["event": "ready"])
    let played = DispatchGroup()
    var tail = Data()
    var inputFrames: UInt64 = 0
    while let incoming = try FileHandle.standardInput.read(upToCount: 8192), !incoming.isEmpty {
        tail.append(incoming)
        let frames = tail.count / 2
        if frames == 0 { continue }
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        buffer.frameLength = AVAudioFrameCount(frames)
        let samples = buffer.floatChannelData![0]
        tail.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<frames {
                let bits = UInt16(raw[i * 2]) | (UInt16(raw[i * 2 + 1]) << 8)
                samples[i] = Float(Int16(bitPattern: bits)) / 32768
            }
        }
        tail = Data(tail.suffix(tail.count % 2))
        inputFrames += UInt64(frames)
        played.enter()
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in played.leave() }
    }
    guard tail.isEmpty, inputFrames > 0 else {
        throw NSError(domain: "PCM", code: 1)
    }
    let duration = Double(inputFrames) / 24000
    guard played.wait(timeout: .now() + duration + 10) == .success else {
        throw NSError(domain: "PCM", code: 2)
    }
    stateLock.lock()
    let finalPeak = peak
    let finalFrames = nonSilentFrames
    let didRender = rendered
    stateLock.unlock()
    player.stop()
    engine.stop()
    engine.mainMixerNode.removeTap(onBus: 0)
    emit(["event": "ended", "input_frames": inputFrames,
          "non_silent_output_frames": finalFrames, "peak": finalPeak, "rendered": didRender])
} catch {
    emit(["event": "error", "code": "NATIVE_AUDIO_FAILED"])
    exit(1)
}
