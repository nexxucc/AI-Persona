import { Hono } from "hono";
import type { AppBindings } from "./types/bindings";

const app = new Hono<{ Bindings: AppBindings }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

export default app;
