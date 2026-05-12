#!/usr/bin/env node

// Node 17+ defaults DNS resolution to `verbatim` order, which returns
// IPv6 addresses first when both AAAA and A records exist. On hosts
// where IPv6 advertises but isn't routed (common with consumer ISPs,
// many cloud VPCs, ARM Linux desktops), every outbound request to
// api.telegram.org / api.anthropic.com / mcp.* lands in a 60-second
// `ETIMEDOUT` before the IPv4 fallback kicks in.
//
// `ipv4first` makes Node return IPv4 first and IPv6 second, restoring
// the pre-Node-17 behaviour. On dual-stack hosts where IPv6 actually
// works this costs nothing — the connection still establishes on the
// first try. The only downside is bypassing the host's preference, but
// for a Telegram bot that talks to a handful of fixed v4-only-reliable
// endpoints this is the right trade.
import * as dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import 'dotenv/config';
import { startBot } from './bot';

startBot().catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});
