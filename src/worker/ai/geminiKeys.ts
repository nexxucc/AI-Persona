import type { AppBindings } from "../types/bindings";

/**
 * Resolve the ordered list of Gemini API keys to use for a request.
 *
 * The free Gemini tier caps `gemini-2.5-flash` at a low number of requests per
 * day per key, so the worker rotates across several keys. `GEMINI_API_KEYS` is a
 * comma-separated list (optional); `GEMINI_API_KEY` is the single legacy key and
 * is always included last as a fallback. Order is preserved and duplicates are
 * removed.
 */
export function getGeminiApiKeys(env: AppBindings): string[] {
	const keys: string[] = [];

	const multiple = env.GEMINI_API_KEYS?.trim();

	if (multiple) {
		for (const candidate of multiple.split(",")) {
			const trimmed = candidate.trim();

			if (trimmed) {
				keys.push(trimmed);
			}
		}
	}

	const single = env.GEMINI_API_KEY?.trim();

	if (single) {
		keys.push(single);
	}

	return [...new Set(keys)];
}

/**
 * True when a Gemini error indicates the key is rate-limited / quota-exhausted,
 * meaning we should advance to the next key rather than fail.
 */
export function isGeminiQuotaError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);

	return (
		message.includes(" 429 ") ||
		message.includes("RESOURCE_EXHAUSTED") ||
		message.includes("GenerateRequestsPerDayPerProjectPerModel") ||
		message.includes("generate_content_free_tier_requests")
	);
}

/**
 * Run `attempt` against each key in turn, advancing to the next key only when the
 * current key returns a quota error. Non-quota errors propagate immediately. If
 * every key is quota-exhausted, the last quota error is thrown so callers can
 * apply their own fallback.
 */
export async function withGeminiKeyRotation<T>(
	apiKeys: string[],
	attempt: (apiKey: string) => Promise<T>,
): Promise<T> {
	if (apiKeys.length === 0) {
		throw new Error("No Gemini API keys are configured.");
	}

	let lastError: unknown = new Error("Gemini request failed before any key was tried.");

	for (const apiKey of apiKeys) {
		try {
			return await attempt(apiKey);
		} catch (error) {
			lastError = error;

			if (isGeminiQuotaError(error)) {
				continue;
			}

			throw error;
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
