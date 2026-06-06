import { Hono } from "hono";
import { getGeminiApiKeys } from "./ai/geminiKeys";
import { getAvailability, bookCalendarEvent } from "./calendar/googleCalendar";
import { handleCalendarChatMessage } from "./chat/calendarIntent";
import { generateGroundedAnswer } from "./chat/groundedAnswer";
import { retrieveHybridEvidence } from "./retrieval/hybridRetrieval";
import { handleVapiToolCalls, isAuthorizedVapiRequest } from "./voice/vapi";
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
		getGeminiApiKeys(c.env),
		query,
	);

	return c.json({
		query,
		evidence,
	});
});



app.post("/api/calendar/availability", async (c) => {
	const body = await c.req.json().catch(() => ({}));

	try {
		const availability = await getAvailability(c.env, body);
		return c.json(availability);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return c.json({ error: message }, 500);
	}
});

app.post("/api/calendar/book", async (c) => {
	const body = await c.req.json().catch(() => ({}));

	try {
		const booking = await bookCalendarEvent(c.env, body);
		return c.json(booking);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return c.json({ error: message }, 400);
	}
});


app.post("/api/vapi/tools", async (c) => {
	if (!isAuthorizedVapiRequest(c.env, c.req.raw)) {
		return c.json({ error: "Unauthorized Vapi tool request." }, 401);
	}

	const body = await c.req.json().catch(() => null);

	if (!body) {
		return c.json({ error: "Invalid Vapi tool payload." }, 400);
	}

	const response = await handleVapiToolCalls(c.env, body);

	return c.json(response);
});

app.post("/api/chat", async (c) => {
	const body = await c.req.json<{ message?: string; conversationId?: string }>().catch(() => null);
	const message = body?.message?.trim();

	if (!message) {
		return c.json({ error: "A non-empty message is required." }, 400);
	}

	const calendarResponse = await handleCalendarChatMessage(
		c.env,
		message,
		body?.conversationId,
	);

	if (calendarResponse) {
		return c.json(calendarResponse);
	}

	const geminiApiKeys = getGeminiApiKeys(c.env);

	const evidence = await retrieveHybridEvidence(
		c.env.DB,
		c.env.VECTORIZE,
		geminiApiKeys,
		message,
		{
			finalLimit: 5,
		},
	);

	const groundedAnswer = await generateGroundedAnswer(
		geminiApiKeys,
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
