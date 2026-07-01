// Multiplayer: sync player positions and render other players as avatars.
import { db } from './firebase';
import { ref, set, get, update, remove, push, onValue, onChildAdded, onChildChanged, onChildRemoved, onDisconnect } from 'firebase/database';
import { Avatar } from './avatar';

function getRoomCode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('room');
}
function makeRoomCode() {
  // 6-char uppercase code, e.g. "ABCD23".
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function makePlayerId() {
  return 'p_' + Math.random().toString(36).slice(2, 9);
}

// Room code: from URL if present (joining), else generated (creating).
export let roomCode = getRoomCode() || makeRoomCode();
export const playerId = makePlayerId();
export function roomExistsInUrl() { return !!getRoomCode(); }

export let myAvatarType = 'steve';
export function chooseAvatar(type) {
  if (type === 'steve' || type === 'alex') myAvatarType = type;
}

export let myName = 'Player';
export function setMyName(name) {
  myName = (name || 'Player').toString().slice(0, 16);
}

let joined = false;

let playerRef = null;
let playersRef = null;
let seedRef = null;
let hostRef = null;
let roomRef = null;
let editsRef = null;
let doorsRef = null;

function buildRefs() {
  playerRef = ref(db, `rooms/${roomCode}/players/${playerId}`);
  playersRef = ref(db, `rooms/${roomCode}/players`);
  seedRef = ref(db, `rooms/${roomCode}/seed`);
  hostRef = ref(db, `rooms/${roomCode}/host`);
  roomRef = ref(db, `rooms/${roomCode}`);
  editsRef = ref(db, `rooms/${roomCode}/edits`);
  doorsRef = ref(db, `rooms/${roomCode}/doors`);
}

export let isHost = false;

// Callback the game sets, invoked when the room is closed by the host (or
// vanishes) so the game can boot the player back to the menu.
let onRoomClosed = null;
export function setOnRoomClosed(cb) { onRoomClosed = cb; }

/**
 * Resolve the shared seed for this room. If the room already has a seed
 * (someone created it first), returns that and we are NOT the host. Otherwise
 * writes `mySeed` as the room's seed, claims host, and returns it.
 * @returns {Promise<number>}
 */
export async function resolveSharedSeed(mySeed) {
  buildRefs();
  const snap = await get(seedRef);
  if (snap.exists()) {
    isHost = false;
    return snap.val();           // joining existing world
  } else {
    await set(seedRef, mySeed);  // we're the creator -> host
    await set(hostRef, playerId);
    isHost = true;
    return mySeed;
  }
}

/** Host action: close the room for everyone and delete it. */
export function closeRoom() {
  if (!isHost || !roomRef) return;
  remove(roomRef);
}

// ---- Read-only hosted worlds (Stage 3) ----

function makeHostCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Remember the host code we last published, so re-hosting can update it.
let myHostCode = localStorage.getItem('mc_host_code') || null;
export function getMyHostCode() { return myHostCode; }

/**
 * Publish a read-only snapshot of the world to Firebase.
 * @param {object} snapshot  { seed, data } from world.getSnapshot()
 * @param {boolean} updateExisting  if true and we have a prior code, overwrite it
 * @returns {Promise<string>}  the host code
 */
export async function hostWorld(snapshot, updateExisting) {
  const code = (updateExisting && myHostCode) ? myHostCode : makeHostCode();
  // A stable owner id per browser, so only we can overwrite our hosted world.
  let owner = localStorage.getItem('mc_owner_id');
  if (!owner) {
    owner = 'o_' + Math.random().toString(36).slice(2, 12);
    localStorage.setItem('mc_owner_id', owner);
  }
  const hostedRef = ref(db, `hosted/${code}`);
  await set(hostedRef, {
    owner,
    seed: snapshot.seed,
    data: snapshot.data || {},
    createdAt: Date.now()
  });
  myHostCode = code;
  localStorage.setItem('mc_host_code', code);
  return code;
}

/**
 * Load a hosted snapshot by code.
 * @returns {Promise<{seed:number,data:object}|null>}
 */
export async function loadHostedWorld(code) {
  const snap = await get(ref(db, `hosted/${code}`));
  if (!snap.exists()) return null;
  const val = snap.val();
  return { seed: val.seed, data: val.data || {} };
}

// Read the ?view=CODE param (spectator mode) from the URL.
export function getViewCode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('view');
}

