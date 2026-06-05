import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VECTORIZE_INDEX_NAME } from "./config.mjs";

const execFileAsync = promisify(execFile);

const inputPath = "local-data/generated/development-embeddings.json";
const ndjsonPath = "local-data/generated/development-vectorize-upsert.ndjson";

const payload = JSON.parse(await readFile(inputPath, "utf8"));

if (!Array.isArray(payload.vectors) || payload.vectors.length === 0) {
	throw new Error("No vectors found. Run npm run vector:embeddings:generate first.");
}

const ndjson = payload.vectors
	.map((vector) =>
		JSON.stringify({
			id: vector.id,
			values: vector.values,
			metadata: vector.metadata,
		}),
	)
	.join("\n");

await writeFile(ndjsonPath, `${ndjson}\n`, "utf8");

const { stdout, stderr } = await execFileAsync(
	"npx",
	["wrangler", "vectorize", "upsert", VECTORIZE_INDEX_NAME, "--file", ndjsonPath],
	{
		maxBuffer: 1024 * 1024 * 64,
	},
);

if (stdout.trim()) {
	console.log(stdout.trim());
}

if (stderr.trim()) {
	console.error(stderr.trim());
}

console.log(`Vectors submitted to Vectorize: ${payload.vectors.length}`);
console.log(`Index: ${VECTORIZE_INDEX_NAME}`);
