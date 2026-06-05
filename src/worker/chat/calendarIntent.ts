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

type PendingAvailability = {
	slots: AvailabilitySlot[];
	createdAt: number;
};

const PENDING_AVAILABILITY_TTL_MS = 20 * 60 * 1000;
const DEFAULT_CONVERSATION_ID = "default-calendar-conversation";

const pendingAvailabilityByConversation = new Map<string, PendingAvailability>();

export async function handleCalendarChatMessage(
	env: AppBindings,
	message: string,
	conversationId: string | undefined,
): Promise<CalendarChatResponse | null> {
	const normalizedMessage = normalizeMessage(message);

	if (!isCalendarRelatedMessage(normalizedMessage)) {
		return null;
	}

	const conversationKey = conversationId?.trim() || DEFAULT_CONVERSATION_ID;

	if (isBookingIntent(normalizedMessage)) {
		return handleBookingMessage(env, message, normalizedMessage, conversationKey);
	}

	return createAvailabilityChatResponse(env, conversationKey);
}

async function handleBookingMessage(
	env: AppBindings,
	message: string,
	normalizedMessage: string,
	conversationKey: string,
): Promise<CalendarChatResponse> {
	const pendingAvailability = getPendingAvailability(conversationKey);
	const slotIndex = extractSlotIndex(normalizedMessage);
	const guestEmail = extractEmail(message);
	const guestName = extractGuestName(message) ?? guestEmail?.split("@")[0] ?? "Guest";

	if (!pendingAvailability || slotIndex === null) {
		return createAvailabilityChatResponse(
			env,
			conversationKey,
			"I can book a call, but I need you to pick one of the available slots first.",
		);
	}

	const selectedSlot = pendingAvailability.slots[slotIndex];

	if (!selectedSlot) {
		return {
			answer: `I could not find that slot number. Please choose one of these instead:\n\n${formatSlots(
				pendingAvailability.slots,
			)}`,
			supported: true,
			model: "calendar-intent",
			citations: [],
			evidence: [],
		};
	}

	if (!guestEmail) {
		return {
			answer: `I can book ${selectedSlot.label}. Please share your email address so I can add you to the calendar invite.`,
			supported: true,
			model: "calendar-intent",
			citations: [],
			evidence: [],
		};
	}

	await bookCalendarEvent(env, {
		startTime: selectedSlot.startTime,
		endTime: selectedSlot.endTime,
		timezone: selectedSlot.timezone,
		guestName,
		guestEmail,
		notes: "Booked from the AI-Persona chat interface.",
	});

	pendingAvailabilityByConversation.delete(conversationKey);

	return {
		answer: `Done, I booked the call for ${selectedSlot.label}. I created a calendar invite and sent it to the provided email address.`,
		supported: true,
		model: "calendar-booking",
		citations: [],
		evidence: [],
	};
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

	pendingAvailabilityByConversation.set(conversationKey, {
		slots: availability.slots,
		createdAt: Date.now(),
	});

	if (availability.slots.length === 0) {
		return {
			answer: "I could not find any available 30-minute slots in the next few days.",
			supported: true,
			model: "calendar-availability",
			citations: [],
			evidence: [],
		};
	}

	const proposedSlots = selectPrivacyPreservingSlots(availability.slots);

	pendingAvailabilityByConversation.set(conversationKey, {
		slots: proposedSlots,
		createdAt: Date.now(),
	});

	return {
		answer: [
			prefix,
			"I checked my calendar and can offer a few available options. If none of these work, share a few time windows that suit you and I can check those instead.",
			formatSlots(proposedSlots),
			'Reply with something like "Book slot 1. My name is Rahul and my email is rahul@example.com."',
		]
			.filter(Boolean)
			.join("\n\n"),
		supported: true,
		model: "calendar-availability",
		citations: [],
		evidence: [],
	};
}

function getPendingAvailability(conversationKey: string): PendingAvailability | null {
	const pendingAvailability = pendingAvailabilityByConversation.get(conversationKey);

	if (!pendingAvailability) {
		return null;
	}

	if (Date.now() - pendingAvailability.createdAt > PENDING_AVAILABILITY_TTL_MS) {
		pendingAvailabilityByConversation.delete(conversationKey);
		return null;
	}

	return pendingAvailability;
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
	return [
		"available",
		"availability",
		"free",
		"calendar",
		"meeting",
		"call",
		"schedule",
		"book a call",
		"book meeting",
		"book slot",
	].some((term) => normalizedMessage.includes(term));
}

function isBookingIntent(normalizedMessage: string): boolean {
	return [
		"book",
		"confirm",
		"schedule",
		"reserve",
	].some((term) => normalizedMessage.includes(term));
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
	const match = message.match(
		/(?:my name is|i am|i'm|this is)\s+([A-Z][A-Z .'-]{1,60})(?:,|\.|\sand\s|\semail\s|$)/i,
	);

	return match?.[1]?.trim() ?? null;
}

function normalizeMessage(message: string): string {
	return message.toLowerCase().replace(/\s+/g, " ").trim();
}
