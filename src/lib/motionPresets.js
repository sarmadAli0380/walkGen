// Preset prompt text — v2, tuned across two real iterations (M6):
//   v0 "slow cinematic, static scene"  -> read as an animated slideshow (dead)
//   v1 "handheld phone, natural sway"  -> alive but amateur (visible shake)
//   v2 (this file)                     -> professional gimbal/steadicam language:
//        constant deliberate motion, perfectly stabilized — how real estate
//        videographers actually shoot.
// Two kinds of preset:
//   kind: "room"   — say what the room IS; bundles the move a professional
//                    would choose for that room type (preferred interface).
//   kind: "camera" — explicit camera moves for callers who want direct control.
// Presets are prompt text only (no native camera_control on the Replicate
// wrapper), so adherence is strong but not guaranteed.

export const DEFAULT_NEGATIVE_PROMPT =
  "static camera, still image, slideshow, frozen scene, shaky camera, handheld shake, camera wobble, distortion, warping, people, flickering";

const STYLE =
  "perfectly stabilized smooth gimbal movement, professional luxury real estate cinematography, realistic lighting, no people visible";

export const PRESETS = {
  // ---- room-type presets: the shot a professional would pick ----
  hallway: {
    kind: "room",
    prompt: `Camera glides forward down the center of the hallway at a slow walking pace, following the leading lines toward the door, ${STYLE}`,
    reliability_note: "corridors are ideal gimbal shots — very reliable",
  },
  living_room: {
    kind: "room",
    prompt: `Slow lateral gimbal glide across the living room, gracefully revealing the seating area and ending on the room's hero feature such as the view or fireplace, ${STYLE}`,
    reliability_note: "reliable; ends on the hero feature",
  },
  kitchen: {
    kind: "room",
    prompt: `Smooth lateral tracking shot gliding slowly along the kitchen island, keeping counters and cabinetry in frame, ${STYLE}`,
    reliability_note: "reliable; the classic kitchen shot",
  },
  bedroom: {
    kind: "room",
    prompt: `Soft slow gimbal push from the doorway into the bedroom, moving gently toward the bed and the natural light from the windows, ${STYLE}`,
    reliability_note: "reliable",
  },
  bathroom: {
    kind: "room",
    prompt: `Short slow push-in revealing the bathroom finishes, ${STYLE}`,
    reliability_note: "keep expectations modest in small rooms; mirrors can artifact",
  },
  exterior: {
    kind: "room",
    prompt: `Slow establishing shot gliding gently toward the home's facade, gradually revealing the property, ${STYLE}`,
    reliability_note: "reliable for establishing shots",
  },
  outdoor: {
    kind: "room",
    prompt: `Smooth walking-pace gimbal glide through the outdoor space toward the view, immersive and steady, ${STYLE}`,
    reliability_note: "the style that tested best — genuine moving-through feel",
  },

  // ---- explicit camera-move presets ----
  push_in: {
    kind: "camera",
    prompt: `Smooth gimbal push forward into the room, slow deliberate floating movement, ${STYLE}`,
    reliability_note: "reliable — reads as gliding in, not a zoom",
  },
  pull_out: {
    kind: "camera",
    prompt: `Smooth gimbal pull backward, slowly revealing more of the room, ${STYLE}`,
    reliability_note: "reliable",
  },
  pan_left_right: {
    kind: "camera",
    prompt: `Smooth gimbal movement traveling from the left side of the room to the right, slow and deliberate, ${STYLE}`,
    reliability_note: "usually good; watch frame edges",
  },
  pan_right_left: {
    kind: "camera",
    prompt: `Smooth gimbal movement traveling from the right side of the room to the left, slow and deliberate, ${STYLE}`,
    reliability_note: "usually good; watch frame edges",
  },
  dolly_forward: {
    kind: "camera",
    prompt: `Smooth walking-pace gimbal glide moving deeper into the space, immersive and perfectly steady, ${STYLE}`,
    reliability_note: "the strongest camera preset",
  },
  orbit: {
    kind: "camera",
    prompt: `Smooth gimbal arc sideways around the center of the room while facing it, consistent room geometry, ${STYLE}`,
    reliability_note: "LEAST reliable — invents unseen geometry indoors; prefer a room preset",
  },
};

export const PRESET_KEYS = Object.keys(PRESETS);

// The professional shot-grammar: which preset a videographer would reach for.
export const SHOT_GUIDE = {
  "entry / hallway / corridor": "hallway",
  "living room / lounge / tv area": "living_room",
  "kitchen / kitchenette": "kitchen",
  "bedroom": "bedroom",
  "bathroom": "bathroom",
  "exterior / facade / establishing": "exterior",
  "patio / balcony / pool / outdoor amenity": "outdoor",
};
