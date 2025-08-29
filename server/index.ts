import { WebSocketServer } from 'ws';
import { WSOut, FighterDTO, Phase } from '../shared/types.ts';

const wss = new WebSocketServer({ port: 8081 });
let phase: Phase = 'LOBBY';
const fighters: FighterDTO[] = [];
let nextId = 1;

function sendAll(msg: WSOut) {
  const json = JSON.stringify(msg);
  wss.clients.forEach(c => { try { (c as any).send(json); } catch {} });
}

function pushState() {
  sendAll({ type: 'state', payload: { phase, fighters } });
}

// Simulated joins during LOBBY
setInterval(() => {
  if (phase !== 'LOBBY') return;
  const id = `u${nextId++}`;
  const team: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B';
  const dto: FighterDTO = {
    id,
    name: `User${Math.floor(Math.random() * 5000)}`,
    team,
    hue: Math.floor(Math.random() * 360),
    level: 1
  };
  fighters.push(dto);
  sendAll({ type: 'joined', payload: dto });
}, 1300);

// Main loop: lobby -> countdown -> battle -> finish -> reset
const loop = async () => {
  while (true) {
    phase = 'LOBBY'; pushState();
    await wait(25000);

    phase = 'COUNTDOWN'; sendAll({ type: 'phase', payload: { phase } });
    await wait(3000);

    phase = 'BATTLE'; sendAll({ type: 'phase', payload: { phase } });
    await wait(35000); // safety end
    fighters.length = 0;
  }
};
loop();

wss.on('connection', (ws) => {
  (ws as any).send(JSON.stringify({ type: 'state', payload: { phase, fighters } } as WSOut));

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg?.type === 'winner') {
        phase = 'FINISH';
        sendAll({ type: 'phase', payload: { phase } });
        setTimeout(() => {
          fighters.length = 0;
          phase = 'LOBBY';
          pushState();
        }, 5000);
      }
    } catch {}
  });
});

// Simulated hearts/gifts during battle
setInterval(() => {
  if (phase !== 'BATTLE') return;
  sendAll({ type: 'hearts', payload: { count: 20 + Math.floor(Math.random() * 50) } });
  if (Math.random() < 0.25) {
    const pick = fighters[Math.floor(Math.random() * fighters.length)];
    if (pick) sendAll({ type: 'gift', payload: { giftType: 'levelup', userId: pick.id } });
  }
}, 2000);

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

console.log('WS server on ws://localhost:8081');