// Boot: config → DB (+seed on first run) → HTTP.
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { isSeeded, seed, syncBusinessInfo } from './seed.ts';
import { buildApp } from './http.ts';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
if (!isSeeded(db)) {
  seed(db);
  console.log('Seeded demo catalogue');
}
syncBusinessInfo(db);
const app = buildApp(db, cfg);
app.locals.sweeper?.start();
const server = app.listen(cfg.port, () => {
  console.log(`Adire Lane commerce listening on :${cfg.port}`);
  console.log(`  MCP endpoint   ${cfg.publicBaseUrl}/mcp`);
  console.log(`  Owner admin    ${cfg.publicBaseUrl}/admin`);
  console.log(`  Payment mode   ${app.locals.sweeper ? '' : ''}${cfg.paymentMode ?? (cfg.paystackSecretKey ? 'paystack_test' : 'simulated')}`);
  console.log(`  Proactive updates ${app.locals.sweeper ? 'on (Chord scheduled messages)' : 'off (no Chord API credentials)'}`);
});

// Keep connections from Chord / the Fly proxy reusable: idle timeout above common 60s proxy timeouts (specs/06 R-4.2).
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
