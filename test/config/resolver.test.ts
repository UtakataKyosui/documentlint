import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleResolutionError, resolveModule } from "../../src/config/resolver.js";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

describe("resolveModule", () => {
  it("resolves a rule shorthand name to its textlint-rule- package", () => {
    const result = resolveModule("rule", "no-todo", projectRoot);
    expect(result.packageName).toBe("textlint-rule-no-todo");
    expect(result.resolvedPath).toMatch(/textlint-rule-no-todo/);
  });

  it("resolves a filter shorthand name to its textlint-filter-rule- package", () => {
    const result = resolveModule("filter", "comments", projectRoot);
    expect(result.packageName).toBe("textlint-filter-rule-comments");
    expect(result.resolvedPath).toMatch(/textlint-filter-rule-comments/);
  });

  it("resolves a plugin shorthand name to its scoped @textlint/textlint-plugin- package", () => {
    const result = resolveModule("plugin", "markdown", projectRoot);
    expect(result.packageName).toBe("@textlint/textlint-plugin-markdown");
    expect(result.resolvedPath).toMatch(/textlint-plugin-markdown/);
  });

  it("resolves a full package name as-is without applying a prefix", () => {
    const result = resolveModule("rule", "textlint-rule-no-todo", projectRoot);
    expect(result.packageName).toBe("textlint-rule-no-todo");
  });

  it("does not build a double-prefixed candidate for a fully qualified name", () => {
    try {
      resolveModule("rule", "textlint-rule-definitely-not-real", projectRoot);
      throw new Error("expected resolveModule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleResolutionError);
      const resolutionError = error as ModuleResolutionError;
      expect(resolutionError.candidates).toEqual(["textlint-rule-definitely-not-real"]);
    }
  });

  it("does not build a double-prefixed candidate for a scoped fully qualified name", () => {
    try {
      resolveModule("plugin", "@acme/textlint-plugin-definitely-not-real", projectRoot);
      throw new Error("expected resolveModule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleResolutionError);
      const resolutionError = error as ModuleResolutionError;
      expect(resolutionError.candidates).toEqual(["@acme/textlint-plugin-definitely-not-real"]);
    }
  });

  it("expands a scoped shorthand within its own scope", () => {
    try {
      resolveModule("rule", "@acme/definitely-not-real", projectRoot);
      throw new Error("expected resolveModule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleResolutionError);
      const resolutionError = error as ModuleResolutionError;
      expect(resolutionError.candidates).toEqual([
        "@acme/textlint-rule-definitely-not-real",
        "@acme/definitely-not-real"
      ]);
    }
  });

  describe("relative path specifiers", () => {
    let tempDir: string;
    let relativeRulePath: string;

    beforeAll(() => {
      tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-resolver-")));
      fs.mkdirSync(path.join(tempDir, "rules"));
      relativeRulePath = path.join(tempDir, "rules", "my-rule.js");
      fs.writeFileSync(relativeRulePath, "export default {};\n");
    });

    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("resolves a relative path against the config file's directory", () => {
      const result = resolveModule("rule", "./rules/my-rule.js", tempDir);
      expect(result.packageName).toBe(relativeRulePath);
      expect(result.resolvedPath).toBe(`file://${relativeRulePath}`);
    });

    it("throws ModuleResolutionError with the resolved candidate when the relative path does not exist", () => {
      expect(() => resolveModule("rule", "./rules/missing.js", tempDir)).toThrowError(
        ModuleResolutionError
      );
      try {
        resolveModule("rule", "./rules/missing.js", tempDir);
        throw new Error("expected resolveModule to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ModuleResolutionError);
        const resolutionError = error as ModuleResolutionError;
        expect(resolutionError.candidates).toEqual([path.join(tempDir, "rules", "missing.js")]);
      }
    });
  });

  it("throws ModuleResolutionError listing all attempted candidates when a rule cannot be resolved", () => {
    try {
      resolveModule("rule", "definitely-not-a-real-rule", projectRoot);
      throw new Error("expected resolveModule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleResolutionError);
      const resolutionError = error as ModuleResolutionError;
      expect(resolutionError.specifier).toBe("definitely-not-a-real-rule");
      expect(resolutionError.kind).toBe("rule");
      expect(resolutionError.candidates).toEqual([
        "textlint-rule-definitely-not-a-real-rule",
        "definitely-not-a-real-rule"
      ]);
      expect(resolutionError.message).toContain("definitely-not-a-real-rule");
      expect(resolutionError.message).toContain("textlint-rule-definitely-not-a-real-rule");
    }
  });

  it("includes a textlint-rule-preset- candidate when a preset cannot be resolved", () => {
    try {
      resolveModule("preset", "preset-definitely-not-real", projectRoot);
      throw new Error("expected resolveModule to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ModuleResolutionError);
      const resolutionError = error as ModuleResolutionError;
      expect(resolutionError.candidates).toContain(
        "textlint-rule-preset-definitely-not-real"
      );
    }
  });
});
