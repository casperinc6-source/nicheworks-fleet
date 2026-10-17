# conway-automoton-survivalbots

An automaton survival ecology inspired by Conway's Game of Life — but the
cells are **bots that fight back**. Zero dependencies, pure Node.js.

## Run

```bash
cd conway-automoton-survivalbots
npm start
```

Open http://localhost:3004

## The ecosystem

| Species | Color | Behavior |
|---|---|---|
| **Hunter** | 🔴 red | chases and eats *any* bot it catches (incl. other hunters) |
| **Forager** | 🟢 green | seeks food pellets near the center spring, flees nothing |
| **Drone**  | 🔵 blue | photosynthetic — drifts, dies only of old age |

Rules: every bot burns energy each tick; eat or starve. Energy > 110 and a
bit of luck → reproduce (energy splits). Energy 0 or old age → death.
Hunters make red dangerous but expensive; foragers are cheap but hunted;
drones persist but never multiply fast.

Watch populations oscillate: red booms crash the greens, red starves,
greens recover — a real predator-prey cycle.

## Structure

- `server.js` — static file server
- `public/index.html` — simulation + UI (controls: Evolve / Tick / Re-seed)
