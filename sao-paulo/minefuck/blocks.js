// Block types, a port of src/main/java/com/minefuck/world/Block.java. The ids are what the
// world files store (tools/sao-paulo/blocks.mjs mirrors them), so keep all three in step.
import { T } from './atlas.js';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5, WOOD: 6, LEAVES: 7, COBBLESTONE: 8, BEDROCK: 9,
  GRAVEL: 10, PLANKS: 11, GLASS: 12, COAL_ORE: 13, IRON_ORE: 14, SNOW: 15,
  ASPHALT: 16, PAINT_WHITE: 17, PAINT_YELLOW: 18, CICLOVIA: 19, SIDEWALK: 20, GRANITE: 21, PORTUGUESE: 22,
  CURB: 23, CONCRETE: 24, MASP_RED: 25, WINDOW: 26, FACADE_WHITE: 27, FACADE_GRAY: 28, FACADE_DARK: 29,
  BRICK: 30, STUCCO_CREAM: 31, STUCCO_OCHRE: 32, STUCCO_PEACH: 33, ROOF: 34, FLOOR: 35, STEEL: 36, FENCE: 37,
  POLE: 38, LAMP: 39, SIGN_BLUE: 40, ORELHAO_BLUE: 41, ORELHAO_YELLOW: 42, BIN_ORANGE: 43, TACTILE: 44,
  RED_TILE: 45, PAVER: 46, PARK_FLOOR: 47, PATH: 48, BELVEDERE: 49, CLAY_ROOF: 50,
};
export const NUM_TYPES = 51;

// layers
export const NONE = 0, OPAQUE = 1, CUTOUT = 2, TRANSLUCENT = 3;
// glass kinds
export const ANNEALED = 1, TEMPERED = 2;

const NAME = [], TEX = [], LAYER = new Uint8Array(NUM_TYPES), SOLID = new Uint8Array(NUM_TYPES);
const HARD = new Float64Array(NUM_TYPES), GLASS_KIND = new Uint8Array(NUM_TYPES), EMISSIVE = new Uint8Array(NUM_TYPES);
export const COLOR = [];

