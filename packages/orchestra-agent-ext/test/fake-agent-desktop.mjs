#!/usr/bin/env node
// Fake agent-desktop shim emitting real envelope shapes (Part C tests only).
// Modes via env FAKE_DESKTOP_MODE: ok (default), error-safe, error-unsafe, secret.
// Invocation count appended to FAKE_DESKTOP_COUNT_FILE when set.
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
const SECRET = "SECRET_PAYLOAD_DO_NOT_LOG";

function envelope(ok, command, data, error) {
	const out = { version: "2.6", ok, command };
	if (data !== undefined) out.data = data;
	if (error !== undefined) out.error = error;
	process.stdout.write(`${JSON.stringify(out)}\n`);
}

function fail(command, code, message, retry) {
	envelope(false, command, undefined, {
		code,
		message,
		disposition: { delivery: retry === "safe" ? "not_delivered" : "unknown", retry },
	});
	process.exit(1);
}

if (cmd === "--version") {
	process.stdout.write("agent-desktop 1.0.2\n");
	process.exit(0);
}

if (cmd === "version") {
	envelope(true, "version", { version: "1.0.2", target: "aarch64", os: "macos" });
	process.exit(0);
}

if (cmd === "status") {
	envelope(true, "status", {
		platform: "macos",
		version: "1.0.2",
		permissions: { accessibility: true, screen_recording: true, automation: true },
		snapshot_id: null,
		ref_count: null,
		session_id: null,
		tracing: false,
		supported_surfaces: ["window", "menu", "sheet"],
	});
	process.exit(0);
}

if (cmd === "snapshot") {
	if (mode === "error-safe") {
		let count = 0;
		try {
			const { readFileSync } = await import("node:fs");
			if (countFile) count = readFileSync(countFile, "utf8").split("\n").filter((l) => l === "snapshot").length;
		} catch {
			// ignore
		}
		if (count <= 1) {
			fail("snapshot", "TIMEOUT", "observation deadline expired", "safe");
		}
	}
	const tree =
		mode === "secret"
			? {
					role: "window",
					name: SECRET,
					children: [{ role: "button", name: SECRET, ref_id: "@s1:e1", available_actions: ["Click"] }],
				}
			: {
					role: "window",
					name: "Untitled",
					children: [{ role: "button", name: "OK", ref_id: "@s1:e1", available_actions: ["Click"] }],
				};
	envelope(true, "snapshot", {
		app: "TextEdit",
		snapshot_id: "s1",
		ref_count: 1,
		complete: true,
		tree,
	});
	process.exit(0);
}

if (cmd === "click" || cmd === "type" || cmd === "set-value") {
	if (mode === "error-unsafe") {
		fail(cmd, "ACTION_FAILED", "action may have landed", "unsafe");
	}
	envelope(true, cmd, {
		action: cmd,
		disposition: { delivery: "delivered_verified", retry: "unsafe" },
	});
	process.exit(0);
}

if (cmd === "screenshot") {
	// 1x1 transparent PNG
	const tiny = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	envelope(true, "screenshot", {
		data: tiny.toString("base64"),
		format: "png",
		width: 1,
		height: 1,
		scale_factor: 2,
	});
	process.exit(0);
}

envelope(false, cmd || "unknown", undefined, {
	code: "INVALID_ARGS",
	message: `shim unknown command ${cmd}`,
	disposition: { delivery: "not_delivered", retry: "safe" },
});
process.exit(2);
