import * as THREE from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { World } from './world';
import { Player } from './player';
import { Physics } from './physics';
import { setupUI } from './ui';
import { ModelLoader } from './modelLoader';
import { Avatar } from './avatar';
import { initMultiplayer, updateMultiplayer, chooseAvatar, resolveSharedSeed, roomExistsInUrl, roomCode, isHost, closeRoom, setOnRoomClosed, hostWorld, loadHostedWorld, getViewCode, getMyHostCode, syncDoorPlace, syncDoorState, setOnRemoteDoor } from './multiplayer';
import { sounds } from './sounds';
import { DoorManager } from './doors';

// UI Setup
const stats = new Stats();
document.body.appendChild(stats.dom);

// Renderer setup
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x80a0e0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Scene setup
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x80a0e0, 50, 75);

const world = new World();
world.generate();
scene.add(world);

const player = new Player(scene, world);
const physics = new Physics(scene);

// Camera setup
const orbitCamera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
orbitCamera.position.set(24, 24, 24);
orbitCamera.layers.enable(1);

const controls = new OrbitControls(orbitCamera, renderer.domElement);
controls.update();

const modelLoader = new ModelLoader((models) => {
  player.setTool(models.pickaxe);
})

let sun;
let ambientLight;
function setupLights() {
  sun = new THREE.DirectionalLight();
  sun.intensity = 1.5;
  sun.position.set(50, 50, 50);
  sun.castShadow = true;

  // Set the size of the sun's shadow box
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0001;
  sun.shadow.mapSize = new THREE.Vector2(2048, 2048);
  scene.add(sun);
  scene.add(sun.target);

  ambientLight = new THREE.AmbientLight();
  ambientLight.intensity = 0.2;
  scene.add(ambientLight);
}

// ---- Day/night cycle + depth darkening ----
// A full day loops every DAY_LENGTH seconds. The sun arcs across the sky,
// changes color (warm at dawn/dusk, white midday), and brightness rises and
// falls. Depth darkening then dims everything further the deeper you go, so
// caves are dark by day and the surface is dark by night.
const DAY_LENGTH = 240;      // seconds for a full day-night loop (4 minutes)
const SURFACE_Y = 10;        // approx ground level; below this depth dimming starts
const DARK_DEPTH = 14;       // blocks down until fully dark underground

let dayTime = DAY_LENGTH * 0.30; // start mid-morning
let dayNightPaused = false;

// Reusable colors to avoid per-frame allocation.
const _skyDay = new THREE.Color(0x80a0e0);
const _skyNight = new THREE.Color(0x05060f);
const _skyDusk = new THREE.Color(0xe88a4a);
const _sunDay = new THREE.Color(0xffffff);
const _sunDusk = new THREE.Color(0xffb066);
const _caveDark = new THREE.Color(0x0a0a12);
const _tmpSky = new THREE.Color();
const _tmpSun = new THREE.Color();

function updateDayNight(dt) {
  if (!dayNightPaused) dayTime = (dayTime + dt) % DAY_LENGTH;
  // phase: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
  const phase = dayTime / DAY_LENGTH;
  const angle = phase * Math.PI * 2;

  // Sun height: sin gives -1 (midnight) .. +1 (noon). daylight in [0,1].
  const sunHeight = Math.sin(angle - Math.PI / 2);
  const daylight = Math.max(0, sunHeight);          // 0 at/under horizon, 1 at noon
  const duskFactor = Math.max(0, 1 - Math.abs(sunHeight) * 3); // peaks near horizon

  // Move the sun around the player (direction matters for shadows/shading).
  sun.position.set(
    Math.cos(angle) * 80,
    sunHeight * 80,
    Math.sin(angle) * 40
  );

  // --- Depth factor: how far underground (0 surface .. 1 deep) ---
  let depth = (SURFACE_Y - player.position.y) / DARK_DEPTH;
  depth = Math.max(0, Math.min(1, depth));
  const depthLight = 1 - depth; // 1 at surface, 0 deep underground

  // --- Sun intensity: bright by day, near zero at night, dimmed by depth ---
  const dayBright = 0.15 + 1.35 * daylight;  // 0.15 night .. 1.5 noon
  sun.intensity = dayBright * (1 - 0.9 * depth);

  // --- Ambient: a little light at night, more by day, dimmed by depth ---
  ambientLight.intensity = (0.06 + 0.18 * daylight) * (1 - 0.75 * depth);

  // --- Sun color: warm near horizon, white high up ---
  _tmpSun.copy(_sunDay).lerp(_sunDusk, duskFactor);
  sun.color.copy(_tmpSun);

  // --- Sky color: day blue -> dusk orange -> night ---
  _tmpSky.copy(_skyNight).lerp(_skyDay, daylight);      // night..day blend
  _tmpSky.lerp(_skyDusk, duskFactor * 0.6);             // add dusk warmth near horizon
  _tmpSky.lerp(_caveDark, depth);                       // darken underground

  scene.background = _tmpSky.clone();
  if (scene.fog) scene.fog.color.copy(_tmpSky);
}

