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

// Fallback chain for transient overload. Both do audio on Allison's free tier (verified
// 2026-06-24: 2.5-flash + flash-latest returned 200 while the API was otherwise "busy").
// On a 503/429 we cycle to the next model before giving up — so Google throttling one
// model at a peak moment no longer dead-ends a recording.
export const GEMINI_MODELS = [GEMINI_MODEL, 'gemini-flash-latest'] as const;

const endpointFor = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const GEMINI_ENDPOINT = endpointFor(GEMINI_MODEL);

// HTTP statuses worth retrying: 429 = rate/quota burst, 500/503 = "model overloaded".
const RETRYABLE = new Set([429, 500, 503]);
const MAX_ATTEMPTS = 4; // total tries across the model chain before surfacing failure
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Exact transcription intent: verbatim, language-preserving, transcript-only.
export const TRANSCRIBE_PROMPT =
  'Transcribe this audio verbatim. The speaker mixes Hebrew and English in the same ' +
  'sentences — keep every word in the language it was actually spoken in, do not ' +
  'translate. Add natural punctuation and paragraph breaks. Output ONLY the transcript ' +
  'text, with no preamble, commentary, or quotation marks.';

// Minimal shape of the Gemini generateContent response we read from.
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

/**
 * Extract the transcript text from a parsed Gemini response.
 * Throws a human-readable error if the response carried an error / block / no text.
 */
export function parseTranscript(data: GeminiResponse): string {
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
export async function transcribeAudio(
  apiKey: string,
  base64: string,
  mimeType: string
): Promise<string> {
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

  let lastOverload = false; // did the final failure look like "model overloaded"?
  // Walk attempts across the model chain. Each retryable failure backs off, then the
  // NEXT attempt prefers a different model so one busy model can't dead-end the recording.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const model = GEMINI_MODELS[attempt % GEMINI_MODELS.length] ?? GEMINI_MODEL;
    // Key is passed as a query param per Gemini's documented contract.
    const url = `${endpointFor(model)}?key=${encodeURIComponent(apiKey)}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Network blip (offline, dropped connection) — treat as retryable.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw new Error('Network problem reaching Gemini. Your recording is safe — try again.');
    }

    let data: GeminiResponse;
    try {
      data = (await res.json()) as GeminiResponse;
    } catch {
      throw new Error(`Gemini returned a non-JSON response (HTTP ${res.status}).`);
    }

    if (res.ok) {
      return parseTranscript(data);
    }

    // Retryable overload/rate burst: back off (exponential) and let the loop try again,
    // rotating to the fallback model on the next pass.
    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS - 1) {
      lastOverload = res.status === 503 || res.status === 500;
      await sleep(600 * 2 ** attempt);
      continue;
    }

    // Non-retryable, or out of attempts.
    if (RETRYABLE.has(res.status)) {
      throw new Error(
        "Gemini is busy right now (Google's servers, not your key). Your recording is " +
          'safe — try again in a moment.'
      );
    }
    const msg = data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Gemini request failed: ${msg}`);
  }

  // Exhausted every attempt on retryable errors.
  throw new Error(
    lastOverload
      ? "Gemini is busy right now (Google's servers, not your key). Your recording is safe — try again in a moment."
      : 'Transcription failed after several tries. Your recording is safe — try again.'
  );
}
