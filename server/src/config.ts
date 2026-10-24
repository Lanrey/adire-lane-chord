// Environment configuration (spec 03-design §D10). Secrets only ever come from env.

export type Config = {
  port: number;
  publicBaseUrl: string;
  mcpToken: string;
  adminToken: string;
  paystackSecretKey: string | null;
  dbPath: string;
  reservationMinutes: number;
  offerMinutes: number;
  mcpMaxPerMinute?: number;
  /** simulated | paystack_test | chord (specs/07). */
  paymentMode?: 'simulated' | 'paystack_test' | 'chord';
  chordWebhookSecret?: string | null;
  chord?: { baseUrl: string; apiKey: string; workspaceId: string; teammateId: string } | null;
  /** Bearer for the owner-only MCP endpoint /mcp/owner (specs/08 I-3). */
  ownerMcpToken?: string | null;
  /** PIN Kemi types in chat before the Owner teammate may change anything (specs/09 G-1). */
  ownerPin?: string | null;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mcpToken = env.MCP_TOKEN ?? '';
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (mcpToken.length < 24) throw new Error('MCP_TOKEN must be set and at least 24 characters');
  if (adminToken.length < 24) throw new Error('ADMIN_TOKEN must be set and at least 24 characters');

  const paystack = env.PAYSTACK_SECRET_KEY?.trim() || null;
  if (paystack && !paystack.startsWith('sk_test_')) {
    throw new Error('PAYSTACK_SECRET_KEY must be a test key (sk_test_…). Live keys are refused.');
  }

  const port = Number(env.PORT ?? 8787);
  const paymentMode = (env.PAYMENT_MODE as Config['paymentMode']) ?? (paystack ? 'paystack_test' : 'simulated');
  if (!['simulated', 'paystack_test', 'chord'].includes(paymentMode!)) throw new Error(`Unknown PAYMENT_MODE ${paymentMode}`);
  if (paymentMode === 'paystack_test' && !paystack) throw new Error('PAYMENT_MODE=paystack_test needs PAYSTACK_SECRET_KEY');
  if (paymentMode === 'chord' && !paystack) console.warn('PAYMENT_MODE=chord without PAYSTACK_SECRET_KEY: payments confirm only via Chord webhooks (no direct Paystack verification)');
  // Backend → Chord API access (proactive updates, memory, catalog sync) whenever credentials are present.
  const chord: Config['chord'] = env.CHORD_API_KEY && env.CHORD_WORKSPACE_ID && env.CHORD_TEAMMATE_ID
    ? { baseUrl: env.CHORD_BASE_URL ?? 'https://api.chordhq.xyz', apiKey: env.CHORD_API_KEY, workspaceId: env.CHORD_WORKSPACE_ID, teammateId: env.CHORD_TEAMMATE_ID }
    : null;
  if (paymentMode === 'chord' && (!chord || !env.CHORD_WEBHOOK_SECRET)) {
    throw new Error('PAYMENT_MODE=chord needs CHORD_API_KEY, CHORD_WORKSPACE_ID, CHORD_TEAMMATE_ID and CHORD_WEBHOOK_SECRET');
  }
  const ownerMcpToken = env.OWNER_MCP_TOKEN ?? null;
  const ownerPin = env.OWNER_PIN?.trim() || null;
  if (ownerPin && !/^\d{6,8}$/.test(ownerPin)) throw new Error('OWNER_PIN must be 6–8 digits');
  if (ownerMcpToken && ownerMcpToken.length < 24) throw new Error('OWNER_MCP_TOKEN must be at least 24 characters');
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    mcpToken,
    adminToken,
    paystackSecretKey: paystack,
    dbPath: env.DB_PATH ?? './data/adire-lane.db',
    reservationMinutes: Number(env.RESERVATION_MINUTES ?? 30),
    offerMinutes: Number(env.OFFER_MINUTES ?? 60),
    mcpMaxPerMinute: Number(env.MCP_MAX_RPM ?? 120),
    paymentMode,
    chordWebhookSecret: env.CHORD_WEBHOOK_SECRET ?? null,
    chord,
    ownerMcpToken,
    ownerPin,
  };
}
