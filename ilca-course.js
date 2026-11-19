export const ILCA_LAYOUTS = Object.freeze(['ilcaStart', 'ilcaBeat', 'ilcaMark']);

// ILCA Race Management Policies, January 2025, §7.2. The leg length is an input.
export function ilcaCourse(config) {
  return { halfLine: config.boats * 4.24 * 1.5 / 2,
    windward: { x: 0, y: config.legLength, label: 'M1' } };
}

// Sample race-shaped fleets inspired by the UK Nationals replays. Values below
// describe synthetic distributions and do not represent measured track points.
export function ilcaBoats(config, course, uniform, normal) {
  const boats = [];
  for (let id = 0; id < config.boats; id++) {
    let bestPoint, bestClearance = -1;
    // Prefer a little initial clearance and cap attempts in crowded setups.
    for (let attempt = 0; attempt < 80; attempt++) {
      const point = sampleBoat(config, course, uniform, normal);
      let clearance = Infinity;
      for (const boat of boats) clearance = Math.min(clearance, Math.hypot(boat.x - point.x, boat.y - point.y));
      if (clearance > bestClearance) { bestPoint = point; bestClearance = clearance; }
      if (clearance >= 2.5) break;
    }
    boats.push(bestPoint);
  }
  return boats;
}

function sampleBoat(c, { halfLine, windward }, random, noise) {
  const L = windward.y;
  const spread = c.spacing * 4.6;
  if (c.layout === 'ilcaStart') {
    // The fleet favours one end, with a thinner band along the rest of the line.
    const x = random() < 0.6
      ? halfLine * Math.max(-0.99, Math.min(0.68, -0.62 + noise() * 0.24))
      : halfLine * (-0.94 + random() * 1.9);
    const y = -3 - random() ** 1.7 * Math.max(15, halfLine * 0.18 + c.spacing * 0.20);
    return { x, y, heading: -0.62 + noise() * 0.17 };
  }

  if (c.layout === 'ilcaBeat') {
    // Unequal, staggered corridors on both sides of the beat.
    const side = random() < 0.60 ? -1 : 1;
    const progress = Math.max(0.18, Math.min(0.91, (side < 0 ? 0.53 : 0.57) + noise() * 0.15));
    const corridor = 0.22 + 0.78 * Math.sin(Math.PI * progress);
    const x = side * spread * (corridor + noise() * 0.27) + noise() * 19;
    const y = L * progress + side * spread * 0.08;
    const sailingSide = random() < 0.68 ? side : -side;
    const heading = sailingSide * (Math.PI / 4 + noise() * 0.06);
    if (random() >= 0.24) return { x, y, heading };

    const leg = 5 + random() * 28;
    const tack = { x: x + Math.sin(heading) * leg, y: y + Math.cos(heading) * leg };
    const next = { x: tack.x - Math.sin(heading) * 70, y: tack.y + Math.cos(heading) * 70 };
    return { x, y, heading, courseAhead: [tack, next] };
  }

  // Some boats are already past M1. The pack and its tail approach from the right.
  const radius = 12;
  if (random() < 0.25) {
    const exitDistance = 16 + random() ** 1.5 * (50 + spread * 0.35);
    return { x: -radius - exitDistance * 0.55 + noise() * 8,
      y: L + radius - exitDistance + noise() * 7, heading: -2.76 + noise() * 0.13 };
  }
  const inbound = 10 + random() ** 1.85 * (90 + spread * 0.47);
  const x = radius + inbound * 0.81 + noise() * (9 + inbound * 0.14);
  const y = L - inbound + noise() * 7;
  const entry = { x: radius, y: L - 4 };
  const courseAhead = [entry, { x: radius, y: L + 8 }, { x: 0, y: L + radius },
    { x: -radius, y: L + 7 }, { x: -radius - 23, y: L - 54 }];
  return { x, y, heading: Math.atan2(entry.x - x, entry.y - y), courseAhead };
}
