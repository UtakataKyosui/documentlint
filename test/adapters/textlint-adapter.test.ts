import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTextlintAdapter } from "../../src/adapters/textlint/adapter.js";
import { resolveTextlintrc } from "../../src/config/textlintrc.js";
import { UnsupportedConfigError } from "../../src/config/errors.js";

const projectRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");

function realPackagePath(name: string): string {
  return fs.realpathSync(path.join(projectRoot, "node_modules", name));
}

function linkPackage(nodeModulesDir: string, name: string): void {
  const target = realPackagePath(name);
  const linkPath = path.join(nodeModulesDir, name);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "dir");
}

function writeFakePreset(nodeModulesDir: string): void {
  const presetDir = path.join(nodeModulesDir, "textlint-rule-preset-fake");
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(
    path.join(presetDir, "package.json"),
    JSON.stringify({ name: "textlint-rule-preset-fake", version: "1.0.0", main: "index.cjs" })
  );
  fs.writeFileSync(
    path.join(presetDir, "index.cjs"),
    `
function loudRule(context) {
  const { Syntax, RuleError, report, getSource } = context;
  return {
    [Syntax.Str](node) {
      if (getSource(node).includes("LOUD")) {
        report(node, new RuleError("loud text found"));
      }
    }
  };
}

function customRule(context, options) {
  const marker = options && typeof options.marker === "string" ? options.marker : "MARK";
  const { Syntax, RuleError, report, getSource } = context;
  return {
    [Syntax.Str](node) {
      if (getSource(node).includes(marker)) {
        report(node, new RuleError("marker " + marker + " found"));
      }
    }
  };
}

module.exports = {
  rules: { loud: loudRule, custom: customRule },
  rulesConfig: { loud: true, custom: { marker: "MARK" } }
};
`
  );
}

function writeFakeFixableRule(nodeModulesDir: string): void {
  const ruleDir = path.join(nodeModulesDir, "textlint-rule-fake-fixable");
  fs.mkdirSync(ruleDir, { recursive: true });
  fs.writeFileSync(
    path.join(ruleDir, "package.json"),
    JSON.stringify({ name: "textlint-rule-fake-fixable", version: "1.0.0", main: "index.cjs" })
  );
  fs.writeFileSync(
    path.join(ruleDir, "index.cjs"),
    `
function reporter(context) {
  const { Syntax, RuleError, report, getSource, fixer } = context;
  return {
    [Syntax.Str](node) {
      const text = getSource(node);
      const index = text.indexOf("FOO");
      if (index !== -1) {
        report(node, new RuleError("found FOO", {
          index,
          fix: fixer.replaceTextRange([index, index + 3], "BAR")
        }));
      }
    }
  };
}

module.exports = { linter: reporter, fixer: reporter };
`
  );
}

function writeMalformedPreset(nodeModulesDir: string): void {
  const presetDir = path.join(nodeModulesDir, "textlint-rule-preset-broken");
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(
    path.join(presetDir, "package.json"),
    JSON.stringify({ name: "textlint-rule-preset-broken", version: "1.0.0", main: "index.cjs" })
  );
  fs.writeFileSync(path.join(presetDir, "index.cjs"), "module.exports = {};\n");
}

