#!/usr/bin/env node
/**
 * CLI entry point. Kept separate from src/cli/index.ts (which exports the
 * command implementations for tests): the bin shim npm installs is a copy of
 * this file, and `main()` here always runs.
 */

import { main } from "./index.ts"

await main()
