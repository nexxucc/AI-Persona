export type AvailabilityRequest = {
	startDate?: string;
	days?: number;
	durationMinutes?: number;
	timezone?: string;
};

export type AvailabilitySlot = {
	startTime: string;
	endTime: string;
	timezone: string;
	label: string;
};

export type AvailabilityResponse = {
	timezone: string;
	durationMinutes: number;
	slots: AvailabilitySlot[];
};

export type BookingRequest = {
	startTime?: string;
	endTime?: string;
	timezone?: string;
	guestName?: string;
	guestEmail?: string;
	notes?: string;
};

export type BookingResponse = {
	confirmed: boolean;
	eventId: string;
	htmlLink: string | null;
	startTime: string;
	endTime: string;
	timezone: string;
};
