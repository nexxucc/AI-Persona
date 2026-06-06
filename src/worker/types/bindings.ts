/**
 * Runtime bindings supplied to the Cloudflare Worker.
 *
 * Resource bindings such as D1 and Vectorize are generated into `Env` from
 * `wrangler.json`. Secrets are configured through `.dev.vars` locally and
 * Worker secrets in deployed environments.
 */
export type AppBindings = Env & {
	APP_ENV: "development" | "production";

	GEMINI_API_KEY: string;
	/** Optional comma-separated list of additional Gemini keys for quota rotation. */
	GEMINI_API_KEYS?: string;

	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	GOOGLE_REFRESH_TOKEN: string;
	GOOGLE_BOOKINGS_CALENDAR_ID: string;
	GOOGLE_AVAILABILITY_CALENDAR_IDS: string;
	GOOGLE_DEFAULT_TIMEZONE: string;

	VAPI_WEBHOOK_SECRET: string;
};