// True while the build box is open, so the render loop keeps using the
// first-person camera instead of falling back to the orbit (3rd person) camera.
let builderViewActive = false;

// Render loop
let previousTime = performance.now();
let _cornerFrame = 0;
function animate() {
  requestAnimationFrame(animate);

  const currentTime = performance.now();
  const dt = (currentTime - previousTime) / 1000;

  // Only update physics when player controls are locked
  if (player.controls.isLocked) {
    physics.update(dt, player, world);
    player.update(world);
    world.update(player);

    // Position the sun relative to the player. Need to adjust both the
    // position and target of the sun to keep the same sun angle
    sun.position.copy(player.camera.position);
    sun.position.sub(new THREE.Vector3(-50, -50, -50));
    sun.target.position.copy(player.camera.position);

    // Update positon of the orbit camera to track player 
    orbitCamera.position.copy(player.position).add(new THREE.Vector3(16, 16, 16));
    controls.target.copy(player.position);

    // Dim the world as the player descends underground.
    updateDayNight(dt);

    // Sync our position and interpolate other players' avatars.
    updateMultiplayer(dt);

    // Update the third-person selfie avatar + corner camera.
    updateCornerView(dt);

    // Footstep sounds while moving on the ground (not flying).
    updateFootsteps(dt);
  }

  // Main view.
  renderer.render(scene, (player.controls.isLocked || builderViewActive) ? player.camera : orbitCamera);

  // Third-person corner inset (top-right), only while actually playing.
  // Rendered every other frame to halve its cost (it's a full second scene pass).
  _cornerFrame = (_cornerFrame + 1) % 2;
  if (selfAvatar && selfAvatar.ready && player.controls.isLocked && _cornerFrame === 0) {
    const w = window.innerWidth, h = window.innerHeight;
    const insetW = Math.min(260, Math.floor(w * 0.22));
    const insetH = Math.floor(insetW * 0.85);
    const margin = 12;
    const x = w - insetW - margin;
    const y = h - insetH - margin; // WebGL origin is bottom-left

    renderer.setScissorTest(true);
    renderer.setViewport(x, y, insetW, insetH);
    renderer.setScissor(x, y, insetW, insetH);
    cornerCamera.aspect = insetW / insetH;
    cornerCamera.updateProjectionMatrix();
    renderer.render(scene, cornerCamera);

    // Reset back to full-screen for next frame.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }

  stats.update();

  previousTime = currentTime;
}

window.addEventListener('resize', () => {
  // Resize camera aspect ratio and renderer size to the new window size
  orbitCamera.aspect = window.innerWidth / window.innerHeight;
  orbitCamera.updateProjectionMatrix();
  player.camera.aspect = window.innerWidth / window.innerHeight;
  player.camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
});

setupUI(world, player, physics, scene);
setupLights();

// ---- Doors ----
const doorManager = new DoorManager(scene);
physics.doorManager = doorManager; // so closed doors block movement

// Place a door locally and (optionally) broadcast it.
function placeDoor(x, y, z, facing = 'south', hinge = 'left', broadcast = true) {
  // Clear the two cells the door occupies (y and y+1) so it's never buried in
  // a wall block the AI may have placed there.
  if (world.getBlock(x, y, z)?.id) world.removeBlock(x, y, z);
  if (world.getBlock(x, y + 1, z)?.id) world.removeBlock(x, y + 1, z);
  doorManager.addDoor(x, y, z, facing, hinge);
  if (broadcast) syncDoorPlace(x, y, z, facing, hinge);
}

// Apply door changes coming from other players.
setOnRemoteDoor((kind, d) => {
  if (kind === 'place') {
    doorManager.addDoor(d.x, d.y, d.z, d.facing || 'south', d.hinge || 'left');
    if (d.open) {
      const door = doorManager.doorAt(d.x, d.y, d.z);
      if (door && !door.open) doorManager.toggle(door);
    }
  } else if (kind === 'state') {
    const door = doorManager.doorAt(d.x, d.y, d.z);
    if (door && door.open !== d.open) doorManager.toggle(door);
  }
});

// Right-click toggles a door you're looking at (within reach).
const _doorRaycaster = new THREE.Raycaster();
const _screenCenter = new THREE.Vector2(0, 0); // pointer-locked = screen center
window.addEventListener('contextmenu', (e) => e.preventDefault()); // no browser menu
window.addEventListener('mousedown', (e) => {
  if (e.button !== 2) return;             // right-click only
  if (!player.controls.isLocked) return; // only while playing
  if (player.readOnly) return;           // spectators can't toggle

  _doorRaycaster.setFromCamera(_screenCenter, player.camera);
  const meshes = doorManager.getMeshes();
  if (meshes.length === 0) return;
  const hits = _doorRaycaster.intersectObjects(meshes, false);
  if (hits.length > 0 && hits[0].distance < 6) {
    const door = doorManager.doorForMesh(hits[0].object);
    if (door) {
      doorManager.toggle(door);
      sounds.play(door.open ? 'place' : 'break', 0.4);
      // Sync the new open/closed state to other players.
      syncDoorState(door.x, door.y, door.z, door.open);
    }
  }
});

// ---- Sound effects ----
// Place/break sounds fire on every local edit (manual or AI), in all modes.
let _aiBuildSoundThrottle = 0;
world.onAnyEdit = (kind) => {
  // For AI builds (many edits at once), throttle so it's one sound, not 100.
  const now = performance.now();
  if (now - _aiBuildSoundThrottle < 60) return;
  _aiBuildSoundThrottle = now;
  sounds.play(kind === 'break' ? 'break' : 'place', 0.5);
};

// ============================================================
// ---- Third-person corner view (selfie cam) ----
// ============================================================
// Renders a small inset in the top-right showing the player's own avatar from
// behind and above. The self-avatar lives on layer 2 so the main first-person
// camera doesn't draw it (which would block the view), but the corner camera
// (layers 0 + 2) does.
const SELF_LAYER = 2;
let selfAvatar = null;
const cornerCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
cornerCamera.layers.enable(0);
cornerCamera.layers.enable(SELF_LAYER);

import('./avatar').then(({ Avatar }) => {
  // Use whatever avatar the player picked (default steve).
  selfAvatar = new Avatar(scene, getSelfAvatarType(), player.height);
  // Put the avatar's meshes on the self layer once it loads.
  const setLayer = () => {
    if (selfAvatar && selfAvatar.root) {
      selfAvatar.root.traverse((o) => o.layers.set(SELF_LAYER));
    }
  };
  // Retry briefly until the model has loaded.
  const iv = setInterval(() => { if (selfAvatar && selfAvatar.ready) { setLayer(); clearInterval(iv); } }, 100);
});

function getSelfAvatarType() {
  // Mirror the avatar chosen in the picker (falls back to steve).
  const selected = document.querySelector('.avatar-card.selected');
  return (selected && selected.dataset.avatar) || 'steve';
}

// Footstep sounds: play at intervals while moving on the ground.
let _stepTimer = 0;
const _stepPrev = new THREE.Vector3();
let _stepInit = false;
function updateFootsteps(dt) {
  if (!_stepInit) { _stepPrev.copy(player.position); _stepInit = true; }
  const dx = player.position.x - _stepPrev.x;
  const dz = player.position.z - _stepPrev.z;
  _stepPrev.copy(player.position);
  const speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.0001);

  const moving = speed > 1 && player.onGround && !player.flying;
  if (moving) {
    _stepTimer -= dt;
    if (_stepTimer <= 0) {
      sounds.play('step', 0.35);
      // Faster steps when sprinting.
      _stepTimer = player.sprinting ? 0.30 : 0.42;
    }
  } else {
    _stepTimer = 0; // reset so first step plays immediately when moving resumes
  }
}


