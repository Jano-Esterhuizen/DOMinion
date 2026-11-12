import { readFileSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "./package-info";

/**
 * Renders a file from templates/ by replacing {{name}} placeholders. Unknown or leftover
 * placeholders are an error so a template change can never ship half-rendered files.
 */
export function renderTemplate(name: string, vars: Record<string, string>): string {
  const source = readFileSync(join(templatesDir(), name), "utf8");
  return renderString(source, vars, name);
}

export function renderString(source: string, vars: Record<string, string>, label = "template"): string {
  const rendered = source.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if (!(key in vars)) throw new Error(`${label}: no value for placeholder ${match}`);
    return vars[key]!;
  });
  return rendered;
}
