import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateOutput } from '../src/runtime.js';
import { wavFixture } from './fixtures/audio.js';

const mp3 = readFileSync(new URL('./fixtures/audio/tone.mp3', import.meta.url));
const vbr = readFileSync(new URL('./fixtures/audio/tone-vbr.mp3', import.meta.url));
const validate = (bytes: Uint8Array, content_type = 'audio/wav') => validateOutput({ bytes, content_type });

describe('Complete audio file validation', () => {
  it('accepts PCM WAV, MPEG-1 stereo CBR and MPEG-2 mono VBR with ID3 metadata', async () => {
    await expect(validate(wavFixture())).resolves.toBeUndefined();
    await expect(validate(mp3, 'audio/mpeg')).resolves.toBeUndefined();
    await expect(validate(vbr, 'audio/mpeg')).resolves.toBeUndefined();
  });
  it('accepts a complete streaming WAV with unknown lengths but rejects an incomplete PCM frame', async () => {
    const bytes = wavFixture(); bytes.writeUInt32LE(0xffffffff, 4); bytes.writeUInt32LE(0xffffffff, 40);
    await expect(validate(bytes)).resolves.toBeUndefined();
    await expect(validate(bytes.subarray(0, -1))).rejects.toMatchObject({code:'result_defect'});
  });
  it('supports odd-byte padded ancillary WAV chunks', async () => {
    const bytes = wavFixture(), extra = Buffer.from('4a554e4b010000000000', 'hex');
    const padded = Buffer.concat([bytes.subarray(0, 36), extra, bytes.subarray(36)]);
    padded.writeUInt32LE(padded.length - 8, 4);
    await expect(validate(padded)).resolves.toBeUndefined();
  });
  it('rejects empty, mislabeled, unsupported and textual audio', async () => {
    for (const [bytes, type] of [[Buffer.alloc(0),'audio/wav'], [mp3,'audio/wav'], [wavFixture(),'audio/mpeg'], [Buffer.from('provider error'),'audio/wav'], [wavFixture(),'audio/ogg']] as const)
      await expect(validate(bytes, type)).rejects.toMatchObject({code:'result_defect'});
    await expect(validateOutput({content_type:'audio/wav',text:'not audio'})).rejects.toMatchObject({code:'result_defect'});
  });
  it('rejects truncated WAV bodies, incorrect lengths, zero channel count and inconsistent block sizes', async () => {
    const mutations = [
      (b:Buffer) => b.subarray(0,-2),
      (b:Buffer) => {b.writeUInt32LE(0,40);return b;},
      (b:Buffer) => {b.writeUInt16LE(0,22);return b;},
      (b:Buffer) => {b.writeUInt16LE(1,32);return b;},
      (b:Buffer) => {b.writeUInt32LE(0,24);return b;},
    ];
    for (const mutate of mutations) await expect(validate(mutate(wavFixture()))).rejects.toMatchObject({code:'result_defect'});
  });
  it('rejects non-finite floating-point WAV samples after decoding', async () => {
    const bytes = wavFixture(); bytes.writeUInt16LE(3,20); bytes.writeUInt16LE(32,34); bytes.writeUInt16LE(4,32); bytes.writeUInt32LE(32000,28);
    await expect(validate(bytes)).resolves.toBeUndefined();
    for (const bad of [NaN, Infinity, -Infinity]) {
      bytes.writeFloatLE(bad,44);
      await expect(validate(bytes)).rejects.toMatchObject({code:'result_defect'});
    }
  });
  it('accepts supported PCM depths, floats, G.711 and the extensible PCM format', async () => {
    for (const [format, bits] of [[1,8],[1,24],[1,32],[3,32],[3,64],[6,8],[7,8]]) {
      const bytes=wavFixture(), size=bits===24?156:160;
      const output=Buffer.from(bytes.subarray(0,44+size));
      output.writeUInt32LE(output.length-8,4);output.writeUInt32LE(size,40);
      output.writeUInt16LE(format,20);output.writeUInt16LE(bits,34);output.writeUInt16LE(bits/8,32);output.writeUInt32LE(8000*bits/8,28);
      await expect(validate(output)).resolves.toBeUndefined();
    }
    const bytes=wavFixture(), extension=Buffer.alloc(24);
    extension.writeUInt16LE(22,0);extension.writeUInt16LE(16,2);extension.writeUInt32LE(4,4);
    Buffer.from('0100000000001000800000aa00389b71','hex').copy(extension,8);
    const extended=Buffer.concat([bytes.subarray(0,36),extension,bytes.subarray(36)]);
    extended.writeUInt32LE(extended.length-8,4);extended.writeUInt32LE(40,16);extended.writeUInt16LE(0xfffe,20);
    await expect(validate(extended)).resolves.toBeUndefined();
    extended[50]=255;
    await expect(validate(extended)).rejects.toMatchObject({code:'result_defect'});
  });
  it('validates IMA and MS ADPCM blocks and rejects corrupt block headers', async () => {
    for (const name of ['tone-ima.wav','tone-ms.wav']) {
      const bytes=readFileSync(new URL(`./fixtures/audio/${name}`,import.meta.url));
      await expect(validate(bytes)).resolves.toBeUndefined();
      const data=bytes.indexOf(Buffer.from('data'))+8;
      bytes[data+(name.includes('ima')?2:0)]=255;
      await expect(validate(bytes)).rejects.toMatchObject({code:'result_defect'});
    }
  });
  it('rejects truncated MP3 frames and metadata, valid audio followed by garbage and broken frame headers', async () => {
    const broken = Buffer.from(mp3); const tagEnd = 10 + broken[6]*0x200000 + broken[7]*0x4000 + broken[8]*0x80 + broken[9]; broken[tagEnd] = 0;
    for (const bytes of [mp3.subarray(0,-1), mp3.subarray(0,12), Buffer.concat([mp3,Buffer.from('garbage')]), broken])
      await expect(validate(bytes,'audio/mpeg')).rejects.toMatchObject({code:'result_defect'});
  });
  it('bounds encoded size before allocating a decoder', async () => {
    await expect(validate(Buffer.alloc(16*1024*1024+1))).rejects.toMatchObject({code:'result_defect'});
  });
});