// Update the self-avatar to follow the player, and position the corner camera.
let _lastSelfPos = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
function updateCornerView(dt) {
  if (!selfAvatar || !selfAvatar.ready) return;

  // Derive horizontal facing (yaw) from the camera's actual look direction.
  // PointerLockControls bakes pitch into camera.rotation, so reading rotation.y
  // directly is unreliable — use the world direction vector instead.
  player.camera.getWorldDirection(_lookDir);
  const yaw = Math.atan2(_lookDir.x, _lookDir.z);
  const feetY = player.position.y - player.height;

  // Detect real movement (horizontal distance moved this frame).
  const dx = player.position.x - _lastSelfPos.x;
  const dz = player.position.z - _lastSelfPos.z;
  const movedSq = dx * dx + dz * dz;
  _lastSelfPos.set(player.position.x, player.position.y, player.position.z);

  // Snap avatar directly to the player, facing the look direction.
  selfAvatar.root.position.set(player.position.x, feetY, player.position.z);
  selfAvatar.root.rotation.y = yaw;
  selfAvatar.targetPosition.set(player.position.x, feetY, player.position.z);
  selfAvatar.targetYaw = yaw;
  if (selfAvatar.mixer) selfAvatar.mixer.update(dt);
  selfAvatar.setMoving(movedSq > 0.0001);

  // Corner camera sits behind and above the player, looking along their facing.
  // "Behind" = opposite the look direction.
  const back = 4, up = 2.5;
  cornerCamera.position.set(
    player.position.x - _lookDir.x * back,
    player.position.y + up,
    player.position.z - _lookDir.z * back
  );
  cornerCamera.lookAt(player.position.x, player.position.y - 0.3, player.position.z);
}


