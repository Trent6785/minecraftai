// Door system (Stage 1: render thin oak slabs in the world).
// Doors are NOT normal cube blocks — they're separate thin objects managed
// here, outside the chunk mesher. Each door is 2 blocks tall, thin in depth,
// faces a cardinal direction, and (later) opens/closes.
import * as THREE from 'three';

const textureLoader = new THREE.TextureLoader();

function loadDoorTexture() {
  const tex = textureLoader.load('textures/door_oak.png');
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

// Facing directions: which way the door's face points (its "front").
// yaw is rotation around Y. 0 = facing +Z (south), etc.
const FACING_YAW = {
  south: 0,
  west: Math.PI / 2,
  north: Math.PI,
  east: -Math.PI / 2,
};

export class DoorManager {
  constructor(scene) {
    this.scene = scene;
    this.texture = loadDoorTexture();
    this.material = new THREE.MeshLambertMaterial({
      map: this.texture,
      transparent: true,   // door textures often have transparent edges
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
    // Map of "x,y,z" (bottom block of the door) -> door record.
    this.doors = new Map();
  }

  key(x, y, z) { return `${x},${y},${z}`; }

  /**
   * Place a door whose BOTTOM occupies world cell (x,y,z), extending up to y+1.
   * @param {number} x @param {number} y @param {number} z
   * @param {string} facing  'north'|'south'|'east'|'west'
   * @param {string} hinge   'left'|'right'
   */
  addDoor(x, y, z, facing = 'south', hinge = 'left') {
    const k = this.key(x, y, z);
    if (this.doors.has(k)) return;

    // A door slab: 1 wide, 2 tall, thin in depth. Pivot at the hinge edge so
    // it can swing later. We use a Group as the hinge pivot, and offset the
    // slab mesh so its edge sits at the pivot.
    const width = 1, height = 2, depth = 0.15;

    const geo = new THREE.BoxGeometry(width, height, depth);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = true;
    // Offset so the hinge edge (left edge) is at the pivot's origin.
    const hingeSign = (hinge === 'left') ? 1 : -1;
    mesh.position.x = hingeSign * (width / 2);

    const pivot = new THREE.Group();
    pivot.add(mesh);

    // Position the pivot at the hinge edge of the cell, vertically centered
    // over the 2-tall span (y to y+1), and at the cell's depth center.
    pivot.position.set(
      x + 0.5 - hingeSign * 0.5,  // hinge edge x
      y + 1.0,                    // center of the 2-tall door (cells y and y+1)
      z + 0.5
    );
    pivot.rotation.y = FACING_YAW[facing] ?? 0;

    this.scene.add(pivot);

    this.doors.set(k, {
      x, y, z, facing, hinge,
      open: false,
      pivot, mesh,
    });
  }

  /** Remove a door at the given bottom cell. */
  removeDoor(x, y, z) {
    const k = this.key(x, y, z);
    const d = this.doors.get(k);
    if (!d) return;
    this.scene.remove(d.pivot);
    d.mesh.geometry.dispose();
    this.doors.delete(k);
  }

  /** Is there a door occupying this cell (bottom or top half)? */
  doorAt(x, y, z) {
    if (this.doors.has(this.key(x, y, z))) return this.doors.get(this.key(x, y, z));
    // Check if this is the TOP half of a door whose bottom is at y-1.
    if (this.doors.has(this.key(x, y - 1, z))) return this.doors.get(this.key(x, y - 1, z));
    return null;
  }

  /** Toggle a door open/closed (snaps instantly). Rotates the hinge pivot 90°. */
  toggle(door) {
    if (!door) return;
    door.open = !door.open;
    // SWING_DIRECTION controls which way the door opens. If it opens the wrong
    // way, flip this single value between +1 and -1.
    const SWING_DIRECTION = +1;
    const swing = SWING_DIRECTION * (Math.PI / 2);
    const base = FACING_YAW[door.facing] ?? 0;
    door.pivot.rotation.y = door.open ? base + swing : base;
  }

  /** All door meshes, for raycasting. */
  getMeshes() {
    const meshes = [];
    for (const d of this.doors.values()) meshes.push(d.mesh);
    return meshes;
  }

  /** Find the door record owning a given mesh. */
  doorForMesh(mesh) {
    for (const d of this.doors.values()) {
      if (d.mesh === mesh) return d;
    }
    return null;
  }
}
