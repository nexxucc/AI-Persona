import { embedQuery } from "../ai/embedding";
import type { EvidenceResult } from "./types";

export type SemanticSearchOptions = {
	limit?: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export async function searchSemanticEvidence(
	db: D1Database,
	vectorize: VectorizeIndex,
	geminiApiKeys: string[],
	query: string,
	options: SemanticSearchOptions = {},
): Promise<EvidenceResult[]> {
	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		return [];
	}

	const embedding = await embedQuery(geminiApiKeys, normalizedQuery);
	const limit = clampLimit(options.limit);

	const vectorMatches = await vectorize.query(embedding, {
		topK: limit,
		returnMetadata: true,
	});

	const chunkIds = vectorMatches.matches
		.map((match) => String(match.metadata?.chunk_id ?? ""))
		.filter(Boolean);

	if (chunkIds.length === 0) {
		return [];
	}

	const placeholders = chunkIds.map(() => "?").join(", ");
	const rows = await db
		.prepare(
			`
			SELECT
				id AS chunk_id,
				document_id,
				title,
				source_type,
				repository_name,
				file_path,
				commit_sha,
				public_url,
				content,
				source_chunks.metadata_json AS metadata
			FROM source_chunks
			WHERE source_chunks.id IN (${placeholders});
			`,
		)
		.bind(...chunkIds)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceResult["sourceType"];
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
		}>();

	const rowsByChunkId = new Map(
		rows.results.map((row) => [row.chunk_id, row]),
	);

	return vectorMatches.matches
		.map((match): EvidenceResult | null => {
			const chunkId = String(match.metadata?.chunk_id ?? "");
			const row = rowsByChunkId.get(chunkId);

			if (!row) {
				return null;
			}

			return {
				chunkId: row.chunk_id,
				documentId: row.document_id,
				title: row.title,
				sourceType: row.source_type,
				repositoryName: row.repository_name,
				filePath: row.file_path,
				commitSha: row.commit_sha,
				publicUrl: row.public_url,
				content: row.content,
				score: match.score,
				retrievalMode: "semantic",
				metadata: parseMetadata(row.metadata),
			};
		})
		.filter((result): result is EvidenceResult => result !== null);
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
	if (!value) {
		return {};
	}

	try {
		const parsedValue = JSON.parse(value);
		return parsedValue && typeof parsedValue === "object"
			? parsedValue as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}