// ============================================================
// ---- Mode menu flow: Singleplayer / Multiplayer + avatar ----
// ============================================================
let gameMode = 'singleplayer';   // 'singleplayer' | 'multiplayer'
let mpJoined = false;

const modeMenu = document.getElementById('mode-menu');
const avatarMenu = document.getElementById('avatar-menu');

// Avatar card selection (on the avatar screen).
const avatarCards = document.querySelectorAll('.avatar-card');
avatarCards.forEach((card) => {
  card.addEventListener('click', () => {
    avatarCards.forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    chooseAvatar(card.dataset.avatar);
  });
});

function showAvatarScreen() {
  modeMenu.style.display = 'none';
  avatarMenu.style.display = 'flex';
}

// If the URL already has a ?room= code, this is someone joining a shared
// world — skip the mode menu and go straight to the avatar screen in MP mode.
const viewCode = getViewCode();
if (viewCode) {
  // Spectator mode: load a hosted read-only snapshot and skip all menus.
  gameMode = 'spectator';
  startSpectatorMode(viewCode);
} else if (roomExistsInUrl()) {
  gameMode = 'multiplayer';
  showAvatarScreen();
} else {
  document.getElementById('btn-singleplayer').addEventListener('click', () => {
    gameMode = 'singleplayer';
    showAvatarScreen();
  });
  document.getElementById('btn-multiplayer').addEventListener('click', () => {
    gameMode = 'multiplayer';
    // Put the room code in the URL so it's shareable.
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomCode);
    window.history.replaceState({}, '', url);
    showAvatarScreen();
  });
}

// Load a hosted snapshot and enter the world read-only.
async function startSpectatorMode(code) {
  document.getElementById('mode-menu').style.display = 'none';
  const status = document.getElementById('status');
  status.innerHTML = 'Loading hosted world...';
  try {
    const snapshot = await loadHostedWorld(code);
    if (!snapshot) {
      status.innerHTML = 'Hosted world not found.';
      return;
    }
    world.applySnapshot(snapshot);
    player.readOnly = true;        // spectators can't edit
    status.innerHTML = 'VIEWING (read-only)';
    setTimeout(() => { status.innerHTML = ''; }, 4000);
    enterGame();
  } catch (err) {
    console.error('[host] failed to load hosted world:', err);
    status.innerHTML = 'Failed to load hosted world.';
  }
}

// "Play" button on the avatar screen — start the chosen mode.
document.getElementById('btn-play').addEventListener('click', async () => {
  avatarMenu.style.display = 'none';

  if (gameMode === 'multiplayer') {
    // Shared seed: first player sets it (and becomes host), others read it.
    let amCreator = false;
    try {
      const seed = await resolveSharedSeed(world.params.seed);
      amCreator = isHost;
      if (seed !== world.params.seed) {
        world.setSeed(seed);
      }
    } catch (err) {
      console.error('[mp] seed resolve failed, using local seed:', err);
    }
    setupMultiplayerHost(false); // hide singleplayer host button in MP

    // If we CREATED the room (we're the host), show the share screen first.
    // Joiners (who read an existing seed) are not host, so they skip it.
    if (amCreator) {
      showShareScreen();
      return; // wait for "Start Playing"
    }
  } else {
    setupMultiplayerHost(true); // singleplayer: show Host button
  }

  enterGame();
});

