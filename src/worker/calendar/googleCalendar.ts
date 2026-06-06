import type { AppBindings } from "../types/bindings";
import type {
	AvailabilityRequest,
	AvailabilityResponse,
	AvailabilitySlot,
	BookingRequest,
	BookingResponse,
} from "./types";

type GoogleTokenResponse = {
	access_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
};

type FreeBusyResponse = {
	calendars?: Record<
		string,
		{
			busy?: Array<{
				start: string;
				end: string;
			}>;
		}
	>;
};

type GoogleCalendarEvent = {
	id?: string;
	htmlLink?: string;
};

const DEFAULT_TIMEZONE = "Asia/Kolkata";
const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 14;
const WORKDAY_START_HOUR = 10;
const WORKDAY_END_HOUR = 18;

let cachedAccessToken: {
	token: string;
	expiresAt: number;
} | null = null;

export async function getAvailability(
	env: AppBindings,
	request: AvailabilityRequest,
): Promise<AvailabilityResponse> {
	const timezone = request.timezone?.trim() || env.GOOGLE_DEFAULT_TIMEZONE || DEFAULT_TIMEZONE;
	const durationMinutes = clampInteger(
		request.durationMinutes,
		15,
		120,
		DEFAULT_DURATION_MINUTES,
	);
	const days = clampInteger(request.days, 1, MAX_DAYS, DEFAULT_DAYS);
	const startDate = request.startDate?.trim() || formatDateInTimeZone(new Date(), timezone);

	const calendars = getAvailabilityCalendarIds(env);
	const rangeStart = zonedDateTimeToUtc(startDate, 0, 0, timezone);
	const rangeEndDate = addDaysToDateString(startDate, days);
	const rangeEnd = zonedDateTimeToUtc(rangeEndDate, 23, 59, timezone);

	const busyRanges = await fetchBusyRanges(env, calendars, rangeStart, rangeEnd, timezone);
	const candidateSlots = generateCandidateSlots({
		startDate,
		days,
		durationMinutes,
		timezone,
	});

	const now = new Date();
	const availableSlots = candidateSlots
		.filter((slot) => new Date(slot.startTime).getTime() > now.getTime())
		.filter((slot) => !busyRanges.some((busy) => rangesOverlap(slot, busy)))
		.slice(0, 12);

	return {
		timezone,
		durationMinutes,
		slots: availableSlots,
	};
}

export async function bookCalendarEvent(
	env: AppBindings,
	request: BookingRequest,
): Promise<BookingResponse> {
	const timezone = request.timezone?.trim() || env.GOOGLE_DEFAULT_TIMEZONE || DEFAULT_TIMEZONE;

	if (!request.startTime || !request.endTime) {
		throw new Error("startTime and endTime are required.");
	}

	const startDate = new Date(request.startTime);
	const endDate = new Date(request.endTime);

	if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
		throw new Error("startTime and endTime must be valid ISO timestamps.");
	}

	if (endDate.getTime() <= startDate.getTime()) {
		throw new Error("endTime must be after startTime.");
	}

	const requestedSlotIsAvailable = await isRequestedSlotAvailable(
		env,
		startDate,
		endDate,
		timezone,
	);

	if (!requestedSlotIsAvailable) {
		throw new Error("That slot is no longer available. Please choose another slot.");
	}

	const accessToken = await getGoogleAccessToken(env);
	const bookingCalendarId = env.GOOGLE_BOOKINGS_CALENDAR_ID || "primary";
	const guestName = request.guestName?.trim() || "Guest";
	const guestEmail = request.guestEmail?.trim();

	const eventBody = {
		summary: `Call with ${guestName} - Vansh Jain`,
		description: [
			"Booked through Vansh Jain's AI persona.",
			request.notes?.trim() ? `Notes: ${request.notes.trim()}` : null,
		]
			.filter(Boolean)
			.join("\n"),
		start: {
			dateTime: startDate.toISOString(),
			timeZone: timezone,
		},
		end: {
			dateTime: endDate.toISOString(),
			timeZone: timezone,
		},
		attendees: guestEmail ? [{ email: guestEmail, displayName: guestName }] : [],
		conferenceData: {
			createRequest: {
				requestId: crypto.randomUUID(),
				conferenceSolutionKey: { type: "hangoutsMeet" },
			},
		},
	};

	const response = await fetch(
		`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
			bookingCalendarId,
		)}/events?sendUpdates=all&conferenceDataVersion=1`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(eventBody),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Google Calendar booking failed: ${response.status} ${errorBody}`);
	}

	const event = (await response.json()) as GoogleCalendarEvent;

	if (!event.id) {
		throw new Error("Google Calendar booking did not return an event id.");
	}

	return {
		confirmed: true,
		eventId: event.id,
		htmlLink: event.htmlLink ?? null,
		startTime: startDate.toISOString(),
		endTime: endDate.toISOString(),
		timezone,
	};
}


async function isRequestedSlotAvailable(
	env: AppBindings,
	startDate: Date,
	endDate: Date,
	timezone: string,
): Promise<boolean> {
	const calendars = getAvailabilityCalendarIds(env);
	const busyRanges = await fetchBusyRanges(env, calendars, startDate, endDate, timezone);

	return !busyRanges.some((busy) =>
		rangesOverlap(
			{
				startTime: startDate.toISOString(),
				endTime: endDate.toISOString(),
			},
			busy,
		),
	);
}

async function getGoogleAccessToken(env: AppBindings): Promise<string> {
	if (cachedAccessToken && Date.now() < cachedAccessToken.expiresAt) {
		return cachedAccessToken.token;
	}

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: env.GOOGLE_REFRESH_TOKEN,
			grant_type: "refresh_token",
		}),
	});

	const tokenResponse = (await response.json()) as GoogleTokenResponse;

	if (!response.ok || !tokenResponse.access_token) {
		throw new Error(
			`Google OAuth refresh failed: ${response.status} ${
				tokenResponse.error_description ?? tokenResponse.error ?? "unknown error"
			}`,
		);
	}

	cachedAccessToken = {
		token: tokenResponse.access_token,
		expiresAt: Date.now() + Math.max((tokenResponse.expires_in ?? 3600) - 120, 60) * 1000,
	};

	return cachedAccessToken.token;
}

async function fetchBusyRanges(
	env: AppBindings,
	calendars: string[],
	rangeStart: Date,
	rangeEnd: Date,
	timezone: string,
): Promise<Array<{ startTime: string; endTime: string }>> {
	const accessToken = await getGoogleAccessToken(env);

	const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			timeMin: rangeStart.toISOString(),
			timeMax: rangeEnd.toISOString(),
			timeZone: timezone,
			items: calendars.map((id) => ({ id })),
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Google Calendar freebusy failed: ${response.status} ${errorBody}`);
	}

	const data = (await response.json()) as FreeBusyResponse;

	return Object.values(data.calendars ?? {})
		.flatMap((calendar) => calendar.busy ?? [])
		.map((busy) => ({
			startTime: new Date(busy.start).toISOString(),
			endTime: new Date(busy.end).toISOString(),
		}));
}

