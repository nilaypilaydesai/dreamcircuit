// Lay the trailer's music under its video (macOS: AVFoundation). The film tool (web/src/tools/
// cinema.ts) writes the video (H.264 MP4, no audio) and the music (a WAV) separately; this copies
// the video's samples through untouched and encodes the music as AAC beside them, cut to the
// video's length, in an MP4 that starts playing before it has all arrived.
//
//   swiftc -O scripts/mux_trailer.swift -o /tmp/mux_trailer
//   /tmp/mux_trailer trailer.mp4 trailer.wav out.mp4

import AVFoundation

let args = CommandLine.arguments
guard args.count == 4 else {
  print("usage: mux_trailer video.mp4 music.wav out.mp4")
  exit(2)
}
let video = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let music = AVURLAsset(url: URL(fileURLWithPath: args[2]))
let out = URL(fileURLWithPath: args[3])
try? FileManager.default.removeItem(at: out)

func fail(_ what: String, _ err: Error?) -> Never {
  print("mux_trailer: \(what): \(err.map { "\($0)" } ?? "unknown error")")
  exit(1)
}

guard let vTrack = video.tracks(withMediaType: .video).first else { fail("no video track in \(args[1])", nil) }
guard let aTrack = music.tracks(withMediaType: .audio).first else { fail("no audio track in \(args[2])", nil) }
let end = video.duration

let writer: AVAssetWriter
let vReader: AVAssetReader, aReader: AVAssetReader
do {
  writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
  vReader = try AVAssetReader(asset: video)
  aReader = try AVAssetReader(asset: music)
} catch { fail("could not open the files", error) }
writer.shouldOptimizeForNetworkUse = true // (the index up front)

let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: nil) // (the samples as they are)
vReader.add(vOut)
let aOut = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [
  AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
  AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
])
aReader.add(aOut)

let hint = vTrack.formatDescriptions.first.map { $0 as! CMFormatDescription }
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: hint)
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
  AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000,
])
vIn.expectsMediaDataInRealTime = false
aIn.expectsMediaDataInRealTime = false
writer.add(vIn)
writer.add(aIn)

guard writer.startWriting() else { fail("could not start writing", writer.error) }
guard vReader.startReading(), aReader.startReading() else { fail("could not read", vReader.error ?? aReader.error) }
writer.startSession(atSourceTime: .zero)

let group = DispatchGroup()
/** Feed ``input`` from ``output`` until it runs dry (or, for the music, past the video's end). */
func pump(_ input: AVAssetWriterInput, _ output: AVAssetReaderTrackOutput, _ label: String, cut: Bool) {
  group.enter()
  let queue = DispatchQueue(label: label)
  input.requestMediaDataWhenReady(on: queue) {
    while input.isReadyForMoreMediaData {
      guard let sample = output.copyNextSampleBuffer(),
            !cut || CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), end) < 0 else {
        input.markAsFinished()
        group.leave()
        return
      }
      if !input.append(sample) {
        input.markAsFinished()
        group.leave()
        return
      }
    }
  }
}
pump(vIn, vOut, "video", cut: false)
pump(aIn, aOut, "music", cut: true)
group.wait()
vReader.cancelReading()
aReader.cancelReading()

let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fail("could not finish \(args[3])", writer.error) }
let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
print("\(args[3]): \(String(format: "%.1f", CMTimeGetSeconds(end))) s, \(size / 1_000_000) MB")
