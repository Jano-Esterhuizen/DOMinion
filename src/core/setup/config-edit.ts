import { readFileSync, writeFileSync } from "node:fs";
import { Node, type ObjectLiteralExpression, Project, type PropertyAssignment, SyntaxKind } from "ts-morph";
import { type LoadedConfig, loadConfig } from "../config/loader";
import { DominionError, errorMessage, isDominionError } from "../errors";
import { relativePosix, writeFileAtomic } from "../fs";

interface TextEdit {
  start: number;
  end: number;
  text: string;
  order: number;
}

/**
 * Small, careful edits to dominion.config.ts for the Setup tab. The file stays the committed
 * source of truth: edits are plain text changes at exact positions (formatting, quotes and
 * comments elsewhere are kept), values computed in code (process.env..., variables) are never
 * overwritten, and an edit that leaves the config invalid is rolled back.
 */
export class ConfigDocument {
  private readonly edits: TextEdit[] = [];

  constructor(
    private readonly label: string,
    readonly root: ObjectLiteralExpression,
    private readonly text: string,
  ) {}

  private get eol(): string {
    return this.text.includes("\r\n") ? "\r\n" : "\n";
  }

  property(obj: ObjectLiteralExpression, key: string): PropertyAssignment | undefined {
    for (const prop of obj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;
      const nameNode = prop.getNameNode();
      const name = Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();
      if (name === key) return prop;
    }
    return undefined;
  }

  /** The object at obj[key]; undefined when missing; an error when it is not a plain object. */
  object(obj: ObjectLiteralExpression, key: string, path: string[]): ObjectLiteralExpression | undefined {
    const prop = this.property(obj, key);
    if (!prop) return undefined;
    const init = prop.getInitializer();
    if (init && Node.isObjectLiteralExpression(init)) return init;
    throw this.notEditable([...path, key]);
  }

  environment(name: string): ObjectLiteralExpression {
    const envs = this.object(this.root, "environments", []);
    const env = envs && this.object(envs, name, ["environments"]);
    if (!env) throw new DominionError(`Environment "${name}" is not defined as a plain object in ${this.label}.`, { code: "UNKNOWN_ENV" });
    return env;
  }

  /** Sets obj[key] to the literal `valueText`; an existing value must be a literal too. */
  setLiteral(obj: ObjectLiteralExpression, key: string, valueText: string, path: string[]): void {
    const prop = this.property(obj, key);
    if (!prop) return this.addProperty(obj, key, valueText);
    const init = prop.getInitializer();
    if (!init || !isLiteral(init)) throw this.notEditable([...path, key]);
    if (init.getText() !== valueText) this.replace(init.getStart(), init.getEnd(), valueText);
  }

  setString(obj: ObjectLiteralExpression, key: string, value: string, path: string[]): void {
    this.setLiteral(obj, key, JSON.stringify(value), path);
  }

  /** Makes obj[key] an object holding these literal entries (creating it when missing). */
  setObject(obj: ObjectLiteralExpression, key: string, entries: Array<[string, string]>, path: string[]): void {
    const child = this.object(obj, key, path);
    if (child) for (const [k, v] of entries) this.setLiteral(child, k, v, [...path, key]);
    else this.addProperty(obj, key, `{ ${entries.map(([k, v]) => `${propertyName(k)}: ${v}`).join(", ")} }`);
  }

  /** Adds `key: valueText` as the object's last property, in the object's own layout. */
  addProperty(obj: ObjectLiteralExpression, key: string, valueText: string): void {
    const entry = `${propertyName(key)}: ${valueText}`;
    const props = obj.getProperties();
    if (!props.length) {
      this.replace(obj.getStart(), obj.getEnd(), `{ ${entry} }`);
      return;
    }
    const last = props[props.length - 1]!;
    const comma = last.getNextSiblingIfKind(SyntaxKind.CommaToken);
    if (!this.text.slice(obj.getStart(), obj.getEnd()).includes("\n")) {
      this.insert(last.getEnd(), `, ${entry}`);
      return;
    }
    if (!comma) this.insert(last.getEnd(), ",");
    // After the last property's line (and any comment at the end of that line).
    let pos = comma ? comma.getEnd() : last.getEnd();
    const lineEnd = this.text.indexOf("\n", pos);
    const restOfLine = this.text.slice(pos, lineEnd === -1 ? this.text.length : lineEnd).replace(/\r$/, "");
    if (restOfLine.trim()) pos += restOfLine.length;
    this.insert(pos, `${this.eol}${lineIndent(this.text, last.getStart())}${entry},`);
  }

