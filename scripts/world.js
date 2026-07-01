import * as THREE from 'three';
import { WorldChunk } from './worldChunk';
import { DataStore } from './dataStore';

export class World extends THREE.Group {

  /**
   * Whether or not we want to load the chunks asynchronously
   */
  asyncLoading = true;

  /**
  * The number of chunks to render around the player.
  * When this is set to 0, the chunk the player is on
  * is the only one that is rendered. If it is set to 1,
  * the adjacent chunks are rendered; if set to 2, the
  * chunks adjacent to those are rendered, and so on.
  */
  drawDistance = 2;

  chunkSize = {
    width: 32,
    height: 32
  };

  params = {
    seed: 0,
    terrain: {
      scale: 100,
      magnitude: 14,
      offset: 7,
      waterOffset: 4
    },
    biomes: {
      scale: 500,
      variation: {
        amplitude: 0.2,
        scale: 50
      },
      tundraToTemperate: 0.25,
      temperateToJungle: 0.5,
      jungleToDesert: 0.75
    },
    trees: {
      trunk: {
        minHeight: 4,
        maxHeight: 7
      },
      canopy: {
        minRadius: 3,
        maxRadius: 3,
        density: 0.7 // Vary between 0.0 and 1.0
      },
      frequency: 0.006
    },
    clouds: {
      scale: 30,
      density: 0.3
    }
  };

  dataStore = new DataStore();

  constructor(seed = null) {
    super();
    // Use a random seed each time the page loads, so every visit is a new world.
    // (A specific seed can still be passed in; saves store the seed in params,
    // so loading a saved game restores its exact world.)
    this.params.seed = (seed !== null) ? seed : Math.floor(Math.random() * 100000);
    this.seed = this.params.seed;

    document.addEventListener('keydown', (ev) => {
      switch (ev.code) {
        case 'KeyK':
          this.save();
          break;
        case 'KeyL':
          this.load();
          break;
      }
    });
  }

  /**
   * Regenerates the world using a specific seed (used for shared multiplayer
   * worlds and loading hosted snapshots).
   * @param {number} seed
   */
  setSeed(seed) {
    this.params.seed = seed;
    this.seed = seed;
    this.generate(true);
  }

  /**
   * Returns a serializable snapshot of this world (seed + block edits),
   * used for read-only hosting.
   */
  getSnapshot() {
    return {
      seed: this.params.seed,
      data: this.dataStore.data
    };
  }

  /**
   * Applies a hosted snapshot (seed + edits) and regenerates.
   */
  applySnapshot(snapshot) {
    this.params.seed = snapshot.seed;
    this.seed = snapshot.seed;
    this.dataStore.data = snapshot.data || {};
    this.generate();
  }

  /**
   * Saves the world data to local storage
   */
  save() {
    localStorage.setItem('minecraft_params', JSON.stringify(this.params));
    localStorage.setItem('minecraft_data', JSON.stringify(this.dataStore.data));
    document.getElementById('status').innerHTML = 'GAME SAVED';
    setTimeout(() => document.getElementById('status').innerHTML = '', 3000);
  }

  /**
   * Loads the game from disk
   */
  load() {
    this.params = JSON.parse(localStorage.getItem('minecraft_params'));
    this.dataStore.data = JSON.parse(localStorage.getItem('minecraft_data'));
    document.getElementById('status').innerHTML = 'GAME LOADED';
    setTimeout(() => document.getElementById('status').innerHTML = '', 3000);
    this.generate();
  }

  /**
   * Regenerate the world data model and the meshes
   */
  generate(clearCache = false) {
    if (clearCache) {
      this.dataStore.clear();
    }

    this.disposeChunks();

    for (let x = -this.drawDistance; x <= this.drawDistance; x++) {
      for (let z = -this.drawDistance; z <= this.drawDistance; z++) {
        this.generateChunk(x, z);
      }
    }
  }

