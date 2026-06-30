import * as THREE from 'three';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { RNG } from './rng';
import { blocks, resources } from './blocks';

const geometry = new THREE.BoxGeometry();

// Cross geometry for plants: two intersecting vertical planes forming an X,
// centered in the block cell. Built once and reused for all plant types.
function makeCrossGeometry() {
  const g = new THREE.BufferGeometry();
  const p1 = new THREE.PlaneGeometry(1, 1);
  const p2 = new THREE.PlaneGeometry(1, 1);
  p1.rotateY(Math.PI / 4);
  p2.rotateY(-Math.PI / 4);
  // Merge the two planes' attributes manually (avoid extra imports).
  const merged = mergePlaneGeometries(p1, p2);
  return merged;
}

// Minimal merge of two PlaneGeometries into one BufferGeometry.
function mergePlaneGeometries(a, b) {
  const ap = a.attributes.position.array;
  const auv = a.attributes.uv.array;
  const an = a.attributes.normal.array;
  const ai = a.index.array;
  const bp = b.attributes.position.array;
  const buv = b.attributes.uv.array;
  const bn = b.attributes.normal.array;
  const bi = b.index.array;

  const positions = new Float32Array(ap.length + bp.length);
  positions.set(ap, 0); positions.set(bp, ap.length);
  const uvs = new Float32Array(auv.length + buv.length);
  uvs.set(auv, 0); uvs.set(buv, auv.length);
  const normals = new Float32Array(an.length + bn.length);
  normals.set(an, 0); normals.set(bn, an.length);

  const vertCountA = ap.length / 3;
  const indices = new Uint16Array(ai.length + bi.length);
  indices.set(ai, 0);
  for (let i = 0; i < bi.length; i++) indices[ai.length + i] = bi[i] + vertCountA;

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}

const crossGeometry = makeCrossGeometry();

export class WorldChunk extends THREE.Group {
  /**
    * @type {{
    *  id: number,
    *  instanceId: number
    * }[][][]}
  */
  data = [];

  constructor(size, params, dataStore) {
    super();
    this.loaded = false;
    this.size = size;
    this.params = params;
    this.dataStore = dataStore;
  }

  /**
    * Generates the world data and meshes
    */
  generate() {
    const start = performance.now();

    const rng = new RNG(this.params.seed);
    this.initializeTerrain();
    this.generateTerrain(rng);
    this.generateCaves(rng);
    this.generateClouds(rng);
    this.loadPlayerChanges();
    this.generateMeshes();

    this.loaded = true;

    //console.log(`Loaded chunk in ${performance.now() - start}ms`);
  }

  /**
    * Initializes an empty world
    */
  initializeTerrain() {
    this.data = [];
    for (let x = 0; x < this.size.width; x++) {
      const slice = [];
      for (let y = 0; y < this.size.height; y++) {
        const row = [];
        for (let z = 0; z < this.size.width; z++) {
          row.push({
            id: blocks.empty.id,
            instanceId: null
          });
        }
        slice.push(row);
      }
      this.data.push(slice);
    }
  }

  /**
   * Get the biome at the local chunk coordinates (x,z)
   * @param {SimplexNoise} simplex 
   * @param {number} x 
   * @param {number} z 
   */
  getBiome(simplex, x, z) {
    let noise = 0.5 * simplex.noise(
      (this.position.x + x) / this.params.biomes.scale,
      (this.position.z + z) / this.params.biomes.scale
    ) + 0.5;

    noise += this.params.biomes.variation.amplitude * (simplex.noise(
      (this.position.x + x) / this.params.biomes.variation.scale,
      (this.position.z + z) / this.params.biomes.variation.scale
    ));

    if (noise < this.params.biomes.tundraToTemperate) {
      return 'Tundra';
    } else if (noise < this.params.biomes.temperateToJungle) {
      return 'Temperate';
    } else if (noise < this.params.biomes.jungleToDesert) {
      return 'Jungle';
    } else {
      return 'Desert';
    }
  }

