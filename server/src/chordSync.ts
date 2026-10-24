// Mirror payable orders into a Chord catalog so Chord's own payment tool can charge them (specs/07 P-2).
// Our DB stays the source of truth: every sync rebuilds the item list from current pending orders.
import type { DB } from './db.ts';
import { now } from './db.ts';

import { ChordApi } from './chordApi.ts';
import type { ChordApiConfig } from './chordApi.ts';

export type ChordSyncConfig = ChordApiConfig & { catalogName?: string };

export class ChordCatalogSync {
  api: ChordApi;
  catalogName: string;
  catalogId: string | null = null;
  constructor(cfg: ChordSyncConfig | ChordApi, fetchImpl: typeof fetch = fetch) {
    this.api = cfg instanceof ChordApi ? cfg : new ChordApi(cfg, fetchImpl);
    this.catalogName = (cfg instanceof ChordApi ? undefined : cfg.catalogName) ?? 'Adire Lane orders';
  }

  private async ensureCatalog(): Promise<string> {
    if (this.catalogId) return this.catalogId;
    const list = await this.api.request<{ catalogs: { id: string; name: string }[] }>('GET', `/v1/workspaces/${this.api.ws}/catalogs`);
    let cat = list.catalogs.find((c) => c.name === this.catalogName);
    if (!cat) cat = await this.api.request<{ id: string; name: string }>('POST', `/v1/workspaces/${this.api.ws}/catalogs`, { name: this.catalogName, currency: 'NGN', items: [] });
    await this.api.request('POST', `/v1/teammates/${this.api.tm}/catalogs`, { catalog_id: cat.id });
    this.catalogId = cat.id;
    return cat.id;
  }

  /** Full replace: one item per live pending order, priced at the exact agreed total. */
  async sync(db: DB): Promise<{ ok: true; items: number } | { ok: false; error: string }> {
    try {
      const id = await this.ensureCatalog();
      const orders = db.prepare(
        "SELECT reference, total FROM orders WHERE status = 'pending_payment' AND reserved_until > ? ORDER BY created_at DESC LIMIT 100",
      ).all(now()) as { reference: string; total: number }[];
      const items = orders.map((o) => ({
        id: o.reference, name: `Adire Lane order ${o.reference}`, category: 'orders',
        description: `Payment for Adire Lane order ${o.reference}`, amount_minor: o.total, available: true,
      }));
      await this.api.request('PUT', `/v1/workspaces/${this.api.ws}/catalogs/${id}`, { items });
      return { ok: true, items: items.length };
    } catch (err) {
      console.error(JSON.stringify({ evt: 'chord_catalog_sync_failed', message: (err as Error).message }));
      return { ok: false, error: (err as Error).message };
    }
  }
}
