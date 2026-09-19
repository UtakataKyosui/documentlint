export { createTextlintAdapter } from "./adapters/textlint/index.js";
export type { CreateTextlintAdapterOptions, TextlintAdapter } from "./adapters/textlint/index.js";

export { resolveTextlintrc } from "./config/textlintrc.js";
export type {
  ResolvedPresetRuleEntry,
  ResolvedRuleEntry,
  ResolvedTextlintrc,
  TextlintRuleOptions
} from "./config/textlintrc.js";

export { resolveModule, ModuleResolutionError } from "./config/resolver.js";
export type { ModuleKind, ResolvedModule } from "./config/resolver.js";

export { UnsupportedConfigError } from "./config/errors.js";

export { normalizeFixResult, normalizeMessage, normalizeResult } from "./diagnostics/normalize.js";
export type {
  Diagnostic,
  DiagnosticLocation,
  DiagnosticSeverity,
  FixEdit,
  FixResult,
  LintResult,
  Position,
  SourceEngine,
  Suggestion,
  TextRange
} from "./diagnostics/types.js";