describe("createTextlintAdapter", () => {
  let tempDir: string;
  let nodeModulesDir: string;
  let configPath: string;

  beforeAll(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "documentlint-textlint-adapter-"))
    );
    nodeModulesDir = path.join(tempDir, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });

    linkPackage(nodeModulesDir, "textlint-rule-no-todo");
    linkPackage(nodeModulesDir, "textlint-filter-rule-comments");
    linkPackage(nodeModulesDir, "@textlint/textlint-plugin-markdown");
    writeFakePreset(nodeModulesDir);
    writeFakeFixableRule(nodeModulesDir);
    writeMalformedPreset(nodeModulesDir);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    configPath = path.join(tempDir, ".textlintrc.json");
  });

  afterEach(() => {
    fs.rmSync(configPath, { force: true });
  });

  function writeConfig(content: unknown): void {
    fs.writeFileSync(configPath, JSON.stringify(content));
  }

  it("lints text and returns normalized diagnostics when a rule fires", async () => {
    writeConfig({ rules: { "no-todo": true }, plugins: { markdown: true } });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const result = await adapter.lintText("# Title\n\nTODO: fix this\n", "doc.md");

    expect(result.filePath).toBe("doc.md");
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.engine).toBe("textlint");
    expect(diagnostic?.ruleId).toBe("no-todo");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.location.start.line).toBe(3);
    expect(diagnostic?.location.range.start).toBeGreaterThanOrEqual(0);
  });

  it("suppresses diagnostics inside a textlint-disable/enable comment block", async () => {
    writeConfig({
      rules: { "no-todo": true },
      filters: { comments: true },
      plugins: { markdown: true }
    });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const text = [
      "# Title",
      "",
      "<!-- textlint-disable -->",
      "",
      "TODO: ignored",
      "",
      "<!-- textlint-enable -->",
      "",
      "TODO: reported",
      ""
    ].join("\n");

    const result = await adapter.lintText(text, "doc.md");

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("reported");
  });

  it("lints files via glob and returns one result per file", async () => {
    writeConfig({ rules: { "no-todo": true }, plugins: { markdown: true } });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc, { cwd: tempDir });

    const targetPath = path.join(tempDir, "target.md");
    fs.writeFileSync(targetPath, "# Title\n\nTODO: from file\n");

    try {
      const results = await adapter.lintFiles([targetPath]);

      expect(results).toHaveLength(1);
      expect(results[0]?.filePath).toBe(targetPath);
      expect(results[0]?.diagnostics).toHaveLength(1);
      expect(results[0]?.diagnostics[0]?.ruleId).toBe("no-todo");
    } finally {
      fs.rmSync(targetPath, { force: true });
    }
  });

  it("fixes text and returns a FixResult shape", async () => {
    writeConfig({ rules: { "fake-fixable": true }, plugins: { markdown: true } });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const text = "This is FOO text.\n";
    const result = await adapter.fixText(text, "doc.md");

    expect(result.filePath).toBe("doc.md");
    expect(result.output).toBe("This is BAR text.\n");
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.ruleId).toBe("fake-fixable");
    expect(result.remaining).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.fix).toEqual({ range: { start: 8, end: 11 }, text: "BAR" });
  });

  it("fixes files and returns a FixResult array", async () => {
    writeConfig({ rules: { "fake-fixable": true }, plugins: { markdown: true } });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc, { cwd: tempDir });

    const targetPath = path.join(tempDir, "fixable.md");
    fs.writeFileSync(targetPath, "This is FOO text.\n");

    try {
      const results = await adapter.fixFiles([targetPath]);

      expect(results).toHaveLength(1);
      expect(results[0]?.filePath).toBe(targetPath);
      expect(results[0]?.output).toBe("This is BAR text.\n");
      expect(results[0]?.applied).toHaveLength(1);
      expect(results[0]?.remaining).toEqual([]);
    } finally {
      fs.rmSync(targetPath, { force: true });
    }
  });

  it("expands a preset into individual rules, honoring overrides and defaults", async () => {
    writeConfig({
      rules: {
        "preset-fake": {
          custom: { marker: "USERMARK" }
        }
      },
      plugins: { markdown: true }
    });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const result = await adapter.lintText("LOUD and USERMARK here\n", "doc.md");

    const ruleIds = result.diagnostics.map((diagnostic) => diagnostic.ruleId).sort();
    expect(ruleIds).toEqual(["fake/custom", "fake/loud"]);
  });

  it("does not trigger the preset default marker once it has been overridden", async () => {
    writeConfig({
      rules: {
        "preset-fake": {
          custom: { marker: "USERMARK" }
        }
      },
      plugins: { markdown: true }
    });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const result = await adapter.lintText("MARK only, no loud words here\n", "doc.md");

    expect(result.diagnostics).toHaveLength(0);
  });

  it("throws UnsupportedConfigError when a preset sub-rule name does not exist", async () => {
    writeConfig({
      rules: {
        "preset-fake": {
          "lodu-typo": false
        }
      },
      plugins: { markdown: true }
    });
    const rc = resolveTextlintrc(configPath);

    await expect(createTextlintAdapter(rc)).rejects.toBeInstanceOf(UnsupportedConfigError);
  });

  it("keeps a preset rule disabled when the config sets it to false", async () => {
    writeConfig({
      rules: {
        "preset-fake": {
          loud: false
        }
      },
      plugins: { markdown: true }
    });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const result = await adapter.lintText("LOUD and MARK here\n", "doc.md");

    const ruleIds = result.diagnostics.map((diagnostic) => diagnostic.ruleId);
    expect(ruleIds).not.toContain("fake/loud");
  });

  it("enables all preset rules with their default options when the preset is set to true", async () => {
    writeConfig({ rules: { "preset-fake": true }, plugins: { markdown: true } });
    const rc = resolveTextlintrc(configPath);
    const adapter = await createTextlintAdapter(rc);

    const result = await adapter.lintText("LOUD and MARK here\n", "doc.md");

    const ruleIds = result.diagnostics.map((diagnostic) => diagnostic.ruleId).sort();
    expect(ruleIds).toEqual(["fake/custom", "fake/loud"]);
  });

  it("throws UnsupportedConfigError when a preset module does not export a rules object", async () => {
    writeConfig({ rules: { "preset-broken": true } });
    const rc = resolveTextlintrc(configPath);

    await expect(createTextlintAdapter(rc)).rejects.toBeInstanceOf(UnsupportedConfigError);
  });
});
