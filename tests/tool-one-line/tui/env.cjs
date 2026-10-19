/**
 * Shared setup for the real-TUI suites: spawn `pi` with only this repo's
 * extension loaded, in an isolated config directory so a developer's own
 * extensions, packages and settings cannot change the layout under test.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const EXTENSION = path.join(REPO, "extensions", "tool-one-line.ts");
const HOME = path.join(REPO, "tmp", "tui-home");

/** Layout expectations in these suites assume hidden thinking and no output padding. */
const SETTINGS = { hideThinkingBlock: true, outputPad: 0, terminal: { clearOnShrink: true } };

function prepare() {
	fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true });
	fs.writeFileSync(path.join(HOME, "settings.json"), `${JSON.stringify(SETTINGS, null, "\t")}\n`);
	const source = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	for (const file of ["auth.json", "models-store.json"]) {
		const from = path.join(source, file);
		const to = path.join(HOME, file);
		if (fs.existsSync(from)) fs.copyFileSync(from, to);
	}
	if (!fs.existsSync(path.join(HOME, "auth.json"))) {
		console.error(`warning: ${path.join(source, "auth.json")} not found; pi will ask for credentials and the suite will fail`);
	}
}

prepare();

const env = {
	...process.env,
	TERM: "xterm-256color",
	PI_CODING_AGENT_DIR: HOME,
	PI_CODING_AGENT_SESSION_DIR: path.join(HOME, "sessions"),
};

/** `pi` is a .cmd on Windows, so it goes through the shell; keep args separate. */
const piArgs = (args) => ["/c", "pi", "-e", EXTENSION, ...args];

module.exports = { REPO, EXTENSION, HOME, env, piArgs };
