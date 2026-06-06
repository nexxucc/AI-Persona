import { getGeminiApiKeys, isGeminiQuotaError, withGeminiKeyRotation } from "../ai/geminiKeys";
import { bookCalendarEvent, getAvailability } from "../calendar/googleCalendar";
import { retrieveHybridEvidence } from "../retrieval/hybridRetrieval";
import type { AvailabilitySlot } from "../calendar/types";
import type { EvidenceResult, EvidenceSourceType } from "../retrieval/types";
import type { AppBindings } from "../types/bindings";

type VapiToolCallResponse = {
	results: Array<{
		toolCallId: string;
		result: unknown;
	}>;
};

type ToolCall = {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

type GeminiGenerateContentResponse = {
	candidates?: Array<{
		content?: {
			parts?: Array<{
				text?: string;
			}>;
		};
	}>;
	error?: {
		message?: string;
	};
};

const VOICE_ANSWER_MODEL = "gemini-2.5-flash";
const VOICE_GENERATION_ATTEMPTS = 2;
const VOICE_RETRY_DELAY_MS = 1500;

export async function handleVapiToolCalls(
	env: AppBindings,
	body: unknown,
): Promise<VapiToolCallResponse> {
	const toolCalls = extractToolCalls(body);

	const results = await Promise.all(
		toolCalls.map(async (toolCall) => ({
			toolCallId: toolCall.id,
			result: await executeToolCall(env, toolCall),
		})),
	);

	return { results };
}

export function isAuthorizedVapiRequest(
	env: AppBindings,
	request: Request,
): boolean {
	const configuredSecret = env.VAPI_WEBHOOK_SECRET?.trim();

	if (!configuredSecret && env.APP_ENV === "development") {
		return true;
	}

	if (!configuredSecret) {
		return false;
	}

	const authorization = request.headers.get("authorization")?.trim() ?? "";
	const bearerToken = authorization.toLowerCase().startsWith("bearer ")
		? authorization.slice("bearer ".length).trim()
		: "";

	const explicitSecret = request.headers.get("x-vapi-secret")?.trim() ?? "";

	return bearerToken === configuredSecret || explicitSecret === configuredSecret;
}

async function executeToolCall(
	env: AppBindings,
	toolCall: ToolCall,
): Promise<unknown> {
	try {
		switch (toolCall.name) {
			case "answer_question":
				return answerQuestion(env, toolCall.arguments);
			case "get_availability":
				return getVoiceAvailability(env, toolCall.arguments);
			case "book_call":
				return bookVoiceCall(env, toolCall.arguments);
			default:
				return `I do not know how to run the tool "${toolCall.name}".`;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `I could not complete that action: ${message}`;
	}
}

async function answerQuestion(
	env: AppBindings,
	args: Record<string, unknown>,
): Promise<string> {
	const question =
		asString(args.question) ??
		asString(args.query) ??
		asString(args.message) ??
		"";

	if (!question.trim()) {
		return "I need a question to answer.";
	}

	const evidence = await retrieveVoiceEvidence(env, question);
	const generationQuestion = buildVoiceGenerationQuestion(question);

	return generateVoiceGroundedAnswer(
		getGeminiApiKeys(env),
		generationQuestion,
		evidence,
		question,
	);
}

async function generateVoiceGroundedAnswer(
	apiKeys: string[],
	question: string,
	evidence: EvidenceResult[],
	originalQuestion: string,
): Promise<string> {
	const evidenceText = formatVoiceEvidence(evidence, 4200);

	if (!evidenceText) {
		return "I do not have enough retrieved evidence to answer that reliably.";
	}

	const answer = await requestVoiceAnswer(apiKeys, question, evidenceText);

	if (isUsableVoiceAnswer(answer)) {
		return sanitizeVoiceAnswer(answer);
	}

	return sanitizeVoiceAnswer(createVoiceEvidenceFallback(originalQuestion, evidence));
}

async function requestVoiceAnswer(
	apiKeys: string[],
	question: string,
	evidenceText: string,
): Promise<string | null> {
	const prompt = [
		"You are generating a short spoken answer for Vansh Jain's AI representative.",
		"Use only the evidence below.",
		"Speak in third person: say Vansh, he, or his.",
		"Do not use I, me, my, or mine when referring to Vansh.",
		"Do not mention citations, chunk IDs, source titles, or internal retrieval details.",
		"Return one complete paragraph of 3 to 5 complete sentences.",
		"The answer must be complete and must not stop mid-sentence.",
		"Begin directly with the answer. Do not add markdown bullets.",
		"If the evidence is not enough, say that the available evidence does not verify the answer reliably.",
		"",
		"Question:",
		question,
		"",
		"Evidence:",
		evidenceText,
	].join("\n");

	try {
		return await withGeminiKeyRotation(apiKeys, (apiKey) =>
			requestVoiceAnswerWithRetry(apiKey, prompt),
		);
	} catch {
		return null;
	}
}

async function requestVoiceAnswerWithRetry(
	apiKey: string,
	prompt: string,
): Promise<string | null> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= VOICE_GENERATION_ATTEMPTS; attempt += 1) {
		try {
			return await requestVoiceAnswerOnce(apiKey, prompt);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (isGeminiQuotaError(lastError)) {
				throw lastError;
			}

			if (!isRetryableVoiceError(lastError) || attempt === VOICE_GENERATION_ATTEMPTS) {
				throw lastError;
			}

			await voiceSleep(VOICE_RETRY_DELAY_MS * attempt);
		}
	}

	throw lastError ?? new Error("Gemini voice answer request failed.");
}

