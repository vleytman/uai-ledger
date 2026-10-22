import decodeWav from '@audio/decode-wav';
import { MPEGDecoder } from 'mpg123-decoder';
import { DomainError } from '../../contracts/src/index.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SAMPLES = 16 * 1024 * 1024; // Across channels; at most 64 MiB of decoded PCM.
const fail = (): never => { throw new DomainError('result_defect'); };
const tag = (bytes: Buffer, offset: number) => bytes.toString('ascii', offset, offset + 4);

function checkPcm(channelData: Float32Array[], sampleRate: number) {
  const frames = channelData[0]?.length ?? 0;
  if (!frames || sampleRate <= 0 || channelData.length > 8 || frames * channelData.length > MAX_SAMPLES) fail();
  for (const channel of channelData) {
    if (channel.length !== frames) fail();
    for (const sample of channel) if (!Number.isFinite(sample)) fail();
  }
  return frames;
}

function validateWav(bytes: Buffer) {
  if (bytes.length < 44 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') fail();
  const streaming = bytes.readUInt32LE(4) === 0xffffffff;
  if (!streaming && bytes.readUInt32LE(4) !== bytes.length - 8) fail();
  let fmt: Buffer | undefined, data: Buffer | undefined;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) fail();
    const declared = bytes.readUInt32LE(offset + 4);
    // Cartesia/FFmpeg streaming WAV uses unknown RIFF/data lengths. The data runs to EOF.
    const size = streaming && declared === 0xffffffff && tag(bytes, offset) === 'data' ? bytes.length - offset - 8 : declared;
    const end = offset + 8 + size;
    if (end + (size % 2) > bytes.length) fail();
    if (tag(bytes, offset) === 'fmt ') { if (fmt || data) fail(); fmt = bytes.subarray(offset + 8, end); }
    if (tag(bytes, offset) === 'data') { if (!fmt || data || !size) fail(); data = bytes.subarray(offset + 8, end); }
    offset = end + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) return fail();
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), block = fmt.readUInt16LE(12), bits = fmt.readUInt16LE(14);
  if (!channels || channels > 8 || !rate || rate > 384000 || !block || data.length % block) fail();
  if (fmt.length !== 16 && (fmt.length < 18 || fmt.readUInt16LE(16) !== fmt.length - 18)) fail();
  if (format === 0xfffe) {
    if (fmt.length < 40 || fmt.readUInt16LE(18) > bits || fmt.subarray(26, 40).toString('hex') !== '000000001000800000aa00389b71') fail();
    format = fmt.readUInt16LE(24);
  }
  let samplesPerBlock = 1;
  if ([1, 3, 6, 7].includes(format)) {
    const depths = format === 1 ? [8, 16, 24, 32] : format === 3 ? [32, 64] : [8];
    if (!depths.includes(bits) || block !== channels * bits / 8 || fmt.readUInt32LE(8) !== rate * block) fail();
  } else if (format === 2 || format === 0x11) {
    if (channels > 2 || bits !== 4 || fmt.length < 20) fail();
    samplesPerBlock = fmt.readUInt16LE(18);
    const header = (format === 2 ? 7 : 4) * channels;
    const expected = (block - header) * 2 / channels + (format === 2 ? 2 : 1);
    if (block < header || samplesPerBlock !== expected || (format === 0x11 && (block - header) % (4 * channels))) fail();
    let coefficients = 0;
    if (format === 2) {
      if (fmt.length < 22) fail();
      coefficients = fmt.readUInt16LE(20);
      if (!coefficients || coefficients > 256 || fmt.length !== 22 + coefficients * 4) fail();
    }
    for (let offset = 0; offset < data.length; offset += block) for (let channel = 0; channel < channels; channel++) {
      if (format === 2 ? data[offset + channel] >= coefficients : data[offset + channel * 4 + 2] > 88 || data[offset + channel * 4 + 3] !== 0) fail();
    }
  } else fail();
  const frames = data.length / block * samplesPerBlock;
  if (!frames || frames * channels > MAX_SAMPLES) fail();
  // Pass just the verified chunks; ancillary RIFF chunks can have odd-byte padding.
  const canonical = Buffer.alloc(28 + fmt.length + data.length);
  canonical.write('RIFF'); canonical.writeUInt32LE(canonical.length - 8, 4); canonical.write('WAVEfmt ', 8);
  canonical.writeUInt32LE(fmt.length, 16); fmt.copy(canonical, 20);
  canonical.write('data', 20 + fmt.length); canonical.writeUInt32LE(data.length, 24 + fmt.length); data.copy(canonical, 28 + fmt.length);
  const decoded = decodeWav(canonical);
  if (decoded.channelData.length !== channels || decoded.sampleRate !== rate || checkPcm(decoded.channelData, rate) !== frames) fail();
}

function mp3Frames(bytes: Buffer): Uint8Array[] {
  let offset = 0, end = bytes.length;
  if (bytes.toString('ascii', 0, 3) === 'ID3') {
    if (end < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.subarray(6, 10).some(v => v > 127)) fail();
    const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
    offset = 10 + size + (bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0);
  }
  if (end >= 128 && bytes.toString('ascii', end - 128, end - 125) === 'TAG') end -= 128;
  const frames: Uint8Array[] = [];
  let totalSamples = 0, streamRate = 0, streamChannels = 0;
  while (offset < end) {
    if (offset + 4 > end || bytes[offset] !== 255 || (bytes[offset + 1] & 0xe0) !== 0xe0) fail();
    const version = (bytes[offset + 1] >> 3) & 3, layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4, rateIndex = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3 || (bytes[offset + 3] & 3) === 2) fail();
    const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const channels = bytes[offset + 3] >> 6 === 3 ? 1 : 2;
    const length = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex] / rate) + ((bytes[offset + 2] >> 1) & 1);
    if (offset + length > end || (streamRate && (streamRate !== rate || streamChannels !== channels))) fail();
    streamRate = rate; streamChannels = channels;
    totalSamples += (version === 3 ? 1152 : 576) * channels;
    if (totalSamples > MAX_SAMPLES) fail();
    frames.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  if (!frames.length || offset !== end) fail();
  return frames;
}

/** Complete-file validation shared by uploads and provider output, before storage/charging. */
export async function validateAudio(contentType: string, input: Uint8Array) {
  try {
    if (!input.length || input.length > MAX_BYTES) fail();
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (contentType === 'audio/wav') return validateWav(bytes);
    if (contentType !== 'audio/mpeg') return fail();
    const frames = mp3Frames(bytes), decoder = new MPEGDecoder();
    try {
      await decoder.ready;
      let samples = 0;
      // Bound each decoded allocation, including long highly compressed files.
      for (let offset = 0; offset < frames.length; offset += 32) {
        const decoded = decoder.decodeFrames(frames.slice(offset, offset + 32));
        if (decoded.errors.length) fail();
        if (decoded.samplesDecoded) samples += checkPcm(decoded.channelData, decoded.sampleRate);
      }
      if (!samples) fail();
    } finally { decoder.free(); }
  } catch { fail(); }
}
