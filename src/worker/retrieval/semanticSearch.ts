import { embedQuery } from "../ai/embedding";
import type { EvidenceResult, EvidenceSourceType } from "./types";

type VectorMetadata = {
	chunk_id?: string;
	source_type?: EvidenceSourceType;
	repository_name?: string | null;
	file_path?: string | null;
	title?: string;
	public_url?: string;
};

type VectorizeMatch = {
	id: string;
	score: number;
	metadata?: VectorMetadata;
};

type SourceChunkRow = {
	chunk_id: string;
	document_id: string;
	title: string;
	source_type: EvidenceSourceType;
	repository_name: string | null;
	file_path: string | null;
	commit_sha: string | null;
	public_url: string;
	content: string;
};

export type SemanticSearchOptions = {
	limit?: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

export async function searchSemanticEvidence(
	db: D1Database,
	vectorize: VectorizeIndex,
	geminiApiKey: string,
	query: string,
	options: SemanticSearchOptions = {},
): Promise<EvidenceResult[]> {
	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		return [];
	}

	const limit = clampLimit(options.limit);
	const queryVector = await embedQuery(geminiApiKey, normalizedQuery);

	const vectorResults = await vectorize.query(queryVector, {
		topK: limit,
		returnMetadata: "all",
	});

	const matches = ((vectorResults.matches ?? []) as VectorizeMatch[]).filter(
		(match) => typeof match.metadata?.chunk_id === "string",
	);

	if (matches.length === 0) {
		return [];
	}

	const chunkIds = matches.map((match) => match.metadata?.chunk_id as string);
	const chunks = await fetchChunksByIds(db, chunkIds);
	const chunksById = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));

	return matches
		.map((match): EvidenceResult | null => {
			const chunkId = match.metadata?.chunk_id as string;
			const chunk = chunksById.get(chunkId);

			if (!chunk) {
				return null;
			}

			return {
				chunkId: chunk.chunk_id,
				documentId: chunk.document_id,
				title: chunk.title,
				sourceType: chunk.source_type,
				repositoryName: chunk.repository_name,
				filePath: chunk.file_path,
				commitSha: chunk.commit_sha,
				publicUrl: chunk.public_url,
				content: chunk.content,
				score: match.score,
				retrievalMode: "semantic",
			};
		})
		.filter((result): result is EvidenceResult => result !== null);
}

async function fetchChunksByIds(
	db: D1Database,
	chunkIds: string[],
): Promise<SourceChunkRow[]> {
	if (chunkIds.length === 0) {
		return [];
	}

	const placeholders = chunkIds.map(() => "?").join(", ");

	const result = await db
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
				content
			FROM source_chunks
			WHERE id IN (${placeholders})
			`,
		)
		.bind(...chunkIds)
		.all<SourceChunkRow>();

	return result.results ?? [];
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_LIMIT);
}
