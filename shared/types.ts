export type Phase = 'LOBBY' | 'COUNTDOWN' | 'BATTLE' | 'FINISH';

export type FighterDTO = {
  id: string;
  name: string;
  team: 'A' | 'B';
  hue: number;     // 0..360
  level: number;   // gifts can raise this
  avatarUrl?: string; // player avatar URL
};

export type StatePayload = {
  phase: Phase;
  fighters: FighterDTO[];
};

export type WSOut =
  | { type: 'state'; payload: StatePayload }
  | { type: 'phase'; payload: { phase: Phase } }
  | { type: 'joined'; payload: FighterDTO }
  | { type: 'hearts'; payload: { count: number; userId?: string } }
  | { type: 'gift'; payload: { giftType: string; userId?: string } }
  | { type: 'winner'; payload: { id: string } };

export type WSIn =
  | { type: 'winner'; payload: { id: string } };
