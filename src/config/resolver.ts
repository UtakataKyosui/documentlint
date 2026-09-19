import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type ModuleKind = "rule" | "filter" | "plugin" | "preset";

export interface ResolvedModule {
  readonly kind: ModuleKind;
  readonly specifier: string;
  readonly packageName: string;
  readonly resolvedPath: string;
}

export class ModuleResolutionError extends Error {
  readonly specifier: string;
  readonly kind: ModuleKind;
  readonly candidates: readonly string[];

  constructor(specifier: string, kind: ModuleKind, candidates: readonly string[]) {
    super(
      `Failed to resolve ${kind} module "${specifier}". Tried candidates: ${candidates.join(", ")}`
    );
    this.name = "ModuleResolutionError";
    this.specifier = specifier;
    this.kind = kind;
    this.candidates = candidates;
  }
}

const RULE_PREFIX = "textlint-rule-";
const FILTER_PREFIX = "textlint-filter-rule-";
const PLUGIN_PREFIX_SCOPED = "@textlint/textlint-plugin-";
const PLUGIN_PREFIX = "textlint-plugin-";
const PRESET_PREFIX = "textlint-rule-preset-";

function isRelativeOrAbsolute(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/") || path.isAbsolute(specifier);
}

const BARE_PREFIXES: Readonly<Record<ModuleKind, readonly string[]>> = {
  rule: [RULE_PREFIX],
  filter: [FILTER_PREFIX],
  plugin: [PLUGIN_PREFIX],
  preset: [PRESET_PREFIX]
};

function splitScope(specifier: string): { scope: string; bare: string } | null {
  if (!specifier.startsWith("@")) {
    return null;
  }
  const slashIndex = specifier.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return { scope: specifier.slice(0, slashIndex), bare: specifier.slice(slashIndex + 1) };
}

function shorthandCandidates(kind: ModuleKind, bare: string): readonly string[] {
  if (kind === "preset") {
    const stripped = bare.startsWith("preset-") ? bare.slice("preset-".length) : bare;
    return [`${PRESET_PREFIX}${stripped}`];
  }
  if (kind === "plugin") {
    return [`${PLUGIN_PREFIX_SCOPED}${bare}`, `${PLUGIN_PREFIX}${bare}`];
  }
  if (kind === "filter") {
    return [`${FILTER_PREFIX}${bare}`];
  }
  return [`${RULE_PREFIX}${bare}`];
}

/**
 * 完全修飾名はそのまま解決する。短縮名は textlint と同じく接頭辞付きを先に試し、
 * 同名の無関係なパッケージが依存にあるときに解決先がずれるのを避ける。
 */
function buildCandidates(kind: ModuleKind, specifier: string): readonly string[] {
  const scoped = splitScope(specifier);
  const bare = scoped === null ? specifier : scoped.bare;

  if (BARE_PREFIXES[kind].some((prefix) => bare.startsWith(prefix))) {
    return [specifier];
  }

  if (scoped === null) {
    return [...shorthandCandidates(kind, bare), specifier];
  }
  const prefixed = shorthandCandidates(kind, bare)
    .filter((name) => !name.startsWith("@"))
    .map((name) => `${scoped.scope}/${name}`);
  return [...prefixed, specifier];
}

function createBaseRequire(baseDir: string): NodeJS.Require {
  return createRequire(path.join(baseDir, "noop.cjs"));
}

export function resolveModule(
  kind: ModuleKind,
  specifier: string,
  baseDir: string
): ResolvedModule {
  const requireFromBase = createBaseRequire(baseDir);

  if (isRelativeOrAbsolute(specifier)) {
    const candidate = path.isAbsolute(specifier) ? specifier : path.join(baseDir, specifier);
    try {
      const resolvedPath = requireFromBase.resolve(candidate);
      return {
        kind,
        specifier,
        packageName: resolvedPath,
        resolvedPath: pathToFileURL(resolvedPath).href
      };
    } catch {
      throw new ModuleResolutionError(specifier, kind, [candidate]);
    }
  }

  const candidates = buildCandidates(kind, specifier);

  for (const candidate of candidates) {
    try {
      const resolvedPath = requireFromBase.resolve(candidate);
      return {
        kind,
        specifier,
        packageName: candidate,
        resolvedPath: pathToFileURL(resolvedPath).href
      };
    } catch {
      continue;
    }
  }

  throw new ModuleResolutionError(specifier, kind, candidates);
}