  /** Removes obj[key] (with its line, when it sits on its own lines). */
  remove(obj: ObjectLiteralExpression, key: string, path: string[]): void {
    const prop = this.property(obj, key);
    if (!prop) return;
    const init = prop.getInitializer();
    if (init && !isLiteral(init) && !Node.isObjectLiteralExpression(init)) throw this.notEditable([...path, key]);
    const comma = prop.getNextSiblingIfKind(SyntaxKind.CommaToken);
    let start = prop.getStart();
    let end = comma ? comma.getEnd() : prop.getEnd();
    const lineStart = this.text.lastIndexOf("\n", start - 1) + 1;
    if (!this.text.slice(lineStart, start).trim()) {
      const lineEnd = this.text.indexOf("\n", end);
      const rest = this.text.slice(end, lineEnd === -1 ? this.text.length : lineEnd).trim();
      if (!rest || rest.startsWith("//")) {
        start = lineStart;
        end = lineEnd === -1 ? this.text.length : lineEnd + 1;
      }
    }
    this.replace(start, end, "");
  }

  notEditable(path: string[]): DominionError {
    return new DominionError(`${path.join(".")} is computed in ${this.label} (not a plain value), so the Setup tab leaves it alone.`, {
      code: "CONFIG_NOT_EDITABLE",
      hint: `Change it in ${this.label} yourself.`,
    });
  }

  private replace(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text, order: this.edits.length });
  }

  private insert(pos: number, text: string): void {
    this.replace(pos, pos, text);
  }

  /** The text with every edit applied (later positions first; same position keeps call order). */
  apply(): string {
    let out = this.text;
    const sorted = [...this.edits].sort((a, b) => b.start - a.start || b.order - a.order);
    for (const edit of sorted) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
  }
}

function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

export function propertyName(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/** Strings, numbers, booleans, regexes and arrays of those. */
function isLiteral(node: Node): boolean {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isNumericLiteral(node) || Node.isRegularExpressionLiteral(node)) return true;
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) return true;
  if (Node.isArrayLiteralExpression(node)) return node.getElements().every(isLiteral);
  return false;
}

function configRootObject(fileName: string, text: string): ObjectLiteralExpression | undefined {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } });
  const sf = project.createSourceFile(fileName, text, { overwrite: true });
  const unwrap = (node: Node | undefined): ObjectLiteralExpression | undefined => {
    if (!node) return undefined;
    if (Node.isObjectLiteralExpression(node)) return node;
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) return unwrap(node.getExpression());
    if (Node.isCallExpression(node)) return unwrap(node.getArguments()[0]);
    if (Node.isIdentifier(node)) return unwrap(sf.getVariableDeclaration(node.getText())?.getInitializer());
    return undefined;
  };
  const exported = sf.getExportAssignment((e) => !e.isExportEquals());
  return exported ? unwrap(exported.getExpression()) : undefined;
}

/**
 * Applies `edit` to the config file and reloads it. Nothing is written when nothing changed; an
 * edit that makes the config invalid is rolled back and reported.
 */
export async function editConfig(loaded: LoadedConfig, edit: (doc: ConfigDocument) => void): Promise<LoadedConfig> {
  const path = loaded.configPath;
  const label = relativePosix(loaded.root, path);
  const text = readFileSync(path, "utf8");
  const root = configRootObject(/\.(c|m)?js$/.test(path) ? "dominion.config.js" : "dominion.config.ts", text);
  if (!root) {
    throw new DominionError(`${label} does not export a literal defineConfig({ ... }), so the Setup tab cannot edit it.`, {
      code: "CONFIG_NOT_EDITABLE",
      hint: `Change it in ${label} yourself.`,
    });
  }
  const doc = new ConfigDocument(label, root, text);
  edit(doc);
  const next = doc.apply();
  if (next === text) return loaded;

  writeFileAtomic(path, next);
  try {
    return await loadConfig({ cwd: loaded.root, configPath: path });
  } catch (error) {
    writeFileSync(path, text, "utf8");
    throw new DominionError(`That change would make ${label} invalid: ${errorMessage(error)}`, {
      code: "CONFIG_EDIT_INVALID",
      hint: isDominionError(error) ? error.hint : undefined,
    });
  }
}
