// title: auto-titles pi sessions. After the first completed run, one cheap
// nested streamSimple call turns the opening exchange into a 2-6 word title
// and sets it via pi.setSessionName() — the session selector then shows
// "Fix rate limiter bug" instead of the raw first prompt. Fail-open: any
// surprise (no model, provider error, odd message shapes) leaves the session
// unnamed and retries on the next run, at most MAX_ATTEMPTS times.
//
// /title            — show the current title
// /title <text>     — set a manual title (auto never overrides it)
// /title auto       — regenerate now from the first exchange
// /title on|off     — toggle auto-titling (process-wide)
//
// PI_TITLE=off disables the extension entirely (A/B switch).
// PI_TITLE_MODEL=provider/id overrides the titling model (default: the
// session's active model).
//
// The titling call is nested (modelRegistry.streamSimple), which skips pi's
// before_provider_headers hooks - so it carries the OpenCode free-tier
// identity itself via ./opencode-nested, or OpenCode answers 403.

import { streamNestedOpencode } from "./opencode-nested.ts";

const MAX_ATTEMPTS = 3;
const SOURCE_CAP = 1500; // chars of each message fed to the titler
const TITLE_CAP = 60; // chars of the final title

const SYSTEM =
	"You write short conversation titles. Reply with the title only: 2 to 6 words, no quotes, no trailing punctuation.";

type StreamChunk = { type: string; message?: { content?: unknown } };

let autoOn = true;
let titled = false; // this session has a title (auto or manual) — auto stands down
let attempts = 0;
let busy = false;
let inflight: Promise<void> | null = null;

// Source texts captured from the first run that had content, so /title auto
// works from command context too (commands receive no event messages).
let sourceUser: string | null = null;
let sourceAssistant: string | null = null;

function textOf(msg: unknown, role: string): string {
	if (!msg || typeof msg !== "object") return "";
	const m = msg as Record<string, any>;
	if (m.role !== role) return "";
	const content = m.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	for (const block of content) {
		if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
			const t = (block as any).text.trim();
			if (t) return t;
		}
	}
	return "";
}

function cap(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;
}

/** Best-effort cleanup of whatever the model returned; null when unusable. */
function sanitize(raw: string): string | null {
	let line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	line = line.replace(/\s+/g, " ").trim();
	// Repeat until stable: markdown edges, a "Title:" prefix, and trailing
	// punctuation peel off in any order ("**Title:** Refactor…" needs it).
	for (;;) {
		const before = line;
		line = line.replace(/^(?:title\s*:\s*|#+\s*|[*_`"'\s])+/i, "");
		line = line.replace(/[*_`"'\s]+$/, "");
		line = line.replace(/[.!?…]+$/, "");
		if (line === before) break;
	}
	if (!line) return null;
	return cap(line, TITLE_CAP);
}

export default function (pi: any) {
	if (process.env.PI_TITLE === "off") return;

	async function generate(ctx: any): Promise<string | null> {
		if (!sourceUser) return null;

		// Model: PI_TITLE_MODEL=provider/id wins, else the session's active
		// model. Resolved per call so mid-session model switches are fine.
		let model: unknown = ctx?.model;
		const override = process.env.PI_TITLE_MODEL;
		if (override) {
			const slash = override.indexOf("/");
			model = slash === -1 ? { provider: "", id: override } : { provider: override.slice(0, slash), id: override.slice(slash + 1) };
		}
		const registry = ctx?.modelRegistry;
		if (!model || !registry || typeof registry.streamSimple !== "function") return null;

		const prompt = [
			"Write the conversation title for this exchange.",
			"",
			`User: ${cap(sourceUser!, SOURCE_CAP)}`,
			"",
			`Assistant: ${sourceAssistant ? cap(sourceAssistant, SOURCE_CAP) : "(no reply yet)"}`,
		].join("\n");

		try {
			const events = streamNestedOpencode(
				registry,
				model,
				{
					systemPrompt: SYSTEM,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
				},
				{ reasoning: "off" },
			);
			let final: StreamChunk | null = null;
			for await (const chunk of events) {
				if (chunk?.type === "done" || chunk?.type === "error") final = chunk as StreamChunk;
			}
			if (!final || final.type !== "done") return null;
			const output = textOf(final.message, "assistant");
			return output ? sanitize(output) : null;
		} catch {
			return null;
		}
	}

	async function run(ctx: any, notify: ((text: string, kind?: "info" | "warning" | "error") => void) | null) {
		busy = true;
		try {
			const title = await generate(ctx);
			if (title) {
				titled = true;
				pi.setSessionName(title);
				notify?.(`title: "${title}"`);
			} else if (attempts >= MAX_ATTEMPTS) {
				notify?.(`title: giving up after ${attempts} failed attempts — /title <text> to set one manually`, "warning");
			}
		} finally {
			busy = false;
		}
	}

	pi.on("session_start", () => {
		// A resumed session that already carries a name stays as it is.
		titled = Boolean(pi.getSessionName());
		attempts = 0;
		busy = false;
		inflight = null;
		sourceUser = null;
		sourceAssistant = null;
	});

	pi.on("agent_end", (event: { messages?: unknown[] }, ctx: any) => {
		// Capture the first exchange before any guard, so /title auto has a
		// source even when this session was titled manually from the start.
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		const userText = messages.map((m) => textOf(m, "user")).find((t) => t.length > 0);
		if (!userText) return; // nothing to title from; don't burn an attempt
		if (!sourceUser) {
			sourceUser = userText;
			sourceAssistant = messages.map((m) => textOf(m, "assistant")).find((t) => t.length > 0) ?? null;
		}

		if (!autoOn || titled || busy || attempts >= MAX_ATTEMPTS) return;

		attempts++;
		// Fire-and-forget: a title is never worth delaying the run boundary.
		inflight = run(ctx, ctx?.ui?.notify?.bind(ctx.ui) ?? null).catch(() => {
			busy = false;
		});
	});

	pi.registerCommand("title", {
		description: "Show, set, or auto-generate the session title (usage: /title [text|auto|on|off])",
		handler: async (args: string, ctx: any) => {
			const arg = args.trim();
			if (!arg) {
				const current = pi.getSessionName();
				ctx.ui.notify(
					current
						? `title: "${current}" (auto ${autoOn ? "on" : "off"})`
						: `title: none yet (auto ${autoOn ? "on" : "off"}, ${attempts}/${MAX_ATTEMPTS} attempts)`,
				);
				return;
			}
			if (arg === "on" || arg === "off") {
				autoOn = arg === "on";
				ctx.ui.notify(`title: auto-titling ${autoOn ? "on" : "off"}`);
				return;
			}
			if (arg === "auto") {
				if (busy) {
					ctx.ui.notify("title: already generating");
					return;
				}
				if (!sourceUser) {
					ctx.ui.notify("title: nothing to title yet — send a message first", "warning");
					return;
				}
				attempts = 0;
				inflight = run(ctx, ctx.ui.notify.bind(ctx.ui)).catch(() => {
					busy = false;
				});
				await inflight;
				return;
			}
			pi.setSessionName(arg);
			titled = true; // a manual title is never overridden by auto
			ctx.ui.notify(`title: "${arg}"`);
		},
	});
}
