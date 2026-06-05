import { GoogleGenAI } from "@google/genai";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	EMBEDDING_BATCH_SIZE,
	EMBEDDING_DIMENSIONS,
	EMBEDDING_MODEL,
	EMBEDDING_REQUEST_DELAY_MS,
} from "./config.mjs";

const inputPath = "local-data/generated/development-chunks.json";
const outputPath = "local-data/generated/development-embeddings.json";

const apiKey = process.env.GEMINI_API_KEY?.trim();

if (!apiKey) {
	throw new Error("GEMINI_API_KEY is required in the current shell.");
}

const chunks = JSON.parse(await readFile(inputPath, "utf8"));

if (!Array.isArray(chunks) || chunks.length === 0) {
	throw new Error("No chunks found. Run npm run vector:chunks:export first.");
}

const ai = new GoogleGenAI({ apiKey });
const vectors = await loadExistingVectors();
const completedVectorIds = new Set(vectors.map((vector) => vector.id));

console.log(`Chunks to embed: ${chunks.length}`);
console.log(`Existing vectors found: ${vectors.length}`);

for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
	const batch = chunks
		.slice(index, index + EMBEDDING_BATCH_SIZE)
		.filter((chunk) => !completedVectorIds.has(chunk.vector_id));

	if (batch.length === 0) {
		console.log(
			`Skipped ${Math.min(index + EMBEDDING_BATCH_SIZE, chunks.length)} of ${chunks.length} chunks.`,
		);
		continue;
	}

	const embeddings = await embedBatchWithRetry(batch);

	if (embeddings.length !== batch.length) {
		throw new Error(
			`Expected ${batch.length} embeddings but received ${embeddings.length}.`,
		);
	}

	for (const [batchIndex, embedding] of embeddings.entries()) {
		const values = embedding.values ?? [];
		const chunk = batch[batchIndex];

		if (values.length !== EMBEDDING_DIMENSIONS) {
			throw new Error(
				`Embedding dimension mismatch for ${chunk.id}. Expected ${EMBEDDING_DIMENSIONS}, received ${values.length}.`,
			);
		}

		vectors.push({
			id: chunk.vector_id,
			values,
			metadata: {
				chunk_id: chunk.id,
				source_type: chunk.source_type,
				repository_name: chunk.repository_name,
				file_path: chunk.file_path,
				title: chunk.title,
				public_url: chunk.public_url,
			},
		});

		completedVectorIds.add(chunk.vector_id);
	}

	await writeEmbeddingFile(vectors);

	console.log(
		`Embedded ${completedVectorIds.size} of ${chunks.length} chunks.`,
	);

	if (completedVectorIds.size < chunks.length) {
		await sleep(EMBEDDING_REQUEST_DELAY_MS);
	}
}

await writeEmbeddingFile(vectors);

console.log(`Embeddings generated: ${vectors.length}`);
console.log(`Output written to: ${outputPath}`);

async function embedBatchWithRetry(batch) {
	for (;;) {
		try {
			const response = await ai.models.embedContent({
				model: EMBEDDING_MODEL,
				contents: batch.map((chunk) => ({
					parts: [{ text: buildEmbeddingText(chunk) }],
				})),
				config: {
					outputDimensionality: EMBEDDING_DIMENSIONS,
				},
			});

			return response.embeddings ?? [];
		} catch (error) {
			const retryDelayMs = getRetryDelayMs(error);

			if (retryDelayMs === null) {
				throw error;
			}

			console.log(
				`Gemini embedding quota reached. Retrying in ${Math.ceil(retryDelayMs / 1000)} seconds.`,
			);
			await sleep(retryDelayMs);
		}
	}
}

async function loadExistingVectors() {
	if (!existsSync(outputPath)) {
		return [];
	}

	const payload = JSON.parse(await readFile(outputPath, "utf8"));

	if (
		payload.model !== EMBEDDING_MODEL ||
		payload.dimensions !== EMBEDDING_DIMENSIONS ||
		!Array.isArray(payload.vectors)
	) {
		throw new Error(
			"Existing embedding file does not match the configured model or dimensions. Remove it before regenerating.",
		);
	}

	return payload.vectors;
}

async function writeEmbeddingFile(vectorsToWrite) {
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(
		outputPath,
		`${JSON.stringify(
			{
				model: EMBEDDING_MODEL,
				dimensions: EMBEDDING_DIMENSIONS,
				vector_count: vectorsToWrite.length,
				vectors: vectorsToWrite,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function buildEmbeddingText(chunk) {
	const fields = [
		`Title: ${chunk.title}`,
		chunk.source_type ? `Source type: ${chunk.source_type}` : null,
		chunk.repository_name ? `Repository: ${chunk.repository_name}` : null,
		chunk.file_path ? `File path: ${chunk.file_path}` : null,
		"",
		chunk.content,
	];

	return fields.filter((value) => value !== null).join("\n");
}

function getRetryDelayMs(error) {
	const message = error instanceof Error ? error.message : String(error);
	const retryMatch = message.match(/retryDelay":"(\d+)s"/);

	if (retryMatch) {
		return (Number(retryMatch[1]) + 5) * 1000;
	}

	if (message.includes('"code":429') || message.includes("RESOURCE_EXHAUSTED")) {
		return 65000;
	}

	return null;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
