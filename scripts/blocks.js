import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

function loadTexture(path) {
  const texture = textureLoader.load(path);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  return texture;
}

// Loads one tile from a horizontal atlas of `tiles` equal-width tiles.
// tileIndex is 0-based from the left. Used for the melon's 32x16 (2-tile) PNG.
function loadAtlasTile(path, tileIndex, tiles) {
  const texture = textureLoader.load(path);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.repeat.set(1 / tiles, 1);
  texture.offset.set(tileIndex / tiles, 0);
  return texture;
}

const textures = {
  cactusSide: loadTexture('textures/cactus_side.png'),
  cactusTop: loadTexture('textures/cactus_top.png'),
  dirt: loadTexture('textures/dirt.png'),
  grass: loadTexture('textures/grass.png'),
  grassSide: loadTexture('textures/grass_side.png'),
  coalOre: loadTexture('textures/coal_ore.png'),
  ironOre: loadTexture('textures/iron_ore.png'),
  jungleTreeSide: loadTexture('textures/jungle_tree_side.png'),
  jungleTreeTop: loadTexture('textures/jungle_tree_top.png'),
  jungleLeaves: loadTexture('textures/jungle_leaves.png'),
  leaves: loadTexture('textures/leaves.png'),
  treeSide: loadTexture('textures/tree_side.png'),
  treeTop: loadTexture('textures/tree_top.png'),
  sand: loadTexture('textures/sand.png'),
  snow: loadTexture('textures/snow.png'),
  snowSide: loadTexture('textures/snow_side.png'),
  stone: loadTexture('textures/stone.png'),
  // --- New textures ---
  glass: loadTexture('textures/glass.png'),
  oakPlank: loadTexture('textures/oakplank.png'),
  glowstone: loadTexture('textures/glowstone.png'),
  pumpkin: loadTexture('textures/pumpkin.png'),
  redFlower: loadTexture('textures/redflower.png'),
  yellowFlower: loadTexture('textures/yellowflower.png'),
  redMushroom: loadTexture('textures/mushroom.png'),
  brownMushroom: loadTexture('textures/brownmushroom.png'),
  melonSide: loadAtlasTile('textures/melon.png', 0, 2), // left tile
  melonTop: loadAtlasTile('textures/melon.png', 1, 2),  // right tile
  cobblestone: loadTexture('textures/cobblestone.png'),
};

