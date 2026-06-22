#!/usr/bin/env node

import { runCli } from "./main.js";

runCli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
