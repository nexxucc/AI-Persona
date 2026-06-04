export type HealthResponse = {
	status: "ok";
	service: "ai-persona-api";
	environment: "development" | "production";
	timestamp: string;
};