export const blocks = {
  empty: {
    id: 0,
    name: 'empty',
    visible: false
  },
  grass: {
    id: 1,
    name: 'grass',
    material: [
      new THREE.MeshLambertMaterial({ map: textures.grassSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.grassSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.grass }), // top
      new THREE.MeshLambertMaterial({ map: textures.dirt }), // bottom
      new THREE.MeshLambertMaterial({ map: textures.grassSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.grassSide })  // back
    ]
  },
  dirt: {
    id: 2,
    name: 'dirt',
    material: new THREE.MeshLambertMaterial({ map: textures.dirt })
  },
  stone: {
    id: 3,
    name: 'stone',
    material: new THREE.MeshLambertMaterial({ map: textures.stone }),
    scale: { x: 30, y: 30, z: 30 },
    scarcity: 0.8
  },
  coalOre: {
    id: 4,
    name: 'coal_ore',
    material: new THREE.MeshLambertMaterial({ map: textures.coalOre }),
    scale: { x: 20, y: 20, z: 20 },
    scarcity: 0.8
  },
  ironOre: {
    id: 5,
    name: 'iron_ore',
    material: new THREE.MeshLambertMaterial({ map: textures.ironOre }),
    scale: { x: 40, y: 40, z: 40 },
    scarcity: 0.9
  },
  tree: {
    id: 6,
    name: 'tree',
    visible: true,
    material: [
      new THREE.MeshLambertMaterial({ map: textures.treeSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.treeSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.treeTop }), // top
      new THREE.MeshLambertMaterial({ map: textures.treeTop }), // bottom
      new THREE.MeshLambertMaterial({ map: textures.treeSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.treeSide })  // back
    ]
  },
  leaves: {
    id: 7,
    name: 'leaves',
    visible: true,
    material: new THREE.MeshLambertMaterial({ map: textures.leaves })
  },
  sand: {
    id: 8,
    name: 'sand',
    visible: true,
    material: new THREE.MeshLambertMaterial({ map: textures.sand })
  },
  cloud: {
    id: 9,
    name: 'cloud',
    visible: true,
    material: new THREE.MeshBasicMaterial({ color: 0xf0f0f0 })
  },
  snow: {
    id: 10,
    name: 'snow',
    material: [
      new THREE.MeshLambertMaterial({ map: textures.snowSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.snowSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.snow }), // top
      new THREE.MeshLambertMaterial({ map: textures.dirt }), // bottom
      new THREE.MeshLambertMaterial({ map: textures.snowSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.snowSide })  // back
    ]
  },
  jungleTree: {
    id: 11,
    name: 'jungleTree',
    material: [
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeTop }),  // top
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeTop }),  // bottom
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.jungleTreeSide })  // back
    ]
  },
  jungleLeaves: {
    id: 12,
    name: 'jungleLeaves',
    material: new THREE.MeshLambertMaterial({ map: textures.jungleLeaves })
  },
  cactus: {
    id: 13,
    name: 'cactus',
    material: [
      new THREE.MeshLambertMaterial({ map: textures.cactusSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.cactusSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.cactusTop }),  // top
      new THREE.MeshLambertMaterial({ map: textures.cactusTop }),  // bottom
      new THREE.MeshLambertMaterial({ map: textures.cactusSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.cactusSide })  // back
    ]
  },
  jungleGrass: {
    id: 14,
    name: 'jungleGrass',
    material: [
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.grassSide }), // right
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.grassSide }), // left
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.grass }), // top
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.dirt }), // bottom
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.grassSide }), // front
      new THREE.MeshLambertMaterial({ color: 0x80c080, map: textures.grassSide })  // back
    ]
  },
  // ============================================================
  // ---- New blocks ----
  // ============================================================
  glass: {
    id: 15,
    name: 'glass',
    visible: true,
    // Transparent so you can see through it (real windows).
    material: new THREE.MeshLambertMaterial({
      map: textures.glass,
      transparent: true,
      opacity: 0.85
    })
  },
  oakPlank: {
    id: 16,
    name: 'oakPlank',
    visible: true,
    material: new THREE.MeshLambertMaterial({ map: textures.oakPlank })
  },
  glowstone: {
    id: 17,
    name: 'glowstone',
    visible: true,
    // Emissive so it visually glows (doesn't cast light, but looks lit).
    material: new THREE.MeshLambertMaterial({
      map: textures.glowstone,
      emissive: 0xffdd88,
      emissiveIntensity: 0.6
    })
  },
  pumpkin: {
    id: 18,
    name: 'pumpkin',
    visible: true,
    material: new THREE.MeshLambertMaterial({ map: textures.pumpkin })
  },
  // ---- Cross-shaped plants (rendered as X, non-solid, walk-through) ----
  redFlower: {
    id: 19,
    name: 'redFlower',
    visible: true,
    isPlant: true,
    material: new THREE.MeshLambertMaterial({
      map: textures.redFlower, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide
    })
  },
  yellowFlower: {
    id: 20,
    name: 'yellowFlower',
    visible: true,
    isPlant: true,
    material: new THREE.MeshLambertMaterial({
      map: textures.yellowFlower, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide
    })
  },
  redMushroom: {
    id: 21,
    name: 'redMushroom',
    visible: true,
    isPlant: true,
    material: new THREE.MeshLambertMaterial({
      map: textures.redMushroom, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide
    })
  },
  brownMushroom: {
    id: 22,
    name: 'brownMushroom',
    visible: true,
    isPlant: true,
    material: new THREE.MeshLambertMaterial({
      map: textures.brownMushroom, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide
    })
  },
  melon: {
    id: 23,
    name: 'melon',
    visible: true,
    material: [
      new THREE.MeshLambertMaterial({ map: textures.melonSide }), // right
      new THREE.MeshLambertMaterial({ map: textures.melonSide }), // left
      new THREE.MeshLambertMaterial({ map: textures.melonTop }),  // top
      new THREE.MeshLambertMaterial({ map: textures.melonTop }),  // bottom
      new THREE.MeshLambertMaterial({ map: textures.melonSide }), // front
      new THREE.MeshLambertMaterial({ map: textures.melonSide })  // back
    ]
  },
  cobblestone: {
    id: 24,
    name: 'cobblestone',
    visible: true,
    material: new THREE.MeshLambertMaterial({ map: textures.cobblestone })
  },
};

export const resources = [
  blocks.stone,
  blocks.coalOre,
  blocks.ironOre
];
