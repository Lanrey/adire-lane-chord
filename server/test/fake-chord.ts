// In-memory fake of the Chord endpoints the backend calls (threads, scheduled tasks, memories, catalogs, bookings).
export type FakeChord = ReturnType<typeof fakeChord>;

export function fakeChord(opts: { teammateId?: string } = {}) {
  const tm = opts.teammateId ?? 'tm';
  const state = {
    threads: [] as { id: string; teammate_id: string; control_state: string; text: string; sender_id: string }[],
    tasks: [] as { id: string; body: Record<string, unknown> }[],
    memories: [] as Record<string, unknown>[],
    bookings: [] as Record<string, unknown>[],
    catalogPuts: [] as unknown[],
    calls: [] as string[],
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${u.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.pathname === '/v1/threads' && method === 'GET') {
      const q = u.searchParams.get('q') ?? '';
      return json({ threads: state.threads.filter((t) => t.text.includes(q)) });
    }
    const th = u.pathname.match(/^\/v1\/threads\/([^/]+)$/);
    if (th) {
      const t = state.threads.find((x) => x.id === th[1]);
      return t ? json({ ...t, metadata: { partner_chat: { sender_id: t.sender_id } } }) : json({ error: { code: 'NOT_FOUND' } }, 404);
    }
    if (u.pathname === '/v1/scheduled-tasks' && method === 'POST') {
      const id = `task_${state.tasks.length + 1}`;
      state.tasks.push({ id, body });
      return json({ id, status: 'PENDING' }, 201);
    }
    if (u.pathname.endsWith('/memories') && method === 'POST') { state.memories.push(body); return json({ id: `mem_${state.memories.length}` }, 201); }
    if (u.pathname.endsWith('/bookings') && method === 'GET') return json({ data: state.bookings, pagination: { has_more: false } });
    if (u.pathname.endsWith('/catalogs') && method === 'GET') return json({ catalogs: [] });
    if (u.pathname.endsWith('/catalogs') && method === 'POST' && u.pathname.includes('/workspaces/')) return json({ id: 'cat-1', name: 'Adire Lane orders' }, 201);
    if (u.pathname.includes('/teammates/') && u.pathname.endsWith('/catalogs')) return json({});
    if (u.pathname.includes('/catalogs/cat-1') && method === 'PUT') { state.catalogPuts.push(body); return json({ id: 'cat-1' }); }
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  }) as typeof fetch;
  return { state, fetchImpl, teammateId: tm, addThread: (id: string, text: string, control_state = 'agent_active', teammate_id = tm) =>
    state.threads.push({ id, teammate_id, control_state, text, sender_id: `sim:${id}` }) };
}
