#!/usr/bin/env node

import { applyDnsFix } from './applyDnsFix';
import { runBot } from './bot';

applyDnsFix();

runBot().catch((error) => {
  console.error(error);
  process.exit(1);
});
