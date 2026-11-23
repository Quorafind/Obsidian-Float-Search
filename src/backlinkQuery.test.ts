import { describe, expect, it } from "vitest";
import { buildBacklinkQuery } from "./backlinkQuery";

const toRegExp = (query: string) => {
	const body = query.trim().slice(1, -1);
	return new RegExp(body);
};

describe("buildBacklinkQuery", () => {
	it("wraps the note name in a wikilink regex", () => {
		expect(buildBacklinkQuery("Note")).toBe(
			" /\\[\\[Note(\\|[^\\]]*)?\\]\\]/"
		);
	});

	it("matches plain and aliased links", () => {
		const re = toRegExp(buildBacklinkQuery("Note"));
		expect(re.test("see [[Note]]")).toBe(true);
		expect(re.test("see [[Note|alias]]")).toBe(true);
	});

	it("does not match other notes", () => {
		const re = toRegExp(buildBacklinkQuery("Note"));
		expect(re.test("see [[Other]]")).toBe(false);
		expect(re.test("see [[Notes]]")).toBe(false);
	});

	it.each(["a.b", "C++", "(draft)", "what?", "a|b", "[x]", "$5", "^top", "a\\b", "{1}", "x*"])(
		"treats %s literally",
		(name) => {
			const re = toRegExp(buildBacklinkQuery(name));
			expect(re.test(`[[${name}]]`)).toBe(true);
			expect(re.test(`[[${name}|alias]]`)).toBe(true);
		}
	);

	it("does not let a dot match arbitrary characters", () => {
		const re = toRegExp(buildBacklinkQuery("a.b"));
		expect(re.test("[[axb]]")).toBe(false);
	});
});
