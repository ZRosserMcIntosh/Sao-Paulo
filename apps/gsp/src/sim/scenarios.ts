// Test scenarios A-F. Each is data: where the player starts, who is out there, the weather.
// Spawning is deterministic for a given seed.
import type { VehicleKind } from './vehicle/catalog';

export type ScenarioId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface SuspectSpec { kind: VehicleKind; personality: string; ahead: number; lane: number; speed: number; paint?: string }

export interface Weather { rain: number; puddles: number; fog: number; overcast: number; sunElevation: number; sunAzimuth: number }

export interface ScenarioDef {
  id: ScenarioId;
  title: string;
  tagline: string;
  description: string;
  start: 'pad' | 'highway';
  playerSpeed: number;
  lightsOn: boolean;
  suspects: SuspectSpec[];
  traffic: number;
  police: number;
  weather: Weather;
  mayhem?: boolean;
}

const sunny: Weather = { rain: 0, puddles: 0, fog: 0.00045, overcast: 0, sunElevation: 0.62, sunAzimuth: 2.3 };

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'A', title: 'Free Drive', tagline: 'The proving ground is yours.',
    description: 'An empty test pad with a slalom and a skid pad, a six-lane loop, an overpass and a county road. Test acceleration, braking, suspension, steering and drifting. Nobody is chasing anybody. Yet.',
    start: 'pad', playerSpeed: 0, lightsOn: false, suspects: [], traffic: 0, police: 0, weather: sunny,
  },
  {
    id: 'B', title: 'Highway Pursuit', tagline: 'A red sedan, a full tank, no plan.',
    description: 'A suspect sedan runs the interstate ahead of you. Bring the pursuit to an end: box it in, bump it, PIT it. Light traffic.',
    start: 'highway', playerSpeed: 30, lightsOn: true,
    suspects: [{ kind: 'sedan', personality: 'darrell', ahead: 70, lane: 1, speed: 33 }],
    traffic: 6, police: 0, weather: sunny,
  },
  {
    id: 'C', title: 'Uncooperative Suspect', tagline: 'Brenda will not be stopping.',
    description: 'An aggressive driver changes lanes, varies speed, uses the shoulder when she panics and recovers when she loses it. More traffic to weave through.',
    start: 'highway', playerSpeed: 32, lightsOn: true,
    suspects: [{ kind: 'sedan', personality: 'brenda', ahead: 60, lane: 0, speed: 36, paint: '#e8e2c8' }],
    traffic: 12, police: 0, weather: sunny,
  },
  {
    id: 'D', title: 'Heavy Vehicle', tagline: 'Travis brought 2.8 tonnes of opinions.',
    description: 'The suspect drives a heavy pickup. More mass, more momentum, a higher centre of mass: it shrugs off bumps a sedan would not, and when it goes, it rolls.',
    start: 'highway', playerSpeed: 30, lightsOn: true,
    suspects: [{ kind: 'pickup', personality: 'travis', ahead: 70, lane: 1, speed: 32 }],
    traffic: 6, police: 0, weather: sunny,
  },
  {
    id: 'E', title: 'Rainy Day in Georgia', tagline: 'Wet roads, standing water, low grip.',
    description: 'A summer storm: wet asphalt, a water film, puddles that grab a wheel, slick red clay. The same suspect, a lot less grip. Brake early.',
    start: 'highway', playerSpeed: 26, lightsOn: true,
    suspects: [{ kind: 'sedan', personality: 'wanda', ahead: 65, lane: 1, speed: 29, paint: '#5d6b74' }],
    traffic: 7, police: 0,
    weather: { rain: 0.8, puddles: 1.2, fog: 0.0042, overcast: 1, sunElevation: 0.45, sunAzimuth: 2.0 },
  },
  {
    id: 'F', title: 'Absolute Mayhem', tagline: 'Three suspects. Three troopers. One loop.',
    description: 'Several suspects, heavy traffic, a work zone full of drums and cones, breakaway signs, and three responding troopers who are very motivated. Property damage is not a concern. It is a certainty.',
    start: 'highway', playerSpeed: 32, lightsOn: true,
    suspects: [
      { kind: 'sedan', personality: 'brenda', ahead: 55, lane: 0, speed: 36 },
      { kind: 'pickup', personality: 'travis', ahead: 110, lane: 2, speed: 33 },
      { kind: 'coupe', personality: 'darrell', ahead: 170, lane: 1, speed: 38 },
    ],
    traffic: 18, police: 3, weather: { ...sunny, sunElevation: 0.32, sunAzimuth: 2.7 }, mayhem: true,
  },
];

export const scenarioById = (id: ScenarioId) => SCENARIOS.find((s) => s.id === id)!;