async function requestVoiceAnswerOnce(
	apiKey: string,
	prompt: string,
): Promise<string | null> {
	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${VOICE_ANSWER_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{
								text: prompt,
							},
						],
					},
				],
				generationConfig: {
					temperature: 0.15,
					topP: 0.8,
					maxOutputTokens: 512,
					thinkingConfig: {
						thinkingBudget: 0,
					},
				},
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`Gemini voice answer request failed: ${response.status} ${errorBody}`,
		);
	}

	const data = (await response.json()) as GeminiGenerateContentResponse;
	const answer = data.candidates?.[0]?.content?.parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();

	return answer || null;
}

function isRetryableVoiceError(error: Error): boolean {
	return (
		error.message.includes(" 500 ") ||
		error.message.includes(" 502 ") ||
		error.message.includes(" 503 ") ||
		error.message.includes(" 504 ") ||
		error.message.includes("UNAVAILABLE")
	);
}

function voiceSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUsableVoiceAnswer(answer: string | null): answer is string {
	if (!answer) {
		return false;
	}

	const normalized = answer.replace(/\s+/g, " ").trim();

	if (normalized.length < 80) {
		return false;
	}

	if (!/[.!?]$/.test(normalized)) {
		return false;
	}

	return !/\b(for|and|or|with|because|including|using|such as|as|to|in|at|by)$/i.test(
		normalized,
	);
}

function formatVoiceEvidence(evidence: EvidenceResult[], maxCharacters: number): string {
	const selectedLines: string[] = [];
	let usedCharacters = 0;

	for (const item of evidence.slice(0, 10)) {
		const sourceParts = [
			item.title,
			item.sourceType,
			item.repositoryName ? `repository: ${item.repositoryName}` : "",
			item.filePath ? `file: ${item.filePath}` : "",
		].filter(Boolean);

		const content = item.content.replace(/\s+/g, " ").trim();

		if (!content) {
			continue;
		}

		const remainingCharacters = maxCharacters - usedCharacters;

		if (remainingCharacters <= 0) {
			break;
		}

		const clippedContent = shortenAtNaturalBoundary(
			content,
			Math.min(850, remainingCharacters),
		);
		const line = `Source: ${sourceParts.join(" | ")}\nContent: ${clippedContent}`;

		selectedLines.push(line);
		usedCharacters += line.length;
	}

	return selectedLines.join("\n\n").trim();
}

async function retrieveVoiceEvidence(
	env: AppBindings,
	question: string,
): Promise<EvidenceResult[]> {
	const normalizedQuestion = question.toLowerCase();

	if (isRoleFitOrBackgroundQuestion(normalizedQuestion)) {
		const roleFitQuery = [
			question,
			"resume education internships work experience skills AI machine learning software engineering projects role fit technical background",
			"evidence from resume, GitHub repositories, project summaries, README files, implementation details, and commit metadata",
		].join("\n");

		const [resumeEvidence, broadProfileEvidence] = await Promise.all([
			fetchResumeEvidence(env, 8),
			retrieveHybridEvidence(
				env.DB,
				env.VECTORIZE,
				getGeminiApiKeys(env),
				roleFitQuery,
				{
					finalLimit: 8,
				},
			),
		]);

		return mergeEvidenceResults([
			...resumeEvidence,
			...broadProfileEvidence,
		]).slice(0, 12);
	}

	const baseEvidence = await retrieveHybridEvidence(
		env.DB,
		env.VECTORIZE,
		getGeminiApiKeys(env),
		buildVoiceRetrievalQuery(question),
		{
			finalLimit: isProjectQuestion(normalizedQuestion) || isCommitHistoryQuestion(normalizedQuestion) ? 10 : 8,
		},
	);

	if (isCommitHistoryQuestion(normalizedQuestion)) {
		let repositoryName = selectBestRepositoryName(question, baseEvidence);

		if (!repositoryName) {
			repositoryName = await findRepositoryNameByQuestion(env, question);
		}

		const commitEvidence = repositoryName
			? await fetchCommitEvidenceByRepositoryNames(
					env,
					[repositoryName],
					14,
				)
			: [];

		const directCommitEvidence =
			commitEvidence.length > 0
				? []
				: await fetchCommitEvidenceByQuestion(env, question, 14);

		if (!repositoryName && directCommitEvidence.length === 0) {
			return baseEvidence.slice(0, 4);
		}

		return mergeEvidenceResults([
			...commitEvidence,
			...directCommitEvidence,
			...(repositoryName ? filterEvidenceByRepository(baseEvidence, repositoryName) : []),
		]).slice(0, 14);
	}

	if (isProjectQuestion(normalizedQuestion)) {
		let repositoryName = selectBestRepositoryName(question, baseEvidence);

		if (!repositoryName) {
			repositoryName = await findRepositoryNameByQuestion(env, question);
		}

		if (!repositoryName) {
			return baseEvidence.slice(0, 4);
		}

		const relatedRepositoryEvidence = await fetchRepositoryEvidenceByNames(
			env,
			[repositoryName],
			14,
		);

		return mergeEvidenceResults([
			...filterEvidenceByRepository(baseEvidence, repositoryName),
			...relatedRepositoryEvidence,
		]).slice(0, 14);
	}

	return baseEvidence;
}



