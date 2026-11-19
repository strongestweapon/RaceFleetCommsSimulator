import { DEFAULTS, makeScene, normalize, rng, simulate } from '../engine.js';

const seeds = Array.from({ length: 5 }, (_, index) => DEFAULTS.seed + 104729 * index);
const scenarios = ['균일 격자', '핀마크 쪽 스타트 밀집', '첫 업윈드 좌우 갈림', '먼 풍상 마크 회항'];

function raceLayout(config, scenario) {
  const scene = makeScene(config);

  // Synthetic stress scenes. These coordinates are not digitized race tracks.
  // All scenes share the same nominal 100-boat start line and receiver.
  const startWidth = config.boats * 4.24 * 1.5;
  const rc = scene.nodes[scene.startLine.rcId];
  rc.x = startWidth / 2;
  scene.startLine.pin.x = -rc.x;
  if (!scenario) return scene;

  const random = rng(config.seed ^ 0x19bd4);
  const boats = scene.nodes.slice(0, config.boats);
  for (let i = boats.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [boats[i], boats[j]] = [boats[j], boats[i]];
  }

  for (const [index, boat] of boats.entries()) {
    const dx = random() - 0.5;
    const dy = random() - 0.5;
    if (scenario === 1) {
      // Three staggered rows at the favoured pin, with a thinner line toward RC.
      const dense = index < 60;
      const row = index % 3;
      boat.x = (dense ? -310 + Math.floor(index / 3) * 9 : -128 + (index - 60) * 11) + dx * 3;
      boat.y = -6 - (dense ? row * 8 : (index % 2) * 6) + dy * 3;
    } else if (scenario === 2) {
      // Two broad tack corridors separated by a sparser patch of water.
      const side = index < 50 ? -1 : 1;
      const station = index % 50;
      boat.x = side * (125 + station * 7.5) + dx * 110;
      boat.y = 390 + station * 9 + dy * 190;
    } else {
      // Dense approach to M1 with a small tail still climbing the beat.
      const station = index % 80;
      boat.x = (index < 80 ? (station % 10 - 4.5) * 12 : -360 + (index - 80) * 13) + dx * 7;
      boat.y = (index < 80 ? 1140 + Math.floor(station / 10) * 12 : 690 + (index - 80) * 17) + dy * 9;
    }
  }
  return scene;
}

function geometry(scene, count) {
  const nodes = scene.nodes.slice(0, count);
  const rc = scene.nodes[scene.startLine.rcId];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const nearest = nodes.map(a => Math.min(...nodes.filter(b => a !== b).map(b => distance(a, b))));
  return {
    meanNearestM: nearest.reduce((a, b) => a + b, 0) / count,
    maxRcM: Math.max(...nodes.map(boat => distance(boat, rc))),
  };
}

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const range = values => [Math.min(...values), Math.max(...values)];
const comparison = scenarios.map((name, index) => {
  const runs = seeds.map(seed => {
    const config = normalize({ ...DEFAULTS, layout: 'spread', seed, speed: 0, antennaShadow: 0, boatHeight: 1.2, boatHeightSpread: 0, waveHeight: 0 });
    const scene = raceLayout(config, index);
    const ble = simulate(config, 'ble', scene);
    const lora = simulate(config, 'lora', scene);
    const loraSingleChannel = simulate({ ...config, channels: 1 }, 'lora', scene);
    if (ble.capped || lora.capped || loraSingleChannel.capped) throw new Error(`Evaluation capped for ${name}, seed ${seed}`);
    return { seed, ...geometry(scene, config.boats), ble: ble.pdr, lora: lora.pdr,
      loraSingleChannel: loraSingleChannel.pdr,
      bleDisconnected: ble.disconnected, loraDisconnected: lora.disconnected,
      bleGapSeconds: ble.longestGap, loraGapSeconds: lora.longestGap };
  });
  return { scenario: name,
    nearestM: Math.round(mean(runs.map(r => r.meanNearestM))),
    farthestRcM: range(runs.map(r => Math.round(r.maxRcM))),
    blePct: range(runs.map(r => +(r.ble * 100).toFixed(1))),
    loraPct: range(runs.map(r => +(r.lora * 100).toFixed(1))),
    loraSingleChannelPct: range(runs.map(r => +(r.loraSingleChannel * 100).toFixed(1))),
    bleDisconnected: range(runs.map(r => r.bleDisconnected)),
    loraDisconnected: range(runs.map(r => r.loraDisconnected)),
    runs };
});
console.log(JSON.stringify({ seeds, comparison }, null, 2));
