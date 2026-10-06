/**
 * OpenCode free-tier identity for nested model calls.
 *
 * pi applies extension `before_provider_headers` hooks to the main agent
 * request only. A nested `modelRegistry.streamSimple(...)` - this extension's
 * titling call, /btw's side question - goes straight to the provider, so the
 * free-tier patch never runs and OpenCode answers 403 FreeTierError.
 *
 * `streamNestedOpencode` applies the same contract to any nested call:
 * - official CLI User-Agent and `x-opencode-client: cli`
 * - a canonical `ses_...` session id derived from the caller's sessionId, so
 *   the free tier sees the request as a continuation of the CLI session
 * - no x-opencode-project / x-opencode-request headers (the CLI sends none)
 * - auth ladder: a credential already on the wire, then OPENCODE_ZEN_API_KEY,
 *   then OPENCODE_API_KEY, then the `opencode auth login` OAuth token, then
 *   anonymous "Bearer public"
 * A 403 on a free model retries with the next untried strategy.
 *
 * Mirrors ~/.pi/agent/extensions/opencode-free-tier, which covers the main
 * agent request path only.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENCODE_USER_AGENT = "opencode/latest/2.0.18/cli";
const OPENCODE_CLIENT = "cli";
const OPENCODE_HOST = "opencode.ai";
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-zen", "opencode-go"]);
const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZEN_KEY_ENV_VARS = ["OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"];

type AuthStrategy = "wire" | "env-key" | "oauth" | "public";

/** Auth attempts that came back 403, per "<provider>/<model>", so the ladder skips them for the rest of the session. */
const failedStrategies = new Map<string, Set<AuthStrategy>>();

let lastSessionTimestamp = 0;
let sessionCounter = 0;

export interface NestedModel {
	provider?: string;
	id?: string;
	baseUrl?: string;
}

export interface ResolvedCredential {
	/** "resolved": pi holds a credential (or the provider is keyless). "unconfigured": pi says it has none. "unknown": no resolver to ask. */
	status: "resolved" | "unconfigured" | "unknown";
	apiKey?: string;
	headers?: Record<string, any>;
}

export interface NestedStreamEvent {
	type: string;
	// biome-ignore lint/suspicious/noExplicitAny: provider events carry open per-type payloads
	[key: string]: any;
}

