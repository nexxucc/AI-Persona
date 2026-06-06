import { bookCalendarEvent, getAvailability } from "../calendar/googleCalendar";
import type { AvailabilitySlot } from "../calendar/types";
import type { AppBindings } from "../types/bindings";

export type CalendarChatResponse = {
	answer: string;
	supported: boolean;
	model: string;
	citations: [];
	evidence: [];
};

type PendingBooking = {
	slotIndex: number;
	guestName: string;
	guestEmail: string;
};

type SessionState = {
	slots: AvailabilitySlot[];
	pendingBooking?: PendingBooking;
};

const PENDING_AVAILABILITY_TTL_MS = 20 * 60 * 1000;
const DEFAULT_CONVERSATION_ID = "default-calendar-conversation";

export async function handleCalendarChatMessage(
	env: AppBindings,
	message: string,
	conversationId: string | undefined,
): Promise<CalendarChatResponse | null> {
	const normalizedMessage = normalizeMessage(message);
	const conversationKey = conversationId?.trim() || DEFAULT_CONVERSATION_ID;
	const session = await getSession(env, conversationKey);

	// If a booking is awaiting email confirmation, handle yes/no/correction first,
	// even when the reply has no calendar keyword (e.g. a bare "yes").
	if (session?.pendingBooking) {
		const confirmationResponse = await handlePendingBookingReply(
			env,
			message,
			normalizedMessage,
			conversationKey,
			session,
		);

		if (confirmationResponse) {
			return confirmationResponse;
		}
	}

	if (!isCalendarRelatedMessage(normalizedMessage)) {
		return null;
	}

	if (isBookingIntent(normalizedMessage)) {
		return handleBookingMessage(env, message, normalizedMessage, conversationKey, session);
	}

	return createAvailabilityChatResponse(env, conversationKey);
}

async function handlePendingBookingReply(
	env: AppBindings,
	message: string,
	normalizedMessage: string,
	conversationKey: string,
	session: SessionState,
): Promise<CalendarChatResponse | null> {
	const pendingBooking = session.pendingBooking;

	if (!pendingBooking) {
		return null;
	}

	const correctedEmail = extractEmail(message);

	// A new email in the reply replaces the one awaiting confirmation.
	if (correctedEmail && correctedEmail !== pendingBooking.guestEmail) {
		const updatedBooking = { ...pendingBooking, guestEmail: correctedEmail };
		await setSession(env, conversationKey, { ...session, pendingBooking: updatedBooking });

		return calendarResponse(
			`Thanks. I will send the invite to ${correctedEmail} instead. Reply "yes" to confirm, or share a different email.`,
			"calendar-booking-confirm",
		);
	}

	if (isAffirmative(normalizedMessage)) {
		return confirmAndBook(env, conversationKey, session, pendingBooking);
	}

	if (isNegative(normalizedMessage)) {
		await setSession(env, conversationKey, { slots: session.slots });

		return calendarResponse(
			"No problem, I have not booked anything. Tell me which slot works and the correct email when you are ready.",
			"calendar-booking-cancelled",
		);
	}

	return null;
}

async function confirmAndBook(
	env: AppBindings,
	conversationKey: string,
	session: SessionState,
	pendingBooking: PendingBooking,
): Promise<CalendarChatResponse> {
	const selectedSlot = session.slots[pendingBooking.slotIndex];

	if (!selectedSlot) {
		await setSession(env, conversationKey, { slots: session.slots });

		return calendarResponse(
			"That slot is no longer available in this conversation. Let me know and I can check availability again.",
			"calendar-booking",
		);
	}

	await bookCalendarEvent(env, {
		startTime: selectedSlot.startTime,
		endTime: selectedSlot.endTime,
		timezone: selectedSlot.timezone,
		guestName: pendingBooking.guestName,
		guestEmail: pendingBooking.guestEmail,
		notes: "Booked from the AI-Persona chat interface.",
	});

	await clearSession(env, conversationKey);

	return calendarResponse(
		`Done, I booked the call for ${selectedSlot.label}. I sent a calendar invite with a meeting link to ${pendingBooking.guestEmail}.`,
		"calendar-booking",
	);
}

