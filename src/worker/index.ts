import { Hono } from "hono";
import { generateGroundedAnswer } from "./chat/groundedAnswer";
import { retrieveHybridEvidence } from "./retrieval/hybridRetrieval";
import type { HealthResponse } from "../shared/types/health";
import type { AppBindings } from "./types/bindings";

const app = new Hono<{ Bindings: AppBindings }>();

app.get("/api/health", (c) => {
	const response: HealthResponse = {
		status: "ok",
		service: "ai-persona-api",
		environment: c.env?.APP_ENV ?? "development",
		timestamp: new Date().toISOString(),
	};

	return c.json(response);
});


app.post("/api/retrieval/search", async (c) => {
	const body = await c.req.json<{ query?: string }>().catch(() => null);
	const query = body?.query?.trim();

	if (!query) {
		return c.json({ error: "A non-empty query is required." }, 400);
	}

	const evidence = await retrieveHybridEvidence(
		c.env.DB,
		c.env.VECTORIZE,
		c.env.GEMINI_API_KEY,
		query,
	);

	return c.json({
		query,
		evidence,
	});
});


app.post("/api/chat", async (c) => {
	const body = await c.req.json<{ message?: string }>().catch(() => null);
	const message = body?.message?.trim();

	if (!message) {
		return c.json({ error: "A non-empty message is required." }, 400);
	}

	const evidence = await retrieveHybridEvidence(
		c.env.DB,
		c.env.VECTORIZE,
		c.env.GEMINI_API_KEY,
		message,
		{
			finalLimit: 8,
		},
	);

	const groundedAnswer = await generateGroundedAnswer(
		c.env.GEMINI_API_KEY,
		message,
		evidence,
	);

	return c.json({
		answer: groundedAnswer.answer,
		supported: groundedAnswer.supported,
		model: groundedAnswer.model,
		citations: groundedAnswer.citations,
		evidence,
	});
});

export default app;
