import { describe, expect, it } from "vitest";
import type { TextlintFixResult, TextlintMessage, TextlintResult } from "@textlint/types";
import { normalizeFixResult, normalizeMessage, normalizeResult } from "../../src/diagnostics/normalize.js";

function createMessage(overrides: Partial<TextlintMessage> = {}): TextlintMessage {
  return {
    type: "lint",
    ruleId: "example-rule",
    message: "example message",
    line: 1,
    column: 1,
    index: 0,
    range: [3, 8],
    loc: {
      start: { line: 2, column: 4 },
      end: { line: 2, column: 9 }
    },
    severity: 2,
    ...overrides
  };
}

describe("normalizeMessage", () => {
  it("maps severity 2 to error", () => {
    const diagnostic = normalizeMessage(createMessage({ severity: 2 }), "doc.md");
    expect(diagnostic.severity).toBe("error");
  });

  it("maps severity 1 to warning", () => {
    const diagnostic = normalizeMessage(createMessage({ severity: 1 }), "doc.md");
    expect(diagnostic.severity).toBe("warning");
  });

  it("maps severity 3 to info", () => {
    const diagnostic = normalizeMessage(createMessage({ severity: 3 }), "doc.md");
    expect(diagnostic.severity).toBe("info");
  });

  it("throws on severity 0, which textlint uses for disabled rules", () => {
    expect(() => normalizeMessage(createMessage({ severity: 0 }), "doc.md")).toThrowError();
  });

  it("preserves both loc and range in the diagnostic location, ignoring deprecated line/column/index", () => {
    const message = createMessage({
      line: 99,
      column: 99,
      index: 99,
      range: [3, 8],
      loc: {
        start: { line: 2, column: 4 },
        end: { line: 2, column: 9 }
      }
    });

    const diagnostic = normalizeMessage(message, "doc.md");

    expect(diagnostic.location).toEqual({
      start: { line: 2, column: 4 },
      end: { line: 2, column: 9 },
      range: { start: 3, end: 8 }
    });
  });

  it("sets engine to textlint and filePath from the argument", () => {
    const diagnostic = normalizeMessage(createMessage(), "docs/example.md");
    expect(diagnostic.engine).toBe("textlint");
    expect(diagnostic.filePath).toBe("docs/example.md");
    expect(diagnostic.ruleId).toBe("example-rule");
    expect(diagnostic.message).toBe("example message");
  });

  it("maps fix when present", () => {
    const message = createMessage({
      fix: { text: "replacement", range: [3, 8] }
    });

    const diagnostic = normalizeMessage(message, "doc.md");

    expect(diagnostic.fix).toEqual({
      range: { start: 3, end: 8 },
      text: "replacement"
    });
  });

  it("omits the fix property entirely when absent", () => {
    const diagnostic = normalizeMessage(createMessage(), "doc.md");
    expect("fix" in diagnostic).toBe(false);
  });

  it("maps suggestions when present", () => {
    const message = createMessage({
      suggestions: [
        {
          id: "suggestion-1",
          message: "use this instead",
          fix: { text: "alt text", range: [3, 8] }
        }
      ]
    });

    const diagnostic = normalizeMessage(message, "doc.md");

    expect(diagnostic.suggestions).toEqual([
      {
        id: "suggestion-1",
        message: "use this instead",
        fix: { range: { start: 3, end: 8 }, text: "alt text" }
      }
    ]);
  });

  it("omits the suggestions property entirely when absent", () => {
    const diagnostic = normalizeMessage(createMessage(), "doc.md");
    expect("suggestions" in diagnostic).toBe(false);
  });
});

describe("normalizeResult", () => {
  it("normalizes all messages and carries the filePath", () => {
    const result: TextlintResult = {
      filePath: "doc.md",
      messages: [createMessage({ severity: 2 }), createMessage({ severity: 1 })]
    };

    const lintResult = normalizeResult(result);

    expect(lintResult.filePath).toBe("doc.md");
    expect(lintResult.diagnostics).toHaveLength(2);
    expect(lintResult.diagnostics[0]?.severity).toBe("error");
    expect(lintResult.diagnostics[1]?.severity).toBe("warning");
    expect(lintResult.diagnostics.every((diagnostic) => diagnostic.filePath === "doc.md")).toBe(true);
  });
});

describe("normalizeFixResult", () => {
  it("maps messages/applyingMessages/remainingMessages to diagnostics/applied/remaining", () => {
    const result: TextlintFixResult = {
      filePath: "doc.md",
      output: "fixed content",
      messages: [createMessage({ ruleId: "rule-all", severity: 2 })],
      applyingMessages: [createMessage({ ruleId: "rule-applied", severity: 1 })],
      remainingMessages: [createMessage({ ruleId: "rule-remaining", severity: 3 })]
    };

    const fixResult = normalizeFixResult(result);

    expect(fixResult.filePath).toBe("doc.md");
    expect(fixResult.output).toBe("fixed content");
    expect(fixResult.diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual(["rule-all"]);
    expect(fixResult.applied.map((diagnostic) => diagnostic.ruleId)).toEqual(["rule-applied"]);
    expect(fixResult.remaining.map((diagnostic) => diagnostic.ruleId)).toEqual(["rule-remaining"]);
  });
});
