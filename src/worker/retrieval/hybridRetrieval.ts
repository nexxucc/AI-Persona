import { searchExactEvidence } from "./exactSearch";
import { searchSemanticEvidence } from "./semanticSearch";
import type { EvidenceResult } from "./types";

export type HybridRetrievalOptions = {
	exactLimit?: number;
	semanticLimit?: number;
	finalLimit?: number;
};

const DEFAULT_EXACT_LIMIT = 8;
const DEFAULT_SEMANTIC_LIMIT = 8;
const DEFAULT_FINAL_LIMIT = 10;
const MAX_FINAL_LIMIT = 16;

export async function retrieveHybridEvidence(
	db: D1Database,
	vectorize: VectorizeIndex,
	geminiApiKey: string,
	query: string,
	options: HybridRetrievalOptions = {},
): Promise<EvidenceResult[]> {
	const finalLimit = clampFinalLimit(options.finalLimit);

	const [exactResults, semanticResults] = await Promise.all([
		searchExactEvidence(db, query, {
			limit: options.exactLimit ?? DEFAULT_EXACT_LIMIT,
		}),
		searchSemanticEvidence(db, vectorize, geminiApiKey, query, {
			limit: options.semanticLimit ?? DEFAULT_SEMANTIC_LIMIT,
		}),
	]);

	return mergeEvidenceResults(exactResults, semanticResults).slice(0, finalLimit);
}

export function mergeEvidenceResults(
	exactResults: EvidenceResult[],
	semanticResults: EvidenceResult[],
): EvidenceResult[] {
	const merged = new Map<string, EvidenceResult>();

	for (const result of semanticResults) {
		merged.set(result.chunkId, result);
	}

	for (const result of exactResults) {
		const existing = merged.get(result.chunkId);

		if (!existing) {
			merged.set(result.chunkId, result);
			continue;
		}

		merged.set(result.chunkId, {
			...existing,
			score: combineScores(result.score, existing.score),
			retrievalMode: "hybrid",
		});
	}

	return [...merged.values()].sort(compareEvidence);
}

function compareEvidence(left: EvidenceResult, right: EvidenceResult): number {
	const modeDifference = modePriority(right.retrievalMode) - modePriority(left.retrievalMode);

	if (modeDifference !== 0) {
		return modeDifference;
	}

	return normalizeScore(right.score) - normalizeScore(left.score);
}

function modePriority(mode: EvidenceResult["retrievalMode"]): number {
	if (mode === "hybrid") {
		return 3;
	}

	if (mode === "semantic") {
		return 2;
	}

	return 1;
}

function combineScores(exactScore: number, semanticScore: number): number {
	return normalizeScore(semanticScore) + 1 / (1 + Math.abs(exactScore));
}

function normalizeScore(score: number): number {
	if (!Number.isFinite(score)) {
		return 0;
	}

	return score;
}

function clampFinalLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_FINAL_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_FINAL_LIMIT);
}