  /**
   * Updates the visible portions of the world based on the
   * current player position
   * @param {Player} player 
   */
  update(player) {
    const visibleChunks = this.getVisibleChunks(player);
    const chunksToAdd = this.getChunksToAdd(visibleChunks);
    this.removeUnusedChunks(visibleChunks);

    for (const chunk of chunksToAdd) {
      this.generateChunk(chunk.x, chunk.z);
    }
  }

  /**
   * Returns an array containing the coordinates of the chunks that 
   * are currently visible to the player
   * @param {Player} player 
   * @returns {{ x: number, z: number}[]}
   */
  getVisibleChunks(player) {
    const visibleChunks = [];

    const coords = this.worldToChunkCoords(
      player.position.x,
      player.position.y,
      player.position.z
    );

    const chunkX = coords.chunk.x;
    const chunkZ = coords.chunk.z;

    for (let x = chunkX - this.drawDistance; x <= chunkX + this.drawDistance; x++) {
      for (let z = chunkZ - this.drawDistance; z <= chunkZ + this.drawDistance; z++) {
        visibleChunks.push({ x, z });
      }
    }

    return visibleChunks;
  }

  /**
   * Returns an array containing the coordinates of the chunks that 
   * are not yet loaded and need to be added to the scene
   * @param {{ x: number, z: number}[]} visibleChunks 
   * @returns {{ x: number, z: number}[]}
   */
  getChunksToAdd(visibleChunks) {
    // Filter down the visible chunks to those not already in the world
    return visibleChunks.filter((chunk) => {
      const chunkExists = this.children
        .map((obj) => obj.userData)
        .find(({ x, z }) => (
          chunk.x === x && chunk.z === z
        ));

      return !chunkExists;
    })
  }

  /**
   * Removes current loaded chunks that are no longer visible to the player
   * @param {{ x: number, z: number}[]} visibleChunks 
   */
  removeUnusedChunks(visibleChunks) {
    // Filter down the visible chunks to those not already in the world
    const chunksToRemove = this.children.filter((chunk) => {
      const { x, z } = chunk.userData;
      const chunkExists = visibleChunks
        .find((visibleChunk) => (
          visibleChunk.x === x && visibleChunk.z === z
        ));

      return !chunkExists;
    });

    for (const chunk of chunksToRemove) {
      chunk.disposeInstances();
      this.remove(chunk);
      // (removed per-chunk logging for performance)
    }
  }

  /**
   * Generates the chunk at the (x, z) coordinates
   * @param {number} x 
   * @param {number} z
   */
  generateChunk(x, z) {
    const chunk = new WorldChunk(this.chunkSize, this.params, this.dataStore);
    chunk.position.set(
      x * this.chunkSize.width,
      0,
      z * this.chunkSize.width);
    chunk.userData = { x, z };

    if (this.asyncLoading) {
      requestIdleCallback(chunk.generate.bind(chunk), { timeout: 1000 });
    } else {
      chunk.generate();
    }

    this.add(chunk);
    // (removed per-chunk logging for performance)
  }

