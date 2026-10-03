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

// -----------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

export {};
