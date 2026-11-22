// São Paulo World · flying game: the challenges, as data.
// Positions are east, north in metres in the map's frame (MASP at the origin),
// as app.js's LANDMARKS. A ring's height is its centre above the ground under
// it; play.js lifts a ring that would sit in the terrain, and the heights
// below were checked against the building tiles (every roof within the ring's
// radius + 40 m is at least 20 m under its rim; the straight line between
// consecutive rings clears every roof within 35 m of it by 15 m).
// To add one: append an entry; `id` is what a shared link and a multiplayer
// room carry (?c=<id>), so keep ids stable.
//
// kind 'rings': start { e, n, h (m above the ground there), hdg (deg true), kt }, r (ring radius, m),
//   rings [[label, e, n, h]], stars [3-star, 2-star] seconds (a missed ring adds MISS_PENALTY).
// kind 'landing': final { km (from the threshold), kt (0: the type's approach speed), side (m right of the centreline),
//   high (m above the 3 degree path) }, wind [kt, from: deg relative to the runway heading], engine: false for a glide.
// kind 'lowpass': a straight corridor from a to b, band [low, high] m above the ground, half-width w;
//   start as rings; scored on the share of its length flown inside.
export const MISS_PENALTY = 8;

export const AIRCRAFT = {
  c172: { label: 'Little plane', sub: 'slow and nimble' },
  kingair: { label: 'Twin prop', sub: 'quick, turns well' },
  phenom300: { label: 'Fast jet', sub: 'needs room to turn' },
  b738: { label: 'Airliner', sub: 'big and steady' },
};

export const CHALLENGES = [
  {
    id: 'park-run', kind: 'rings', name: 'Park run', blurb: 'Six easy rings from Ibirapuera to Pacaembu.', aircraft: 'c172', r: 48,
    start: { e: 420, n: -4900, h: 170, hdg: 352, kt: 100 },
    rings: [['Ibirapuera', 230, -3400, 160], ['Obelisco', 143, -2580, 150], ['Paraíso', 380, -1350, 170], ['MASP', -1, 1, 175], ['Consolação', -500, 740, 170], ['Pacaembu', -969, 1417, 150]],
    stars: [115, 135],
  },
  {
    id: 'downtown', kind: 'rings', name: 'Downtown loop', blurb: 'Nine rings round the old centre and its towers, always turning right.', aircraft: 'c172', r: 48,
    start: { e: 1044, n: 4174, h: 150, hdg: 140, kt: 100 },
    rings: [['Estação da Luz', 2072, 2948, 140], ['Mercado Municipal', 2684, 2220, 130], ['Catedral da Sé', 2193, 1161, 150], ['Bela Vista', 1100, 500, 180], ['MASP', -1, 1, 175],
      ['Pacaembu', -969, 1417, 180], ['Copan', 1200, 1725, 220], ['Teatro Municipal', 1747, 1819, 260], ['Martinelli', 2150, 1780, 240]],
    stars: [210, 240],
  },
  {
    id: 'jet-dash', kind: 'rings', name: 'Jet dash', blurb: 'Congonhas to Campo de Marte in a jet: five big gates, as fast as you dare.', aircraft: 'phenom300', r: 130,
    start: { e: -760, n: -10500, h: 420, hdg: 4, kt: 250 },
    rings: [['Congonhas', -522, -7260, 380], ['Ibirapuera', -194, -2904, 380], ['Avenida Paulista', -1, 1, 420], ['Bom Retiro', 1500, 3300, 420], ['Campo de Marte', 1800, 5850, 380]],
    stars: [120, 150],
  },
  {
    id: 'rooftops', kind: 'lowpass', name: 'Rooftop run', blurb: 'Skim the towers of Avenida Paulista: stay in the lane, just above the roofs.', aircraft: 'c172',
    start: { e: 2340, n: -1545, h: 190, hdg: 303.4, kt: 100 },
    a: [1670, -1101], b: [-836, 552], band: [125, 205], w: 80,
    stars: [90, 65],
  },
  { id: 'land-it', kind: 'landing', name: 'Land it', blurb: 'The runway is straight ahead. Line it up and touch down softly.', aircraft: 'c172', final: { km: 2.2 } },
  { id: 'crosswind', kind: 'landing', name: 'Crosswind', blurb: 'The same landing with the wind pushing you sideways.', aircraft: 'c172', final: { km: 2.2 }, wind: [13, -70] },
  { id: 'glide', kind: 'landing', name: 'Engine out', blurb: 'The engine has stopped. Glide it to the runway: there is only one try.', aircraft: 'c172', final: { km: 1.7, high: 140, side: 220 }, engine: false },
  { id: 'jet-landing', kind: 'landing', name: 'Land the jet', blurb: 'Twice the speed and ten times the weight. Same idea.', aircraft: 'phenom300', final: { km: 5 } },
];
export const challengeById = (id) => CHALLENGES.find((c) => c.id === id) || null;

// The city's sights for a free flight: a ring over each to fly through. [name, e, n, h (ring centre above the ground, piston)].
export const SIGHTS = [
  ['MASP', -1, 1, 175], ['Catedral da Sé', 2193, 1161, 150], ['Copan', 1154, 1665, 230], ['Edifício Itália', 1244, 1784, 215],
  ['Martinelli', 2097, 1794, 260], ['Altino Arantes', 2209, 1768, 250], ['Estação da Luz', 2072, 2948, 140], ['Teatro Municipal', 1747, 1819, 200],
  ['Mercado Municipal', 2684, 2220, 130], ['Parque Ibirapuera', -194, -2904, 90], ['Oca', 87, -2809, 110], ['Obelisco', 143, -2580, 160],
  ['Ponte Estaiada', -4320, -5722, 160], ['Congonhas', -522, -7260, 110], ['Pacaembu', -969, 1417, 120], ['Jockey Club', -4310, -2007, 100],
  ['Conjunto Nacional', -436, 288, 180],
];
