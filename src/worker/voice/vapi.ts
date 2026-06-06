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
		env.GEMINI_API_KEY,
		generationQuestion,
		evidence,
	);
}



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

async function generateVoiceGroundedAnswer(
	apiKey: string,
	question: string,
	evidence: EvidenceResult[],
): Promise<string> {
	const evidenceText = formatVoiceEvidence(evidence, 3500);

	if (!evidenceText) {
		return "I do not have enough retrieved evidence to answer that reliably.";
	}

	const answer = await requestVoiceAnswer(apiKey, question, evidenceText);

	if (isUsableVoiceAnswer(answer)) {
		return sanitizeVoiceAnswer(answer);
	}

	return createVoiceEvidenceFallback(question, evidence);
}


async function requestVoiceAnswer(
	apiKey: string,
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
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${VOICE_ANSWER_MODEL}:generateContent?key=${apiKey}`,
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
						maxOutputTokens: 320,
					},
				}),
			},
		);

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as GeminiGenerateContentResponse;
		const answer = data.candidates?.[0]?.content?.parts
			?.map((part) => part.text ?? "")
			.join("")
			.trim();

		return answer || null;
	} catch {
		return null;
	}
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

		const clippedContent = content.slice(0, Math.min(900, remainingCharacters));
		const line = `Source: ${sourceParts.join(" | ")}\nContent: ${clippedContent}`;

		selectedLines.push(line);
		usedCharacters += line.length;
	}

	return selectedLines.join("\n\n").trim();
}

function sanitizeVoiceAnswer(answer: string): string {
	return answer
		.replace(/\s+/g, " ")
		.replace(/^["']|["']$/g, "")
		.trim();
}

function createVoiceEvidenceFallback(
	question: string,
	evidence: EvidenceResult[],
): string {
	const normalizedQuestion = question.toLowerCase();
	const highlights = selectVoiceEvidenceHighlights(evidence, 3);

	if (isProjectQuestion(normalizedQuestion)) {
		const projectTitle = getBestEvidenceTitle(evidence);

		if (highlights.length >= 2) {
			return [
				`Based on the retrieved project evidence, ${projectTitle} is described as ${ensureSentence(toSentenceFragment(highlights[0]))}`,
				`It includes ${ensureSentence(toSentenceFragment(highlights[1]))}`,
				highlights[2] ? `Its evaluation or implementation details include ${ensureSentence(toSentenceFragment(highlights[2]))}` : "",
			]
				.filter(Boolean)
				.join(" ");
		}

		if (highlights.length === 1) {
			return `Based on the retrieved project evidence, ${projectTitle} is described as ${ensureSentence(toSentenceFragment(highlights[0]))}`;
		}

		return `I found retrieved evidence for ${projectTitle}, but I do not have enough detail to summarize it reliably.`;
	}

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

function isProjectQuestion(normalizedQuestion: string): boolean {
	return [
		"project",
		"tell me about",
		"explain",
		"built",
		"what is",
		"what did",
		"how did",
		"improve",
	].some((term) => normalizedQuestion.includes(term));
}

function getBestEvidenceTitle(evidence: EvidenceResult[]): string {
	const projectEvidence = evidence.find((item) => item.repositoryName);
	const titledEvidence = projectEvidence ?? evidence.find((item) => item.title);

	return titledEvidence?.repositoryName ?? titledEvidence?.title ?? "this project";
}


function selectVoiceEvidenceHighlights(
	evidence: EvidenceResult[],
	limit: number,
): string[] {
	const highlights: string[] = [];
	const seen = new Set<string>();

	const keywordPattern =
		/\b(built|developed|engineered|implemented|integrated|created|worked|experience|intern|project|ai|ml|machine learning|software|pipeline|system|application|model|evaluation|testing|debugging|frontend|backend)\b/i;

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

	return shortenAtNaturalBoundary(cleaned, 190);
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

function toSentenceFragment(value: string): string {
	const cleaned = value
		.replace(/^this paper presents\s+/i, "")
		.replace(/^this project presents\s+/i, "")
		.replace(/^the project is\s+/i, "")
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

	return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}


function ensureSentence(value: string): string {
	const trimmed = value.trim();

	if (!trimmed) {
		return "";
	}

	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
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
			"evidence from resume, GitHub repositories, project summaries, README files, and implementation details",
		].join("\n");

		const [resumeEvidence, broadProfileEvidence] = await Promise.all([
			fetchResumeEvidence(env, 10),
			retrieveHybridEvidence(
				env.DB,
				env.VECTORIZE,
				env.GEMINI_API_KEY,
				roleFitQuery,
				{
					finalLimit: 10,
				},
			),
		]);

		return mergeEvidenceResults([
			...resumeEvidence,
			...broadProfileEvidence,
		]).slice(0, 14);
	}

	const evidence = await retrieveHybridEvidence(
		env.DB,
		env.VECTORIZE,
		env.GEMINI_API_KEY,
		buildVoiceRetrievalQuery(question),
		{
			finalLimit: isProjectQuestion(normalizedQuestion) ? 10 : 8,
		},
	);

	if (!isProjectQuestion(normalizedQuestion)) {
		return evidence;
	}

	const repositoryNames = getRepositoryNamesFromEvidence(evidence);

	if (repositoryNames.length === 0) {
		return evidence;
	}

	const relatedRepositoryEvidence = await fetchRepositoryEvidenceByNames(
		env,
		repositoryNames,
		12,
	);

	return mergeEvidenceResults([
		...evidence,
		...relatedRepositoryEvidence,
	]).slice(0, 14);
}


function buildVoiceGenerationQuestion(question: string): string {
	const normalizedQuestion = question.toLowerCase();

	if (!isRoleFitOrBackgroundQuestion(normalizedQuestion)) {
		return [
			question,
			"",
			"Answer as Vansh Jain's AI representative, not as Vansh himself.",
			"Use third person. Say Vansh, he, or his.",
			"Do not use I, me, my, or mine when referring to Vansh.",
			"Use only the provided evidence.",
		].join("\n");
	}

	return [
		"Explain why Vansh Jain is a strong fit for an AI/software engineering role, based only on the provided evidence.",
		"The caller did not provide a specific job description, so do not reject the answer because exact role requirements are missing.",
		"",
		"Answer as Vansh Jain's AI representative, not as Vansh himself.",
		"Use third person. Say Vansh, he, or his.",
		"Do not use I, me, my, or mine when referring to Vansh.",
		"Keep the answer voice-friendly: 3 to 5 sentences, no markdown bullets.",
		"Use only the provided evidence.",
		"Prioritize resume, education, internships, skills, and strong project evidence when available.",
		"Do not over-focus on one weak repository if stronger resume or project evidence is present.",
		"Do not invent requirements, employers, achievements, or metrics that are not supported by the evidence.",
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

function getRepositoryNamesFromEvidence(evidence: EvidenceResult[]): string[] {
	const repositoryNames = new Set<string>();

	for (const item of evidence) {
		if (item.repositoryName) {
			repositoryNames.add(item.repositoryName);
		}

		if (repositoryNames.size >= 2) {
			break;
		}
	}

	return [...repositoryNames];
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
				CASE source_type
					WHEN 'github_readme' THEN 0
					WHEN 'github_manifest' THEN 1
					WHEN 'github_repository' THEN 2
					WHEN 'github_document' THEN 3
					ELSE 4
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

function buildVoiceRetrievalQuery(question: string): string {
	const normalizedQuestion = question.toLowerCase();

	if (isRoleFitOrBackgroundQuestion(normalizedQuestion)) {
		return [
			question,
			"resume education experience internship skills projects AI ML software engineering role fit",
			"curated GitHub projects AI-Persona NLP-Research-Assistant ChandraQuant-Siddhanta CellSignalMapper Assessment-Creator",
		].join("\n");
	}

	return question;
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
				? `I checked Vansh's calendar and found these options. ${slots
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
		return `Before booking, read this email back to the caller exactly and ask for confirmation: ${guestEmail}`;
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
	)}. A calendar invite has been sent to ${guestEmail}.`;
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
