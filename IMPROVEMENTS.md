# Ghost Rush gameplay updates

## Changes
- Added moving, pulsing energy mines alongside meteors. The client renderer and authoritative server use the same deterministic mine positions, so multiplayer collisions stay consistent.
- Mine motion becomes more intense on later laps.
- Refined the ghost racer silhouette with a spectral scarf, speed streaks, hood rim, eye highlights, boots, and a chest emblem.
- Kept the existing hold-to-swing controls and lap-based meteor ramp intact.

## Test
Build the frontend from `client/` with `npm ci && npm run build`.
Run the Python backend suite from `server-python/` with
`python -m unittest discover -s tests -v`.

For a release, run a local multiplayer race and verify hazard timing before deploying.


## Spirit points update
- Spirit cores award 100 points each, once per player per race.
- Removed the Dash mechanic and Spirit Energy resource.
- Added a live Spirit Points display and collected-core counter.
- The finish screen counts up to the final point total, including core, shield, checkpoint, time, lap, and placement rewards.
- Kept Shield Relics as a one-hit defensive pickup.
