// Grounded-chat evaluation harness.
// Sends the golden Q&A set to a deployed worker's /api/chat, then scores
// groundedness, hallucination, retrieval recall/precision, latency and the
// LLM-fallback rate. Deterministic (manual-labelled golden set) and repeatable.
//
// Usage:
//   BASE_URL="https://ai-persona.vanshjain05.workers.dev" \
//   node scripts/eval/run-chat-eval.mjs
import { goldenSet } from "./golden-set.mjs";

const baseUrl = (process.env.BASE_URL || "https://ai-persona.vanshjain05.workers.dev").replace(/\/$/, "");
const refusalMarkers = [
	"do not have",
	"don't have",
	"not enough",
	"does not verify",
	"cannot answer",
	"no evidence",
	"not verify",
	"could not find",
	"do not know",
];

function includesAny(haystack, needles) {
	const lower = haystack.toLowerCase();
	return needles.some((n) => lower.includes(n.toLowerCase()));
}

function sourceMatches(citations, expectSource) {
	if (!expectSource) return false;
	const key = expectSource.toLowerCase();
	if (key === "resume") {
		return citations.some((c) => (c.sourceType || "").toLowerCase() === "resume");
	}
	return citations.some((c) =>
		[c.repositoryName, c.title, c.publicUrl]
			.filter(Boolean)
			.some((field) => field.toLowerCase().replace(/[^a-z0-9]/g, "").includes(key.replace(/[^a-z0-9]/g, ""))),
	);
}

async function ask(question, conversationId) {
	const start = Date.now();
	const response = await fetch(`${baseUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: question, conversationId }),
	});
	const latencyMs = Date.now() - start;
	const payload = await response.json();
	return { latencyMs, status: response.status, payload };
}

const results = [];

for (const item of goldenSet) {
	const { latencyMs, status, payload } = await ask(item.question, `eval-${item.id}-${Date.now()}`);
	const answer = payload.answer || "";
	const citations = payload.citations || [];
	const model = payload.model || "unknown";
	const isFallback = model.includes("evidence-fallback");
	const refused = includesAny(answer, refusalMarkers);

	let grounded;
	let hallucinated = false;
	let retrievalHit = null;
	let relevantCitations = 0;

	if (item.type === "adversarial") {
		hallucinated = includesAny(answer, item.forbidden);
		grounded = !hallucinated; // refusing or staying grounded both count
	} else {
		retrievalHit = sourceMatches(citations, item.expectSource);
		relevantCitations = citations.filter((c) =>
			sourceMatches([c], item.expectSource) ? 1 : 0,
		).length;
		const factPresent = includesAny(answer, item.expectAnyFact);
		grounded = factPresent && !refused;
		// A confident answer that lacks every expected fact and is not a refusal
		// is treated as an unsupported/incorrect answer (potential hallucination).
		hallucinated = !factPresent && !refused;
	}

	results.push({
		id: item.id,
		type: item.type,
		status,
		model,
		isFallback,
		latencyMs,
		grounded,
		hallucinated,
		refused,
		retrievalHit,
		relevantCitations,
		totalCitations: citations.length,
		answerPreview: answer.slice(0, 120),
	});

	console.log(
		`${grounded ? "PASS" : "FAIL"} [${item.type[0]}] ${item.id} | ${latencyMs}ms | ${model}${item.type === "factual" ? ` | retr:${retrievalHit ? "hit" : "miss"}` : ""}`,
	);
}

const factual = results.filter((r) => r.type === "factual");
const adversarial = results.filter((r) => r.type === "adversarial");
const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];

const retrievalHits = factual.filter((r) => r.retrievalHit).length;
const totalRelevantCitations = factual.reduce((s, r) => s + r.relevantCitations, 0);
const totalCitations = factual.reduce((s, r) => s + r.totalCitations, 0);
const hallucinations = results.filter((r) => r.hallucinated).length;

const summary = {
	baseUrl,
	totalQuestions: results.length,
	factualQuestions: factual.length,
	adversarialQuestions: adversarial.length,
	groundednessRate: +(results.filter((r) => r.grounded).length / results.length).toFixed(3),
	hallucinationRate: +(hallucinations / results.length).toFixed(3),
	adversarialRefusalRate: +(adversarial.filter((r) => !r.hallucinated).length / adversarial.length).toFixed(3),
	retrievalRecallAt5: +(retrievalHits / factual.length).toFixed(3),
	retrievalPrecisionApprox: totalCitations ? +(totalRelevantCitations / totalCitations).toFixed(3) : 0,
	llmFallbackRate: +(results.filter((r) => r.isFallback).length / results.length).toFixed(3),
	latencyMs: { p50: p(latencies, 0.5), p95: p(latencies, 0.95), max: latencies[latencies.length - 1] },
};

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(summary, null, 2));

const fs = await import("node:fs/promises");
await fs.mkdir("eval-results", { recursive: true });
await fs.writeFile(
	"eval-results/chat-eval.json",
	JSON.stringify({ summary, results }, null, 2),
);
console.log("\nWrote eval-results/chat-eval.json");
