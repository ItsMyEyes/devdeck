# Kantor AI exterior port

Approved source: kangkungmozzarella/kantor-ai, commit 1bc084b682519c8a436ac255b205d77e6618e696, public/office.js exterior and animation block. User approved replacing both old environments in all three views. Keep moving traffic on Low (8 vehicles); High/Balanced 20. Preserve 64 buildings, 12 clouds, 8 birds, seeded trees, road/vehicle geometry and colors. Uniformly fit the exterior around both floors/lounges with 4-unit clearance. Preserve the agent interior and operational truth. Use installed Three.js; retain source MIT notice. No backend/dependency/CDN changes.

1. Build a pure deterministic city layout, placement transform and active-time animation model with tests for geometry exclusion, lanes, wrap, quality, reduced motion and hide/resume.
2. Render shared/instanced city geometry and moving vehicles/clouds/birds. Integrate all views, warm reference palette, clipping range, no environment preference, continuous rendering even with no agents.
3. Compare native screenshots against pinned reference. Check all views/time periods/themes, empty/reduced/hidden states. Measure M3/8GB, 1400x900, warmup5s then3x30s per working/idle/mixed; every5s >=30fps, up to20+20 actors and camera interaction.
4. Run workspace/full frontend suite, typecheck and production build; one fresh final review, fix important findings, retain evidence and commit locally on the existing feature branch.
