import Phaser from 'phaser';
import { SceneBattle } from './game/SceneBattle';

// Ensure a HUD root exists (absolute, pointer-events: none)
const HUD_ID = 'hud';
let hud = document.getElementById(HUD_ID);
if (!hud) {
  hud = document.createElement('div');
  hud.id = HUD_ID;
  Object.assign(hud.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '10',
    fontFamily: 'Inter, system-ui, Arial',
    color: '#fff',
  });
  document.body.appendChild(hud);
}


const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1920,
  height: 1080,
  backgroundColor: '#121212',
  pixelArt: true,
  physics: {
    default: 'matter',              // ← Matter required by Fighter
    matter: { gravity: {
      y: 0,
      x: 0
    }, debug: false },
  },
  scene: [SceneBattle],
};

new Phaser.Game(config);