function buildVoiceGenerationQuestion(question: string): string {
	const normalizedQuestion = question.toLowerCase();

	if (isCommitHistoryQuestion(normalizedQuestion)) {
		return [
			question,
			"",
			"Answer as Vansh Jain's AI representative, not as Vansh himself.",
			"Use third person. Say Vansh, he, or his.",
			"Use only the provided commit or repository evidence.",
			"Focus specifically on commit history, repository evolution, changed files, implementation changes, and development progress when that evidence exists.",
			"If commit-specific evidence is not present, clearly say that the retrieved evidence does not include specific commit-history details.",
			"Keep the answer voice-friendly: 3 to 5 complete sentences, no markdown bullets.",
		].join("\n");
	}

	if (isProjectQuestion(normalizedQuestion)) {
		return [
			question,
			"",
			"Answer as Vansh Jain's AI representative, not as Vansh himself.",
			"Use third person. Say Vansh, he, or his.",
			"Use only the provided project evidence.",
			"Cover purpose, tech stack, implementation detail, evaluation, design tradeoff, or improvement area when available.",
			"Keep the answer voice-friendly: 3 to 5 complete sentences, no markdown bullets.",
		].join("\n");
	}

	if (isRoleFitOrBackgroundQuestion(normalizedQuestion)) {
		return [
			"Explain why Vansh Jain is a strong fit for an AI/software engineering role, based only on the provided evidence.",
			"The caller did not provide a specific job description, so do not reject the answer because exact role requirements are missing.",
			"",
			"Answer as Vansh Jain's AI representative, not as Vansh himself.",
			"Use third person. Say Vansh, he, or his.",
			"Use only the provided evidence.",
			"Prioritize resume, education, internships, skills, and strong project evidence when available.",
			"Keep the answer voice-friendly: 3 to 5 complete sentences, no markdown bullets.",
			"Do not invent requirements, employers, achievements, or metrics that are not supported by the evidence.",
		].join("\n");
	}

	return [
		question,
		"",
		"Answer as Vansh Jain's AI representative, not as Vansh himself.",
		"Use third person. Say Vansh, he, or his.",
		"Use only the provided evidence.",
		"Keep the answer voice-friendly: 3 to 5 complete sentences, no markdown bullets.",
	].join("\n");
}

async function fetchResumeEvidence(
	env: AppBindings,
	limit: number,
): Promise<EvidenceResult[]> {
	const rows = await env.DB
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
				metadata_json AS metadata
			FROM source_chunks
			WHERE source_type = 'resume'
			ORDER BY chunk_index ASC
			LIMIT ?
			`,
		)
		.bind(limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceSourceType;
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
		}>();

	return (rows.results ?? []).map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 100 - index,
		retrievalMode: "exact",
		metadata: parseMetadata(row.metadata),
	}));
}

async function fetchRepositoryEvidenceByNames(
	env: AppBindings,
	repositoryNames: string[],
	limit: number,
): Promise<EvidenceResult[]> {
	if (repositoryNames.length === 0) {
		return [];
	}

	const placeholders = repositoryNames.map(() => "?").join(", ");

	const rows = await env.DB
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
				metadata_json AS metadata
			FROM source_chunks
			WHERE repository_name IN (${placeholders})
			ORDER BY
				CASE
					WHEN lower(title) LIKE '%readme%' THEN 0
					WHEN lower(file_path) LIKE '%readme%' THEN 1
					WHEN lower(source_type) LIKE '%manifest%' THEN 2
					WHEN lower(source_type) LIKE '%repository%' THEN 3
					WHEN lower(title) LIKE '%commit%' THEN 4
					ELSE 5
				END,
				chunk_index ASC
			LIMIT ?
			`,
		)
		.bind(...repositoryNames, limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceSourceType;
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
		}>();

	return (rows.results ?? []).map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 80 - index,
		retrievalMode: "exact",
		metadata: parseMetadata(row.metadata),
	}));
}

