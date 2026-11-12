#!/usr/bin/env node
import { reportCliError } from "./output";
import { createProgram } from "./program";

createProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    process.exitCode = reportCliError(error);
  });