function enterGame() {
  document.getElementById('overlay').style.visibility = 'visible';
}

// --- Share screen (room creators) ---
function showShareScreen() {
  const shareMenu = document.getElementById('share-menu');
  const input = document.getElementById('share-link-input');
  input.value = window.location.href; // already has ?room=XXXX
  shareMenu.style.display = 'flex';

  document.getElementById('copy-link-btn').onclick = () => {
    input.select();
    navigator.clipboard?.writeText(input.value);
    const btn = document.getElementById('copy-link-btn').querySelector('.menu-btn-title');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };

  document.getElementById('start-playing-btn').onclick = () => {
    shareMenu.style.display = 'none';
    enterGame();
  };
}

// Join the multiplayer room the first time the player locks in (starts playing).
player.controls.addEventListener('lock', () => {
  if (gameMode === 'multiplayer' && !mpJoined) {
    mpJoined = true;
    initMultiplayer(scene, world, player);
    // Show the Close Room button only for the host.
    if (isHost) {
      const btn = document.getElementById('close-room-btn');
      btn.style.display = 'block';
      btn.onclick = () => {
        if (confirm('Close this room for everyone?')) {
          closeRoom();
          window.location.href = window.location.origin; // back to menu
        }
      };
    }
  }
});

// If the room gets closed (by host) while we're in it, return to the menu.
setOnRoomClosed(() => {
  alert('The room was closed by the host.');
  window.location.href = window.location.origin;
});

// Host button (singleplayer read-only sharing) is wired in setupHostButton().
function setupMultiplayerHost(showHost) {
  const hostBtn = document.getElementById('host-btn');
  if (showHost) {
    hostBtn.style.display = 'block';
    setupHostButton();
  } else {
    hostBtn.style.display = 'none';
  }
}

// Real read-only hosting (Stage 3).
let hostWired = false;
function setupHostButton() {
  if (hostWired) return;
  hostWired = true;
  const hostBtn = document.getElementById('host-btn');
  const popup = document.getElementById('share-popup');

  hostBtn.addEventListener('click', async () => {
    const existing = getMyHostCode();
    // If we've hosted before, ask whether to update or make new.
    let updateExisting = false;
    if (existing) {
      updateExisting = confirm(
        'You already have a hosted world.\n\nOK = update that existing link\nCancel = create a new link'
      );
    }

    popup.style.display = 'block';
    popup.innerHTML = 'Publishing world...';
    try {
      const snapshot = world.getSnapshot();
      const code = await hostWorld(snapshot, updateExisting);
      const link = `${window.location.origin}${window.location.pathname}?view=${code}`;
      popup.innerHTML =
        '<b>Read-only world published!</b><br>' +
        'Anyone with this link can view (not edit):<br>' +
        `<a href="${link}" target="_blank">${link}</a><br>` +
        '<button id="copy-host-link">Copy link</button>';
      document.getElementById('copy-host-link').onclick = () => {
        navigator.clipboard?.writeText(link);
        document.getElementById('copy-host-link').textContent = 'Copied!';
      };
    } catch (err) {
      console.error('[host] publish failed:', err);
      popup.innerHTML = 'Failed to publish world.';
    }
  });
}

// ---- Settings menu ----
const settingsGear = document.getElementById('settings-gear');
const settingsPanel = document.getElementById('settings-panel');

// Show the gear once the player starts playing.
player.controls.addEventListener('lock', () => {
  settingsGear.style.display = 'block';
});

settingsGear.addEventListener('click', () => {
  const open = settingsPanel.style.display === 'block';
  settingsPanel.style.display = open ? 'none' : 'block';
  // Opening settings requires the mouse, so unlock pointer while it's open.
  if (!open && player.controls.isLocked) player.controls.unlock();
});
document.getElementById('settings-close').addEventListener('click', () => {
  settingsPanel.style.display = 'none';
});

// Sound volume + mute.
document.getElementById('set-volume').addEventListener('input', (e) => {
  sounds.masterVolume = e.target.value / 100;
});
document.getElementById('set-mute').addEventListener('change', (e) => {
  sounds.enabled = !e.target.checked;
});

