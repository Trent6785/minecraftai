import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();

// Cache loaded glTF data per model name so we don't re-fetch the same file
// for every avatar. Each entry: { scene, animations }.
const modelCache = {};

function loadModel(name) {
  if (modelCache[name]) return Promise.resolve(modelCache[name]);
  return new Promise((resolve, reject) => {
    loader.load(`./models/${name}.glb`, (gltf) => {
      modelCache[name] = { scene: gltf.scene, animations: gltf.animations };
      resolve(modelCache[name]);
    }, undefined, reject);
  });
}

/**
 * An Avatar is a player character (Steve or Alex) placed in the world.
 * It loads the model, normalizes its size to the player's height, sets up
 * animation (idle / walk), and exposes simple controls used by both the
 * local test and (later) networked players.
 */
export class Avatar {
  /**
   * @param {THREE.Scene} scene  scene to add the avatar to
   * @param {string} type        'steve' or 'alex'
   * @param {number} targetHeight world-units tall the avatar should be (~player height)
   */
  constructor(scene, type = 'steve', targetHeight = 1.8) {
    this.scene = scene;
    this.type = type;
    this.targetHeight = targetHeight;
    this.root = new THREE.Group();      // we move/rotate this
    this.mixer = null;
    this.actions = {};                  // name -> AnimationAction
    this.current = null;                // currently playing action
    this.ready = false;
    this.disposed = false;
    this.scene.add(this.root);

    // For smoothing networked movement later.
    this.targetPosition = new THREE.Vector3();
    this.targetYaw = 0;

    loadModel(type).then(({ scene: modelScene, animations }) => {
      // If this avatar was disposed before the model finished loading, bail.
      if (this.disposed) return;
      // Use SkeletonUtils' clone so multiple avatars of the same model (e.g. two
      // players both as Steve) each get their own working skeleton. A plain
      // .clone() loses the skeleton and the mesh goes invisible.
      const model = skeletonClone(modelScene);

      // --- Normalize size: scale so the model is `targetHeight` tall ---
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const currentHeight = size.y || 1;
      const scale = this.targetHeight / currentHeight;
      model.scale.setScalar(scale);

      // --- Recenter so feet sit at the group's origin (y=0) ---
      const box2 = new THREE.Box3().setFromObject(model);
      model.position.y -= box2.min.y;        // drop so lowest point = 0
      model.position.x -= (box2.min.x + box2.max.x) / 2; // center horizontally
      model.position.z -= (box2.min.z + box2.max.z) / 2;

      // Per-model fine-tune: some rigs sit slightly low. Nudge up if needed.
      // If a model sinks into the ground, increase its offset here.
      const GROUND_OFFSET = { steve: 0, alex: 0.12 };
      model.position.y += (GROUND_OFFSET[this.type] || 0);

      model.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });

      this.model = model;
      this.root.add(model);

      // --- Animations ---
      if (animations && animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(model);
        for (const clip of animations) {
          this.actions[clip.name.toLowerCase()] = this.mixer.clipAction(clip);
        }
        // Log the clip names so we can confirm idle/walk names per model.
        console.log(`[avatar:${type}] animations:`, animations.map(a => a.name));
        // Try to start an idle-ish animation by default.
        this.play(this._findClip(['idle', 'stand', 'breathing']) || Object.keys(this.actions)[0]);
      }

      this.ready = true;
    }).catch((err) => {
      console.error(`Failed to load avatar '${type}':`, err);
    });
  }

  // Find the best action whose name contains one of the given keywords.
  // Prefers 'armature|'-prefixed clips (the rigged ones) when both exist,
  // since some exports include an empty bare clip alongside the real rigged one.
  _findClip(keywords) {
    const names = Object.keys(this.actions);
    for (const kw of keywords) {
      const matches = names.filter(n => n.includes(kw));
      if (matches.length === 0) continue;
      // Prefer a rigged (armature) clip if present.
      const rigged = matches.find(n => n.includes('armature'));
      return rigged || matches[0];
    }
    return null;
  }

  /** Play an animation by (lowercased) name, cross-fading from the current one. */
  play(name) {
    if (!name || !this.actions[name]) return;
    const next = this.actions[name];
    if (this.current === next) return;
    next.reset().fadeIn(0.2).play();
    if (this.current) this.current.fadeOut(0.2);
    this.current = next;
  }

  /** Switch to walking or idle based on whether the avatar is moving. */
  setMoving(isMoving) {
    if (!this.ready) return;
    if (isMoving) {
      this.play(this._findClip(['walk', 'run', 'move']));
    } else {
      this.play(this._findClip(['idle', 'stand', 'breathing']));
    }
  }

  /** Place the avatar at a world position (feet at y). */
  setPosition(x, y, z) {
    this.root.position.set(x, y, z);
    this.targetPosition.set(x, y, z);
  }

  /** Face a yaw angle (radians). */
  setYaw(yaw) {
    this.root.rotation.y = yaw;
    this.targetYaw = yaw;
  }

  /** Set the TARGET position the avatar smoothly moves toward (networked). */
  setTargetPosition(x, y, z) {
    this.targetPosition.set(x, y, z);
  }

  /** Set the TARGET yaw the avatar smoothly rotates toward (networked). */
  setTargetYaw(yaw) {
    this.targetYaw = yaw;
  }

  /** Advance animation and smoothly interpolate toward target transform. */
  update(dt) {
    if (this.mixer) this.mixer.update(dt);

    // Smoothly move toward the latest networked target (interpolation).
    // Lerp factor framerate-independent-ish; 10 is a snappy-but-smooth feel.
    const k = Math.min(1, dt * 10);
    this.root.position.lerp(this.targetPosition, k);

    // Shortest-path angle interpolation for yaw.
    let dy = this.targetYaw - this.root.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.root.rotation.y += dy * k;

    // Auto-detect movement to switch walk/idle, based on how far we're moving.
    const dist = this.root.position.distanceTo(this.targetPosition);
    this.setMoving(dist > 0.02);
  }

  /** Set/update a floating name tag above the avatar. */
  setName(name) {
    this.name = name;
    if (!name) return;

    // Render the name onto a canvas, use it as a sprite texture.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontSize = 48;
    ctx.font = `${fontSize}px 'Minecraft', sans-serif`;
    const textW = ctx.measureText(name).width;
    canvas.width = textW + 40;
    canvas.height = fontSize + 24;

    // Background pill.
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Text.
    ctx.font = `${fontSize}px 'Minecraft', sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 20, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;

    if (this.nameSprite) {
      this.nameSprite.material.map?.dispose();
      this.nameSprite.material.map = texture;
      this.nameSprite.material.needsUpdate = true;
    } else {
      const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
      this.nameSprite = new THREE.Sprite(mat);
      this.root.add(this.nameSprite);
    }
    // Scale and position above the avatar's head.
    const aspect = canvas.width / canvas.height;
    const h = 0.4;
    this.nameSprite.scale.set(h * aspect, h, 1);
    this.nameSprite.position.set(0, this.targetHeight + 0.35, 0);
    this.nameSprite.renderOrder = 999;
  }

  /** Remove from scene and stop animation. Does NOT dispose geometry/materials/
   *  textures, because SkeletonUtils.clone() shares those with the cached model
   *  and other avatars of the same type — disposing them would corrupt those. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.scene.remove(this.root);
  }
}
