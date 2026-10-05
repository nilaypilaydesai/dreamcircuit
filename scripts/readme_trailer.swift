// The trailer as the README plays it (macOS: AVFoundation). GitHub plays a video in a README only
// when it was uploaded to GitHub itself, at most 10 MB on a free plan, and shows its first frame
// until it is played: the trailer opens on black, so this one opens on the title card (the poster:
// the name over the slow-motion jump) for a second, fades it out, and then runs the trailer, its
// music from the film's own WAV. 768x432, exactly twice the game's 384x216 (the 1080p film is five
// times it, so every pixel of the game stays a 2x2 block), H.264 and AAC.
//
//   swiftc -O scripts/readme_trailer.swift -o /tmp/readme_trailer
//   /tmp/readme_trailer trailer.mp4 trailer.wav trailer.jpg out.mp4 [video bits/s, default 650000]

import AVFoundation
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count == 5 || args.count == 6 else {
  print("usage: readme_trailer video.mp4 music.wav card.jpg out.mp4 [video bits/s]")
  exit(2)
}
let video = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let music = AVURLAsset(url: URL(fileURLWithPath: args[2]))
let out = URL(fileURLWithPath: args[4])
let videoRate = args.count == 6 ? Int(args[5]) ?? 650_000 : 650_000
try? FileManager.default.removeItem(at: out)

func fail(_ what: String, _ err: Error?) -> Never {
  print("readme_trailer: \(what): \(err.map { "\($0)" } ?? "unknown error")")
  exit(1)
}

let W = 768, H = 432, fps: Int32 = 30
let hold = 30, fade = 9 // frames: the card held, then faded to black (the trailer opens on black)
let lead = CMTime(value: CMTimeValue(hold + fade), timescale: fps) // how much later the trailer starts

guard let vTrack = video.tracks(withMediaType: .video).first else { fail("no video track in \(args[1])", nil) }
guard let aTrack = music.tracks(withMediaType: .audio).first else { fail("no audio track in \(args[2])", nil) }
let srcSize = vTrack.naturalSize
let end = CMTimeAdd(lead, video.duration)

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, nil),
      let card = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("could not read \(args[3])", nil) }

let writer: AVAssetWriter
let vReader: AVAssetReader, aReader: AVAssetReader
do {
  writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
  vReader = try AVAssetReader(asset: video)
  aReader = try AVAssetReader(asset: music)
} catch { fail("could not open the files", error) }
writer.shouldOptimizeForNetworkUse = true // (the index up front: it starts playing before it has all arrived)

let pixels: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: pixels)
vReader.add(vOut)
let aOut = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [
  AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false,
  AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
])
aReader.add(aOut)

// (the film's frames come in at 1920x1080 and are scaled down to 768x432 by the encoder)
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: videoRate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: 60, AVVideoExpectedSourceFrameRateKey: fps,
  ],
])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
  AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
])
vIn.expectsMediaDataInRealTime = false
aIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: Int(srcSize.width), kCVPixelBufferHeightKey as String: Int(srcSize.height),
])
writer.add(vIn)
writer.add(aIn)

guard writer.startWriting() else { fail("could not start writing", writer.error) }
guard vReader.startReading(), aReader.startReading() else { fail("could not read", vReader.error ?? aReader.error) }
writer.startSession(atSourceTime: .zero)

/** The card at the film's size, darkened toward black by ``dark`` (0..1). */
func cardFrame(_ dark: Double) -> CVPixelBuffer? {
  guard let pool = adaptor.pixelBufferPool else { return nil }
  var buf: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buf)
  guard let pb = buf else { return nil }
  CVPixelBufferLockBaseAddress(pb, [])
  defer { CVPixelBufferUnlockBaseAddress(pb, []) }
  let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
  guard let g = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: w, height: h, bitsPerComponent: 8,
                          bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
  else { return nil }
  g.interpolationQuality = .none
  g.draw(card, in: CGRect(x: 0, y: 0, width: w, height: h))
  if dark > 0 {
    g.setFillColor(CGColor(gray: 0, alpha: dark))
    g.fill(CGRect(x: 0, y: 0, width: w, height: h))
  }
  return pb
}

let group = DispatchGroup()

// the picture: the card, its fade, then every frame of the film, later by the card's length
group.enter()
var cardAt = 0
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "video")) {
  while vIn.isReadyForMoreMediaData {
    if cardAt < hold + fade {
      let dark = cardAt < hold ? 0 : Double(cardAt - hold + 1) / Double(fade)
      guard let pb = cardFrame(dark), adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(cardAt), timescale: fps))
      else { fail("could not write the card", writer.error) }
      cardAt += 1
      continue
    }
    guard let sample = vOut.copyNextSampleBuffer(), let pb = CMSampleBufferGetImageBuffer(sample) else {
      vIn.markAsFinished()
      group.leave()
      return
    }
    let at = CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(sample), lead)
    if !adaptor.append(pb, withPresentationTime: at) { fail("could not write a frame", writer.error) }
  }
}

// the music: silence under the card, then the film's, cut at the end of the picture
group.enter()
var silent = false
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "music")) {
  while aIn.isReadyForMoreMediaData {
    guard let sample = aOut.copyNextSampleBuffer() else {
      aIn.markAsFinished()
      group.leave()
      return
    }
    if !silent {
      silent = true
      // (as many frames of silence as the card lasts, in the music's own format)
      guard let fmt = CMSampleBufferGetFormatDescription(sample),
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee else { fail("no audio format", nil) }
      let frames = Int(Double(asbd.mSampleRate) * CMTimeGetSeconds(lead)), bytes = frames * Int(asbd.mBytesPerFrame)
      var block: CMBlockBuffer?
      CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                         customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
      guard let blk = block else { fail("no silence", nil) }
      CMBlockBufferFillDataBytes(with: 0, blockBuffer: blk, offsetIntoDestination: 0, dataLength: bytes)
      var quiet: CMSampleBuffer?
      CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: blk, formatDescription: fmt,
                                                           sampleCount: frames, presentationTimeStamp: .zero,
                                                           packetDescriptions: nil, sampleBufferOut: &quiet)
      guard let q = quiet, aIn.append(q) else { fail("could not write the silence", writer.error) }
    }
    if CMTimeCompare(CMTimeAdd(CMSampleBufferGetPresentationTimeStamp(sample), lead), end) >= 0 { continue } // (the WAV runs on past the picture)
    // (its own timing, every entry later by the card's length: an entry's duration is a sample's)
    var count: CMItemCount = 0
    CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count)
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
    CMSampleBufferGetSampleTimingInfoArray(sample, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count)
    for i in timing.indices {
      timing[i].presentationTimeStamp = CMTimeAdd(timing[i].presentationTimeStamp, lead)
      timing[i].decodeTimeStamp = .invalid
    }
    var moved: CMSampleBuffer?
    CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sample, sampleTimingEntryCount: count,
                                          sampleTimingArray: &timing, sampleBufferOut: &moved)
    guard let m = moved, aIn.append(m) else { fail("could not write the music", writer.error) }
  }
}
group.wait()
vReader.cancelReading()
aReader.cancelReading()

let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fail("could not finish \(args[4])", writer.error) }
let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
print("\(args[4]): \(String(format: "%.1f", CMTimeGetSeconds(end))) s, \(String(format: "%.2f", Double(size) / 1_000_000)) MB")