async function fetchCommitEvidenceByRepositoryNames(
	env: AppBindings,
	repositoryNames: string[],
	limit: number,
): Promise<EvidenceResult[]> {
	if (repositoryNames.length === 0) {
		return [];
	}

	const placeholders = repositoryNames.map(() => "?").join(", ");

	const rows = await env.DB
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
				metadata_json AS metadata
			FROM source_chunks
			WHERE repository_name IN (${placeholders})
				AND (
					lower(source_type) LIKE '%commit%'
					OR lower(title) LIKE '%commit%'
					OR lower(file_path) LIKE '%commit%'
					OR lower(content) LIKE '%commit%'
					OR commit_sha IS NOT NULL
				)
			ORDER BY
				CASE
					WHEN lower(title) LIKE '%commit%' THEN 0
					WHEN lower(source_type) LIKE '%commit%' THEN 1
					WHEN commit_sha IS NOT NULL THEN 2
					ELSE 3
				END,
				chunk_index ASC,
				id ASC
			LIMIT ?
			`,
		)
		.bind(...repositoryNames, limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceSourceType;
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
		}>();

	return (rows.results ?? []).map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 90 - index,
		retrievalMode: "exact",
		metadata: parseMetadata(row.metadata),
	}));
}

async function getVoiceAvailability(
	env: AppBindings,
	args: Record<string, unknown>,
): Promise<{
	message: string;
	speechText: string;
	slots: Array<{
		option: number;
		label: string;
		spokenLabel: string;
		startTime: string;
		endTime: string;
		timezone: string;
	}>;
}> {
	const availability = await getAvailability(env, {
		days: asNumber(args.days) ?? 7,
		durationMinutes: asNumber(args.durationMinutes) ?? 30,
		timezone: asString(args.timezone) ?? env.GOOGLE_DEFAULT_TIMEZONE ?? "Asia/Kolkata",
	});

	const proposedSlots = selectPrivacyPreservingSlots(availability.slots);

	const slots = proposedSlots.map((slot, index) => ({
		option: index + 1,
		label: slot.label,
		spokenLabel: `Option ${index + 1}: ${slot.label.replace(" - ", " to ")} IST`,
		startTime: slot.startTime,
		endTime: slot.endTime,
		timezone: slot.timezone,
	}));

	return {
		message:
			slots.length > 0
				? "Read speechText exactly. Do not reorder, shorten, or paraphrase the slots."
				: "I could not find any available 30-minute slots in the next few days.",
		speechText:
			slots.length > 0
				? `I found these available options. ${slots
						.map((slot) => slot.spokenLabel)
						.join(". ")}. Which option works best for you?`
				: "I could not find any available 30-minute slots in the next few days.",
		slots,
	};
}

async function bookVoiceCall(
	env: AppBindings,
	args: Record<string, unknown>,
): Promise<string> {
	const startTime = asString(args.startTime);
	const endTime = asString(args.endTime);
	const timezone = asString(args.timezone) ?? env.GOOGLE_DEFAULT_TIMEZONE ?? "Asia/Kolkata";
	const guestName = asString(args.guestName) ?? "Guest";
	const guestEmail = asString(args.guestEmail);
	const emailConfirmed = args.emailConfirmed === true;

	if (!startTime || !endTime) {
		return "I need the selected start time and end time before I can book the call.";
	}

	if (!guestEmail || !isValidEmail(guestEmail)) {
		return "I need a valid email address before I can send the calendar invite. Please ask the caller to spell it clearly.";
	}

	if (!emailConfirmed) {
		return `Before booking, ask the caller to confirm this email exactly: ${formatEmailForSpeech(
			guestEmail,
		)}. Ask: Is that correct? Do not book until the caller confirms.`;
	}

	const booking = await bookCalendarEvent(env, {
		startTime,
		endTime,
		timezone,
		guestName,
		guestEmail,
		notes: "Booked from the Vapi voice agent.",
	});

	return `Confirmed. The call is booked for ${formatSlotLabel(
		booking.startTime,
		booking.endTime,
		booking.timezone,
	)}. The calendar invite has been sent.`;
}

function createVoiceEvidenceFallback(
	question: string,
	evidence: EvidenceResult[],
): string {
	const normalizedQuestion = question.toLowerCase();

	if (isCommitHistoryQuestion(normalizedQuestion)) {
		const scopedEvidence = getQuestionScopedProjectEvidence(question, evidence);
		const commitScopedEvidence = scopedEvidence.length > 0 ? scopedEvidence : evidence;
		const projectTitle = toSpokenProjectName(getBestEvidenceTitle(commitScopedEvidence));
		const commitHighlights = selectCommitEvidenceHighlights(commitScopedEvidence, 4);

		if (commitHighlights.length > 0) {
			return [
				`For ${projectTitle}, the retrieved commit evidence points to ${ensureSentence(toSentenceFragment(commitHighlights[0]))}`,
				commitHighlights[1] ? `It also shows ${ensureSentence(toSentenceFragment(commitHighlights[1]))}` : "",
				commitHighlights[2] ? `Another commit-level detail is ${ensureSentence(toSentenceFragment(commitHighlights[2]))}` : "",
			]
				.filter(Boolean)
				.join(" ");
		}

		return "I do not have reliable commit-history evidence for that project in the retrieved sources, so I should not guess.";
	}

	if (isProjectQuestion(normalizedQuestion)) {
		const scopedEvidence = getQuestionScopedProjectEvidence(question, evidence);
		const projectTitle = toSpokenProjectName(getBestEvidenceTitle(scopedEvidence));

		if (!hasStrongProjectMatch(question, scopedEvidence)) {
			return "I do not have enough reliable retrieved evidence to identify that project, so I should not guess or combine it with another portfolio item.";
		}

		const highlights = selectVoiceEvidenceHighlights(scopedEvidence, 4);

		if (highlights.length >= 2) {
			return [
				`Based on the retrieved project evidence, ${projectTitle} is described as ${ensureSentence(toSentenceFragment(highlights[0]))}`,
				`It includes ${ensureSentence(toSentenceFragment(highlights[1]))}`,
				highlights[2] ? `A relevant implementation or evaluation detail is ${ensureSentence(toSentenceFragment(highlights[2]))}` : "",
				highlights[3] ? `Another useful detail is ${ensureSentence(toSentenceFragment(highlights[3]))}` : "",
			]
				.filter(Boolean)
				.join(" ");
		}

		if (highlights.length === 1) {
			return `Based on the retrieved project evidence, ${projectTitle} is described as ${ensureSentence(toSentenceFragment(highlights[0]))}`;
		}

		return `I found retrieved evidence for ${projectTitle}, but I do not have enough detail to summarize it reliably.`;
	}

	const highlights = selectVoiceEvidenceHighlights(evidence, 4);

	if (highlights.length >= 2) {
		return [
			"Vansh appears to be a strong fit for an AI or software engineering role based on the retrieved resume and project evidence.",
			`The evidence highlights ${ensureSentence(highlights[0])}`,
			`It also mentions ${ensureSentence(highlights[1])}`,
			highlights[2] ? `Another relevant point is ${ensureSentence(highlights[2])}` : "",
			"Together, this shows practical experience across software implementation, applied AI, and machine learning work.",
		]
			.filter(Boolean)
			.join(" ");
	}

	if (highlights.length === 1) {
		return [
			"Vansh appears relevant for an AI or software engineering role based on the retrieved evidence.",
			`The evidence highlights ${ensureSentence(highlights[0])}`,
			"I would avoid adding more detail unless more supporting evidence is retrieved.",
		].join(" ");
	}

	return "I found some relevant evidence for this, but I cannot answer it reliably right now.";
}



function selectVoiceEvidenceHighlights(
	evidence: EvidenceResult[],
	limit: number,
): string[] {
	const highlights: string[] = [];
	const seen = new Set<string>();

	const keywordPattern =
		/\b(built|developed|engineered|implemented|integrated|created|worked|experience|intern|project|ai|ml|machine learning|software|pipeline|system|application|model|evaluation|testing|debugging|frontend|backend|feature|architecture|framework|indicator|diagnostic|commit|metadata|changed|updated|added|removed|refactor)\b/i;

	for (const item of evidence) {
		const candidates = item.content
			.split(/\n|(?<=\.)\s+/)
			.map(cleanVoiceHighlight)
			.filter(Boolean);

		for (const candidate of candidates) {
			const normalized = candidate.toLowerCase();

			if (seen.has(normalized)) {
				continue;
			}

			if (!keywordPattern.test(candidate)) {
				continue;
			}

			if (candidate.length < 35 || isLikelyHeading(candidate)) {
				continue;
			}

			seen.add(normalized);
			highlights.push(candidate);

			if (highlights.length >= limit) {
				return highlights;
			}
		}
	}

	return highlights;
}

function selectCommitEvidenceHighlights(
	evidence: EvidenceResult[],
	limit: number,
): string[] {
	return selectVoiceEvidenceHighlights(
		evidence.filter(
			(item) =>
				item.title.toLowerCase().includes("commit") ||
				item.sourceType.toLowerCase().includes("commit") ||
				item.content.toLowerCase().includes("commit"),
		),
		limit,
	);
}

function cleanVoiceHighlight(value: string): string {
	const cleaned = value
		.replace(/^[\s\-•*→]+/, "")
		.replace(/\[[^\]]+\]\([^)]+\)/g, "")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/[`*_#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!cleaned) {
		return "";
	}

	return shortenAtNaturalBoundary(cleaned, 210);
}

