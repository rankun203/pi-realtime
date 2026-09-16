// Log structured diagnostics, never raw provider errors: they can contain credentials or request bodies.
const networkReasons: Record<string, string> = {
	ENOTFOUND: "DNS lookup failed. Check the network or VPN DNS settings",
	EAI_AGAIN: "DNS lookup temporarily failed. Check the network or VPN DNS settings",
	ECONNREFUSED: "Connection refused by the remote endpoint",
	ECONNRESET: "Connection was reset",
	ETIMEDOUT: "Connection timed out",
	ENETUNREACH: "Network is unreachable",
	EHOSTUNREACH: "Remote host is unreachable",
	UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
	UND_ERR_HEADERS_TIMEOUT: "Timed out waiting for response headers",
	UND_ERR_BODY_TIMEOUT: "Timed out reading the response",
	UND_ERR_SOCKET: "Network socket closed unexpectedly",
	CERT_HAS_EXPIRED: "TLS certificate has expired",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate could not be verified",
	SELF_SIGNED_CERT_IN_CHAIN: "TLS certificate chain is not trusted",
	DEPTH_ZERO_SELF_SIGNED_CERT: "TLS certificate is self-signed",
	ERR_TLS_CERT_ALTNAME_INVALID: "TLS certificate does not match the hostname",
};

export class VoiceTransportError extends Error {
	constructor(
		readonly operation: string,
		readonly hostname: string,
		readonly diagnostics: ReturnType<typeof safeErrorDetails>,
	) {
		const reason = diagnostics.httpStatus
			? `Provider returned HTTP ${diagnostics.httpStatus}`
			: diagnostics.codes.length
				? diagnostics.codes.map((code) => `${networkReasons[code]} (${code})`).join("; ")
				: diagnostics.kind === "TimeoutError"
					? "Request timed out"
					: diagnostics.kind === "SyntaxError"
						? "Provider returned an invalid response"
						: "Network or provider request failed; no recognized cause was supplied";
		super(`${operation} failed for ${hostname}: ${reason}.`);
		this.name = "VoiceTransportError";
	}
}

/** Keep nested fetch/AggregateError causes useful without copying arbitrary messages, URLs, or headers. */
export function safeErrorDetails(error: unknown): { kind: string; codes: string[]; httpStatus?: number } {
	const codes = new Set<string>();
	let httpStatus: number | undefined;
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || depth > 5) return;
		const e = value as { code?: unknown; status?: unknown; cause?: unknown; errors?: unknown };
		if (typeof e.code === "string" && Object.hasOwn(networkReasons, e.code)) codes.add(e.code);
		if (typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599)
			httpStatus ??= e.status;
		visit(e.cause, depth + 1);
		if (Array.isArray(e.errors)) e.errors.slice(0, 8).forEach((child) => visit(child, depth + 1));
	};
	visit(error, 0);
	const name = error instanceof Error ? error.name : "UnknownError";
	const kind = ["Error", "TypeError", "SyntaxError", "TimeoutError", "AbortError", "AggregateError"].includes(name)
		? name
		: "Error";
	return { kind, codes: [...codes], ...(httpStatus === undefined ? {} : { httpStatus }) };
}

export function voiceErrorRecord(error: unknown): Record<string, unknown> {
	return error instanceof VoiceTransportError
		? { operation: error.operation, hostname: error.hostname, message: error.message, ...error.diagnostics }
		: safeErrorDetails(error);
}

export async function voiceOperation<T>(operation: string, url: string, action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (error) {
		throw new VoiceTransportError(operation, new URL(url).hostname, safeErrorDetails(error));
	}
}
