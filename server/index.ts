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

// Enhanced hearts simulation with per-user attribution
function simulateHearts() {
  if (phase !== 'BATTLE' || fighters.length === 0) return;
  
  const totalHearts = 20 + Math.floor(Math.random() * 50);
  
  // Sometimes attribute to specific users, sometimes just total
  if (Math.random() < 0.6 && fighters.length > 0) {
    // Distribute hearts among random users
    const heartGivers = Math.min(3, Math.max(1, Math.floor(fighters.length * 0.3)));
    const remainingHearts = totalHearts;
    
    for (let i = 0; i < heartGivers; i++) {
      const user = fighters[Math.floor(Math.random() * fighters.length)];
      const userHearts = Math.floor(remainingHearts / (heartGivers - i)) + Math.floor(Math.random() * 10);
      sendAll({ type: 'hearts', payload: { count: userHearts, userId: user.id } });
    }
  } else {
    // Just send total without user attribution
    sendAll({ type: 'hearts', payload: { count: totalHearts } });
  }
}

// Simulated joins during LOBBY
setInterval(() => {
  if (phase !== 'LOBBY') return;
  const id = `u${nextId++}`;
  const team: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B';
  const avatarUrl = Math.random() < 0.7 ? `https://i.pravatar.cc/150?u=${id}` : undefined;
  const dto: FighterDTO = {
    id,
    name: `User${Math.floor(Math.random() * 5000)}`,
    team,
    hue: Math.floor(Math.random() * 360),
    level: 1,
    avatarUrl
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
  simulateHearts();
  if (Math.random() < 0.25) {
    const pick = fighters[Math.floor(Math.random() * fighters.length)];
    if (pick) sendAll({ type: 'gift', payload: { giftType: 'levelup', userId: pick.id } });
  }
}, 2000);

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

console.log('WS server on ws://localhost:8081');