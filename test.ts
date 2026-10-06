/**
 * Smoke test: runs index.ts against a fake ExtensionAPI with a canned
 * streamSimple. No network, no real model, no real pi. `bun test.ts`.
 */

const { default: activate } = await import("./index.ts");

// --- fake pi -----------------------------------------------------------------

type Handler = (event: any, ctx?: any) => any;

function makeFake(titles: string[] | null, fail: boolean) {
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, { handler: Handler }> = {};
	const calls: { model: any; context: any; options: any }[] = [];
	let name: string | undefined;
	const notes: string[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand(cmd: string, opts: { handler: Handler }) {
			commands[cmd] = opts;
		},
		setSessionName(next: string) {
			name = next;
		},
		getSessionName() {
			return name;
		},
	};
	const ctx: any = {
		model: { provider: "test", id: "m1" },
		ui: { notify: (m: string, k?: any) => notes.push(m) },
		modelRegistry: titles || fail
			? {
					streamSimple: (_model: any, context: any, options: any) => {
						calls.push({ model: _model, context, options });
						return (async function* () {
							if (fail) yield { type: "error", error: "boom" };
							else yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: titles!.shift()! }] } };
						})();
					},
				}
			: { streamSimple: undefined },
	};
	const fire = (event: string, payload: any) => (handlers[event] ?? []).forEach((h) => h(payload, ctx));
	return { pi, ctx, handlers, commands, calls, notes, fire, get name() { return name; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- asserts -----------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) {
		passed++;
	} else {
		failed++;
		console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

async function settle(fake: ReturnType<typeof makeFake>, timeoutMs = 1000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) await sleep(20);
}

// --- tests -------------------------------------------------------------------

// Off switch: registers nothing.
process.env.PI_TITLE = "off";
{
	const fake = makeFake(["Ignored"], false);
	activate(fake.pi);
	check("PI_TITLE=off registers nothing", !fake.handlers["agent_end"] && !fake.commands["title"]);
}
delete process.env.PI_TITLE;

// Happy path: titles after the first run, sanitized.
{
	const fake = makeFake(['"Fix the Rate Limiter Bug".'], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", {
		messages: [
			{ role: "user", content: [{ type: "text", text: "My rate limiter fails under burst traffic, why?" }] },
			{ role: "assistant", content: [{ type: "text", text: "Because the fixed window allows 2x burst at the boundary." }] },
		],
	});
	await settle(fake);
	check("auto-titles after first run", fake.name === "Fix the Rate Limiter Bug", `got: ${fake.name}`);
	check("title call used session model", fake.calls[0]?.model?.id === "m1");
	check("title call disables reasoning", fake.calls[0]?.options?.reasoning === "off");
	check("prompt carries the exchange", String(fake.calls[0]?.context?.messages?.[0]?.content?.[0]?.text ?? "").includes("rate limiter fails"));
	fake.fire("agent_end", { messages: [{ role: "user", content: [{ type: "text", text: "second question" }] }] });
	check("titled session is not retitled", fake.calls.length === 1);
}

// Sanitizer strips prefixes, markdown, punctuation; caps length.
{
	const fake = makeFake(["**Title:** Refactor the auth middleware flow!!"], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "refactor auth" }] });
	await settle(fake);
	check("sanitizes model output", fake.name === "Refactor the auth middleware flow", `got: ${fake.name}`);
}
{
	const fake = makeFake(["x".repeat(100)], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "long" }] });
	await settle(fake);
	check("caps title length at 60", (fake.name?.length ?? 0) <= 61, `got: ${fake.name?.length}`);
}

// No user text: no call, no attempt burned.
{
	const fake = makeFake(["Unused"], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "only assistant" }] }] });
	await settle(fake);
	check("no user text skips titling", fake.calls.length === 0 && !fake.name);
}

// Failing stream: retries on later runs, warns and stops after 3.
{
	const fake = makeFake(null, true);
	activate(fake.pi);
	fake.fire("session_start", {});
	for (let i = 0; i < 3; i++) {
		fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
		await settle(fake);
	}
	fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
	await settle(fake);
	check("gives up after 3 failed attempts", fake.calls.length === 3 && fake.notes.some((n) => n.includes("giving up after 3")));
}

