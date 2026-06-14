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
export function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate === inputRate)
        return buffer;
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
export function mergeChunks(chunks) {
    let total = 0;
    for (const c of chunks)
        total += c.length;
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
export function encodeWav(samples, sampleRate) {
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
export function blobToBase64(blob) {
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
export function wavByteLength(sampleCount) {
    return 44 + sampleCount * 2;
}
function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
}