// Day/night pause + time.
document.getElementById('set-daynight-pause').addEventListener('change', (e) => {
  dayNightPaused = e.target.checked;
});
document.getElementById('set-time').addEventListener('input', (e) => {
  dayTime = (e.target.value / 100) * DAY_LENGTH;
});

// Field of view.
document.getElementById('set-fov').addEventListener('input', (e) => {
  player.camera.fov = Number(e.target.value);
  player.camera.updateProjectionMatrix();
});

// Mouse sensitivity (PointerLockControls.pointerSpeed).
document.getElementById('set-sensitivity').addEventListener('input', (e) => {
  player.controls.pointerSpeed = e.target.value / 100;
});

animate();

// ============================================================
// ---- AI Builder ----
// ============================================================
const BUILDER_API_URL = 'https://minecraft-ai-builder.trentnoland5678.workers.dev';

// Tracks the most recent build so it can be undone.
// Each entry: { x, y, z, prevId } — prevId is what was there before (0 = empty).
let lastBuild = null;

// Finds the Y of the topmost solid block in column (x, z), scanning down from startY.
function findGroundY(x, z, startY) {
  for (let y = startY; y >= 0; y--) {
    const block = world.getBlock(x, y, z);
    if (block && block.id !== 0) return y;
  }
  return 0;
}

// Computes the world-space anchor (x, z) for a build:
// where the player is looking if they're targeting a block, otherwise
// a few blocks ahead of the player along their view direction.
function getBuildAnchor() {
  if (player.selectedCoords) {
    return {
      x: Math.round(player.selectedCoords.x),
      z: Math.round(player.selectedCoords.z)
    };
  }
  // Fall back to ~6 blocks in front of the player along view direction.
  const dir = new THREE.Vector3();
  player.camera.getWorldDirection(dir);
  dir.y = 0;
  dir.normalize();
  return {
    x: Math.round(player.position.x + dir.x * 6),
    z: Math.round(player.position.z + dir.z * 6)
  };
}

// The anchor and ground level used for the LAST build, so that a follow-up
// edit maps the AI's coordinates back onto the same world positions.
let lastAnchor = null;     // { x, z }
let lastGroundLevel = null; // number

// Persistent set of world positions that the AI has placed blocks at.
// This is how we tell a built STRUCTURE apart from natural terrain: only
// these count as editable. Key format: "x,y,z".
const aiPlaced = new Set();
const posKey = (x, y, z) => x + ',' + y + ',' + z;

// Scans for an AI-built structure near the build anchor. Only blocks the AI
// itself placed count — natural terrain (grass, trees, hills) is ignored, so
// standing in a field is correctly treated as a fresh BUILD, not an edit.
// Returns { existing: [{x,y,z,id}], anchor, groundLevel }.
function scanExisting() {
  const anchor = getBuildAnchor();
  const ax = anchor.x;
  const az = anchor.z;

  const scanTop = Math.round(player.position.y) + 8;
  const groundLevel = findGroundY(ax, az, scanTop);

  // Look for AI-placed blocks within range of the anchor.
  const R = 12;  // horizontal half-size
  const H = 24;  // vertical range above ground
  const existing = [];
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let h = 1; h <= H; h++) {
        const wx = ax + dx;
        const wy = groundLevel + h;
        const wz = az + dz;
        if (!aiPlaced.has(posKey(wx, wy, wz))) continue; // skip terrain
        const block = world.getBlock(wx, wy, wz);
        if (block && block.id !== 0) {
          // AI frame: x/z offsets from anchor, z centered around 7, y = height.
          existing.push({ x: dx, y: h, z: dz + 7, id: block.id });
        }
      }
    }
  }
  return { existing, anchor, groundLevel };
}

