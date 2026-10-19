// Engine voices for the synthesizer in engine-worklet.js, one per car.
//
// The sound of an engine is set mostly by when each exhaust bank receives a combustion pulse,
// which follows from the cylinder count, the crank layout and the firing order:
//  - flat-plane V8 / flat-six / V12 / V6 with alternating banks: each bank hears evenly spaced
//    pulses, so the sound is smooth and rises in pitch to a howl or scream;
//  - cross-plane V8: each bank hears pulses 180-270-180-90 degrees apart, which puts energy at
//    half and quarter orders - the uneven "burble" of a muscle car or an AMG;
//  - turbochargers sit in the exhaust and soak up the pulse edges (a softer, deeper tone) and add
//    compressor whistle and a blow-off on a lift;
//  - pipe lengths and diameters set the resonances (bigger cylinders and longer pipes: lower).
// Events are [fraction of the four-stroke cycle (720 deg of crank), exhaust bank 0/1].
// Values are design estimates from engine geometry, not recordings or measurements.

const even = (n, banks) => Array.from({ length: n }, (_, k) => [k / n, banks[k % banks.length]]);

export const VOICES = {
  // Rosser Stella V8: flat-plane V8, 9,000 rpm. The original voice (synth defaults).
  stella: {},

  // Porsche 911 Carrera S / 4S (992): 3.0 L twin-turbo flat-six. Boxer firing alternates banks
  // (1-6-2-4-3-5), so each bank hears three evenly spaced pulses: the flat-six howl, three
  // pulses per crank revolution. Smaller cylinders and short headers: higher resonances than a
  // V8. Twin turbos soften it; the sports exhaust still crackles on a lift.
  porsche911: {
    events: even(6, [0, 1]),
    jitter: 0.004,
    res: [[118, 8, 0.013, 0.85], [355, 16, 0.0065, 0.62], [840, 28, 0.0042, 0.52], [1720, 60, 0.0028, 0.32], [3400, 110, 0.0015, 0.15]],
    comb: [0.0074, 0.0003],
    intake: [[2150, 0.0024, 1], [4100, 0.0012, 0.45]],
    whineOrder: 30,
    stereo: 0.66,
    turbo: 0.5,
    turboWhistle: 0.8,
    crackle: 0.9,
    interior: 0.14,
    drive: 1.05,
    gain: 1.0,
  },

  // Mercedes-AMG S 63 (W222): 4.0 L "hot-V" twin-turbo cross-plane V8. Bank order L R L R R L R L
  // gives each bank uneven pulses (the AMG burble). Big bores and long pipes: low resonances.
  // The S-Class cabin is well insulated; the AMG exhaust flaps still let it pop on a lift.
  amgS63: {
    events: [[0, 0], [1 / 8, 1], [2 / 8, 0], [3 / 8, 1], [4 / 8, 1], [5 / 8, 0], [6 / 8, 1], [7 / 8, 0]],
    jitter: 0.008,
    res: [[78, 5, 0.019, 0.95], [252, 12, 0.008, 0.6], [565, 22, 0.005, 0.45], [1220, 50, 0.003, 0.24], [2650, 100, 0.0016, 0.11]],
    comb: [0.0106, 0.0005],
    intake: [[1650, 0.0026, 1], [3200, 0.0012, 0.4]],
    whineOrder: 22,
    stereo: 0.7,
    turbo: 0.45,
    turboWhistle: 0.6,
    crackle: 1.6,
    interior: 0.1,
    drive: 1.1,
    gain: 1.0,
  },

  // Mercedes-Benz S 600 Guard: 6.0 L twin-turbo 60-degree V12. Twelve even events alternating
  // banks - effectively two straight-sixes - so it is very smooth: a turbine-like hum rather
  // than a beat. Heavily silenced, no pops, and an armoured cabin with ballistic glass.
  s600Guard: {
    events: even(12, [0, 1]),
    jitter: 0.003,
    res: [[88, 6, 0.016, 0.8], [282, 12, 0.007, 0.48], [640, 24, 0.0045, 0.36], [1350, 50, 0.003, 0.2], [2900, 100, 0.0016, 0.08]],
    comb: [0.0112, 0.0004],
    intake: [[1500, 0.0028, 1], [2900, 0.0013, 0.35]],
    whineOrder: 36,
    stereo: 0.62,
    turbo: 0.75,
    turboWhistle: 0.45,
    crackle: 0.12,
    interior: 0.06,
    drive: 0.8,
    gain: 0.85,
  },

  // Formula 1: 1.6 L 90-degree V6 turbo hybrid, 15,000 rpm limit. Even firing into a single
  // turbo and one tailpipe (merged exhaust), very short pipes: a high, rasping note. The hybrid
  // motor on the crank adds an electric whine; the straight-cut gearbox whines too.
  f1: {
    events: even(6, [0, 1]),
    jitter: 0.002,
    res: [[165, 4, 0.01, 0.7], [490, 10, 0.0055, 0.62], [1120, 20, 0.0038, 0.56], [2350, 40, 0.0024, 0.4], [4600, 80, 0.0012, 0.2]],
    comb: [0.0046, 0.0002],
    combFb: 0.4,
    intake: [[2500, 0.002, 1], [5000, 0.001, 0.5]],
    pulseW: 0.00028,
    whineOrder: 42,
    stereo: 0.52,
    turbo: 0.4,
    turboWhistle: 0.7,
    crackle: 0.35,
    hybrid: 1,
    hybridOrder: 12,
    interior: 0.3,
    drive: 1.3,
    gain: 1.0,
  },

  // Generic reference cars (fictional), each given a fitting layout so they don't all share the
  // Stella's V8.
  // Sports RWD: 3.0 L turbo straight-six, twin-scroll (cylinders 1-3 and 4-6 on separate scrolls,
  // firing 1-5-3-6-2-4 alternates them), one tailpipe pair.
  refSports: {
    events: even(6, [0, 1]),
    jitter: 0.004,
    res: [[105, 3, 0.014, 0.85], [330, 8, 0.0065, 0.58], [760, 15, 0.0043, 0.48], [1600, 30, 0.0028, 0.28], [3300, 60, 0.0015, 0.13]],
    comb: [0.0088, 0.0002],
    stereo: 0.55,
    turbo: 0.6,
    crackle: 0.7,
    gain: 0.95,
  },
  // Hatch FWD: 2.0 L turbo four, 4-2-1 manifold, single exhaust: a nasal, buzzy note.
  refHatch: {
    events: even(4, [0, 1]),
    jitter: 0.005,
    res: [[124, 4, 0.012, 0.8], [385, 10, 0.006, 0.6], [910, 20, 0.004, 0.5], [1900, 40, 0.0025, 0.3], [3800, 80, 0.0014, 0.15]],
    comb: [0.0072, 0.0002],
    stereo: 0.52,
    turbo: 0.45,
    crackle: 0.4,
    gain: 0.85,
  },
  // Saloon AWD: 3.0 L twin-turbo 90-degree V6, even firing alternating banks.
  refSaloon: {
    events: even(6, [0, 1]),
    jitter: 0.005,
    res: [[98, 6, 0.015, 0.85], [310, 12, 0.007, 0.55], [720, 24, 0.0045, 0.45], [1500, 50, 0.003, 0.26], [3150, 100, 0.0016, 0.12]],
    comb: [0.0095, 0.0004],
    turbo: 0.6,
    crackle: 0.6,
    interior: 0.12,
    gain: 0.95,
  },
  // Hypercar: 8.0 L quad-turbo W16 (16 even events, two banks): deep, dense, whooshing.
  refHyper: {
    events: even(16, [0, 1]),
    jitter: 0.003,
    res: [[70, 5, 0.02, 0.9], [230, 12, 0.008, 0.55], [520, 22, 0.005, 0.42], [1150, 50, 0.003, 0.22], [2500, 100, 0.0016, 0.1]],
    comb: [0.011, 0.0005],
    turbo: 0.8,
    turboWhistle: 1.2,
    crackle: 0.5,
    gain: 0.95,
  },
  // Race car (high downforce): 3.0 L naturally aspirated 72-degree V10, 12,500 rpm.
  refRace: {
    events: even(10, [0, 1]),
    jitter: 0.003,
    res: [[140, 6, 0.011, 0.8], [440, 14, 0.0058, 0.6], [1020, 26, 0.0039, 0.55], [2150, 50, 0.0025, 0.36], [4300, 100, 0.0013, 0.18]],
    comb: [0.0052, 0.0003],
    pulseW: 0.0003,
    whineOrder: 40,
    crackle: 0.6,
    interior: 0.35,
    drive: 1.25,
    gain: 1.0,
  },
  // Sport motorcycle: 1.0 L flat-plane inline four, 4-into-1 exhaust, 12,500 rpm: the screamer.
  motorcycle: {
    events: even(4, [0, 1]),
    jitter: 0.004,
    res: [[150, 3, 0.011, 0.8], [470, 8, 0.0055, 0.62], [1080, 16, 0.0038, 0.55], [2250, 30, 0.0024, 0.36], [4500, 60, 0.0013, 0.18]],
    comb: [0.005, 0.0001],
    pulseW: 0.0003,
    stereo: 0.5,
    crackle: 0.8,
    drive: 1.2,
    gain: 0.9,
  },
};
