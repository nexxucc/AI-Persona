export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

export async function embedQuery(
	apiKey: string,
	query: string,
): Promise<number[]> {
	const trimmedQuery = query.trim();

	if (!trimmedQuery) {
		throw new Error("Cannot embed an empty query.");
	}

	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				content: {
					parts: [
						{
							text: buildQueryEmbeddingText(trimmedQuery),
						},
					],
				},
				outputDimensionality: EMBEDDING_DIMENSIONS,
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`Gemini embedding request failed: ${response.status} ${errorBody}`,
		);
	}

	const payload = (await response.json()) as {
		embedding?: {
			values?: number[];
		};
	};

	const values = payload.embedding?.values ?? [];

	if (values.length !== EMBEDDING_DIMENSIONS) {
		throw new Error(
			`Expected ${EMBEDDING_DIMENSIONS} embedding dimensions but received ${values.length}.`,
		);
	}

	return values;
}

function buildQueryEmbeddingText(query: string): string {
	return [
		"Represent this recruiter or interviewer question for retrieval over Vansh Jain's resume and public GitHub project evidence.",
		"",
		query,
	].join("\n");
}
