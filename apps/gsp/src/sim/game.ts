// The paperwork: counters, achievements and dispatch radio. Purely game-side; reads what the
// physics did, never changes it.
import type { Rng } from './math';

export interface Counters {
  propertyDamage: number; // $ to the state, the county and the public
  patrolRepair: number; // $ to the patrol fleet
  conesLost: number;
  pursuitTime: number; // s
  apprehensions: number;
  forms: number; // administrative burden
  pages: number;
  pits: number;
  guardrailHits: number;
  signsDown: number;
  windows: number;
}

export type ToastKind = 'dispatch' | 'achievement' | 'radio' | 'info' | 'bill';
export interface Toast { id: number; kind: ToastKind; title: string; text: string; t: number }

export const LOADING_LINES = [
  'Welcome to Georgia. You should\'ve taken Alabama.',
  'Calibrating the tyre model against a parking lot full of Waffle House napkins…',
  'Teaching the suspect to ignore blue lights…',
  'Filing Form GSP-1138 in triplicate…',
  'Pre-heating the boiled peanuts…',
  'Reminding the guardrails that they are load-bearing…',
  'Negotiating with the county for more cones…',
  'Checking the pursuit policy (it says "be careful")…',
];

export const ACHIEVEMENTS: Record<string, string> = {
  welcome: 'Welcome to Georgia. You should\'ve taken Alabama.',
  paperwork: 'The paperwork has entered the chat.',
  guardrail: 'That guardrail was taxpayer-funded.',
  adjuster: 'Insurance Adjuster Difficulty: Legendary.',
  county: 'The County Has Requested Financial Assistance.',
  supervisor: 'Your supervisor would like a word.',
  gdot: 'Georgia Department of Transportation disliked that.',
  concluded: 'Pursuit concluded. Administrative nightmare initiated.',
  pit: 'Textbook PIT. The textbook is now under review.',
  cones: 'Cone Zone? More like Gone Zone.',
  rollover: 'Gravity: 1. Paint job: 0.',
  airtime: 'The Dukes of Hazzard was not a training video.',
  glass: 'Safety glass performed exactly as advertised.',
  drift: 'Tokyo Drift: Macon Edition.',
  wrongway: 'Wrong way. Your other wrong way.',
  pileup: 'Three-car pileup. The tow trucks are giddy.',
  overpass: 'Bridge inspection is due in 2031. Was.',
};

const RADIO = {
  start: [
    'Dispatch to 71: suspect vehicle is a {car}, northbound on the I-GSP loop at a high rate of speed. Driver is {name}. {blurb}',
    'All units, 71 is in pursuit of a {car}. Suspect is {name}. {blurb}',
  ],
  chatter: [
    '71, be advised: the suspect\'s mama called. She says he\'s a good boy.',
    'Unit 12 en route, ETA whenever the biscuits are done.',
    'County says if you hit another cone they\'re sending you the invoice personally.',
    '71, GDOT wants to know who keeps redecorating their guardrail.',
    'Air unit is grounded. The pilot is at his daughter\'s recital.',
    'Reminder: the pursuit policy says "be careful." That\'s the whole policy.',
    'Lieutenant says the paperwork for this one will be "a journey."',
    'Be advised, there is a pickup full of watermelons somewhere on the loop. Do not. Hit. The watermelons.',
    'Dispatch has located the suspect\'s Facebook. He is posting about this pursuit. Live.',
  ],
  pit: ['71, nice PIT. Sergeant wants you to know that was "fine."', 'Textbook. Somebody get the dash cam to Training.'],
  concluded: ['Suspect in custody. 71, you\'re going to need a bigger clipboard.', 'Pursuit terminated. Supervisor is on scene, and he brought forms.'],
};

export class GameState {
  counters: Counters = this.zero();
  toasts: Toast[] = [];
  achieved = new Set<string>();
  pursuit = { active: false, start: 0, concluded: false, reason: '' };
  private nextId = 1;
  private chatterTimer = 25;
  onToast?: (t: Toast) => void;
  onRadio?: (line: string) => void;