// ---- Door sync ----
// Hook the game sets to apply remote door placements/toggles.
let onRemoteDoor = null;
export function setOnRemoteDoor(cb) { onRemoteDoor = cb; }

let _applyingRemoteDoor = false;

/** Broadcast a door placement to the room. */
export function syncDoorPlace(x, y, z, facing, hinge) {
  if (!doorsRef || _applyingRemoteDoor) return;
  const k = `${x}_${y}_${z}`;
  set(ref(db, `rooms/${roomCode}/doors/${k}`), { x, y, z, facing, hinge, open: false });
}

/** Broadcast a door's open/closed state change. */
export function syncDoorState(x, y, z, open) {
  if (!doorsRef || _applyingRemoteDoor) return;
  const k = `${x}_${y}_${z}`;
  update(ref(db, `rooms/${roomCode}/doors/${k}`), { open });
}

// Called from initMultiplayer to start listening for door changes.
function listenForDoors() {
  // Existing + new door placements.
  onChildAdded(doorsRef, (snap) => {
    const d = snap.val();
    if (!d || !onRemoteDoor) return;
    _applyingRemoteDoor = true;
    onRemoteDoor('place', d);
    _applyingRemoteDoor = false;
  });
  // Door state changes (open/close).
  onChildChanged(doorsRef, (snap) => {
    const d = snap.val();
    if (!d || !onRemoteDoor) return;
    _applyingRemoteDoor = true;
    onRemoteDoor('state', d);
    _applyingRemoteDoor = false;
  });
}

const remotePlayers = new Map();

let _scene = null;
let _world = null;
let _localPlayer = null;

const SEND_INTERVAL = 100;
let lastSend = 0;

/**
 * Initialize multiplayer. Pass the THREE scene, the world, and the local Player.
 */
export function initMultiplayer(scene, world, localPlayer) {
  if (joined) return;
  joined = true;
  _scene = scene;
  _world = world;
  _localPlayer = localPlayer;
  if (!playersRef) buildRefs();

  console.log(`[mp] joined room "${roomCode}" as ${playerId} (${myAvatarType})`);

  // Announce ourselves with an initial position.
  const p = localPlayer.position;
  set(playerRef, {
    id: playerId,
    avatar: myAvatarType,
    name: myName,
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

  // --- Block edit sync ---
  // Send our local edits (manual place/break AND AI builds) to Firebase.
  _world.onLocalEdit = (x, y, z, blockId) => {
    push(editsRef, { x, y, z, b: blockId });
  };

  // Receive edits. onChildAdded fires for ALL existing edits first (so a new
  // joiner replays everything already built), then for each new edit live.
  onChildAdded(editsRef, (snap) => {
    const e = snap.val();
    if (!e) return;
    _world.applyRemoteEdit(e.x, e.y, e.z, e.b);
  });

  // Listen for door placements and open/close state across the room.
  listenForDoors();

  // --- Detect the room being closed (host force-close, or it vanishing) ---
  onValue(seedRef, (snap) => {
    if (!snap.exists() && joined) {
      // Seed gone => room was deleted. Boot back to menu.
      console.log('[mp] room closed');
      if (onRoomClosed) onRoomClosed();
    }
  });

  // --- Auto-cleanup: if we're the last player to leave, delete the room ---
  // When our tab disconnects, also try to remove the whole room IF empty.
  // We check the player count and, if we're the only one, schedule room
  // removal on disconnect.
  onValue(playersRef, (snap) => {
    const players = snap.val() || {};
    const count = Object.keys(players).length;
    if (count <= 1) {
      // We're (about to be) the last one — clean up the whole room on disconnect.
      onDisconnect(roomRef).remove();
    } else {
      // Others are here; only remove our own entry on disconnect.
      onDisconnect(roomRef).cancel();
      onDisconnect(playerRef).remove();
    }
  });
}

function addRemotePlayer(data) {
  if (remotePlayers.has(data.id)) return;
  console.log(`[mp] player joined: ${data.id} (${data.avatar})`);
  const avatar = new Avatar(_scene, data.avatar || 'steve', _localPlayer.height);
  avatar.setPosition(data.x, data.y - _localPlayer.height, data.z);
  avatar.setYaw(data.yaw || 0);
  // Show their name above their head once the model is ready.
  const applyName = () => {
    if (avatar.ready) avatar.setName(data.name || 'Player');
    else setTimeout(applyName, 150);
  };
  applyName();
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
