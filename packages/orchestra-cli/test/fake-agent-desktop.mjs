#!/usr/bin/env node
// Fake agent-desktop shim for orchestra-cli doctor tests (Part C).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const countFile = process.env.FAKE_DESKTOP_COUNT_FILE;
if (countFile) {
	try {
		appendFileSync(countFile, `${cmd}\n`);
	} catch {
		// ignore
	}
}
const mode = process.env.FAKE_DESKTOP_MODE ?? "ok";

function envelope(ok, command, data, error) {
	const out = { version: "2.6", ok, command };
	if (data !== undefined) out.data = data;
	if (error !== undefined) out.error = error;
	process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (cmd === "--version") {
	process.stdout.write(`agent-desktop ${mode === "mismatch" ? "1.2.0" : "1.0.2"}\n`);
	process.exit(0);
}

if (cmd === "version") {
	envelope(true, "version", {
		version: mode === "mismatch" ? "1.2.0" : "1.0.2",
		target: "aarch64",
		os: "macos",
	});
	process.exit(0);
}

if (cmd === "status") {
	if (mode === "status-denied") {
		envelope(false, "status", undefined, {
			code: "PERM_DENIED",
			message: "Accessibility permission not granted",
			disposition: { delivery: "not_delivered", retry: "safe" },
		});
		process.exit(1);
	}
	envelope(true, "status", {
		platform: "macos",
		version: "1.0.2",
		permissions: { accessibility: true, screen_recording: true, automation: true },
		snapshot_id: null,
		ref_count: null,
		supported_surfaces: ["window", "menu"],
	});
	process.exit(0);
}

if (cmd === "snapshot") {
	const poor = mode === "poor";
	envelope(true, "snapshot", {
		app: "TextEdit",
		snapshot_id: "s1",
		ref_count: poor ? 2 : 1,
		complete: !poor,
		tree: poor
			? {
					role: "window",
					name: "Untitled",
					children: [
						{ role: "button", name: "OK", ref_id: "@s1:e1", available_actions: ["Click"] },
						{ role: "button", name: "", ref_id: "@s1:e2", available_actions: ["Click"] },
					],
				}
			: {
					role: "window",
					name: "Untitled",
					children: [{ role: "button", name: "OK", ref_id: "@s1:e1", available_actions: ["Click"] }],
				},
	});
	process.exit(0);
}

envelope(false, cmd || "unknown", undefined, {
	code: "INVALID_ARGS",
	message: `shim unknown command ${cmd}`,
	disposition: { delivery: "not_delivered", retry: "safe" },
});
process.exit(2);
