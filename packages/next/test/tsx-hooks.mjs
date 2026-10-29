// Test-only module hooks: Node's --experimental-strip-types does not handle
// JSX, so a .tsx source file is transpiled here with the package's own
// TypeScript (no new dependency), as react-jsx, before Node loads it.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// Next's subpath modules have no package "exports", which a bundler resolves and
// Node's ESM resolver does not: name the file.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/navigation") return nextResolve("next/navigation.js", context);
  if (specifier === "next/headers") return nextResolve("next/headers.js", context);
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
  const fileName = fileURLToPath(url);
  const source = await readFile(fileName, "utf8");
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      verbatimModuleSyntax: false,
      allowImportingTsExtensions: true,
    },
  });
  return { format: "module", source: out.outputText, shortCircuit: true };
}