// Places a blueprint. `mode` is 'build' (fresh, recenter + ground-snap) or
// 'edit' (use the same anchor/ground as the scan so coords line up).
// blockId === 0 means DELETE the block at that position.
function buildBlueprint(blueprint, mode, scan, doorList) {
  let ax, az, groundLevel;
  let cX = 0, cZ = 7;

  if (mode === 'edit' && scan) {
    // Reuse the scan's frame exactly so edits align with existing blocks.
    ax = scan.anchor.x;
    az = scan.anchor.z;
    groundLevel = scan.groundLevel;
  } else {
    // Fresh build: recenter the blueprint on the anchor and snap to ground.
    const anchor = getBuildAnchor();
    ax = anchor.x;
    az = anchor.z;

    let minBX = Infinity, maxBX = -Infinity, minBZ = Infinity, maxBZ = -Infinity;
    for (const b of blueprint) {
      if (b.blockId === 0) continue; // ignore deletes when centering
      if (b.x < minBX) minBX = b.x;
      if (b.x > maxBX) maxBX = b.x;
      if (b.z < minBZ) minBZ = b.z;
      if (b.z > maxBZ) maxBZ = b.z;
    }
    cX = isFinite(minBX) ? Math.round((minBX + maxBX) / 2) : 0;
    cZ = isFinite(minBZ) ? Math.round((minBZ + maxBZ) / 2) : 7;

    const scanTop = Math.round(player.position.y) + 8;
    let g = Infinity;
    const footprint = new Set();
    for (const b of blueprint) {
      const wx = ax + (b.x - cX);
      const wz = az + (b.z - cZ);
      const key = wx + ',' + wz;
      if (!footprint.has(key)) {
        footprint.add(key);
        const gg = findGroundY(wx, wz, scanTop);
        if (gg < g) g = gg;
      }
    }
    groundLevel = isFinite(g) ? g : Math.round(player.position.y) - 1;

    // Store the recentre offsets on the blueprint for placement below.
    blueprint = blueprint.map(b => ({ ...b, x: b.x - cX, z: b.z - cZ }));
  }

  // For edits, the AI frame centers z around 7; undo that here.
  const zOffset = (mode === 'edit') ? 7 : 0;

  const record = [];
  for (const b of blueprint) {
    const wx = ax + b.x;
    const wy = groundLevel + b.y;
    const wz = az + (b.z - zOffset);
    if (wy < 1) continue;
    const existing = world.getBlock(wx, wy, wz);
    const prevId = existing ? existing.id : 0;

    if (b.blockId === 0) {
      // delete — only if something is actually there
      if (prevId !== 0) {
        record.push({ x: wx, y: wy, z: wz, prevId });
        world.removeBlock(wx, wy, wz);
        aiPlaced.delete(posKey(wx, wy, wz));
      }
    } else {
      record.push({ x: wx, y: wy, z: wz, prevId });
      world.addBlock(wx, wy, wz, b.blockId);
      aiPlaced.add(posKey(wx, wy, wz));
    }
  }
  lastBuild = record;
  lastAnchor = { x: ax, z: az };
  lastGroundLevel = groundLevel;

  // Place any doors using the SAME coordinate transform as the blocks.
  if (doorList && doorList.length) {
    const zOff = (mode === 'edit') ? 7 : 0;
    for (const d of doorList) {
      const wx = ax + (d.x - cX);
      const wy = groundLevel + d.y;
      const wz = az + ((d.z - cZ) - zOff);
      if (wy < 1) continue;
      placeDoor(wx, wy, wz, d.facing || 'south', 'left', true);
    }
  }

  console.log(`${mode === 'edit' ? 'Edited' : 'Built'} ${record.length} blocks at (${ax}, ${az}), ground ${groundLevel}`);
}

// Undo the most recent build: remove placed blocks, restore overwritten ones.
function undoLastBuild() {
  if (!lastBuild || lastBuild.length === 0) {
    showToast('Nothing to undo');
    return;
  }
  for (const r of lastBuild) {
    world.removeBlock(r.x, r.y, r.z);
    aiPlaced.delete(posKey(r.x, r.y, r.z));
    if (r.prevId && r.prevId !== 0) {
      world.addBlock(r.x, r.y, r.z, r.prevId);
      // If we restored a block that the AI had placed earlier, keep tracking it.
      // (prevId came from the world; only re-track if it was AI-owned before —
      // we can't know for sure, so we leave it untracked, which is safe:
      // worst case that block just won't count as part of the structure.)
    }
  }
  showToast(`Undid ${lastBuild.length} blocks`);
  lastBuild = null;
}

// --- Small toast for feedback ---
function showToast(msg) {
  const t = document.getElementById('status');
  if (t) {
    t.innerHTML = msg;
    setTimeout(() => { if (t.innerHTML === msg) t.innerHTML = ''; }, 2500);
  }
}