  zero(): Counters {
    return { propertyDamage: 0, patrolRepair: 0, conesLost: 0, pursuitTime: 0, apprehensions: 0, forms: 0, pages: 0, pits: 0, guardrailHits: 0, signsDown: 0, windows: 0 };
  }

  reset(keepTotals = false) {
    if (!keepTotals) { this.counters = this.zero(); this.achieved.clear(); }
    this.pursuit = { active: false, start: 0, concluded: false, reason: '' };
    this.chatterTimer = 25;
    this.lastForm.clear();
  }

  toast(kind: ToastKind, title: string, text: string, t: number) {
    const x = { id: this.nextId++, kind, title, text, t };
    this.toasts.push(x);
    if (this.toasts.length > 30) this.toasts.shift();
    this.onToast?.(x);
  }

  achieve(key: string, t: number) {
    if (this.achieved.has(key)) return;
    this.achieved.add(key);
    this.toast('achievement', 'Achievement', ACHIEVEMENTS[key] ?? key, t);
    this.paper(1, 2);
  }

  paper(forms: number, pages: number) { this.counters.forms += forms; this.counters.pages += pages; }

  radio(text: string, t: number, title = 'Dispatch') {
    this.toast('radio', title, text, t);
    this.onRadio?.(text);
  }

  startPursuit(t: number, car: string, name: string, blurb: string, rng: Rng) {
    this.pursuit = { active: true, start: t, concluded: false, reason: '' };
    this.radio(rng.pick(RADIO.start).replace('{car}', car).replace('{name}', name).replace('{blurb}', blurb), t);
    this.achieve('paperwork', t);
    this.paper(2, 5);
  }

  apprehend(name: string, how: string, t: number, last: boolean) {
    this.counters.apprehensions++;
    this.paper(3, 12);
    if (!last) this.toast('dispatch', `${name} detained`, how, t);
  }

  conclude(t: number, reason: string, rng: Rng) {
    if (!this.pursuit.active || this.pursuit.concluded) return;
    this.pursuit.concluded = true;
    this.pursuit.reason = reason;
    this.radio(rng.pick(RADIO.concluded), t);
    this.toast('dispatch', 'Pursuit concluded', reason, t);
    this.achieve('concluded', t);
    this.paper(6, 31);
  }

  pitDone(t: number, rng: Rng) {
    this.counters.pits++;
    this.achieve('pit', t);
    if (this.counters.pits === 1 || rng.chance(0.4)) this.radio(rng.pick(RADIO.pit), t);
    this.paper(2, 6); // Use of Force narrative
  }

  private lastForm = new Map<string, number>();
  property(amount: number, what: string, t: number) {
    this.counters.propertyDamage += amount;
    // one damage report per kind of thing every few seconds (a scrape is one report, not 900)
    if ((amount >= 30 || what === 'cone') && t - (this.lastForm.get(what) ?? -99) > 3) { this.lastForm.set(what, t); this.paper(1, 1); }
    if (this.counters.propertyDamage > 100000) this.achieve('adjuster', t);
    if (this.counters.propertyDamage > 500000) this.achieve('county', t);
    void what;
  }
  patrol(amount: number, t: number) {
    this.counters.patrolRepair += amount;
    if (this.counters.patrolRepair > 15000) this.achieve('supervisor', t);
  }

  tick(dt: number, t: number, rng: Rng) {
    if (this.pursuit.active && !this.pursuit.concluded) {
      this.counters.pursuitTime += dt;
      this.chatterTimer -= dt;
      if (this.chatterTimer <= 0) { this.chatterTimer = rng.range(28, 55); this.radio(rng.pick(RADIO.chatter), t); }
      // pursuit reports: a page a minute
      if (Math.floor(this.counters.pursuitTime / 60) > Math.floor((this.counters.pursuitTime - dt) / 60)) this.paper(1, 3);
    }
  }
}
