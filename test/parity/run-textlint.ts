import { createLinter, loadTextlintrc } from "textlint";
import type { TextlintFixResult, TextlintResult } from "@textlint/types";

export interface TextlintReference {
  lintText(text: string, filePath: string): Promise<TextlintResult>;
  fixText(text: string, filePath: string): Promise<TextlintFixResult>;
  lintFiles(filesOrGlobs: readonly string[]): Promise<TextlintResult[]>;
  fixFiles(filesOrGlobs: readonly string[]): Promise<TextlintFixResult[]>;
}

export async function createTextlintReference(configFilePath: string): Promise<TextlintReference> {
  const descriptor = await loadTextlintrc({ configFilePath });
  const linter = createLinter({ descriptor });

  return {
    lintText: (text, filePath) => linter.lintText(text, filePath),
    fixText: (text, filePath) => linter.fixText(text, filePath),
    lintFiles: (filesOrGlobs) => linter.lintFiles([...filesOrGlobs]),
    fixFiles: (filesOrGlobs) => linter.fixFiles([...filesOrGlobs])
  };
}
