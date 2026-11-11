/**
 * sv-control — SingersVoice control plane (Hono + WebSocket, Node 22, no build step).
 *
 *   npm run control            # http://localhost:8787
 *   GET  /health               # liveness
 *   GET  /time                 # server epoch ms (clients sync their clocks against it)
 *   GET  /meets                # open meets
 *   POST /meets                # { title, trackId, trackTitle, backgroundId, hostId }
 *   WS   /ws?meetId=…          # ClientMessage / ServerMessage from @singersvoice/protocol
 *
 * Skeleton scope (V2): rooms, stage slots (max 10), ready state, GMT kickstart, chat, resume tokens.
 * Not yet: Google ID-token auth, Postgres, session-pod scheduling, LL-HLS stream URLs.
 */
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { newId, type ClientMessage } from '@singersvoice/protocol';
import { MeetRegistry, type Client } from './meets.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://localhost:4173,https://singersvoice.github.io').split(',');

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const registry = new MeetRegistry();

app.use('*', cors({ origin: ORIGINS }));
app.get('/health', (c) => c.json({ ok: true, service: 'sv-control', version: '2.0.0', meets: registry.rooms.size, now: Date.now() }));
app.get('/time', (c) => c.json({ serverEpochMs: Date.now() }));
app.get('/meets', (c) => c.json(registry.list()));
app.post('/meets', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<{ title: string; trackId: string; trackTitle: string; backgroundId: string; hostId: string }>;
  if (!body.trackId || !body.hostId) return c.json({ error: 'trackId and hostId are required' }, 400);
  const room = registry.create({
    title: body.title ?? 'SingersVoice meet',
    hostId: body.hostId,
    trackId: body.trackId,
    trackTitle: body.trackTitle ?? '',
    backgroundId: body.backgroundId ?? 'mytestbg1',
  });
  return c.json(room.meet, 201);
});

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    const meetId = c.req.query('meetId') ?? '';
    const clientId = newId('cli-');
    let client: Client | null = null;
    return {
      onMessage(evt, ws) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(evt.data)) as ClientMessage;
        } catch {
          return ws.send(JSON.stringify({ t: 'error', code: 'bad_json', message: 'Invalid message' }));
        }
        const room = registry.get(meetId);
        if (!room) return ws.send(JSON.stringify({ t: 'error', code: 'no_meet', message: 'Meet not found' }));
        if (msg.t === 'hello') {
          // TODO(V2): verify Google ID token → userId/displayName. Until then the token carries a display name.
          client = {
            id: clientId,
            userId: msg.token || clientId,
            displayName: msg.token || 'Guest',
            role: msg.role,
            slot: null,
            resumeToken: msg.resumeToken ?? newId('rt-'),
            send: (m) => ws.send(JSON.stringify(m)),
            lastSeen: Date.now(),
          };
          room.join(client);
          return;
        }
        if (!client) return ws.send(JSON.stringify({ t: 'error', code: 'no_hello', message: 'Send hello first' }));
        client.lastSeen = Date.now();
        const isHost = client.userId === room.meet.hostId;
        switch (msg.t) {
          case 'ping':
            client.send({ t: 'pong', sentAt: msg.sentAt, serverEpochMs: Date.now() });
            break;
          case 'claimSlot':
            if (!room.claimSlot(client.id, msg.slot)) client.send({ t: 'error', code: 'slot_taken', message: `Slot ${msg.slot} is taken` });
            break;
          case 'leaveSlot':
            if (client.slot) {
              room.releaseSlot(client.slot);
              client.slot = null;
              client.role = 'audience';
              room.broadcast({ t: 'meet', meet: room.meet });
            }
            break;
          case 'ready':
            room.setReady(client.id, msg.ready);
            break;
          case 'chat':
            room.say(client.id, msg.text);
            break;
          case 'host.start':
            if (isHost) room.start(msg.leadMs);
            else client.send({ t: 'error', code: 'not_host', message: 'Only the host can start' });
            break;
          case 'host.stop':
            if (isHost) room.stop('host');
            break;
          case 'host.setTrack':
            if (isHost) {
              room.meet.trackId = msg.trackId;
              room.broadcast({ t: 'meet', meet: room.meet });
            }
            break;
          case 'host.setBackground':
            if (isHost) {
              room.meet.backgroundId = msg.backgroundId;
              room.broadcast({ t: 'meet', meet: room.meet });
            }
            break;
          case 'perf.clockReport':
            // Drift/RTT telemetry per performer; feeds the continuity ladder later.
            break;
        }
      },
      onClose() {
        if (client) registry.get(meetId)?.leave(client.id);
      },
    };
  }),
);

const server = serve({ fetch: app.fetch, port: PORT }, () => console.log(`sv-control listening on :${PORT}`));
injectWebSocket(server);
