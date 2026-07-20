// wav.ts — in-browser PCM → 16 kHz mono WAV encoder
// WHAT: pure functions that downsample Float32 mic samples to 16 kHz mono and write
//       a canonical 16-bit PCM WAV (RIFF) blob, plus a Blob→base64 helper.
// WHY:  Gemini's documented audio MIME types are wav/mp3/aiff/aac/ogg/flac. Android
//       Chrome's MediaRecorder produces audio/webm, which is NOT guaranteed to work.
//       So we capture raw PCM via Web Audio and encode WAV ourselves — Gemini always
//       accepts audio/wav. Mono + 16 kHz keeps the base64 payload small (~30 KB/sec).
// DECIDED: 16 kHz, mono, 16-bit PCM. Linear-interpolation downsample (good enough for
//          speech; Gemini transcribes fine). No dependencies.
// BUILT:  downsampleBuffer, encodeWav, blobToBase64, wavByteLength helpers.
// NEXT:   none — stable. If quality ever matters, swap to a windowed-sinc resampler.

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Linear-resample a mono Float32 sample buffer from `inputRate` to `outputRate`.
 * Returns the original buffer untouched when the rates already match.
 */
export function downsampleBuffer(
  buffer: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (outputRate === inputRate) return buffer;
  if (outputRate > inputRate) {
    // We never upsample in this app; guard against misuse by returning input.
    return buffer;
  }
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const exactPos = i * ratio;
    const before = Math.floor(exactPos);
    const after = Math.min(before + 1, buffer.length - 1);
    const frac = exactPos - before;
    result[i] = buffer[before] * (1 - frac) + buffer[after] * frac;
  }
  return result;
}

/**
 * Concatenate a list of Float32 chunks into one contiguous buffer.
 */
export function mergeChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}

/**
 * Encode mono Float32 PCM samples (already at `sampleRate`) into a 16-bit WAV Blob.
 * Writes a standard 44-byte RIFF/WAVE header followed by little-endian PCM.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = bytesPerSample; // mono
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, 1, true); // num channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples, clamped float [-1,1] → int16
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: 'audio/wav' });
}

/**
 * Read a Blob as a base64 string (no data: prefix) — the form Gemini's
 * inline_data.data field expects.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return a string'));
        return;
      }
      // result looks like "data:audio/wav;base64,AAAA..." — strip the prefix.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Bytes a finished WAV will occupy for a given sample count (header + PCM).
 * Used to estimate payload size / enforce the inline ceiling.
 */
export function wavByteLength(sampleCount: number): number {
  return 44 + sampleCount * 2;
}

/**
 * v34 — split one long WAV blob into several self-contained WAV blobs, each with ≤ maxDataBytes
 * of PCM (cut on an even byte so a 16-bit sample is never torn in half). Re-headers every chunk,
 * reading the sample rate out of the source header so the chunks stay faithful. Returns [blob]
 * untouched when it already fits. This is what lets a LONG brain-dump transcribe at all: Gemini's
 * inline request cap rejects a big single payload, so the app transcribes the dump in parts and
 * joins the transcripts — instead of dead-ending the exact note she'd least want to lose.
 * Only valid for the app's own PCM WAV encoding (RIFF/WAVE, data chunk at offset 44 — what
 * encodeWav writes). Throws on anything that isn't that shape.
 */
export async function splitWavBlob(blob: Blob, maxDataBytes: number): Promise<Blob[]> {
  if (blob.size <= 44 + maxDataBytes) return [blob];
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  if (
    view.getUint32(0, false) !== 0x52494646 /* 'RIFF' */ ||
    view.getUint32(8, false) !== 0x57415645 /* 'WAVE' */ ||
    view.getUint32(36, false) !== 0x64617461 /* 'data' at 36 — encodeWav's fixed layout */ ||
    view.getUint16(20, true) !== 1 /* PCM */ ||
    view.getUint16(22, true) !== 1 /* mono — a stereo file re-headered as mono would garble */ ||
    view.getUint16(34, true) !== 16 /* 16-bit — anything else breaks the even-byte cut math */
  ) {
    throw new Error('splitWavBlob: not a canonical PCM WAV (this app only splits its own WAVs)');
  }
  const sampleRate = view.getUint32(24, true);
  const pcm = new Uint8Array(buf, 44);
  const step = maxDataBytes - (maxDataBytes % 2); // even cut — never tear a 16-bit sample
  const chunks: Blob[] = [];
  for (let start = 0; start < pcm.length; start += step) {
    const slice = pcm.subarray(start, Math.min(start + step, pcm.length));
    const out = new ArrayBuffer(44 + slice.length);
    const outView = new DataView(out);
    writeString(outView, 0, 'RIFF');
    outView.setUint32(4, 36 + slice.length, true);
    writeString(outView, 8, 'WAVE');
    writeString(outView, 12, 'fmt ');
    outView.setUint32(16, 16, true);
    outView.setUint16(20, 1, true);
    outView.setUint16(22, 1, true);
    outView.setUint32(24, sampleRate, true);
    outView.setUint32(28, sampleRate * 2, true);
    outView.setUint16(32, 2, true);
    outView.setUint16(34, 16, true);
    writeString(outView, 36, 'data');
    outView.setUint32(40, slice.length, true);
    new Uint8Array(out, 44).set(slice);
    chunks.push(new Blob([out], { type: 'audio/wav' }));
  }
  return chunks;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