function getAvailabilityCalendarIds(env: AppBindings): string[] {
	const configuredCalendars = (env.GOOGLE_AVAILABILITY_CALENDAR_IDS || "")
		.split(",")
		.map((calendarId) => calendarId.trim())
		.filter(Boolean);

	if (configuredCalendars.length > 0) {
		return configuredCalendars;
	}

	return [env.GOOGLE_BOOKINGS_CALENDAR_ID || "primary"];
}

function generateCandidateSlots({
	startDate,
	days,
	durationMinutes,
	timezone,
}: {
	startDate: string;
	days: number;
	durationMinutes: number;
	timezone: string;
}): AvailabilitySlot[] {
	const slots: AvailabilitySlot[] = [];

	for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
		const date = addDaysToDateString(startDate, dayOffset);

		for (
			let minutes = WORKDAY_START_HOUR * 60;
			minutes + durationMinutes <= WORKDAY_END_HOUR * 60;
			minutes += durationMinutes
		) {
			const start = zonedDateTimeToUtc(
				date,
				Math.floor(minutes / 60),
				minutes % 60,
				timezone,
			);
			const end = new Date(start.getTime() + durationMinutes * 60_000);

			slots.push({
				startTime: start.toISOString(),
				endTime: end.toISOString(),
				timezone,
				label: formatSlotLabel(start, end, timezone),
			});
		}
	}

	return slots;
}

function rangesOverlap(
	slot: { startTime: string; endTime: string },
	busy: { startTime: string; endTime: string },
): boolean {
	const slotStart = new Date(slot.startTime).getTime();
	const slotEnd = new Date(slot.endTime).getTime();
	const busyStart = new Date(busy.startTime).getTime();
	const busyEnd = new Date(busy.endTime).getTime();

	return slotStart < busyEnd && busyStart < slotEnd;
}

function zonedDateTimeToUtc(
	dateString: string,
	hour: number,
	minute: number,
	timeZone: string,
): Date {
	const [year, month, day] = dateString.split("-").map(Number);
	const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
	const offset = getTimeZoneOffsetMs(timeZone, utcGuess);
	const firstPass = new Date(utcGuess.getTime() - offset);
	const correctedOffset = getTimeZoneOffsetMs(timeZone, firstPass);

	return new Date(utcGuess.getTime() - correctedOffset);
}

function getTimeZoneOffsetMs(timeZone: string, date: Date): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);

	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const zonedAsUtc = Date.UTC(
		Number(values.year),
		Number(values.month) - 1,
		Number(values.day),
		Number(values.hour),
		Number(values.minute),
		Number(values.second),
	);

	return zonedAsUtc - date.getTime();
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);

	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

	return `${values.year}-${values.month}-${values.day}`;
}

function addDaysToDateString(dateString: string, days: number): string {
	const [year, month, day] = dateString.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0));

	return date.toISOString().slice(0, 10);
}

function formatSlotLabel(start: Date, end: Date, timeZone: string): string {
	const formatter = new Intl.DateTimeFormat("en-IN", {
		timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});

	const endFormatter = new Intl.DateTimeFormat("en-IN", {
		timeZone,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});

	return `${formatter.format(start)} - ${endFormatter.format(end)}`;
}

function clampInteger(
	value: number | undefined,
	minimum: number,
	maximum: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return fallback;
	}

	return Math.min(Math.max(value, minimum), maximum);
}
