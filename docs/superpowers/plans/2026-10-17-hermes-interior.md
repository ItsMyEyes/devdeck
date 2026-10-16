# DevDeck — Hermes-inspired interior implementation

Approved specification: user implementation plan in this chat, continued 2026-10-17. Base 27fcbac; reference Hermes3D beb76292747b816ef317aa6f9a3992e0014f81d9.

## Goal and constraints

Upgrade the warm stylized interior, preserving layout, navigation, furniture contact targets, rig/IK, deterministic identity, existing agent semantics, Kantor AI exterior, both floors and all three views. No backend/API/auth/polling changes or new operational features. No layout editor, audio, extra renderer, new partitions or fabricated work/speech/success.

## Deliverables

1. Shared oak/cream/charcoal/teal/blue/terracotta palette independent of UI theme; deterministic wood, plaster, fabric and metal textures. Local Kenney Furniture Kit 2.0 and Poly Haven Studio Small 09 1K HDR with source/license/version/SHA-256 manifest. Do not redistribute Hermes model/HDR bytes with unverified origin.
2. Fit desk/chair/sofa/coffee table/cabinet/bookshelf/plant/coffee machine/fridge/floor lamp into existing envelopes and preserve all contacts. Retain laptop, held props and child workstations; per-model procedural fallback; instanced shared models; original click destinations.
3. Warm key/cool fill/environment lighting, four local-time periods, contact shading, night emissive lamps and at most two non-shadow local lights per floor. High: textures1024/normal maps/DPR1.5/shadow2048/N8AO half-res and gentle bloom. Balanced:512/normal maps/DPR1.25/shadow1024/no postprocessing. Low:256/no normal maps/environment/local lights/dynamic shadows/DPR1/no postprocessing. Preserve Auto thresholds/cooldown. No DOF, realtime reflection, motion blur or vignette.
4. Refine existing character surfaces and faces; deterministic blink, neutral/focus/attention/error from verified intent; Low/reduced-motion static. Actor names/work labels only on selection/hover/focus; status dots remain. Building retains floor titles and selected/hover details; floor views add non-overlapping zone names. Selection > hover/focus > zone, structure occlusion for zones and leader lines for shifted detail labels.
5. Office-focused initial/reset framing; respect saved cameras/follow. Cache shared resources, mutate transforms without React per-frame updates, clean disposal through floor/quality/mount transitions.

## Verification

- Preserve layout/contact invariants, exercise models failing/late-loading/disposal/batching, material determinism/filtering, label precedence, semantic/static faces, quality transitions and camera persistence.
- Visual evidence: three views × four time periods × two UI themes plus desk/seated/sofa/pantry close-ups. Preserve selection/child routing, reduced motion, WebGL fallback, hidden render/poll suspension and no skipped-motion replay.
- Apple M3/8GB,1400×900,20parents+20children+20vehicles: Auto and High; each working/idle/mixed scenario has5s warmup and3×30s runs, every5s window≥30FPS including zoom/rotation. Low smoke uses8vehicles. State exactly which gates are actually measured.
- Focused workspace tests, complete frontend suite, frontend typecheck and production build. Source/license inventory, screenshots, raw performance and device details retained as evidence.

## Review focus

- Async model failure or completion after unmount must preserve fallback/avoid leaked allocations.
- Rotated/scaled imported furniture must stay inside unchanged navigation footprints and respect seat/keyboard contacts.
- Quality/floor transitions must not leak materials/textures, remount actors, or enable heavy effects on Balanced/Low.
- Dense labels and keyboard focus must retain selection/status access without obstructing scene interactions.
- Hidden/reduced scenes must not acquire a render loop or replay time-dependent environmental/face motion.
