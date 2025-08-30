// overlay/ui/NameplateFactory.ts
import Phaser from 'phaser';

const nameplateCache = new Map<string, string>(); // "MightyMouse|Wizard" -> textureKey

// Tweak these to taste
const NAME_H = 12;
const ROLE_H = 10;
const V_GAP = 2;            // gap between name and role bars
const LEFT_INSET = 12;      // space to the left so the avatar can "kiss" the box
const PAD_X = 6;            // text horizontal padding inside each bar
const STROKE = 1;
const FRAME_COLOR = 0xc9aa71;

/**
 * Bakes a tiny two-row medieval nameplate (name + role) into a texture and returns the key.
 * We cache per (name|role) so identical pairs reuse the same texture.
 */
export function getOrCreateNameplate(scene: Phaser.Scene, name: string, role: string): string {
  const cacheKey = `np_${name}|${role}`;
  const outKey = cacheKey.replace('|', '_');

  if (nameplateCache.has(cacheKey)) return nameplateCache.get(cacheKey)!;

  // Create temporary Text to measure widths
  const tmpName = scene.add.text(-1000, -1000, name, {
    fontSize: '10px',
    fontStyle: 'bold',
    color: '#ffffff',
  }).setOrigin(0.5, 0.5);

  const tmpRole = scene.add.text(-1000, -1000, role, {
    fontSize: '9px',
    color: '#dddddd',
  }).setOrigin(0.5, 0.5);

  // Compute widths (clamped to a minimum so ultra-short names still look nice)
  const nameW = Math.max(40, Math.ceil(tmpName.width) + PAD_X * 2);
  const roleW = Math.max(34, Math.ceil(tmpRole.width) + PAD_X * 2);

  // Overall canvas size
  const width  = Math.max(nameW, roleW) + LEFT_INSET; // room on the left for the avatar to sit flush
  const height = NAME_H + V_GAP + ROLE_H;

  // Build an offscreen render texture
  const rt = scene.add.renderTexture(-9999, -9999, width, height).setVisible(false);

  // Draw frames
  const g = scene.add.graphics();
  g.lineStyle(STROKE, FRAME_COLOR, 1);

  // Name bar (top)
  g.strokeRoundedRect(LEFT_INSET + STROKE * 0.5, STROKE * 0.5, nameW - STROKE, NAME_H - STROKE, 2);

  // Role bar (bottom)
  const roleY = NAME_H + V_GAP;
  g.strokeRoundedRect(LEFT_INSET + STROKE * 0.5, roleY + STROKE * 0.5, roleW - STROKE, ROLE_H - STROKE, 2);

  rt.draw(g, 0, 0);
  g.destroy();

  // Reposition text to the correct centers and draw once into the RT
  tmpName.setPosition(LEFT_INSET + nameW / 2, NAME_H / 2).setStroke('#000', 2);
  tmpRole.setPosition(LEFT_INSET + roleW / 2, roleY + ROLE_H / 2).setStroke('#000', 2);

  rt.draw(tmpName);
  rt.draw(tmpRole);

  // Cleanup temp texts
  tmpName.destroy();
  tmpRole.destroy();

  // Save baked texture and destroy RT
  rt.saveTexture(outKey);
  rt.destroy();

  nameplateCache.set(cacheKey, outKey);
  return outKey;
}
