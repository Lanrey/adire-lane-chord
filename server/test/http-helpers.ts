import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/http.ts';
import { freshDb } from './helpers.ts';
import type { Config } from '../src/config.ts';

export const MCP_TOKEN = 'mcp-test-token-0123456789abcdef';
export const ADMIN_TOKEN = 'admin-test-token-0123456789abcdef';

export async function startServer(overrides: Partial<Config> = {}, appOpts: Parameters<typeof buildApp>[2] = {}) {
  const db = freshDb();
  const cfg: Config = {
    port: 0, publicBaseUrl: 'http://localhost', mcpToken: MCP_TOKEN, adminToken: ADMIN_TOKEN,
    paystackSecretKey: null, dbPath: ':memory:', reservationMinutes: 30, offerMinutes: 60, ownerPin: '246810', ...overrides,
  };
  const server: Server = await new Promise((resolve) => { const s = buildApp(db, cfg, appOpts).listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}
