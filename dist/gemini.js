// gemini.ts — Google Gemini transcription call + response parsing
// WHAT: builds the generateContent request (inline audio), POSTs it with the user's
//       key, and parses the transcript out of the response JSON.
// WHY:  isolating the network shape here keeps app.ts about UI/state, and lets the
//       Playwright tests mock `transcribeAudio` / the fetch without a real key or mic.
// DECIDED: model = gemini-2.5-flash (fast, multimodal/audio, strong multilingual). Picked
//          2026-06-14 after live-testing Allison's key: gemini-2.0-flash returned
//          free-tier "limit: 0" for her account, while 2.5-flash returns 200 on her free
//          tier. Key travels phone → Google only; never stored anywhere but localStorage;
//          never logged. Verbatim He/En prompt — do NOT translate. Output = transcript only.
// BUILT:  TRANSCRIBE_PROMPT, GEMINI_ENDPOINT, transcribeAudio(), parseTranscript().
// NEXT:   v0 is inline-only (≤~10 min). If longer dumps become routine, add the Gemini
//         File API upload path — deliberately out of scope for now.
export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// Exact transcription intent: verbatim, language-preserving, transcript-only.
export const TRANSCRIBE_PROMPT = 'Transcribe this audio verbatim. The speaker mixes Hebrew and English in the same ' +
    'sentences — keep every word in the language it was actually spoken in, do not ' +
    'translate. Add natural punctuation and paragraph breaks. Output ONLY the transcript ' +
    'text, with no preamble, commentary, or quotation marks.';
/**
 * Extract the transcript text from a parsed Gemini response.
 * Throws a human-readable error if the response carried an error / block / no text.
 */
export function parseTranscript(data) {
    if (data.error?.message) {
        throw new Error(`Gemini error: ${data.error.message}`);
    }
    if (data.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error('Gemini returned no transcript text.');
    }
    return text.trim();
}
/**
 * Send a base64 audio payload to Gemini and return the transcript.
 * @param apiKey   user's Gemini key (from localStorage; never persisted elsewhere)
 * @param base64   audio bytes, base64-encoded, no data: prefix
 * @param mimeType e.g. 'audio/wav'
 */
export async function transcribeAudio(apiKey, base64, mimeType) {
    const body = {
        contents: [
            {
                parts: [
                    { text: TRANSCRIBE_PROMPT },
                    { inline_data: { mime_type: mimeType, data: base64 } },
                ],
            },
        ],
    };
    // Key is passed as a query param per Gemini's documented contract.
    const url = `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data;
    try {
        data = (await res.json());
    }
    catch {
        throw new Error(`Gemini returned a non-JSON response (HTTP ${res.status}).`);
    }
    if (!res.ok) {
        const msg = data.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`Gemini request failed: ${msg}`);
    }
    return parseTranscript(data);
}
