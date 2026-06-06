-- Durable per-conversation booking state for the chat interface.
-- Cloudflare Workers are stateless across isolates, so the previously used
-- in-memory Map dropped pending availability between requests. This table holds
-- the proposed slots (and any booking awaiting email confirmation) keyed by the
-- client-supplied conversation id. Rows are expired in code via created_at.
CREATE TABLE chat_sessions (
	conversation_id TEXT PRIMARY KEY NOT NULL,
	state_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