// /title auto with no source warns; manual title wins and blocks auto;
// /title auto overrides it on demand.
{
	const fake = makeFake(["Regenerated Title"], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	await fake.commands["title"].handler("auto", fake.ctx);
	check("/title auto with no source warns", fake.notes.some((n) => n.includes("nothing to title")));
	await fake.commands["title"].handler("My Manual Title", fake.ctx);
	check("manual title is set", fake.name === "My Manual Title");
	fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
	await settle(fake);
	check("auto never overrides manual title", fake.calls.length === 0);
	await fake.commands["title"].handler("auto", fake.ctx);
	check("/title auto regenerates", fake.name === "Regenerated Title" && fake.calls.length === 1);
}

// /title off stops auto-titling.
{
	const fake = makeFake(["Unused"], false);
	activate(fake.pi);
	fake.fire("session_start", {});
	await fake.commands["title"].handler("off", fake.ctx);
	fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
	await settle(fake);
	check("/title off stops auto", fake.calls.length === 0 && !fake.name);
}

// session_start: unnamed fresh session arms auto; resumed named session stands down.
{
	const fake = makeFake(["Fresh Title"], false);
	activate(fake.pi);
	fake.pi.setSessionName("Carried Over");
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
	await settle(fake);
	check("resumed named session not retitled", fake.calls.length === 0 && fake.name === "Carried Over");
}

// PI_TITLE_MODEL override is honored. (Auto was switched off by an earlier
// block — autoOn is process-wide by design, so switch it back on first.)
{
	const fake = makeFake(["Override Model Used"], false);
	activate(fake.pi);
	process.env.PI_TITLE_MODEL = "other/cheap-model";
	fake.fire("session_start", {});
	await fake.commands["title"].handler("on", fake.ctx);
	fake.fire("agent_end", { messages: [{ role: "user", content: "q" }] });
	await settle(fake);
	delete process.env.PI_TITLE_MODEL;
	check("PI_TITLE_MODEL overrides session model", fake.calls[0]?.model?.provider === "other" && fake.calls[0]?.model?.id === "cheap-model");
}

// Nested calls skip pi's before_provider_headers hooks, so pi-title sends the
// OpenCode free-tier identity itself: CLI User-Agent, x-opencode-client, a
// canonical ses_ session id, no project/request headers.
{
	const headers: Record<string, any>[] = [];
	process.env.OPENCODE_ZEN_API_KEY = "ladder-key";
	const fake = makeFake(["Free Tier Title"], false);
	fake.ctx.model = { provider: "opencode", id: "space-bunny-free" };
	fake.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) =>
		(async function* () {
			headers.push(await options.transformHeaders({ authorization: "Bearer unused", "x-opencode-project": "pi" }));
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "Free Tier Title" }] } };
		})();
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "free tier question" }] });
	await settle(fake);
	delete process.env.OPENCODE_ZEN_API_KEY;
	const sent = headers[0] ?? {};
	check("sends opencode CLI identity", sent["User-Agent"] === "opencode/latest/2.0.18/cli" && sent["x-opencode-client"] === "cli", JSON.stringify(sent));
	check("sends canonical ses_ session id", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(String(sent["x-opencode-session"])), String(sent["x-opencode-session"]));
	check("drops opencode project header", sent["x-opencode-project"] === undefined);
	check("replaces placeholder auth with the env console key", sent.Authorization === "Bearer ladder-key", String(sent.Authorization));
	check("titles on a free-tier model", fake.name === "Free Tier Title", `got: ${fake.name}`);
}

// A 403 on a free model retries with the next auth strategy instead of giving up.
{
	let attempts = 0;
	const usedAuth: string[] = [];
	process.env.OPENCODE_ZEN_API_KEY = "ladder-key";
	const fake = makeFake(["Retried Title"], false);
	fake.ctx.model = { provider: "opencode", id: "space-bunny-free" };
	fake.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false });
	fake.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) =>
		(async function* () {
			attempts++;
			const headers = await options.transformHeaders({});
			usedAuth.push(String(headers.Authorization));
			if (attempts === 1) {
				yield { type: "error", error: { errorMessage: "403 Forbidden (FreeTierError): rejected" } };
				return;
			}
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "Retried Title" }] } };
		})();
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "403 question" }] });
	await settle(fake);
	delete process.env.OPENCODE_ZEN_API_KEY;
	check("retries once after a free-tier 403", attempts === 2 && fake.name === "Retried Title", `attempts=${attempts} name=${fake.name}`);
	check("retry walks down the auth ladder", usedAuth[0] === "Bearer ladder-key" && usedAuth[1] === "Bearer public", usedAuth.join(" -> "));
}

// Regression: the OpenAI-compatible providers skip their own Authorization when
// the caller supplied one, so a placeholder injected on a nested call silently
// downgrades pi's real key to the anonymous tier (429 FreeUsageLimitError).
{
	const seen: { headers: Record<string, any>; options: any }[] = [];
	const fake = makeFake(["Credential Title"], false);
	fake.ctx.model = { provider: "opencode", id: "space-bunny-free" };
	fake.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "REAL-KEY" });
	fake.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) =>
		(async function* () {
			seen.push({ headers: await options.transformHeaders({}), options });
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "Credential Title" }] } };
		})();
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "credential question" }] });
	await settle(fake);
	check("keeps pi's resolved credential", seen[0]?.headers?.Authorization === "Bearer REAL-KEY", String(seen[0]?.headers?.Authorization));
	check("passes pi's api key through", seen[0]?.options?.apiKey === "REAL-KEY");
	check("titles with a real credential", fake.name === "Credential Title", `got: ${fake.name}`);
}

// A real credential already on the wire is never replaced.
{
	const seen: Record<string, any>[] = [];
	const fake = makeFake(["Wire Title"], false);
	fake.ctx.model = { provider: "opencode", id: "space-bunny-free" };
	fake.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "RESOLVED-KEY" });
	fake.ctx.modelRegistry.streamSimple = (_model: any, _context: any, options: any) =>
		(async function* () {
			seen.push(await options.transformHeaders({ Authorization: "Bearer WIRE-KEY" }));
			yield { type: "done", message: { role: "assistant", content: [{ type: "text", text: "Wire Title" }] } };
		})();
	activate(fake.pi);
	fake.fire("session_start", {});
	fake.fire("agent_end", { messages: [{ role: "user", content: "wire question" }] });
	await settle(fake);
	check("never downgrades a wire credential", seen[0]?.Authorization === "Bearer WIRE-KEY", String(seen[0]?.Authorization));
}

// -----------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

export {};