function shortenAtNaturalBoundary(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value.replace(/[,:;]+$/, "").trim();
	}

	const clipped = value.slice(0, maxLength);
	const boundaryIndexes = [
		clipped.lastIndexOf("."),
		clipped.lastIndexOf(";"),
		clipped.lastIndexOf(","),
		clipped.lastIndexOf(" and "),
		clipped.lastIndexOf(" with "),
		clipped.lastIndexOf(" for "),
	].filter((index) => index > 60);

	const boundary = boundaryIndexes.length > 0 ? Math.max(...boundaryIndexes) : -1;

	if (boundary > 0) {
		return clipped.slice(0, boundary).replace(/[,:;]+$/, "").trim();
	}

	return clipped.replace(/\s+\S*$/, "").replace(/[,:;]+$/, "").trim();
}

function ensureSentence(value: string): string {
	const trimmed = value.trim();

	if (!trimmed) {
		return "";
	}

	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function toSentenceFragment(value: string): string {
	const cleaned = value
		// Strip leading "this/the <noun> <verb>" stems that produce double-verb
		// seams when embedded after "It includes ...", e.g.
		// "It includes this report documents the architecture".
		.replace(
			/^(?:this|the)\s+(?:report|paper|project|document|repository|repo|readme|summary|framework|system|study)\s+(?:documents?|presents?|introduces?|describes?|details?|covers?|explains?|provides?|outlines?|shows?|is|was)\s+/i,
			"",
		)
		.replace(/^this paper presents\s+/i, "")
		.replace(/^this project presents\s+/i, "")
		.replace(/^the project is\s+/i, "")
		.replace(/^it includes\s+/i, "")
		.replace(/^it is\s+/i, "")
		.replace(/^is\s+/i, "")
		.replace(/^evaluation spans\s+/i, "")
		.replace(/^evaluation includes\s+/i, "")
		.replace(/^implementation includes\s+/i, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?]+$/, "");

	if (!cleaned) {
		return "";
	}

	return lowercaseLeadingWord(cleaned);
}

