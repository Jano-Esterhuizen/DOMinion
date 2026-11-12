import { MCP_TOOL_PREFIX } from "../mcp";

/** Short display name: "mcp__playwright__browser_click" -> "browser_click". */
export function shortToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

function str(value: unknown, max = 120): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Human-readable one-liner for the run log ("navigated to /cart", "click \"Add to cart\""). */
export function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const tool = shortToolName(name);
  const element = typeof input.element === "string" ? `"${str(input.element, 80)}"` : "";
  switch (tool) {
    case "browser_navigate":
      return `navigate to ${str(input.url)}`;
    case "browser_navigate_back":
      return "go back";
    case "browser_snapshot":
      return "read the page";
    case "browser_click":
      return `click ${element}`;
    case "browser_type":
      return `type into ${element}`;
    case "browser_fill_form":
      return `fill ${Array.isArray(input.fields) ? input.fields.length : 0} form field(s)`;
    case "browser_select_option":
      return `select ${str(input.values)} in ${element}`;
    case "browser_press_key":
      return `press ${str(input.key)}`;
    case "browser_hover":
      return `hover ${element}`;
    case "browser_wait_for":
      return input.text ? `wait for "${str(input.text, 60)}"` : input.textGone ? `wait for "${str(input.textGone, 60)}" to disappear` : "wait";
    case "browser_take_screenshot":
      return "take a screenshot";
    case "browser_generate_locator":
      return `generate a locator for ${element}`;
    case "browser_verify_element_visible":
      return `verify ${str(input.role)} "${str(input.accessibleName, 60)}" is visible`;
    case "browser_verify_text_visible":
      return `verify text "${str(input.text, 60)}" is visible`;
    case "browser_verify_list_visible":
      return `verify list ${element}`;
    case "browser_verify_value":
      return `verify value of ${element}`;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return `${tool.toLowerCase()} ${str(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `${tool.toLowerCase()} ${str(input.pattern, 60)} in ${str(input.path ?? ".")}`;
    default:
      return tool;
  }
}

export interface ParsedToolResult {
  /** Playwright code the tool ran (Playwright MCP "### Ran Playwright code" section). */
  code?: string;
  /** "### Result" section (generated locators, verify results). */
  result?: string;
  /** "### Error" section or the first line of an error result. */
  error?: string;
  pageUrl?: string;
}

/** Parses Playwright MCP's Markdown-sectioned tool output. */
export function parseToolResultText(text: string): ParsedToolResult {
  const out: ParsedToolResult = {};
  const sections = text.split(/^### /m);
  for (const section of sections) {
    const [heading = "", ...rest] = section.split("\n");
    const body = rest.join("\n").trim();
    if (heading.startsWith("Ran Playwright code")) {
      out.code = body.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
    } else if (heading.startsWith("Result")) {
      out.result = body;
    } else if (heading.startsWith("Error")) {
      out.error = body.split("\n")[0];
    } else if (heading.startsWith("Page")) {
      const match = /- Page URL: (\S+)/.exec(body);
      if (match) out.pageUrl = match[1];
    }
  }
  return out;
}

export interface ToolResultContent {
  text: string;
  images: Array<{ data: string; mediaType: string }>;
}

/** Flattens a tool_result block's content (string or text/image parts). */
export function toolResultContent(content: unknown): ToolResultContent {
  if (typeof content === "string") return { text: content, images: [] };
  const out: ToolResultContent = { text: "", images: [] };
  if (!Array.isArray(content)) return out;
  for (const part of content as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string") out.text += (out.text ? "\n" : "") + part.text;
    if (part.type === "image") {
      const source = part.source as { type?: string; data?: string; media_type?: string } | undefined;
      if (source?.type === "base64" && source.data) out.images.push({ data: source.data, mediaType: source.media_type ?? "image/png" });
    }
  }
  return out;
}

/** One line for the run log from a tool result. */
export function summarizeToolResult(tool: string, parsed: ParsedToolResult, isError: boolean): string | undefined {
  if (isError) return parsed.error ?? "failed";
  if (tool === "browser_generate_locator" && parsed.result) return `verified locator ${parsed.result.split("\n")[0]}`;
  if (tool.startsWith("browser_verify_") && parsed.code) return `verified ${parsed.code.replace(/^await /, "").replace(/;$/, "")}`;
  if (tool === "browser_navigate" && parsed.pageUrl) return `navigated to ${parsed.pageUrl}`;
  return undefined;
}
