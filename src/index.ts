#!/usr/bin/env node
import 'dotenv/config';
import { startBot } from './bot';

startBot().catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