async function handleBookingMessage(
	env: AppBindings,
	message: string,
	normalizedMessage: string,
	conversationKey: string,
	session: SessionState | null,
): Promise<CalendarChatResponse> {
	const slotIndex = extractSlotIndex(normalizedMessage);
	const guestEmail = extractEmail(message);
	const guestName = extractGuestName(message) ?? guestEmail?.split("@")[0] ?? "Guest";

	if (!session || session.slots.length === 0 || slotIndex === null) {
		return createAvailabilityChatResponse(
			env,
			conversationKey,
			"I can book a call, but I need you to pick one of the available slots first.",
		);
	}

	const selectedSlot = session.slots[slotIndex];

	if (!selectedSlot) {
		return calendarResponse(
			`I could not find that slot number. Please choose one of these instead:\n\n${formatSlots(
				session.slots,
			)}`,
			"calendar-intent",
		);
	}

	if (!guestEmail) {
		return calendarResponse(
			`I can book ${selectedSlot.label}. Please share your email address so I can add you to the calendar invite.`,
			"calendar-intent",
		);
	}

	// Store the booking and require an explicit confirmation before creating the
	// event, mirroring the voice agent's email-confirmation safety.
	await setSession(env, conversationKey, {
		slots: session.slots,
		pendingBooking: { slotIndex, guestName, guestEmail },
	});

	return calendarResponse(
		`Just to confirm: I will book ${selectedSlot.label} and send the invite to ${guestEmail}. Reply "yes" to confirm, or send a corrected email.`,
		"calendar-booking-confirm",
	);
}

async function createAvailabilityChatResponse(
	env: AppBindings,
	conversationKey: string,
	prefix?: string,
): Promise<CalendarChatResponse> {
	const availability = await getAvailability(env, {
		days: 7,
		durationMinutes: 30,
		timezone: env.GOOGLE_DEFAULT_TIMEZONE || "Asia/Kolkata",
	});

	if (availability.slots.length === 0) {
		await clearSession(env, conversationKey);

		return calendarResponse(
			"I could not find any available 30-minute slots in the next few days.",
			"calendar-availability",
		);
	}

	const proposedSlots = selectPrivacyPreservingSlots(availability.slots);

	await setSession(env, conversationKey, { slots: proposedSlots });

	return calendarResponse(
		[
			prefix,
			"I checked my calendar and can offer a few available options. If none of these work, share a few time windows that suit you and I can check those instead.",
			formatSlots(proposedSlots),
			'Reply with something like "Book slot 1. My name is Rahul and my email is rahul@example.com."',
		]
			.filter(Boolean)
			.join("\n\n"),
		"calendar-availability",
	);
}

function calendarResponse(answer: string, model: string): CalendarChatResponse {
	return {
		answer,
		supported: true,
		model,
		citations: [],
		evidence: [],
	};
}

async function getSession(
	env: AppBindings,
	conversationKey: string,
): Promise<SessionState | null> {
	const row = await env.DB.prepare(
		`SELECT state_json, created_at FROM chat_sessions WHERE conversation_id = ?`,
	)
		.bind(conversationKey)
		.first<{ state_json: string; created_at: number }>();

	if (!row) {
		return null;
	}

	if (Date.now() - row.created_at > PENDING_AVAILABILITY_TTL_MS) {
		await clearSession(env, conversationKey);
		return null;
	}

	try {
		const parsed = JSON.parse(row.state_json) as SessionState;

		if (!parsed || !Array.isArray(parsed.slots)) {
			return null;
		}

		return parsed;
	} catch {
		return null;
	}
}

