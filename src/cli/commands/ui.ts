import { spawn } from "node:child_process";
import type { Command } from "commander";
import { DominionError } from "../../core/errors";
import { startServer } from "../../server";
import { findProjectRoot } from "../../server/project";
import { loadCommandContext } from "../context";
import { color, line, warn } from "../output";

/** Opens a URL in the default browser without a shell-quoting dependency. */
export function openBrowser(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => warn(`Could not open a browser; open ${url} yourself.`));
    child.unref();
  } catch {
    warn(`Could not open a browser; open ${url} yourself.`);
  }
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("start the local UI (127.0.0.1 only, token-protected) and open it in the browser")
    .option("--port <port>", "port to listen on", "4555")
    .option("--no-open", "do not open the browser")
    .action(async (flags: { port: string; open?: boolean }) => {
      const port = Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DominionError(`--port must be a port number (got "${flags.port}").`, { code: "BAD_FLAG" });
      // A project without dominion.config.ts still gets the UI: the Setup tab creates it.
      let loaded;
      try {
        loaded = await loadCommandContext();
      } catch (error) {
        if (!(error instanceof DominionError) || error.code !== "CONFIG_NOT_FOUND") throw error;
      }
      let server;
      try {
        server = await startServer({ loaded, root: loaded ? undefined : findProjectRoot(process.cwd()), port });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          throw new DominionError(`Port ${port} is already in use.`, { code: "PORT_IN_USE", hint: "Pass another port, for example `npx dominion ui --port 4556`." });
        }
        throw error;
      }
      line(`${color.bold("DOMinion UI")} running at ${color.cyan(server.openUrl)}`);
      if (!loaded) line(color.gray(`No dominion.config.ts yet in ${server.project.root}: the Setup tab walks you through it.`));
      line(color.gray("Only this machine can reach it, and only with this link (it carries a one-time token). Press Ctrl+C to stop."));
      if (flags.open !== false) openBrowser(server.openUrl);
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      line(color.gray("Stopping DOMinion UI..."));
      await server.close();
    });
}
