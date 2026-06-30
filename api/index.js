// Cloudflare Worker — Minecraft AI Builder proxy
// Builds NEW structures and EDITS existing ones.
// Receives a prompt plus an optional snapshot of nearby blocks, asks Gemini
// for blocks to add/remove, returns validated JSON. API key stays server-side.

const BLOCK_IDS = {
  grass: 1, dirt: 2, stone: 3, coal_ore: 4, iron_ore: 5,
  wood: 6, leaves: 7, sand: 8, snow: 10, jungle_wood: 11,
  jungle_leaves: 12, cactus: 13,
  glass: 15, planks: 16, glowstone: 17, pumpkin: 18,
  red_flower: 19, yellow_flower: 20, red_mushroom: 21, brown_mushroom: 22,
  melon: 23, cobblestone: 24
};
// Reverse map: id -> name, for describing the existing structure to the AI.
const ID_TO_NAME = {};
for (const [name, id] of Object.entries(BLOCK_IDS)) ID_TO_NAME[id] = name;

const MODEL = 'gemini-3.1-flash-lite';

const SYSTEM_PROMPT = `You are an expert builder for a voxel game like Minecraft. You either BUILD a new structure or EDIT an existing one, depending on what the user asks and what already exists near them.

OUTPUT FORMAT
Respond with ONLY a JSON object, no markdown, no prose, no code fences:
{"blocks":[{"x":int,"y":int,"z":int,"block":string}]}
Each entry places a block. To DELETE a block at a position, use the special value "air":
{"x":int,"y":int,"z":int,"block":"air"}

COORDINATE SYSTEM
All coordinates are integer OFFSETS from the player at (0,0,0).
- x = left(-) to right(+)
- y = vertical. y=1 is the first layer resting ON the ground. Build upward (y=1,2,3...). NEVER use y less than 1. You cannot delete the ground at y=0.
- z = depth. Structures sit in FRONT of the player. Center around z=7, roughly z=2 to z=12.
The player approaches from the FRONT (smallest z). Entrances go on the front face.

BLOCK PALETTE (use these exact strings)
- stone: gray, sturdy. Walls, castles, towers, foundations, paths.
- wood: brown log with rings on ends. Cabins, frames, trunks, fences, pillars.
- leaves: solid green, leafy. Foliage, tree canopies, hedges. NOT transparent — never use as glass/windows.
- grass: green top, dirt sides. Ground/lawn.
- dirt: plain brown. Underground, paths, filler.
- sand: pale tan. Deserts, beaches, light floors.
- snow: white top. Snowy roofs, winter builds, white accents.
- coal_ore (dark speckled), iron_ore (tan speckled): stone family; add texture/detail to stone builds.
- cactus: green, spiky. Desert plants only.
- jungle_wood (darker log), jungle_leaves (lush green): jungle/tropical builds.
- glass: TRANSPARENT — real see-through windows. Use for windows, greenhouses, skylights.
- planks: smooth flat wood. Floors, walls, decks, refined wooden builds (cleaner than rough logs).
- glowstone: glowing yellow block. Lighting, lamps, accents, magical builds.
- pumpkin: orange pumpkin. Farms, decoration, autumn scenes, jack-o-lantern builds.
- red_flower, yellow_flower: small flowers (sit on the ground, 1 block). Gardens, decoration, meadows.
- red_mushroom, brown_mushroom: small mushrooms (sit on the ground, 1 block). Forest floors, decoration.
- melon: green-striped melon block with red interior on top. Farms, jungle builds, food displays.
- cobblestone: rough gray cobbles. Paths, rustic walls, castle foundations, dungeon-style builds.
- air: SPECIAL — deletes the block at that position. Use only when editing/removing.

MODE
- If NO existing structure is provided, BUILD the requested thing fresh. Ignore "air".
- If an existing structure IS provided (a list of blocks already near the player), the user most likely wants to MODIFY it. Read those blocks to understand the current shape, then output ONLY the changes needed:
  * To ADD to it (a roof, a tower, battlements, windows, a wall around it), output the new blocks at the right coordinates so they connect to what's there.
  * To REMOVE part of it, output "air" at those positions.
  * Leave unchanged blocks OUT of your output entirely — only return what changes.
  * Match the existing materials and alignment so the edit looks intentional.

HOW TO BUILD WELL
1. PLAN FIRST internally: footprint, height, shape; what makes it recognizable.
2. SCALE: houses ~5-7 wide, 4-6 tall; towers ~5 wide, 10-15 tall; trees ~6-9 tall. Fill the space.
3. STRUCTURE: closed, connected walls; roofs supported by walls; no floating blocks except leaf canopies.
4. ENTRANCE (any enclosed building): a 1-wide, 2-tall doorway (y=1 AND y=2) in the front wall — just leave those out.
5. INTERIORS: hollow and enterable; windows are small GAPS (no transparent block exists).
6. DETAIL: battlements, layered roofs, ore accents, symmetry.
7. MATERIALS: fit the theme; mix 2-3 for interest.

CONSTRAINTS
- Total output under 600 blocks.
- Keep coordinates within 18 of origin.

Return ONLY the JSON object.`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const prompt = (body.prompt || '').toString().slice(0, 500);
    if (!prompt.trim()) {
      return json({ error: 'Empty prompt' }, 400);
    }

    // Optional: existing blocks near the player, already as offsets from anchor.
    // Format from client: [{x,y,z,id}], we convert ids to names for the AI.
    const existing = Array.isArray(body.existing) ? body.existing : [];

    let userMessage = `Request: "${prompt}"`;
    if (existing.length > 0) {
      // Describe the existing structure compactly as name@(x,y,z).
      const described = existing
        .slice(0, 800) // hard cap so the prompt can't blow up
        .map(b => {
          const name = ID_TO_NAME[b.id];
          if (!name) return null;
          return `${name}@(${b.x},${b.y},${b.z})`;
        })
        .filter(Boolean)
        .join(' ');
      userMessage += `\n\nExisting structure near the player (block@(x,y,z)):\n${described}\n\nModify it according to the request. Output ONLY the blocks that change (new blocks, or "air" to delete).`;
    }

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
              temperature: 0.85,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingLevel: 'medium' }
            }
          })
        }
      );

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        return json({ error: 'Gemini request failed', detail: errText }, 502);
      }

      const data = await geminiRes.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.replace(/```json|```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return json({ error: 'AI returned unparseable output', raw: cleaned.slice(0, 500) }, 502);
      }

      const isEdit = existing.length > 0;

      // Build output. blockId === 0 means "delete" (air).
      let out = [];
      const seen = new Set();
      for (const b of (parsed.blocks || [])) {
        if (typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') continue;
        const x = Math.round(b.x), y = Math.round(b.y), z = Math.round(b.z);
        if (y < 1) continue;

        let blockId;
        if (b.block === 'air') {
          blockId = 0; // delete marker
        } else {
          blockId = BLOCK_IDS[b.block];
          if (blockId === undefined) continue;
        }

        const key = x + ',' + y + ',' + z;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x, y, z, blockId });
        if (out.length >= 600) break;
      }

      // Only guarantee a doorway on fresh builds, not edits (edits may
      // intentionally not be enclosed buildings).
      if (!isEdit) {
        out = ensureDoorway(out);
      }

      return json({ blocks: out });
    } catch (err) {
      return json({ error: 'Worker error', detail: String(err) }, 500);
    }
  }
};

// Carve a 1-wide, 2-tall doorway in the front wall (smallest z) if this looks
// like an enclosed building. Operates on a single (x,z) column.
function ensureDoorway(blocks) {
  // Only consider solid (non-delete) blocks.
  const solid = blocks.filter(b => b.blockId !== 0);
  if (solid.length < 12) return blocks;

  const occupied = new Set();
  for (const b of solid) occupied.add(b.x + ',' + b.y + ',' + b.z);
  const has = (x, y, z) => occupied.has(x + ',' + y + ',' + z);

  let minZ = Infinity;
  for (const b of solid) if (b.z < minZ) minZ = b.z;

  const candidates = [];
  for (const b of solid) {
    if (b.z === minZ && b.y === 1 && has(b.x, 2, b.z)) {
      candidates.push({ x: b.x, z: b.z });
    }
  }
  if (candidates.length === 0) return blocks;

  const centerX = candidates.reduce((a, c) => a + c.x, 0) / candidates.length;
  let door = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c.x - centerX);
    if (d < bestDist) { bestDist = d; door = c; }
  }

  return blocks.filter(b =>
    !(b.x === door.x && b.z === door.z && (b.y === 1 || b.y === 2) && b.blockId !== 0)
  );
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
