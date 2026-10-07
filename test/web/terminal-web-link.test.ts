// Adapted from packages/components/src/Terminal/web-link.test.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { describe, expect, test } from "vitest";
import { activateWebLink } from "../../src/components/Terminal/web-link";

/**
 * The scheme guard on terminal link activation. WebLinksAddon itself only
 * detects http(s) text, but OSC 8 hyperlinks carry whatever URI the
 * program that printed them chose — file:, javascript:, custom protocol
 * handlers — and both link paths funnel through activateWebLink before
 * anything reaches openExternal. main re-checks the scheme on its side
 * (ipc-misc.ts); this is the renderer half of the same posture.
 */
describe("activateWebLink", () => {
	const openedBy = (uri: string): string | null => {
		let opened: string | null = null;
		activateWebLink(uri, (url) => {
			opened = url;
		});
		return opened;
	};

	test("opens http and https URIs verbatim", () => {
		expect(openedBy("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
		expect(openedBy("http://localhost:3000/")).toBe("http://localhost:3000/");
		expect(openedBy("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
	});

	test("refuses every non-http(s) scheme", () => {
		expect(openedBy("file:///etc/passwd")).toBeNull();
		expect(openedBy("javascript:alert(1)")).toBeNull();
		expect(openedBy("cubecomputer://auth/callback")).toBeNull();
		expect(openedBy("vscode://open?x=1")).toBeNull();
	});

	test("refuses strings that merely contain an http URL", () => {
		expect(openedBy("see https://example.com")).toBeNull();
		expect(openedBy("xhttps://example.com")).toBeNull();
	});
});