export interface NestedStreamOptions {
	sessionId?: string;
	signal?: AbortSignal;
	transformHeaders?: (headers: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>;
	[key: string]: unknown;
}

export interface NestedRegistry {
	streamSimple(model: NestedModel, context: unknown, options?: NestedStreamOptions): unknown;
}

function randomBase62(length: number): string {
	const bytes = randomBytes(length);
	return Array.from(bytes, (byte) => BASE62[byte % BASE62.length]).join("");
}

function generateSessionId(): string {
	const timestamp = Date.now();
	if (timestamp === lastSessionTimestamp) {
		sessionCounter += 1;
	} else {
		lastSessionTimestamp = timestamp;
		sessionCounter = 1;
	}
	const rawValue = BigInt(timestamp) * 0x1000n + BigInt(sessionCounter);
	const value = ~rawValue;
	const encodedTimestamp = Array.from({ length: 6 }, (_, index) =>
		Number((value >> BigInt(40 - 8 * index)) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
	return `ses_${encodedTimestamp}${randomBase62(14)}`;
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

/** Keep canonical ids as-is; translate anything else (pi UUIDs) into the shape the CLI sends. */
function translateSessionId(sessionId: string): string {
	const normalized = sessionId.trim();
	if (OPENCODE_SESSION_RE.test(normalized)) return normalized;
	const digest = createHash("sha256")
		.update(`opencode\0${OPENCODE_CLIENT}\0${normalized}`)
		.digest();
	const suffix = Array.from(digest.subarray(6, 20), (byte) => BASE62[byte % BASE62.length]).join("");
	return `ses_${toHex(digest.subarray(0, 6))}${suffix}`;
}

export function isOpencodeModel(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const m = model as NestedModel;
	return OPENCODE_PROVIDERS.has(m.provider ?? "") || (typeof m.baseUrl === "string" && m.baseUrl.includes(OPENCODE_HOST));
}

function isOpencodeZenModel(model: NestedModel): boolean {
	return model.provider === "opencode" || model.provider === "opencode-zen";
}

/** Only the `-free` models need the CLI identity; paid models keep pi's own headers. */
export function isFreeTierModel(model: unknown): boolean {
	if (!model || typeof model !== "object") return false;
	const id = (model as NestedModel).id;
	return typeof id === "string" && id.endsWith("-free");
}

function cliOAuthAccessToken(): string | undefined {
	try {
		const xdg = process.env.XDG_DATA_HOME?.trim();
		const dataDir = xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode");
		const parsed: unknown = JSON.parse(readFileSync(join(dataDir, "auth.json"), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const entry = (parsed as Record<string, unknown>).opencode;
		if (!entry || typeof entry !== "object") return undefined;
		const e = entry as Record<string, unknown>;
		if (e.type !== "oauth") return undefined;
		if (typeof e.enterpriseUrl === "string" && e.enterpriseUrl !== "") return undefined;
		if (typeof e.access !== "string" || e.access === "") return undefined;
		if (typeof e.expires === "number" && e.expires <= Date.now() + 5 * 60 * 1000) return undefined;
		return e.access;
	} catch {
		return undefined;
	}
}

function envZenApiKey(): string | undefined {
	for (const name of ZEN_KEY_ENV_VARS) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

/** True when the value on the wire is not a real credential: absent, empty, pi's "unused" token, or the anonymous placeholder. */
function isPlaceholderAuth(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	const v = String(value).trim().toLowerCase();
	return v === "" || v === "bearer" || v === "bearer public" || v === "none" || v === "unused" || v === "bearer unused";
}

function authHeaderValue(strategy: AuthStrategy): string {
	if (strategy === "env-key") return `Bearer ${envZenApiKey()}`;
	if (strategy === "oauth") return `Bearer ${cliOAuthAccessToken()}`;
	return "Bearer public";
}

function ladderStrategies(): AuthStrategy[] {
	const strategies: AuthStrategy[] = [];
	if (envZenApiKey()) strategies.push("env-key");
	if (cliOAuthAccessToken()) strategies.push("oauth");
	strategies.push("public");
	return strategies;
}

/** Next strategy to try for this model; `wire` counts only when a real credential is on the wire. */
function nextStrategy(modelKey: string, allowWire: boolean): AuthStrategy | undefined {
	const failed = failedStrategies.get(modelKey);
	if (allowWire && !failed?.has("wire")) return "wire";
	return ladderStrategies().find((s) => !failed?.has(s));
}

function modelKeyOf(model: NestedModel): string {
	return `${model.provider ?? ""}/${model.id ?? ""}`;
}

function isForbidden(event: NestedStreamEvent): boolean {
	if (event.type !== "error") return false;
	const message = String(event.error?.errorMessage ?? event.errorMessage ?? "");
	return /(^|\D)403(\D|$)/.test(message) || /freetier/i.test(message);
}

/**
 * pi's own credential resolution for this model, the same one the main agent
 * path uses. Mirroring it matters: the OpenAI-compatible providers skip their
 * own `Authorization` header when the caller already supplied one, so injecting
 * a placeholder on a call where pi holds a real key silently downgrades it to
 * the anonymous tier (429 FreeUsageLimitError).
 */
async function resolveCredential(registry: NestedRegistry, model: NestedModel): Promise<ResolvedCredential> {
	const resolver = (registry as { getApiKeyAndHeaders?: (m: NestedModel) => Promise<any> }).getApiKeyAndHeaders;
	if (typeof resolver !== "function") return { status: "unknown" };
	try {
		const resolved = await resolver.call(registry, model);
		if (!resolved?.ok) return { status: "unconfigured" };
		return { status: "resolved", apiKey: resolved.apiKey, headers: resolved.headers };
	} catch {
		return { status: "unknown" };
	}
}

/**
 * Header transform that makes one nested request look like official OpenCode
 * CLI traffic. `chosen` receives the auth strategy used, for the retry loop.
 */
export function applyOpencodeIdentity(
	model: NestedModel,
	headers: Record<string, any>,
	sessionSeed: string | undefined,
	chosen: { strategy?: AuthStrategy },
	credential?: ResolvedCredential,
): Record<string, any> {
	if (!isOpencodeModel(model)) return headers;
	const out: Record<string, any> = { ...headers };

	if (isOpencodeZenModel(model)) {
		const wireAuth = out.Authorization ?? out.authorization;
		const credentialAuth = credential?.headers?.Authorization ?? credential?.headers?.authorization;
		const credentialKey =
			credential?.status === "resolved"
				? typeof credential.apiKey === "string" && credential.apiKey !== ""
					? credential.apiKey
					: !isPlaceholderAuth(credentialAuth)
						? String(credentialAuth).replace(/^\s*bearer\s+/i, "")
						: undefined
				: undefined;

		if (!isPlaceholderAuth(wireAuth) && wireAuth !== undefined) {
			// A real credential is already on the wire: keep it verbatim under one
			// spelling, so the provider cannot pick up a stale lowercase duplicate.
			delete out.authorization;
			delete out.Authorization;
			out.Authorization = String(wireAuth);
			chosen.strategy = "wire";
		} else if (credentialKey) {
			delete out.authorization;
			delete out.Authorization;
			out.Authorization = `Bearer ${credentialKey}`;
			chosen.strategy = "wire";
		} else if (credential?.status === "resolved" || credential?.status === "unconfigured" || ladderStrategies().some((s) => s !== "public")) {
			// pi holds no credential, or the provider is keyless: fall down the
			// ladder, ending at the anonymous tier.
			delete out.Authorization;
			delete out.authorization;
			delete out["x-api-key"];
			const strategy = nextStrategy(modelKeyOf(model), false) ?? "public";
			out.Authorization = authHeaderValue(strategy);
			chosen.strategy = strategy;
		}
		// else: no resolver and no ladder credential - leave the headers alone so
		// the provider can still apply whatever pi resolved for itself.
	}

	if (isFreeTierModel(model)) {
		out["User-Agent"] = OPENCODE_USER_AGENT;
		delete out["user-agent"];
		out["x-opencode-client"] = OPENCODE_CLIENT;
		delete out["x-opencode-project"];
		delete out["x-opencode-request"];
		delete out["x-opencode-request-id"];
		// pi's opencode provider only adds this header when it is absent, so
		// setting a canonical id here keeps a caller's UUID from reaching the wire.
		const seed = typeof out["x-opencode-session"] === "string" ? String(out["x-opencode-session"]) : sessionSeed;
		out["x-opencode-session"] = seed ? translateSessionId(seed) : generateSessionId();
	}

	return out;
}

/**
 * Drop-in replacement for `registry.streamSimple(...)` in nested calls.
 * Yields the same events, but holds back the terminal event while a 403 on a
 * free-tier model is retried with the next auth strategy.
 */
export async function* streamNestedOpencode(
	registry: NestedRegistry,
	model: NestedModel,
	context: unknown,
	options: NestedStreamOptions = {},
): AsyncGenerator<NestedStreamEvent> {
	const modelKey = modelKeyOf(model);
	const retryable = isOpencodeZenModel(model) && isFreeTierModel(model);
	const chosen: { strategy?: AuthStrategy } = {};
	const incoming = options.transformHeaders;
	const credential = await resolveCredential(registry, model);
	const withKey = credential.status === "resolved" && credential.apiKey ? { apiKey: credential.apiKey } : {};

	for (;;) {
		const requestOptions: NestedStreamOptions = {
			...options,
			...withKey,
			transformHeaders: async (headers: Record<string, any>) => {
				const base = incoming ? await incoming(headers) : headers;
				return applyOpencodeIdentity(model, base, options.sessionId, chosen, credential);
			},
		};

		const stream = (await registry.streamSimple(model, context, requestOptions)) as AsyncIterable<NestedStreamEvent>;
		let terminal: NestedStreamEvent | undefined;
		for await (const event of stream) {
			if (event?.type === "done" || event?.type === "error") {
				terminal = event;
				continue;
			}
			yield event;
		}

		if (!terminal) return;

		const aborted = (options.signal as AbortSignal | undefined)?.aborted === true;
		if (retryable && !aborted && isForbidden(terminal) && markFailed(modelKey, chosen.strategy)) continue;

		yield terminal;
		return;
	}
}

/** Record the rejected strategy; true when another one is left to try. */
function markFailed(modelKey: string, strategy: AuthStrategy | undefined): boolean {
	if (!strategy || strategy === "public") return false;
	let failed = failedStrategies.get(modelKey);
	if (!failed) {
		failed = new Set<AuthStrategy>();
		failedStrategies.set(modelKey, failed);
	}
	failed.add(strategy);
	// "wire" is only reachable again if a different credential appears later,
	// which the header transform re-checks on every call.
	return nextStrategy(modelKey, false) !== undefined;
}