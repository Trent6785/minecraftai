// Multiplayer: sync player positions and render other players as avatars.
import { db } from './firebase';
import { ref, set, update, onValue, onChildAdded, onChildChanged, onChildRemoved, onDisconnect } from 'firebase/database';
import { Avatar } from './avatar';

function getRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('room') || 'lobby').toUpperCase();
}
function makePlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 9);
}

export const roomCode = getRoomCode();
export const playerId = makePlayerId();

// Chosen avatar. Defaults to steve; the start-screen picker can change it
// before the player joins the room.
export let myAvatarType = 'steve';
export function chooseAvatar(type) {
  if (type === 'steve' || type === 'alex') myAvatarType = type;
}

let joined = false;

const playerRef = ref(db, `rooms/${roomCode}/players/${playerId}`);
const playersRef = ref(db, `rooms/${roomCode}/players`);

// Remote players: id -> { avatar, data }
const remotePlayers = new Map();

let _scene = null;
let _world = null;
let _localPlayer = null;

// How often we push our position to Firebase (ms). ~10/sec.
const SEND_INTERVAL = 100;
let lastSend = 0;

/**
 * Initialize multiplayer. Pass the THREE scene, the world, and the local Player.
 */
export function initMultiplayer(scene, world, localPlayer) {
  if (joined) return;       // only join once
  joined = true;
  _scene = scene;
  _world = world;
  _localPlayer = localPlayer;

  console.log(`[mp] joining room "${roomCode}" as ${playerId} (${myAvatarType})`);

  // Announce ourselves with an initial position.
  const p = localPlayer.position;
  set(playerRef, {
    id: playerId,
    avatar: myAvatarType,
    x: p.x, y: p.y, z: p.z,
    yaw: 0,
    t: Date.now()
  });

  // Auto-remove our entry on disconnect.
  onDisconnect(playerRef).remove();

  // --- Spawn an avatar when another player joins ---
  onChildAdded(playersRef, (snap) => {
    const data = snap.val();
    if (!data || data.id === playerId) return; // skip ourselves
    addRemotePlayer(data);
  });

  // --- Update a player's target transform when their data changes ---
  onChildChanged(playersRef, (snap) => {
    const data = snap.val();
    if (!data || data.id === playerId) return;
    const rp = remotePlayers.get(data.id);
    if (rp) {
      // Feet position: data.y is the camera/eye height; drop to feet.
      rp.avatar.setTargetPosition(data.x, data.y - _localPlayer.height, data.z);
      rp.avatar.setTargetYaw(data.yaw || 0);
    } else {
      addRemotePlayer(data);
    }
  });

  // --- Remove a player's avatar when they leave ---
  onChildRemoved(playersRef, (snap) => {
    const data = snap.val();
    if (!data) return;
    const rp = remotePlayers.get(data.id);
    if (rp) {
      rp.avatar.dispose();
      remotePlayers.delete(data.id);
      console.log(`[mp] player left: ${data.id}`);
    }
  });
}

function addRemotePlayer(data) {
  if (remotePlayers.has(data.id)) return;
  console.log(`[mp] player joined: ${data.id} (${data.avatar})`);
  const avatar = new Avatar(_scene, data.avatar || 'steve', _localPlayer.height);
  avatar.setPosition(data.x, data.y - _localPlayer.height, data.z);
  avatar.setYaw(data.yaw || 0);
  remotePlayers.set(data.id, { avatar, data });
}

/**
 * Call every frame. Sends our position (throttled) and interpolates others.
 */
export function updateMultiplayer(dt) {
  if (!_localPlayer) return;

  // Send our position a few times per second.
  const now = performance.now();
  if (now - lastSend > SEND_INTERVAL) {
    lastSend = now;
    const p = _localPlayer.position;
    // Yaw from the camera's Y rotation.
    const yaw = _localPlayer.camera.rotation.y;
    update(playerRef, { x: p.x, y: p.y, z: p.z, yaw, t: Date.now() });
  }

  // Interpolate every remote avatar toward its target.
  for (const { avatar } of remotePlayers.values()) {
    avatar.update(dt);
  }
}

export function setMyAvatar(type) {
  myAvatarType = type;
  update(playerRef, { avatar: type });
}