/**
 * Lowercase the first character only when the leading word is an ordinary
 * capitalized word. Acronyms (ROC-AUC, NIFTY, MACD) and mixed-case names
 * (ChandraQuant) are left intact so they are not mangled into "rOC-AUC".
 */
function lowercaseLeadingWord(value: string): string {
	const firstWord = value.split(/\s+/, 1)[0] ?? "";
	const letters = firstWord.replace(/[^A-Za-z]/g, "");
	const uppercaseCount = (letters.match(/[A-Z]/g) ?? []).length;

	if (uppercaseCount > 1) {
		return value;
	}

	return value.charAt(0).toLowerCase() + value.slice(1);
}

function sanitizeVoiceAnswer(answer: string): string {
	return formatTechnicalTermsForSpeech(
		answer
			.replace(/\s+/g, " ")
			.replace(/^["']|["']$/g, "")
			.trim(),
	);
}

function formatTechnicalTermsForSpeech(value: string): string {
	return value
		.replace(/\bChandraQuant[-\s]?Siddhanta\b/gi, "Chandra Quant Siddhanta")
		.replace(/\bChandraQuant\b/g, "Chandra Quant")
		.replace(/\bLangGraph\b/g, "Lang Graph")
		.replace(/\bLangChain\b/g, "Lang Chain")
		.replace(/\bHuggingFace\b/g, "Hugging Face")
		.replace(/\bFAISS\b/g, "F A I S S")
		.replace(/\bRAG\b/g, "R A G")
		.replace(/\bOCR\b/g, "O C R")
		.replace(/\bRTL-SDR\b/g, "R T L S D R")
		.replace(/\bMAVLink\b/g, "Mav Link")
		.replace(/\bMACD\b/g, "M A C D")
		.replace(/\bROC-AUC\b/gi, "R O C A U C")
		.replace(/%K\/%D/g, "percent K and percent D")
		.replace(/\bCCI\b/g, "C C I");
}

function isProjectQuestion(normalizedQuestion: string): boolean {
	return [
		"project",
		"repository",
		"repo",
		"github",
		"tell me about",
		"explain",
		"built",
		"what is",
		"what did",
		"how did",
		"improve",
		"tech stack",
		"architecture",
		"implementation",
	].some((term) => normalizedQuestion.includes(term));
}



function isCommitHistoryQuestion(normalizedQuestion: string): boolean {
	return [
		"commit",
		"commit history",
		"recent changes",
		"repository history",
		"repo history",
		"what changed",
	].some((term) => normalizedQuestion.includes(term));
}

function isRoleFitOrBackgroundQuestion(normalizedQuestion: string): boolean {
	return [
		"good fit",
		"right person",
		"why should",
		"why vansh",
		"background",
		"experience",
		"skills",
		"strength",
		"hire",
		"role",
		"internship",
	].some((term) => normalizedQuestion.includes(term));
}

function isLikelyHeading(value: string): boolean {
	const words = value.trim().split(/\s+/);

	if (words.length <= 12 && !/[.!?]$/.test(value)) {
		return true;
	}

	if (/^[A-Z][A-Za-z0-9\s:-]+$/.test(value) && words.length <= 14) {
		return true;
	}

	return false;
}

function getBestEvidenceTitle(evidence: EvidenceResult[]): string {
	const projectEvidence = evidence.find((item) => item.repositoryName);
	const titledEvidence = projectEvidence ?? evidence.find((item) => item.title);

	return titledEvidence?.repositoryName ?? titledEvidence?.title ?? "this project";
}



function toSpokenProjectName(value: string): string {
	return value
		.replace(/[-_]/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim();
}

function formatEmailForSpeech(value: string): string {
	const replacements: Record<string, string> = {
		".": "dot",
		"@": "at",
		"_": "underscore",
		"-": "hyphen",
		"+": "plus",
		"0": "zero",
		"1": "one",
		"2": "two",
		"3": "three",
		"4": "four",
		"5": "five",
		"6": "six",
		"7": "seven",
		"8": "eight",
		"9": "nine",
	};

	return value
		.trim()
		.toLowerCase()
		.split("")
		.map((char) => replacements[char] ?? char)
		.join(", ");
}

function buildVoiceRetrievalQuery(question: string): string {
	const normalizedQuestion = question.toLowerCase();

	if (isCommitHistoryQuestion(normalizedQuestion)) {
		return [
			question,
			"commit history repository commits changed files implementation development evolution",
		].join("\n");
	}

	if (isRoleFitOrBackgroundQuestion(normalizedQuestion)) {
		return [
			question,
			"resume education experience internship skills projects AI ML software engineering role fit",
			"evidence from resume GitHub repositories project summaries README files implementation details",
		].join("\n");
	}

	if (isProjectQuestion(normalizedQuestion)) {
		return [
			question,
			"project purpose tech stack implementation evaluation design tradeoffs improvements README repository",
		].join("\n");
	}

	return question;
}



function getQuestionScopedProjectEvidence(
	question: string,
	evidence: EvidenceResult[],
): EvidenceResult[] {
	const repositoryName = selectBestRepositoryName(question, evidence);

	if (!repositoryName) {
		return [];
	}

	return filterEvidenceByRepository(evidence, repositoryName);
}

function hasStrongProjectMatch(
	question: string,
	evidence: EvidenceResult[],
): boolean {
	if (evidence.length === 0) {
		return false;
	}

	const repositoryName = selectBestRepositoryName(question, evidence);

	if (!repositoryName) {
		return false;
	}

	return scoreRepositoryMatch(question, repositoryName) >= 5;
}

function filterEvidenceByRepository(
	evidence: EvidenceResult[],
	repositoryName: string,
): EvidenceResult[] {
	const normalizedRepositoryName = normalizeSearchText(repositoryName);

	return evidence.filter((item) => {
		if (item.repositoryName) {
			return normalizeSearchText(item.repositoryName) === normalizedRepositoryName;
		}

		const normalizedTitle = normalizeSearchText(item.title);
		return normalizedTitle.includes(normalizedRepositoryName);
	});
}

function selectBestRepositoryName(
	question: string,
	evidence: EvidenceResult[],
): string | null {
	const candidates = new Map<string, number>();

	for (const item of evidence) {
		if (!item.repositoryName) {
			continue;
		}

		const currentScore = candidates.get(item.repositoryName) ?? 0;
		const score = Math.max(
			currentScore,
			scoreRepositoryMatch(question, item.repositoryName),
			scoreRepositoryMatch(question, item.title),
		);

		candidates.set(item.repositoryName, score);
	}

	let bestRepositoryName: string | null = null;
	let bestScore = 0;

	for (const [repositoryName, score] of candidates.entries()) {
		if (score > bestScore) {
			bestRepositoryName = repositoryName;
			bestScore = score;
		}
	}

	return bestScore >= 5 ? bestRepositoryName : null;
}

function scoreRepositoryMatch(question: string, candidate: string): number {
	const normalizedQuestion = normalizeSearchText(question);
	const normalizedCandidate = normalizeSearchText(candidate);

	if (!normalizedQuestion || !normalizedCandidate) {
		return 0;
	}

	let score = 0;

	if (
		normalizedQuestion.includes(normalizedCandidate) ||
		normalizedCandidate.includes(normalizedQuestion)
	) {
		score += 8;
	}

	const questionTokens = tokenizeSearchText(normalizedQuestion);
	const candidateTokens = tokenizeSearchText(normalizedCandidate);

	for (const questionToken of questionTokens) {
		for (const candidateToken of candidateTokens) {
			if (questionToken === candidateToken) {
				score += 3;
				continue;
			}

			if (
				questionToken.length >= 5 &&
				candidateToken.length >= 5 &&
				(candidateToken.startsWith(questionToken) ||
					questionToken.startsWith(candidateToken))
			) {
				score += 2;
			}
		}
	}

	return score;
}

function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[_-]/g, " ")
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeSearchText(value: string): string[] {
	const stopWords = new Set([
		"tell",
		"me",
		"about",
		"the",
		"of",
		"in",
		"for",
		"vansh",
		"jain",
		"github",
		"repo",
		"repository",
		"project",
		"commit",
		"history",
		"specific",
		"specifically",
	]);

	return normalizeSearchText(value)
		.split(" ")
		.filter((token) => token.length >= 3 && !stopWords.has(token));
}


async function findRepositoryNameByQuestion(
	env: AppBindings,
	question: string,
): Promise<string | null> {
	const tokens = tokenizeSearchText(question).slice(0, 5);

	if (tokens.length === 0) {
		return null;
	}

	const tokenConditions = tokens
		.map(
			() =>
				`(
					lower(replace(replace(repository_name, '-', ' '), '_', ' ')) LIKE ?
					OR lower(replace(replace(title, '-', ' '), '_', ' ')) LIKE ?
					OR lower(public_url) LIKE ?
				)`,
		)
		.join(" AND ");

	const bindings = tokens.flatMap((token) => {
		const pattern = `%${token}%`;
		return [pattern, pattern, pattern];
	});

	const rows = await env.DB
		.prepare(
			`
			SELECT
				repository_name,
				COUNT(*) AS match_count
			FROM source_chunks
			WHERE repository_name IS NOT NULL
				AND ${tokenConditions}
			GROUP BY repository_name
			ORDER BY match_count DESC
			LIMIT 1
			`,
		)
		.bind(...bindings)
		.all<{
			repository_name: string | null;
			match_count: number;
		}>();

	return rows.results?.[0]?.repository_name ?? null;
}



async function fetchCommitEvidenceByQuestion(
	env: AppBindings,
	question: string,
	limit: number,
): Promise<EvidenceResult[]> {
	const tokens = tokenizeProjectLookupText(question).slice(0, 5);

	if (tokens.length === 0) {
		return [];
	}

	const tokenConditions = tokens
		.map(
			() =>
				`(
					lower(replace(replace(repository_name, '-', ' '), '_', ' ')) LIKE ?
					OR lower(replace(replace(title, '-', ' '), '_', ' ')) LIKE ?
					OR lower(public_url) LIKE ?
					OR lower(content) LIKE ?
				)`,
		)
		.join(" AND ");

	const bindings = tokens.flatMap((token) => {
		const pattern = `%${token}%`;
		return [pattern, pattern, pattern, pattern];
	});

	const rows = await env.DB
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
				metadata_json AS metadata
			FROM source_chunks
			WHERE (
					lower(source_type) LIKE '%commit%'
					OR lower(title) LIKE '%commit%'
					OR lower(file_path) LIKE '%commit%'
					OR lower(content) LIKE '%commit%'
					OR commit_sha IS NOT NULL
				)
				AND ${tokenConditions}
			ORDER BY
				CASE
					WHEN lower(title) LIKE '%commit%' THEN 0
					WHEN lower(source_type) LIKE '%commit%' THEN 1
					WHEN commit_sha IS NOT NULL THEN 2
					ELSE 3
				END,
				chunk_index ASC,
				id ASC
			LIMIT ?
			`,
		)
		.bind(...bindings, limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceSourceType;
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
		}>();

	return (rows.results ?? []).map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 85 - index,
		retrievalMode: "exact",
		metadata: parseMetadata(row.metadata),
	}));
}

function tokenizeProjectLookupText(value: string): string[] {
	const stopWords = new Set([
		"tell",
		"me",
		"about",
		"the",
		"of",
		"in",
		"for",
		"vansh",
		"jain",
		"github",
		"repo",
		"repository",
		"project",
		"commit",
		"history",
		"specific",
		"specifically",
		"recent",
		"changes",
		"what",
		"changed",
	]);

	return normalizeSearchText(value)
		.split(" ")
		.filter((token) => token.length >= 3 && !stopWords.has(token));
}


function mergeEvidenceResults(evidenceGroups: EvidenceResult[]): EvidenceResult[] {
	const seen = new Set<string>();
	const merged: EvidenceResult[] = [];

	for (const evidence of evidenceGroups) {
		if (seen.has(evidence.chunkId)) {
			continue;
		}

		seen.add(evidence.chunkId);
		merged.push(evidence);
	}

	return merged;
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

function extractToolCalls(body: unknown): ToolCall[] {
	const root = asRecord(body);
	const message = asRecord(root.message);

	const rawToolCalls =
		asArray(message.toolCallList) ??
		asArray(message.toolCalls) ??
		asArray(root.toolCallList) ??
		asArray(root.toolCalls) ??
		[];

	return rawToolCalls
		.map((value, index): ToolCall | null => {
			const rawToolCall = asRecord(value);
			const rawFunction = asRecord(rawToolCall.function);

			const id =
				asString(rawToolCall.id) ??
				asString(rawToolCall.toolCallId) ??
				`tool-call-${index + 1}`;

			const name =
				asString(rawToolCall.name) ??
				asString(rawFunction.name) ??
				asString(rawToolCall.toolName) ??
				"";

			const args =
				parseArguments(rawToolCall.arguments) ??
				parseArguments(rawFunction.arguments) ??
				parseArguments(rawFunction.parameters) ??
				{};

			if (!name) {
				return null;
			}

			return {
				id,
				name,
				arguments: args,
			};
		})
		.filter((toolCall): toolCall is ToolCall => toolCall !== null);
}

function parseArguments(value: unknown): Record<string, unknown> | null {
	if (!value) {
		return null;
	}

	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return asRecord(parsed);
		} catch {
			return null;
		}
	}

	return asRecord(value);
}

function selectPrivacyPreservingSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
	if (slots.length <= 3) {
		return slots;
	}

	const selected: AvailabilitySlot[] = [];
	const usedDates = new Set<string>();

	for (const slot of slots) {
		const dateKey = slot.startTime.slice(0, 10);

		if (usedDates.has(dateKey)) {
			continue;
		}

		selected.push(slot);
		usedDates.add(dateKey);

		if (selected.length === 3) {
			return selected;
		}
	}

	for (const index of [0, Math.floor(slots.length / 2), slots.length - 1]) {
		const slot = slots[index];

		if (slot && !selected.some((selectedSlot) => selectedSlot.startTime === slot.startTime)) {
			selected.push(slot);
		}

		if (selected.length === 3) {
			break;
		}
	}

	return selected;
}

function isValidEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatSlotLabel(startTime: string, endTime: string, timezone: string): string {
	const start = new Date(startTime);
	const end = new Date(endTime);

	const startFormatter = new Intl.DateTimeFormat("en-IN", {
		timeZone: timezone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});

	const endFormatter = new Intl.DateTimeFormat("en-IN", {
		timeZone: timezone,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});

	return `${startFormatter.format(start)} - ${endFormatter.format(end)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function asArray(value: unknown): unknown[] | null {
	return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