  /**
   * Gets the block data at (x, y, z)
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   * @returns {{id: number, instanceId: number} | null}
   */
  getBlock(x, y, z) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.loaded) {
      return chunk.getBlock(
        coords.block.x,
        coords.block.y,
        coords.block.z
      );
    } else {
      return null;
    }
  }

  /**
   * Returns the coordinates of the block at world (x,y,z)
   *  - `chunk` is the coordinates of the chunk containing the block
   *  - `block` is the coordinates of the block relative to the chunk
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   * @returns {{
   *  chunk: { x: number, z: number},
   *  block: { x: number, y: number, z: number}
   * }}
   */
  worldToChunkCoords(x, y, z) {
    const chunkCoords = {
      x: Math.floor(x / this.chunkSize.width),
      z: Math.floor(z / this.chunkSize.width)
    };

    const blockCoords = {
      x: x - this.chunkSize.width * chunkCoords.x,
      y,
      z: z - this.chunkSize.width * chunkCoords.z
    };

    return {
      chunk: chunkCoords,
      block: blockCoords
    }
  }

  /**
   * Returns the WorldChunk object at the specified coordinates
   * @param {number} chunkX
   * @param {number} chunkZ
   * @returns {WorldChunk | null}
   */
  getChunk(chunkX, chunkZ) {
    return this.children.find((chunk) => (
      chunk.userData.x === chunkX &&
      chunk.userData.z === chunkZ
    ));
  }

  disposeChunks() {
    this.traverse((chunk) => {
      if (chunk.disposeInstances) {
        chunk.disposeInstances();
      }
    });
    this.clear();
  }

  /**
   * Adds a new block at (x,y,z) of type `blockId`
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   * @param {number} blockId 
   */
  addBlock(x, y, z, blockId) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      chunk.addBlock(
        coords.block.x,
        coords.block.y,
        coords.block.z,
        blockId
      );

      // Hide neighboring blocks if they are completely obscured
      this.hideBlock(x - 1, y, z);
      this.hideBlock(x + 1, y, z);
      this.hideBlock(x, y - 1, z);
      this.hideBlock(x, y + 1, z);
      this.hideBlock(x, y, z - 1);
      this.hideBlock(x, y, z + 1);

      // Broadcast this edit to other players (unless we're applying a remote one).
      if (this.onLocalEdit && !this._applyingRemote) {
        this.onLocalEdit(x, y, z, blockId);
      }
      // Always-firing hook (sound effects, etc.), for local edits only.
      if (this.onAnyEdit && !this._applyingRemote) {
        this.onAnyEdit('place', x, y, z, blockId);
      }
    }
  }

  /**
   * Removes the block at (x, y, z) and sets it to empty
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  removeBlock(x, y, z) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    // Don't allow removing the first layer of blocks
    if (coords.block.y === 0) return;

    if (chunk) {
      chunk.removeBlock(
        coords.block.x,
        coords.block.y,
        coords.block.z
      );

      // Reveal adjacent neighbors if they are hidden
      this.revealBlock(x - 1, y, z);
      this.revealBlock(x + 1, y, z);
      this.revealBlock(x, y - 1, z);
      this.revealBlock(x, y + 1, z);
      this.revealBlock(x, y, z - 1);
      this.revealBlock(x, y, z + 1);

      // Broadcast deletion (blockId 0 = empty) unless applying a remote edit.
      if (this.onLocalEdit && !this._applyingRemote) {
        this.onLocalEdit(x, y, z, 0);
      }
      if (this.onAnyEdit && !this._applyingRemote) {
        this.onAnyEdit('break', x, y, z, 0);
      }

      // If a plant (flower/mushroom) was sitting on this block, it would now
      // float — remove it too.
      const above = this.getBlock(x, y + 1, z);
      if (above && above.id !== blocks.empty.id) {
        const def = Object.values(blocks).find(b => b.id === above.id);
        if (def?.isPlant) {
          this.removeBlock(x, y + 1, z);
        }
      }
    }
  }

  /**
   * Applies a remote edit from another player WITHOUT re-broadcasting it.
   */
  applyRemoteEdit(x, y, z, blockId) {
    this._applyingRemote = true;
    if (blockId === 0) {
      this.removeBlock(x, y, z);
    } else {
      this.addBlock(x, y, z, blockId);
    }
    this._applyingRemote = false;
  }

  /**
   * Reveals the block at (x,y,z) by adding a new mesh instance
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  revealBlock(x, y, z) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk) {
      chunk.addBlockInstance(
        coords.block.x,
        coords.block.y,
        coords.block.z
      )
    }
  }

  /**
   * Hides the block at (x,y,z) by removing the mesh instance
   * @param {number} x 
   * @param {number} y 
   * @param {number} z 
   */
  hideBlock(x, y, z) {
    const coords = this.worldToChunkCoords(x, y, z);
    const chunk = this.getChunk(coords.chunk.x, coords.chunk.z);

    if (chunk && chunk.isBlockObscured(coords.block.x, coords.block.y, coords.block.z)) {
      chunk.deleteBlockInstance(
        coords.block.x,
        coords.block.y,
        coords.block.z
      )
    }
  }
}