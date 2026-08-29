import * as dns from 'dns';

/**
 * @description Prefer IPv4 when DNS returns both address families. Hosts that
 * advertise but cannot route IPv6 otherwise wait for a long timeout before
 * falling back to IPv4 for Telegram, provider, and MCP requests.
 */
export function applyDnsFix(): void {
  dns.setDefaultResultOrder('ipv4first');
}