  /**
   * Generates the terrain data for the world
   */
  generateTerrain(rng) {
    const simplex = new SimplexNoise(rng);
    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        const biome = this.getBiome(simplex, x, z);

        // Layered (multi-octave) noise: a big base shape plus finer detail,
        // so we get large mountains AND small rolling hills, not uniform bumps.
        const tScale = this.params.terrain.scale;
        const base = simplex.noise(
          (this.position.x + x) / tScale,
          (this.position.z + z) / tScale
        );
        const detail = 0.5 * simplex.noise(
          (this.position.x + x) / (tScale * 0.45),
          (this.position.z + z) / (tScale * 0.45)
        );
        const fine = 0.25 * simplex.noise(
          (this.position.x + x) / (tScale * 0.18),
          (this.position.z + z) / (tScale * 0.18)
        );
        // Combine and renormalize so the magnitude still controls overall height.
        let value = (base + detail + fine) / 1.75;
        // Push peaks higher and flatten lowlands for a more dramatic profile.
        value = Math.sign(value) * Math.pow(Math.abs(value), 0.85);

        // Scale the noise based on the magnitude/offset
        const scaledNoise = this.params.terrain.offset +
          this.params.terrain.magnitude * value;

        // Computing the height of the terrain at this x-z location
        let height = Math.floor(scaledNoise);

        // Clamping height between 0 and max height
        height = Math.max(0, Math.min(height, this.size.height - 1));

        // Fill in all blocks at or below the terrain height
        for (let y = this.size.height; y >= 0; y--) {
          if (y <= this.params.terrain.waterOffset && y === height) {
            this.setBlockId(x, y, z, blocks.sand.id);
          } else if (y === height) {
            let groundBlockType;
            if (biome === 'Desert') {
              groundBlockType = blocks.sand.id;
            } else if (biome === 'Jungle') {
              groundBlockType = blocks.jungleGrass.id;
            } else if (biome === 'Temperate') {
              groundBlockType = blocks.grass.id;
            } else if (biome === 'Tundra') {
              groundBlockType = blocks.snow.id;
            }

            this.setBlockId(x, y, z, groundBlockType);

            // Biome-aware tree frequency: denser jungle/temperate forests,
            // sparse desert cacti, occasional tundra pines.
            let treeFreq = this.params.trees.frequency;
            if (biome === 'Jungle') treeFreq *= 3.0;
            else if (biome === 'Temperate') treeFreq *= 1.8;
            else if (biome === 'Tundra') treeFreq *= 0.8;
            else if (biome === 'Desert') treeFreq *= 1.2;

            if (rng.random() < treeFreq) {
              this.generateTree(rng, biome, x, height + 1, z);
            } else if (biome === 'Temperate' &&
                       y > this.params.terrain.waterOffset &&
                       rng.random() < 0.004) {
              // Rarely scatter a pumpkin on temperate grass.
              this.setBlockId(x, height + 1, z, blocks.pumpkin.id);
            } else if (biome === 'Jungle' &&
                       y > this.params.terrain.waterOffset &&
                       rng.random() < 0.004) {
              // Rarely scatter a melon in the jungle.
              this.setBlockId(x, height + 1, z, blocks.melon.id);
            } else if ((biome === 'Temperate' || biome === 'Jungle') &&
                       y > this.params.terrain.waterOffset &&
                       rng.random() < 0.03) {
              // Scatter flowers on grassy ground.
              const r = rng.random();
              const flowerId = r < 0.5 ? blocks.redFlower.id : blocks.yellowFlower.id;
              this.setBlockId(x, height + 1, z, flowerId);
            } else if ((biome === 'Temperate' || biome === 'Jungle') &&
                       y > this.params.terrain.waterOffset &&
                       rng.random() < 0.015) {
              // Scatter mushrooms (forest floor).
              const r = rng.random();
              const mushId = r < 0.5 ? blocks.redMushroom.id : blocks.brownMushroom.id;
              this.setBlockId(x, height + 1, z, mushId);
            } else if ((biome === 'Temperate' || biome === 'Jungle') &&
                       y > this.params.terrain.waterOffset &&
                       rng.random() < 0.02) {
              // Scatter small leafy bushes on grassy ground (uses existing leaf blocks).
              this.generateBush(biome, x, height + 1, z);
            }
          } else if (y < height && this.getBlock(x, y, z).id === blocks.empty.id) {
            this.generateResourceIfNeeded(simplex, x, y, z);
          }
        }
      }
    }
  }

  /**
   * Carves caves into the solid terrain using 3D noise, then lines the
   * cave edges with cobblestone and scatters some cobblestone into stone.
   * Two noise scales combine to give both small pockets and winding tunnels.
   * @param {RNG} rng
   */
  generateCaves(rng) {
    const simplex = new SimplexNoise(rng);

    // Don't carve right at the surface (keeps the ground crust intact) or
    // below the water line (the flat water plane would show through caves).
    const surfaceBuffer = 3;
    const minCarveY = this.params.terrain.waterOffset + 2;

    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        // Find this column's surface height (topmost non-empty block).
        let surfaceY = -1;
        for (let y = this.size.height - 1; y >= 0; y--) {
          const b = this.getBlock(x, y, z);
          if (b && b.id !== blocks.empty.id && b.id !== blocks.cloud.id) {
            surfaceY = y;
            break;
          }
        }
        if (surfaceY < 0) continue;

        const carveTop = surfaceY - surfaceBuffer;

        for (let y = minCarveY; y <= carveTop; y++) {
          const block = this.getBlock(x, y, z);
          if (!block || block.id === blocks.empty.id) continue;
          // Only carve through stone/dirt-like ground, not trees etc.
          if (block.id !== blocks.stone.id &&
              block.id !== blocks.dirt.id &&
              block.id !== blocks.coalOre.id &&
              block.id !== blocks.ironOre.id) {
            continue;
          }

          const wx = this.position.x + x;
          const wy = y;
          const wz = this.position.z + z;

          // Big winding tunnels (large scale) + small pockets (small scale).
          const tunnel = simplex.noise3d(wx / 28, wy / 22, wz / 28);
          const pocket = simplex.noise3d(wx / 12, wy / 12, wz / 12);
          const caveValue = tunnel * 0.7 + pocket * 0.3;

          // Above this threshold = carve out air. Higher threshold = rarer caves.
          if (caveValue > 0.45) {
            this.setBlockId(x, y, z, blocks.empty.id);
          }
        }
      }
    }

    // Second pass: line cave edges with cobblestone, and scatter cobblestone
    // randomly through underground stone.
    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        for (let y = minCarveY; y < this.size.height; y++) {
          const block = this.getBlock(x, y, z);
          if (!block || block.id !== blocks.stone.id) continue;

          // Is this stone block touching cave air? Then line it with cobblestone.
          const touchesAir =
            this.isEmptyAt(x + 1, y, z) || this.isEmptyAt(x - 1, y, z) ||
            this.isEmptyAt(x, y + 1, z) || this.isEmptyAt(x, y - 1, z) ||
            this.isEmptyAt(x, y, z + 1) || this.isEmptyAt(x, y, z - 1);

          if (touchesAir && rng.random() < 0.6) {
            this.setBlockId(x, y, z, blocks.cobblestone.id);
          } else if (rng.random() < 0.03) {
            // Scatter random cobblestone through stone.
            this.setBlockId(x, y, z, blocks.cobblestone.id);
          }
        }
      }
    }
  }

  /**
   * Returns true if the block at local (x,y,z) is empty/air (in bounds).
   */
  isEmptyAt(x, y, z) {
    const b = this.getBlock(x, y, z);
    return !!b && b.id === blocks.empty.id;
  }

  /**
   * Determines if a resource block should be generated at (x, y, z)
   * @param {SimplexNoise} simplex
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  generateResourceIfNeeded(simplex, x, y, z) {
    this.setBlockId(x, y, z, blocks.dirt.id);
    resources.forEach(resource => {
      const value = simplex.noise3d(
        (this.position.x + x) / resource.scale.x,
        (this.position.y + y) / resource.scale.y,
        (this.position.z + z) / resource.scale.z);

      if (value > resource.scarcity) {
        this.setBlockId(x, y, z, resource.id);
      }
    });
  }

  /**
   * Creates a tree appropriate for the biome at (x, y, z)
   * @param {string} biome
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  generateTree(rng, biome, x, y, z) {
    const minH = this.params.trees.trunk.minHeight;
    const maxH = this.params.trees.trunk.maxHeight;
    const h = Math.round(minH + (maxH - minH) * rng.random());

    for (let treeY = y; treeY < y + h; treeY++) {
      if (biome === 'Temperate' || biome === 'Tundra') {
        this.setBlockId(x, treeY, z, blocks.tree.id);
      } else if (biome === 'Jungle') {
        this.setBlockId(x, treeY, z, blocks.jungleTree.id);
      } else if (biome === 'Desert') {
        this.setBlockId(x, treeY, z, blocks.cactus.id);
      }
    }

    // Generate canopy centered on the top of the tree
    if (biome === 'Temperate' || biome === 'Jungle') {
      this.generateTreeCanopy(biome, x, y + h, z, rng);
    }
  }

  generateTreeCanopy(biome, centerX, centerY, centerZ, rng) {
    const minR = this.params.trees.canopy.minRadius;
    const maxR = this.params.trees.canopy.maxRadius;
    const r = Math.round(minR + (maxR - minR) * rng.random());

    for (let x = -r; x <= r; x++) {
      for (let y = -r; y <= r; y++) {
        for (let z = -r; z <= r; z++) {
          const n = rng.random();

          // Make sure the block is within the canopy radius
          if (x * x + y * y + z * z > r * r) continue;
          // Don't overwrite an existing block
          const block = this.getBlock(centerX + x, centerY + y, centerZ + z);
          if (block && block.id !== blocks.empty.id) continue;
          // Fill in the tree canopy with leaves based on the density parameter
          if (n < this.params.trees.canopy.density) {
            if (biome === 'Temperate') {
              this.setBlockId(centerX + x, centerY + y, centerZ + z, blocks.leaves.id);
            } else if (biome === 'Jungle') {
              this.setBlockId(centerX + x, centerY + y, centerZ + z, blocks.jungleLeaves.id);
            }
          }
        }
      }
    }
  }

  /**
   * Creates a small 1-2 block leafy bush at ground level
   * @param {string} biome
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  generateBush(biome, x, y, z) {
    const leafId = (biome === 'Jungle') ? blocks.jungleLeaves.id : blocks.leaves.id;
    const below = this.getBlock(x, y, z);
    if (below && below.id !== blocks.empty.id) return;
    this.setBlockId(x, y, z, leafId);
  }

  /**
   * Creates happy little clouds
   * @param {RNG} rng 
   */
  generateClouds(rng) {
    const simplex = new SimplexNoise(rng);
    for (let x = 0; x < this.size.width; x++) {
      for (let z = 0; z < this.size.width; z++) {
        const value = (simplex.noise(
          (this.position.x + x) / this.params.clouds.scale,
          (this.position.z + z) / this.params.clouds.scale
        ) + 1) * 0.5;

        if (value < this.params.clouds.density) {
          this.setBlockId(x, this.size.height - 1, z, blocks.cloud.id);
        }
      }
    }
  }

  /**
   * Pulls any changes from the data store and applies them to the data model
   */
  loadPlayerChanges() {
    for (let x = 0; x < this.size.width; x++) {
      for (let y = 0; y < this.size.height; y++) {
        for (let z = 0; z < this.size.width; z++) {
          if (this.dataStore.contains(this.position.x, this.position.z, x, y, z)) {
            const blockId = this.dataStore.get(this.position.x, this.position.z, x, y, z);
            this.setBlockId(x, y, z, blockId);
          }
        }
      }
    }
  }

  generateWater() {
    // Only draw the water plane if this chunk actually has a water basin — i.e.
    // some column whose SURFACE (topmost solid block) sits at or below the water
    // line. Otherwise skip it, so the flat water sheet doesn't show through caves
    // and dips in dry inland/hill chunks.
    const waterLevel = this.params.terrain.waterOffset;
    let hasWater = false;
    for (let x = 0; x < this.size.width && !hasWater; x++) {
      for (let z = 0; z < this.size.width && !hasWater; z++) {
        // Find the surface height of this column (topmost solid, non-cloud block).
        let surfaceY = -1;
        for (let y = this.size.height - 1; y >= 0; y--) {
          const b = this.getBlock(x, y, z);
          if (b && b.id !== blocks.empty.id && b.id !== blocks.cloud.id) {
            surfaceY = y;
            break;
          }
        }
        // A basin: the ground surface is at or below the water line.
        if (surfaceY >= 0 && surfaceY <= waterLevel) {
          hasWater = true;
        }
      }
    }
    if (!hasWater) return; // dry chunk — no water plane

    const material = new THREE.MeshLambertMaterial({
      color: 0x9090e0,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide
    });

    const waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    waterMesh.rotateX(-Math.PI / 2.0);
    waterMesh.position.set(
      this.size.width / 2,
      this.params.terrain.waterOffset + 0.4,
      this.size.width / 2
    );
    waterMesh.scale.set(this.size.width, this.size.width, 1);
    waterMesh.layers.set(1);

    this.add(waterMesh);
  }

  /**
    * Generates the 3D representation of the world from the world data
    */
  generateMeshes() {
    this.clear();

    this.generateWater();

    const maxCount = this.size.width * this.size.width * this.size.height;

    // Creating a lookup table where the key is the block id
    const meshes = {};
    Object.values(blocks)
      .filter(blockType => blockType.id !== blocks.empty.id)
      .forEach(blockType => {
        const geom = blockType.isPlant ? crossGeometry : geometry;
        const mesh = new THREE.InstancedMesh(geom, blockType.material, maxCount);
        mesh.name = blockType.id;
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        meshes[blockType.id] = mesh;
      });

    const matrix = new THREE.Matrix4();
    for (let x = 0; x < this.size.width; x++) {
      for (let y = 0; y < this.size.height; y++) {
        for (let z = 0; z < this.size.width; z++) {
          const blockId = this.getBlock(x, y, z).id;

          if (blockId === blocks.empty.id) continue;

          const mesh = meshes[blockId];
          const instanceId = mesh.count;

          const isPlant = blocks[Object.keys(blocks).find(k => blocks[k].id === blockId)]?.isPlant;
          if (isPlant || !this.isBlockObscured(x, y, z)) {
            matrix.setPosition(x, y, z);
            mesh.setMatrixAt(instanceId, matrix);
            this.setBlockInstanceId(x, y, z, instanceId);
            mesh.count++;
          }
        }
      }
    }

    this.add(...Object.values(meshes));
  }

  /**
  * Gets the block data at (x, y, z)
  * @param {number} x
  * @param {number} y
  * @param {number} z
  * @returns {{id: number, instanceId: number}}
  */
  getBlock(x, y, z) {
    if (this.inBounds(x, y, z)) {
      return this.data[x][y][z];
    } else {
      return null;
    }
  }

  /**
   * Adds a new block at (x,y,z) of type `blockId`
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   * @param {number} blockId 
   */
  addBlock(x, y, z, blockId) {
    if (this.getBlock(x, y, z).id === blocks.empty.id) {
      this.setBlockId(x, y, z, blockId);
      this.addBlockInstance(x, y, z);
      this.dataStore.set(this.position.x, this.position.z, x, y, z, blockId);
    }
  }

  /**
   * Removes the block at (x, y, z)
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  removeBlock(x, y, z) {
    const block = this.getBlock(x, y, z);
    if (block && block.id !== blocks.empty.id) {
      this.deleteBlockInstance(x, y, z);
      this.setBlockId(x, y, z, blocks.empty.id);
      this.dataStore.set(this.position.x, this.position.z, x, y, z, blocks.empty.id);
    }
  }

  /**
   * Removes the mesh instance associated with `block` by swapping it
   * with the last instance and decrementing the instance count.
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  deleteBlockInstance(x, y, z) {
    const block = this.getBlock(x, y, z);

    if (block.id === blocks.empty.id || block.instanceId === null) return;

    // Get the mesh and instance id of the block
    const mesh = this.children.find((instanceMesh) => instanceMesh.name === block.id);
    const instanceId = block.instanceId;

    // Swapping the transformation matrix of the block in the last position
    // with the block that we are going to remove
    const lastMatrix = new THREE.Matrix4();
    mesh.getMatrixAt(mesh.count - 1, lastMatrix);

    // Updating the instance id of the block in the last position to its new instance id
    const v = new THREE.Vector3();
    v.applyMatrix4(lastMatrix);
    this.setBlockInstanceId(v.x, v.y, v.z, instanceId);

    // Swapping the transformation matrices
    mesh.setMatrixAt(instanceId, lastMatrix);

    // This effectively removes the last instance from the scene
    mesh.count--;

    // Notify the instanced mesh we updated the instance matrix
    // Also re-compute the bounding sphere so raycasting works
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();

    // Remove the instance associated with the block and update the data model
    this.setBlockInstanceId(x, y, z, null);
  }

  /**
   * Create a new instance for the block at (x,y,z)
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  addBlockInstance(x, y, z) {
    const block = this.getBlock(x, y, z);

    // Verify the block exists, it isn't an empty block type, and it doesn't already have an instance
    if (block && block.id !== blocks.empty.id && block.instanceId === null) {
      // Get the mesh and instance id of the block
      const mesh = this.children.find((instanceMesh) => instanceMesh.name === block.id);
      const instanceId = mesh.count++;
      this.setBlockInstanceId(x, y, z, instanceId);

      // Compute the transformation matrix for the new instance and update the instanced
      const matrix = new THREE.Matrix4();
      matrix.setPosition(x, y, z);
      mesh.setMatrixAt(instanceId, matrix);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /**
    * Sets the block id for the block at (x, y, z)
    * @param {number} x
    * @param {number} y
    * @param {number} z
    * @param {number} id
    */
  setBlockId(x, y, z, id) {
    if (this.inBounds(x, y, z)) {
      this.data[x][y][z].id = id;
    }
  }


  /**
    * Sets the block instance id for the block at (x, y, z)
    * @param {number} x
    * @param {number} y
    * @param {number} z
    * @param {number} instanceId
    */
  setBlockInstanceId(x, y, z, instanceId) {
    if (this.inBounds(x, y, z)) {
      this.data[x][y][z].instanceId = instanceId;
    }
  }

  /**
    * Checks if the (x, y, z) coordinates are within bounds
    * @param {number} x
    * @param {number} y
    * @param {number} z
    * @returns {boolean}
    */
  inBounds(x, y, z) {
    if (x >= 0 && x < this.size.width &&
      y >= 0 && y < this.size.height &&
      z >= 0 && z < this.size.width) {
      return true;
    } else {
      return false;
    }
  }

  /**
    * Returns true if this block is completely hidden by other blocks
    * @param {number} x
    * @param {number} y
    * @param {number} z
    * @returns {boolean}
    */
  isBlockObscured(x, y, z) {
    const up = this.getBlock(x, y + 1, z)?.id ?? blocks.empty.id;
    const down = this.getBlock(x, y - 1, z)?.id ?? blocks.empty.id;
    const left = this.getBlock(x + 1, y, z)?.id ?? blocks.empty.id;
    const right = this.getBlock(x - 1, y, z)?.id ?? blocks.empty.id;
    const forward = this.getBlock(x, y, z + 1)?.id ?? blocks.empty.id;
    const back = this.getBlock(x, y, z - 1)?.id ?? blocks.empty.id;

    // A plant (or empty) neighbor does not obscure a face, since you can see
    // through it — so the solid block's face must still render.
    const isSeeThrough = (id) => {
      if (id === blocks.empty.id) return true;
      const b = Object.values(blocks).find(bl => bl.id === id);
      return b?.isPlant === true;
    };

    // If any of the block's sides is exposed (empty or see-through), not obscured
    if (isSeeThrough(up) ||
      isSeeThrough(down) ||
      isSeeThrough(left) ||
      isSeeThrough(right) ||
      isSeeThrough(forward) ||
      isSeeThrough(back)) {
      return false;
    } else {
      return true;
    }
  }

  disposeInstances() {
    this.traverse((obj) => {
      if (obj.dispose) obj.dispose();
    });
    this.clear();
  }
}