// --- Build prompt UI (styled like Minecraft's chat box) ---
const builderUI = document.createElement('div');
builderUI.style.cssText = `
  position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
  z-index: 1000; display: none; align-items: center; gap: 8px;
  background: rgba(0,0,0,0.55); padding: 6px 8px;
  font-family: 'Minecraft', monospace;
`;
builderUI.innerHTML = `
  <input id="ai-build-input" type="text" placeholder="Describe what to build..."
    style="width:320px; padding:6px 8px; border:none; background:rgba(0,0,0,0.5);
           color:#ffffff; font-family:'Minecraft',monospace; font-size:15px; outline:none;" />
  <button id="ai-build-go"
    style="padding:6px 12px; border:2px solid #6e6e6e; background:#7a7a7a; color:#fff;
           font-family:'Minecraft',monospace; font-size:14px; cursor:pointer;">Build</button>
  <span id="ai-build-status" style="color:#e0e0e0; font-size:13px; min-width:60px;"></span>
`;
document.body.appendChild(builderUI);

const buildInput = builderUI.querySelector('#ai-build-input');
const buildGo = builderUI.querySelector('#ai-build-go');
const buildStatus = builderUI.querySelector('#ai-build-status');

let builderOpen = false;
function openBuilder() {
  builderOpen = true;
  builderViewActive = true;
  builderUI.style.display = 'flex';
  // Suppress the start menu while typing: flag debugCamera so the unlock
  // handler doesn't show the overlay, then unlock for typing.
  player.debugCamera = true;
  if (player.controls.isLocked) player.controls.unlock();
  buildInput.focus();
}
function closeBuilder() {
  builderOpen = false;
  builderViewActive = false;
  builderUI.style.display = 'none';
  buildInput.value = '';
  buildStatus.textContent = '';
  player.debugCamera = false;
  // Re-lock straight back into the world.
  if (!player.controls.isLocked) {
    try { player.controls.lock(); } catch (e) {}
  }
}

async function runBuild() {
  const prompt = buildInput.value.trim();
  if (!prompt) return;
  buildGo.disabled = true;

  // Animate "Working", "Working.", "Working..", "Working..." in a loop.
  let dots = 0;
  buildStatus.textContent = 'Working';
  const workingAnim = setInterval(() => {
    dots = (dots + 1) % 4;
    buildStatus.textContent = 'Working' + '.'.repeat(dots);
  }, 400);

  try {
    // Scan for an existing structure near the build anchor. If blocks are
    // found, we're editing; otherwise it's a fresh build.
    const scan = scanExisting();
    const isEdit = scan.existing.length > 0;

    const res = await fetch(BUILDER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        existing: isEdit ? scan.existing : []
      })
    });
    const data = await res.json();
    if (data.error) {
      // A 502/503 or "overloaded/unavailable" means Gemini is under heavy load,
      // not a real failure — show a friendly message instead of "Error".
      const detail = (data.detail || '') + ' ' + (data.error || '');
      const highDemand = res.status === 502 || res.status === 503 ||
        /overload|unavailable|503|429|rate/i.test(detail);
      buildStatus.textContent = highDemand ? 'High demand — try again' : 'Error';
      console.error('Builder error:', data);
    } else if ((data.blocks && data.blocks.length) || (data.doors && data.doors.length)) {
      buildBlueprint(data.blocks || [], isEdit ? 'edit' : 'build', scan, data.doors || []);
      const verb = isEdit ? 'Edited' : 'Built';
      const n = (data.blocks ? data.blocks.length : 0) + (data.doors ? data.doors.length : 0);
      buildStatus.textContent = `${verb} ${n}!`;
      setTimeout(closeBuilder, 1000);
    } else {
      buildStatus.textContent = 'Nothing built';
    }
  } catch (err) {
    buildStatus.textContent = 'High demand — try again';
    console.error(err);
  } finally {
    // Always stop the dot animation once the build finishes or errors.
    clearInterval(workingAnim);
  }
  buildGo.disabled = false;
}

buildGo.addEventListener('click', runBuild);
buildInput.addEventListener('keydown', (ev) => {
  ev.stopPropagation();
  if (ev.key === 'Enter') runBuild();
  if (ev.key === 'Escape') closeBuilder();
});

// Press B to open the builder; N to undo last build.
document.addEventListener('keydown', (ev) => {
  if (ev.code === 'KeyB' && !builderOpen && player.controls.isLocked) {
    if (player.readOnly) return;   // spectators can't AI-build
    ev.preventDefault();
    openBuilder();
  }
  if (ev.code === 'KeyN' && !builderOpen && player.controls.isLocked) {
    ev.preventDefault();
    undoLastBuild();
  }
});