async function setSession(
	env: AppBindings,
	conversationKey: string,
	state: SessionState,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO chat_sessions (conversation_id, state_json, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(conversation_id) DO UPDATE SET
			state_json = excluded.state_json,
			created_at = excluded.created_at`,
	)
		.bind(conversationKey, JSON.stringify(state), Date.now())
		.run();
}

async function clearSession(env: AppBindings, conversationKey: string): Promise<void> {
	await env.DB.prepare(`DELETE FROM chat_sessions WHERE conversation_id = ?`)
		.bind(conversationKey)
		.run();
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

	const fallbackIndexes = [
		0,
		Math.floor(slots.length / 2),
		slots.length - 1,
	];

	for (const index of fallbackIndexes) {
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

function formatSlots(slots: AvailabilitySlot[]): string {
	return slots
		.slice(0, 5)
		.map((slot, index) => `${index + 1}. ${slot.label}`)
		.join("\n");
}

function isCalendarRelatedMessage(normalizedMessage: string): boolean {
	const phraseTerms = [
		"book a call",
		"book a meeting",
		"book meeting",
		"book slot",
		"set up a call",
		"schedule a call",
	];

	if (phraseTerms.some((term) => normalizedMessage.includes(term))) {
		return true;
	}

	// Whole-word matching so "called", "recall", "freely" etc. do not
	// false-trigger the calendar flow.
	const wordTerms = [
		"available",
		"availability",
		"free",
		"calendar",
		"meeting",
		"call",
		"schedule",
		"reschedule",
		"appointment",
	];

	return wordTerms.some((term) => new RegExp(`\\b${term}\\b`).test(normalizedMessage));
}

function isBookingIntent(normalizedMessage: string): boolean {
	return [
		"book",
		"confirm",
		"schedule",
		"reserve",
	].some((term) => normalizedMessage.includes(term));
}

function isAffirmative(normalizedMessage: string): boolean {
	return /\b(yes|yeah|yep|yup|correct|confirm|confirmed|right|go ahead|book it|sounds good|that works)\b/.test(
		normalizedMessage,
	);
}

function isNegative(normalizedMessage: string): boolean {
	return /\b(no|nope|nah|wrong|incorrect|cancel|don't|do not|stop)\b/.test(normalizedMessage);
}

function extractSlotIndex(normalizedMessage: string): number | null {
	const numericMatch =
		normalizedMessage.match(/\bslot\s*([0-9]+)\b/) ??
		normalizedMessage.match(/\boption\s*([0-9]+)\b/);

	if (numericMatch?.[1]) {
		return Number(numericMatch[1]) - 1;
	}

	const ordinalSlots: Record<string, number> = {
		first: 0,
		second: 1,
		third: 2,
		fourth: 3,
		fifth: 4,
	};

	for (const [ordinal, index] of Object.entries(ordinalSlots)) {
		if (normalizedMessage.includes(ordinal)) {
			return index;
		}
	}

	return null;
}

function extractEmail(message: string): string | null {
	return message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
}

function extractGuestName(message: string): string | null {
	const match = message.match(/(?:my name is|i am|i'm|this is)\s+(.+)/i);

	if (!match?.[1]) {
		return null;
	}

	// Take up to three leading name words, stopping at connectors like
	// "and my email is ..." so the captured name stays clean.
	const stopWords = new Set(["and", "my", "email", "e-mail", "mail", "is", "the", "at"]);
	const words: string[] = [];

	for (const rawWord of match[1].split(/\s+/)) {
		const word = rawWord.replace(/[^A-Za-z.'-]/g, "");

		if (!word || !/^[A-Za-z]/.test(word) || stopWords.has(word.toLowerCase())) {
			break;
		}

		words.push(word);

		if (words.length >= 3) {
			break;
		}
	}

	const name = words.join(" ").replace(/[.\s]+$/, "").trim();

	return name || null;
}

function normalizeMessage(message: string): string {
	return message.toLowerCase().replace(/\s+/g, " ").trim();
}
