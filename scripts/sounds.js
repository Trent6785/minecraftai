// Simple sound effects manager. Loads short clips and plays them on demand.
// Files live in public/sounds/. Missing files fail silently (no crash).

class Sounds {
  constructor() {
    this.buffers = {};
    this.enabled = true;
    this.masterVolume = 1.0;
    // Preload by creating Audio elements we can clone for overlapping plays.
    this.sources = {
      place: 'sounds/place.wav',
      break: 'sounds/break.wav',
      step:  'sounds/step.wav',
    };
    this.templates = {};
    for (const [name, url] of Object.entries(this.sources)) {
      const a = new Audio(url);
      a.preload = 'auto';
      // If the file is missing, mark it so we don't keep trying.
      a.addEventListener('error', () => { this.templates[name] = null; });
      this.templates[name] = a;
    }
  }

  /** Play a one-shot sound by name. Overlapping plays are allowed. */
  play(name, volume = 1.0) {
    if (!this.enabled) return;
    const template = this.templates[name];
    if (!template) return;            // missing file — silent
    try {
      // Clone so rapid repeats (e.g. footsteps) can overlap.
      const a = template.cloneNode();
      a.volume = Math.max(0, Math.min(1, volume * this.masterVolume));
      const p = a.play();
      if (p && p.catch) p.catch(() => {}); // ignore autoplay rejections
    } catch (e) {
      // ignore
    }
  }
}

export const sounds = new Sounds();
