import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VECTORIZE_INDEX_NAME } from "./config.mjs";

const execFileAsync = promisify(execFile);

const embeddingPath = "local-data/generated/development-embeddings.json";
const payload = JSON.parse(await readFile(embeddingPath, "utf8"));

if (payload.vector_count !== 1377 || payload.dimensions !== 768) {
	throw new Error(
		`Expected 1377 vectors with 768 dimensions, received ${payload.vector_count} vectors with ${payload.dimensions} dimensions.`,
	);
}

const probes = [
	findProbe((vector) => vector.metadata?.source_type === "resume"),
	findProbe((vector) => vector.metadata?.repository_name === "AI-Persona"),
	findProbe((vector) => vector.metadata?.repository_name === "NLP-Research-Assistant"),
].filter(Boolean);

if (probes.length < 2) {
	throw new Error("Not enough representative vectors were found for the smoke test.");
}

for (const probe of probes) {
	console.log(`Probe vector: ${probe.id}`);
	console.log(`Title: ${probe.metadata.title}`);
	console.log(`Source type: ${probe.metadata.source_type}`);
	console.log(`Repository: ${probe.metadata.repository_name ?? "none"}`);

	const { stdout, stderr } = await execFileAsync(
		"npx",
		[
			"wrangler",
			"vectorize",
			"query",
			VECTORIZE_INDEX_NAME,
			"--vector-id",
			probe.id,
			"--top-k",
			"5",
			"--return-metadata",
			"all",
		],
		{
			maxBuffer: 1024 * 1024 * 16,
		},
	);

	if (stderr.trim()) {
		console.error(stderr.trim());
	}

	const output = stdout.trim();

	if (!output) {
		throw new Error(`Vectorize query returned no output for ${probe.id}.`);
	}

	console.log(output);
	console.log("");
}

console.log("Vectorize semantic smoke test completed.");

function findProbe(predicate) {
	return payload.vectors.find(predicate) ?? null;
}