function def(id, name, layer, hardness, top, bottom = top, side = top) {
  NAME[id] = name; TEX[id] = [top, bottom, side]; LAYER[id] = layer; HARD[id] = hardness;
  SOLID[id] = layer !== NONE && id !== B.WATER ? 1 : 0;
}
const O = OPAQUE, C = CUTOUT, Tr = TRANSLUCENT;
def(B.AIR, 'Air', NONE, 0, 0);
def(B.GRASS, 'Grass', O, 40, T.GRASS_TOP, T.DIRT, T.GRASS_SIDE);
def(B.DIRT, 'Dirt', O, 30, T.DIRT);
def(B.STONE, 'Stone', O, 400, T.STONE);
def(B.SAND, 'Sand', O, 25, T.SAND);
def(B.WATER, 'Water', Tr, 0, T.WATER);
def(B.WOOD, 'Log', O, 150, T.LOG_TOP, T.LOG_TOP, T.LOG_SIDE);
def(B.LEAVES, 'Leaves', C, 2, T.LEAVES);
def(B.COBBLESTONE, 'Cobblestone', O, 350, T.COBBLE);
def(B.BEDROCK, 'Bedrock', O, Infinity, T.BEDROCK);
def(B.GRAVEL, 'Gravel', O, 30, T.GRAVEL);
def(B.PLANKS, 'Planks', O, 60, T.PLANKS);
def(B.GLASS, 'Glass (annealed)', Tr, 1, T.GLASS);
def(B.COAL_ORE, 'Coal Ore', O, 400, T.COAL_ORE);
def(B.IRON_ORE, 'Iron Ore', O, 450, T.IRON_ORE);
def(B.SNOW, 'Snow', O, 10, T.SNOW);
def(B.ASPHALT, 'Asphalt', O, 300, T.ASPHALT);
def(B.PAINT_WHITE, 'Road Paint', O, 300, T.PAINT_WHITE, T.ASPHALT, T.ASPHALT);
def(B.PAINT_YELLOW, 'Yellow Line', O, 300, T.PAINT_YELLOW, T.ASPHALT, T.ASPHALT);
def(B.CICLOVIA, 'Ciclovia', O, 300, T.CICLOVIA, T.ASPHALT, T.ASPHALT);
def(B.SIDEWALK, 'Sidewalk', O, 250, T.SIDEWALK);
def(B.GRANITE, 'Paulista Granite', O, 400, T.GRANITE);
def(B.PORTUGUESE, 'Portuguese Stone', O, 250, T.PORTUGUESE, T.SIDEWALK, T.SIDEWALK);
def(B.CURB, 'Curb', O, 300, T.CURB);
def(B.CONCRETE, 'Exposed Concrete', O, 500, T.CONCRETE);
def(B.MASP_RED, 'MASP Red', O, 800, T.MASP_RED);
def(B.WINDOW, 'Window (tempered)', Tr, 3, T.WINDOW);
def(B.FACADE_WHITE, 'White Facade', O, 300, T.FACADE_WHITE);
def(B.FACADE_GRAY, 'Gray Facade', O, 300, T.FACADE_GRAY);
def(B.FACADE_DARK, 'Dark Facade', O, 300, T.FACADE_DARK);
def(B.BRICK, 'Brick', O, 250, T.BRICK);
def(B.STUCCO_CREAM, 'Cream Stucco', O, 150, T.STUCCO_CREAM);
def(B.STUCCO_OCHRE, 'Ochre Stucco', O, 150, T.STUCCO_OCHRE);
def(B.STUCCO_PEACH, 'Peach Stucco', O, 150, T.STUCCO_PEACH);
def(B.ROOF, 'Roof', O, 200, T.ROOF, T.FLOOR, T.ROOF);
def(B.FLOOR, 'Floor Slab', O, 300, T.FLOOR);
def(B.STEEL, 'Steel', O, 600, T.STEEL);
def(B.FENCE, 'Iron Fence', C, 20, T.FENCE);
def(B.POLE, 'Concrete Pole', O, 60, T.POLE);
def(B.LAMP, 'Street Lamp', O, 5, T.LAMP);
def(B.SIGN_BLUE, 'Street Sign', O, 5, T.SIGN_BLUE);
def(B.ORELHAO_BLUE, 'Orelhão (blue)', O, 8, T.ORELHAO_BLUE);
def(B.ORELHAO_YELLOW, 'Orelhão (yellow)', O, 8, T.ORELHAO_YELLOW);
def(B.BIN_ORANGE, 'Papeleira', O, 3, T.BIN_ORANGE);
def(B.TACTILE, 'Tactile Paving', O, 250, T.TACTILE);
def(B.RED_TILE, 'Red Ceramic Tile', O, 200, T.RED_TILE);
def(B.PAVER, 'Interlock Paver', O, 200, T.PAVER);
def(B.PARK_FLOOR, 'Forest Floor', O, 30, T.PARK_FLOOR, T.DIRT, T.PARK_FLOOR_SIDE);
def(B.PATH, 'Park Path', O, 30, T.PATH, T.DIRT, T.DIRT);
def(B.BELVEDERE, 'MASP Belvedere', O, 400, T.BELVEDERE);
def(B.CLAY_ROOF, 'Clay Roof Tile', O, 40, T.CLAY_ROOF, T.FLOOR, T.CLAY_ROOF);
GLASS_KIND[B.GLASS] = ANNEALED;
GLASS_KIND[B.WINDOW] = TEMPERED;
EMISSIVE[B.LAMP] = 1;

export const name = (b) => NAME[b] || 'Unknown';
/** Atlas tile for a face: 0 top, 1 bottom, 2..5 sides. */
export const texture = (b, face) => TEX[b][face === 0 ? 0 : face === 1 ? 1 : 2];
export const layer = (b) => LAYER[b];
export const isSolid = (b) => SOLID[b] === 1;
export const isOpaque = (b) => LAYER[b] === OPAQUE;
export const isEmissive = (b) => EMISSIVE[b] === 1;
export const glassKind = (b) => GLASS_KIND[b];
export const isGlass = (b) => GLASS_KIND[b] !== 0;
/** Impact energy (kJ) needed to knock the block out of the world. */
export const hardness = (b) => HARD[b];
export const LAYERS = LAYER, SOLIDS = SOLID;

export function computeColors(atlas) {
  for (let i = 0; i < NUM_TYPES; i++) COLOR[i] = atlas.averageColor(TEX[i][2]);
}

export const HOTBAR = [B.GRASS, B.STONE, B.PLANKS, B.GLASS, B.WINDOW, B.MASP_RED, B.CONCRETE, B.ASPHALT, B.LEAVES];
