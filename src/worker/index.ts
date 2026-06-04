import { Hono } from "hono";
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

export default app;
