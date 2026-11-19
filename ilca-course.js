export const ILCA_LAYOUTS = Object.freeze(['ilcaStart', 'ilcaBeat', 'ilcaMark', 'ilcaDownwind', 'ilcaLeeward']);
export const ILCA_LEEWARD_OFFSET = Math.round(0.05 * 1852);
const HULL_LENGTH = 4.24;

// ILCA Race Management Policies (January 2025), §§6.5–6.6 and 7.2.
export function ilcaCourse(config) {
  const y = config.leewardOffset ?? ILCA_LEEWARD_OFFSET;
  const halfGate = HULL_LENGTH * 10 / 2;
  return { halfLine: config.boats * HULL_LENGTH * 1.5 / 2,
    windward: { x: 0, y: config.legLength, label: 'M1' },
    leeward: { x: 0, y, marks: [
      { x: -halfGate, y, label: '3S' },
      { x: halfGate, y, label: '3P' }
    ] } };
}

// Sample race-shaped fleets inspired by the UK Nationals replays. Values below
// describe synthetic distributions and do not represent measured track points.
export function ilcaBoats(config, course, uniform, normal) {
  const boats = [];
  for (let id = 0; id < config.boats; id++) {
    let bestPoint, bestClearance = -1;
    // Keep both branches represented even in small fleets and lopsided samples.
    const gateSide = id === 0 ? -1 : id === 1 ? 1 : undefined;
    // Prefer a little initial clearance and cap attempts in crowded setups.
    for (let attempt = 0; attempt < 80; attempt++) {
      const point = sampleBoat(config, course, uniform, normal, gateSide);
      let clearance = Infinity;
      for (const boat of boats) clearance = Math.min(clearance, Math.hypot(boat.x - point.x, boat.y - point.y));
      if (clearance > bestClearance) { bestPoint = point; bestClearance = clearance; }
      if (clearance >= 2.5) break;
    }
    boats.push(bestPoint);
  }
  return boats;
}

function sampleBoat(c, { halfLine, windward, leeward }, random, noise, gateSide) {
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

  const runLength = L - leeward.y;
  const lane = (random() < 0.58 ? -1 : 1) * spread * (0.24 + random() * 0.32);
  gateSide = gateSide ?? Math.sign(lane);
  const run = [
    { x: lane, y: leeward.y + runLength * 0.68 },
    { x: lane * 0.60, y: leeward.y + runLength * 0.23 }
  ];
  const leeY = leeward.y;
  const mark = leeward.marks[gateSide < 0 ? 0 : 1];
  const entryX = mark.x * (0.22 + 0.42 * random());
  const turnRadius = 8 + 10 * random();
  const turn = [
    { x: entryX, y: leeY + 16 },
    { x: entryX, y: leeY },
    { x: mark.x, y: leeY - turnRadius },
    { x: mark.x + gateSide * turnRadius, y: leeY - 4 },
    { x: mark.x + gateSide * (32 + 50 * random()), y: leeY + 42 + 50 * random() }
  ];

  if (c.layout === 'ilcaDownwind') {
    const progress = Math.max(0.12, Math.min(0.88, 0.52 + noise() * 0.20));
    const y = L - runLength * progress;
    const x = lane * (0.55 + Math.sin(Math.PI * progress) * 0.45) + noise() * 13;
    return routedBoat(x, y, [], run.filter(point => point.y < y - 8), turn, gateSide);
  }

  if (c.layout === 'ilcaLeeward') {
    const inbound = 18 + random() ** 1.5 * Math.min(runLength * 0.34, 95 + spread * 0.18);
    const x = entryX + gateSide * inbound * 0.36 + noise() * 8;
    return routedBoat(x, leeY + inbound, [], [], turn, gateSide);
  }

  // Some boats have already rounded M1. The rest approach from the right.
  const radius = 12;
  if (random() < 0.25) {
    const exitDistance = 16 + random() ** 1.5 * Math.min(runLength * 0.25, 50 + spread * 0.35);
    const x = -radius - exitDistance * 0.55 + noise() * 8;
    const y = L + radius - exitDistance + noise() * 7;
    return routedBoat(x, y, [], run.filter(point => point.y < y - 8), turn, gateSide);
  }
  const inbound = 10 + random() ** 1.85 * Math.min(runLength * 0.4, 90 + spread * 0.47);
  const x = radius + inbound * 0.81 + noise() * (9 + inbound * 0.14);
  const y = L - inbound + noise() * 7;
  const approach = [{ x: radius, y: L - 4 }, { x: radius, y: L + 8 }, { x: 0, y: L + radius },
    { x: -radius, y: L + 7 }, { x: -radius - 23, y: L - 54 }];
  return routedBoat(x, y, approach, run, turn, gateSide);
}

function routedBoat(x, y, approach, run, turn, gateSide) {
  const courseAhead = [...approach, ...run, ...turn];
  const first = courseAhead[0];
  return {
    x, y, heading: Math.atan2(first.x - x, first.y - y), courseAhead, gateSide,
    windwardExit: approach.length,
    leewardEntry: approach.length + run.length + 1
  };
}

export function routeLength(boat) {
  let length = 0;
  let previous = boat;
  for (const point of boat.courseAhead) {
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return length;
}
