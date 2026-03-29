#!/usr/bin/env node

import { runCli } from "../src/cli.js";

interface MainOptions {
  args?: string[];
  runCliImpl?: typeof runCli;
  exit?: (code: number) => void;
  stderr?: (...args: unknown[]) => void;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
  const runCliImpl = options.runCliImpl ?? runCli;
  const exit = options.exit ?? process.exit;
  const stderr = options.stderr ?? console.error;

  try {
    const exitCode = await runCliImpl(args);
    exit(exitCode);
  } catch (error) {
    stderr("[kernel] Startup failed:", error);
    exit(1);
  }
}

void main();