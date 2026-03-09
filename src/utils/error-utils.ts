import type { ErrorDiagnostic } from "../types";

type DiagnosticCarrier = Error & {
	code?: unknown;
	stage?: unknown;
	details?: unknown;
	diagnostic?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const toOptionalString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
};

const toStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const normalized = value
		.map((item) => toOptionalString(item))
		.filter((item): item is string => Boolean(item));
	return normalized.length > 0 ? normalized : undefined;
};

const stringifyRecord = (value: Record<string, unknown>): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

export const mergeErrorDetails = (
	...detailGroups: Array<string[] | undefined>
): string[] | undefined => {
	const merged: string[] = [];
	for (const group of detailGroups) {
		if (!group) {
			continue;
		}
		for (const item of group) {
			if (!merged.includes(item)) {
				merged.push(item);
			}
		}
	}
	return merged.length > 0 ? merged : undefined;
};

export const normalizeErrorDiagnostic = (error: unknown): ErrorDiagnostic => {
	if (typeof error === "string") {
		return { message: error };
	}

	if (error instanceof Error) {
		const carrier = error as DiagnosticCarrier;
		const nested = isRecord(carrier.diagnostic) ? carrier.diagnostic : undefined;
		return {
			message:
				toOptionalString(nested?.message) ??
				toOptionalString(error.message) ??
				String(error),
			name:
				toOptionalString(nested?.name) ??
				toOptionalString(error.name) ??
				undefined,
			code:
				toOptionalString(nested?.code) ??
				toOptionalString(carrier.code) ??
				undefined,
			stage:
				toOptionalString(nested?.stage) ??
				toOptionalString(carrier.stage) ??
				undefined,
			stack:
				toOptionalString(nested?.stack) ??
				toOptionalString(error.stack) ??
				undefined,
			details: mergeErrorDetails(
				toStringArray(nested?.details),
				toStringArray(carrier.details),
			),
		};
	}

	if (isRecord(error)) {
		const nested = isRecord(error.diagnostic) ? error.diagnostic : undefined;
		return {
			message:
				toOptionalString(nested?.message) ??
				toOptionalString(error.message) ??
				stringifyRecord(error),
			name:
				toOptionalString(nested?.name) ??
				toOptionalString(error.name) ??
				undefined,
			code:
				toOptionalString(nested?.code) ??
				toOptionalString(error.code) ??
				undefined,
			stage:
				toOptionalString(nested?.stage) ??
				toOptionalString(error.stage) ??
				undefined,
			stack:
				toOptionalString(nested?.stack) ??
				toOptionalString(error.stack) ??
				undefined,
			details: mergeErrorDetails(
				toStringArray(nested?.details),
				toStringArray(error.details),
			),
		};
	}

	return { message: String(error) };
};

export const createErrorFromDiagnostic = (diagnostic: ErrorDiagnostic): Error => {
	const error = new Error(diagnostic.message);
	if (diagnostic.name) {
		error.name = diagnostic.name;
	}
	if (diagnostic.stack) {
		error.stack = diagnostic.stack;
	}
	return applyErrorDiagnostic(error, diagnostic);
};

export const applyErrorDiagnostic = (
	error: Error,
	diagnostic: Omit<ErrorDiagnostic, "message">,
): Error => {
	const carrier = error as DiagnosticCarrier;
	if (diagnostic.name) {
		error.name = diagnostic.name;
	}
	if (diagnostic.stack) {
		error.stack = diagnostic.stack;
	}
	if (diagnostic.code) {
		carrier.code = diagnostic.code;
	}
	if (diagnostic.stage) {
		carrier.stage = diagnostic.stage;
	}
	if (diagnostic.details && diagnostic.details.length > 0) {
		carrier.details = diagnostic.details;
	}
	return error;
};
