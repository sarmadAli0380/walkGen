// Static payload for describe_ontology — lets any client orient itself before
// calling anything else.
export const ONTOLOGY = {
  entities: [
    {
      name: "Photo",
      description: "A source room image",
      key_fields: ["source (local path or http(s) URL)", "room_label (optional)"],
    },
    {
      name: "MotionPreset",
      description:
        "A named shot style (prompt text only). kind:'room' presets encode what a professional videographer would shoot for that room type (preferred); kind:'camera' presets are explicit moves.",
      key_fields: ["key", "kind (room | camera)", "prompt", "reliability_note"],
    },
    {
      name: "Clip",
      description: "One generated video segment",
      key_fields: [
        "clip_id", "status", "photo_source", "motion", "duration",
        "model", "room_label", "created_at", "local_path (once downloaded)",
      ],
    },
    {
      name: "Walkthrough",
      description: "The final stitched video",
      key_fields: ["clips (ordered)", "transition", "output.path"],
    },
  ],
  relationships: [
    "A Clip is generated FROM exactly one Photo, USING exactly one MotionPreset (or a custom prompt).",
    "A Walkthrough is an ordered sequence of Clips. Only Clips in 'succeeded' state are eligible.",
    "clip_id IS the Replicate prediction ID — there is no second ID system. The filesystem is the registry.",
  ],
  clip_lifecycle: [
    "generate_clip -> processing",
    "processing --check_clip--> succeeded (downloaded to storage/clips/{clip_id}.mp4; eligible for stitch_walkthrough)",
    "processing --check_clip--> failed (with error; safe to retry generate_clip)",
    "processing --cancel_clip--> failed (canceled)",
  ],
  tools: [
    { name: "describe_ontology", reads: [], writes: [], note: "this document" },
    { name: "list_motion_presets", reads: ["MotionPreset"], writes: [] },
    { name: "list_clips", reads: ["Clip"], writes: [], note: "reads sidecars; no network" },
    { name: "generate_clip", reads: ["Photo", "MotionPreset"], writes: ["Clip"], note: "submits; returns immediately" },
    { name: "check_clip", reads: ["Clip"], writes: ["Clip"], note: "batch; disk-first; downloads on success" },
    { name: "cancel_clip", reads: ["Clip"], writes: ["Clip"] },
    { name: "stitch_walkthrough", reads: ["Clip"], writes: ["Walkthrough"] },
  ],
};
