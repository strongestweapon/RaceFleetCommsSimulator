import { ILCA_LAYOUTS, ILCA_LEEWARD_OFFSET, ilcaCourse, ilcaBoats } from './ilca-course.js';

// Screening model, not a calibrated RF or Bluetooth conformance simulator.
// All time values are seconds, positions metres, power dBm unless noted.
export const MODEL_VERSION = '0.9.0';
export const ENVIRONMENT_STEP = 0.1;
export const DEFAULTS = Object.freeze({
  boats: 100, spacing: 70, layout: 'ilcaBeat', legLength: 1100, leewardOffset: ILCA_LEEWARD_OFFSET, collectors: 1,
  speed: 0, waveHeight: 0, wavePeriod: 4,
  hz: 1, payload: 24, duration: 8, deadline: 1, seed: 20261119,
  power: 8, boatHeight: 0.8, boatHeightSpread: 0.2, receiverHeight: 3, fade: 3, loss: 3,
  antennaShadow: 4, shadowSide: 'stern',
  sf: 7, bw: 500, cr: 5, channels: 2, mac: 'tdma', jitter: 0.3,
  channelSpacing: 1, adjacent: 45,
  relays: 15, ttl: 3, repeats: 1, scan: 100, bleSensitivity: -95,
  capture: 6, queueMs: 300, maxEvents: 600000
});
export const SPACE = Object.freeze({
  boats: [10, 200, 10], spacing: [10, 250, 10], legLength: [400, 2200, 100],
  leewardOffset: [-300, 200, 1],
  speed: [0, 15, 1], waveHeight: [0, 3, 0.25], wavePeriod: [2, 8, 1],
  layout: [...ILCA_LAYOUTS, 'spread', 'start', 'split', 'leader', 'chain'],
  collectors: [1, 3, 1], power: [0, 20, 2],
  boatHeight: [0.4, 3, 0.2], loss: [0, 15, 1],
  boatHeightSpread: [0, 0.3, 0.05], receiverHeight: [0.5, 10, 0.5], antennaShadow: [0, 20, 1],
  shadowSide: ['bow', 'starboard', 'stern', 'port'],
  fade: [0, 10, 1], bleSensitivity: [-110, -85, 1],
  channelSpacing: [0.125, 2, 0.125], adjacent: [0, 80, 5], capture: [0, 20, 1], queueMs: [20, 2000, 20],
  duration: [8, 15, 30],
  hz: [0.5, 1, 2, 5], payload: [8, 16, 24, 32, 48],
  sf: [7, 8, 9, 10, 11, 12], bw: [125, 250, 500], cr: [5, 6, 7, 8],
  channels: [1, 2, 3, 4], mac: ['tdma', 'aloha'], jitter: [0, 0.3, 1, 3, 10],
  relays: [0, 60, 5], ttl: [0, 2, 3, 4, 5], repeats: [1, 2, 3],
  scan: [25, 50, 75, 100]
});
const RANGED = new Set(['boats', 'spacing', 'legLength', 'leewardOffset', 'collectors', 'power', 'boatHeight', 'loss', 'relays', 'speed', 'waveHeight', 'wavePeriod',
  'boatHeightSpread', 'receiverHeight', 'antennaShadow', 'fade', 'bleSensitivity', 'channelSpacing', 'adjacent', 'capture', 'queueMs']);
export const isSliderParameter = key => RANGED.has(key);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function noise(r) { return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r()); }
export function normalize(input = {}) {
  const c = { ...DEFAULTS, ...input };
  for (const key of Object.keys(SPACE)) {
    if (key === 'duration') continue; // Public engine also supports custom durations in 2–30 s.
    const v = SPACE[key];
    if (RANGED.has(key)) {
      const number = Number(c[key]);
      c[key] = clamp(Number.isFinite(number) ? number : DEFAULTS[key], v[0], v[1]);
    }
    else if (!v.includes(c[key])) c[key] = DEFAULTS[key];
  }
  c.boats = Math.round(c.boats); c.collectors = Math.round(c.collectors);
  c.duration = clamp(Number(c.duration) || 8, 2, 30);
  c.deadline = clamp(Number(c.deadline) || 1, 0.1, 5);
  c.seed = Number(c.seed) >>> 0;
  return c;
}
export function loraAirtime({ sf = 7, bw = 500, cr = 5, payload = 24, implicit = true, crc = true, preamble = 8 }) {
  const ts = 2 ** sf / (bw * 1000), de = ts >= 0.016 ? 1 : 0;
  const symbols = 8 + Math.max(0, Math.ceil((8 * payload - 4 * sf + 28 + (crc ? 16 : 0) - (implicit ? 20 : 0)) / (4 * (sf - 2 * de))) * cr);
  return (preamble + 4.25 + symbols) * ts;
}
export function bleSegments(payload) {
  // Vendor opcode 3 B, TransMIC 4 B. Unsegmented access PDU <= 11 B.
  const access = payload + 3;
  if (access <= 11) return [{ bytes: payload + 21, airtime: (payload + 39) * 8e-6 }];
  const out = [];
  for (let remaining = access + 4; remaining > 0; remaining -= 12) {
    const bytes = 17 + Math.min(12, remaining);
    out.push({ bytes, airtime: (bytes + 18) * 8e-6 });
  }
  return out;
}
export function sensitivity(c, kind) {
  if (kind === 'ble') return c.bleSensitivity;
  // Datasheet Rev 2.2 lists SF7/SF12 endpoints, NOT the intermediate SFs.
  // Interpolation is an explicit screening assumption; CR coding gain is excluded.
  const [sf7, sf12] = {125: [-124, -137], 250: [-121, -134], 500: [-117, -129]}[c.bw];
  return sf7 + (sf12 - sf7) * (c.sf - 7) / 5;
}
export function pathLoss(distance, freqMHz, ht, hr) {
  const d = Math.max(1, distance);
  const free = 20 * Math.log10(d) + 20 * Math.log10(freqMHz) - 27.55;
  const twoRay = 40 * Math.log10(d) - 20 * Math.log10(ht) - 20 * Math.log10(hr);
  return Math.max(free, twoRay);
}
export function makeScene(c) {
  const r = rng(c.seed ^ 0x9E3779B9), n = c.boats, side = Math.ceil(Math.sqrt(n)), s = c.spacing;
  const course = ILCA_LAYOUTS.includes(c.layout) ? ilcaCourse(c) : null;
  const fleet = course ? ilcaBoats(c, course, r, () => noise(r)) : legacyBoats(c, side, r);
  const nodes = fleet.map((point, id) => ({ ...point, id, relay: false, collector: false }));
  // Keep relay selection and speed draws independent from the racing layout.
  const rankRandom = course ? rng(c.seed ^ 0xD931E) : r;
  const ranked = nodes.map(node => ({ node, key: rankRandom() })).sort((a, b) => a.key - b.key);
  ranked.slice(0, Math.round(n * c.relays / 100)).forEach(({ node }) => node.relay = true);
  const motion = rng(c.seed ^ 0x2F631);
  const mounting = rng(c.seed ^ 0x5BA9);
  for (const node of nodes) {
    node.speedFactor = 0.7 + motion() * 0.6;
    node.heightOffset = 2 * mounting() - 1;
  }

  const maxY = course?.windward.y ?? Math.max(...nodes.map(p => p.y));
  const halfWidths = { spread: 0.5, start: 0.65, split: 1.075, leader: 0.5 };
  const halfWidth = course?.halfLine ?? (c.layout === 'chain' ? s : (side * halfWidths[c.layout] + 0.35) * s);
  const rc = { id: n, x: halfWidth, y: 0, collector: true, relay: false, label: 'RC' };
  const startLine = { pin: { x: -halfWidth, y: rc.y }, rcId: rc.id };
  const offset = course ? halfWidth * 0.4 : side * s * 0.2;
  nodes.push(rc);
  if (c.collectors >= 2) nodes.push({ id: n + 1, x: -offset, y: maxY * 0.55, collector: true, relay: false, label: 'G2' });
  if (c.collectors >= 3) nodes.push({ id: n + 2, x: offset, y: maxY * 0.95, collector: true, relay: false, label: 'G3' });
  const near = nodes.slice(0, n).map((p, i) => Math.min(...nodes.slice(0, n).filter((_, j) => i !== j).map(q => Math.hypot(p.x - q.x, p.y - q.y))));
  return { nodes, startLine, windward: course?.windward ?? null, leeward: course?.leeward ?? null,
    nearest: near.reduce((a, b) => a + b, 0) / n, farthest: Math.max(...nodes.slice(0, n).map(p => Math.min(...nodes.slice(n).map(q => Math.hypot(p.x - q.x, p.y - q.y))))) };
}

function legacyBoats(c, side, r) {
  const n = c.boats, s = c.spacing;
  return Array.from({ length: n }, (_, i) => {
    const a = (i % side - (side - 1) / 2 + (r() - 0.5) * 0.5) * s;
    const b = (Math.floor(i / side) + 1 + r() * 0.4) * s;
    let x = a, y = b;
    if (c.layout === 'start') { x *= 1.3; y = s * 1.8 + (b - s) * 0.16; }
    if (c.layout === 'split') { x = a * 0.55 + (i % 2 ? 1 : -1) * side * s * 0.8; }
    if (c.layout === 'leader' && i >= n - Math.max(1, Math.floor(n * 0.05))) y += side * s * 1.3;
    if (c.layout === 'chain') { x = (r() - 0.5) * s; y = (i + 1) * s; }
    return { x, y, heading: -0.25 + r() * 0.5 };
  });
}
// Three-component illustrative deep-water field, NOT a calibrated sea spectrum.
// Long-record elevation RMS is Hm0/4. Short evaluation windows need not attain that RMS.
// 12 deg/m roll RMS and 3 dB/m link-fade scale are explicit unmeasured assumptions.
export function waveState(c, x, y, t) {
  if (!c.waveHeight) return { elevation: 0, roll: 0, fade: 0 };
  const r = rng(c.seed ^ 0x7A11), weights = [0.8, 0.5, 0.3], ratios = [1, 0.8, 1.23];
  const norm = Math.sqrt(weights.reduce((sum, w) => sum + w * w, 0) / 2);
  let surface = 0, rocking = 0;
  for (let i = 0; i < weights.length; i++) {
    const omega = 2 * Math.PI / c.wavePeriod * ratios[i], angle = 0.6 + i * 0.18;
    const phase = omega ** 2 / 9.81 * (x * Math.cos(angle) + y * Math.sin(angle)) - omega * t + r() * 2 * Math.PI;
    surface += weights[i] * Math.cos(phase); rocking += weights[i] * Math.sin(phase);
  }
  return { elevation: c.waveHeight / 4 * surface / norm,
    roll: clamp(c.waveHeight * 12 * Math.PI / 180 * rocking / norm, -70 * Math.PI / 180, 70 * Math.PI / 180),
    fade: c.waveHeight * 3 * surface / norm };
}
export function nodeState(c, node, t) {
  const speed = node.collector ? 0 : c.speed * (node.speedFactor ?? 1) * 0.514444;
  const { x, y, heading, waypointsPassed } = positionAtDistance(node, speed * t);
  const wave = waveState(c, x, y, t), roll = wave.roll * (node.collector ? 0.5 : 1);
  const mountHeight = node.collector ? c.receiverHeight : c.boatHeight + (node.heightOffset ?? 0) * c.boatHeightSpread;
  return { ...node, x, y, heading, waypointsPassed, speed, roll, elevation: wave.elevation, waveFade: wave.fade,
    mountHeight, height: Math.max(0.1, mountHeight * Math.cos(roll)) };
}

const shadowOffsets = { bow: 0, starboard: Math.PI / 2, stern: Math.PI, port: -Math.PI / 2 };

// Angles are clockwise from +Y. Each boat heels around its own fore-aft axis.
function antennaPose(c, node) {
  const tilt = Math.sin(node.roll);
  const heading = node.heading ?? 0;
  const shadow = heading + shadowOffsets[c.shadowSide];
  return {
    ...node,
    sideX: Math.cos(heading) * tilt, sideY: -Math.sin(heading) * tilt, vertical: Math.cos(node.roll),
    shadowX: Math.sin(shadow), shadowY: Math.cos(shadow),
  };
}

export function antennaLoss(c, from, to) {
  return linkAntennaLoss(c, antennaPose(c, from), antennaPose(c, to));
}

function linkAntennaLoss(c, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const meters = Math.hypot(dx, dy);
  const ux = meters ? dx / meters : 0, uy = meters ? dy / meters : 0;
  // Short-dipole approximation with near-horizontal propagation. Project onto the
  // two axes transverse to the link, then take their coupling. Cap the ideal null.
  const transverseFrom = from.sideX * uy - from.sideY * ux;
  const transverseTo = to.sideX * uy - to.sideY * ux;
  const coupling = transverseFrom * transverseTo + from.vertical * to.vertical;
  const orientation = meters ? -20 * Math.log10(clamp(Math.abs(coupling), 0.05, 1)) : 0;

  // Illustrative smooth shadow centred on the chosen heading-relative side.
  // Boat-to-boat links include both ends; RC collectors have no boat shadow.
  const fromShadow = from.collector ? 0 : Math.max(0, from.shadowX * ux + from.shadowY * uy);
  const toShadow = to.collector ? 0 : Math.max(0, -to.shadowX * ux - to.shadowY * uy);
  return orientation + c.antennaShadow * (fromShadow ** 2 + toShadow ** 2);
}

function positionAtDistance(node, distance) {
  let { x, y, heading = 0 } = node;
  let waypointsPassed = 0;
  if (distance === 0) return { x, y, heading, waypointsPassed };
  for (const next of node.courseAhead ?? []) {
    const dx = next.x - x, dy = next.y - y;
    const leg = Math.hypot(dx, dy);
    if (leg >= 1e-8) {
      heading = Math.atan2(dx, dy);
      if (distance < leg) return { x: x + dx * distance / leg, y: y + dy * distance / leg, heading, waypointsPassed };
    }
    x = next.x; y = next.y; distance -= leg; waypointsPassed++;
  }
  return { x: x + Math.sin(heading) * distance, y: y + Math.cos(heading) * distance, heading, waypointsPassed };
}
export function createPropagation(c, scene, kind) {
  const n = scene.nodes.length, r = rng(c.seed ^ 0x3A91B6), shadow = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) shadow[i * n + j] = shadow[j * n + i] = noise(r) * c.fade;
  const db = new Float64Array(n * n), mw = new Float64Array(n * n), stamps = new Int32Array(n * n).fill(-1);
  let frame = -1, poses = [], updates = 0;
  const dynamic = c.waveHeight > 0 || c.speed > 0;
  function advance(time) {
    const next = dynamic ? Math.floor((time + 1e-9) / ENVIRONMENT_STEP) : 0;
    if (frame === next) return false;
    frame = next; updates++;
    poses = scene.nodes.map(node => antennaPose(c, nodeState(c, node, frame * ENVIRONMENT_STEP)));
    return true;
  }
  function power(i, j) {
    if (i === j) return 100;
    const index = i * n + j;
    if (stamps[index] !== frame) {
      const a = poses[i], b = poses[j], directionalLoss = linkAntennaLoss(c, a, b);
      const value = c.power - pathLoss(Math.hypot(a.x - b.x, a.y - b.y), kind === 'ble' ? 2440 : 922.55, a.height, b.height)
        - c.loss + shadow[index] + (a.waveFade + b.waveFade) / Math.SQRT2 - directionalLoss;
      db[index] = db[j * n + i] = value; mw[index] = mw[j * n + i] = 10 ** (value / 10);
      stamps[index] = stamps[j * n + i] = frame;
    }
    return db[index];
  }
  advance(0);
  return { advance, power, linear(i, j) { power(i, j); return i === j ? 1e10 : mw[i * n + j]; },
    get frame() { return frame; }, get updates() { return updates; }, dynamic };
}
class Heap {
  constructor() { this.a = []; this.serial = 0; }
  push(e) { e.order = this.serial++; const a = this.a; a.push(e); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(e, a[p])) break; a[i] = a[p]; i = p; } a[i] = e; }
  less(x, y) { return x.t < y.t || (x.t === y.t && (x.type < y.type || (x.type === y.type && x.order < y.order))); }
  pop() { const a = this.a, first = a[0], last = a.pop(); if (a.length) { let i = 0;
    while (true) { let j = i * 2 + 1; if (j >= a.length) break;
      if (j + 1 < a.length && this.less(a[j + 1], a[j])) j++;
      if (!this.less(a[j], last)) break; a[i] = a[j]; i = j; } a[i] = last; } return first; }
  get length() { return this.a.length; }
}
function percentile(a, p) { if (!a.length) return null; a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))]; }
export function simulate(input, kind = 'lora', customScene = null) {
  const c = normalize(input), scene = customScene || makeScene(c), nodes = scene.nodes, count = nodes.length;
  const r = rng(c.seed ^ (kind === 'lora' ? 0x5678ABCD : 0x1234CDEF));
  const propagation = createPropagation(c, scene, kind), power = propagation.power, linear = propagation.linear;
  const sens = sensitivity(c, kind), threshold = 10 ** (c.capture / 10), heap = new Heap(), active = new Set();
  const messages = [], next = new Float64Array(count), radioUntil = new Float64Array(count), airtimeByChannel = new Float64Array(kind === 'ble' ? 3 : c.channels);
  const txByNode = new Uint32Array(count), cache = Array.from({ length: count }, () => new Set());
  const scanPhase = nodes.map(() => r() * 0.03), stats = { weak: 0, collision: 0, halfDuplex: 0, queue: 0, radioTx: 0, events: 0 };
  // A topology bound distinguishes a missing RF route from congestion observed
  // at some unrelated relay. It deliberately ignores scan timing/collisions.
  const hopLimit = kind === 'lora' || c.ttl === 0 ? 1 : c.ttl;
  let topologyFrame = -1, minHops;
  const everReachable = new Uint8Array(c.boats);
  function topology() {
    if (topologyFrame === propagation.frame) return minHops;
    topologyFrame = propagation.frame;
    minHops = Array.from({ length: count }, (_, i) => i >= c.boats ? 0 : Infinity);
    const queue = nodes.filter(n => n.collector).map(n => n.id);
    for (let k = 0; k < queue.length; k++) {
      const dest = queue[k], depth = minHops[dest] + 1; if (depth > hopLimit) continue;
      for (let source = 0; source < c.boats; source++) {
        if (source === dest || minHops[source] <= depth || power(source, dest) < sens) continue;
        minHops[source] = depth; everReachable[source] = 1;
        if (kind === 'ble' && nodes[source].relay) queue.push(source);
      }
    }
    return minHops;
  }
  const segments = kind === 'ble' ? bleSegments(c.payload) : [{ airtime: loraAirtime(c) }];
  const period = 1 / c.hz, until = c.duration + c.deadline;
  if (propagation.dynamic) for (let frame = 1; frame * ENVIRONMENT_STEP <= until; frame++) heap.push({ t: frame * ENVIRONMENT_STEP, type: 0.5 });
  for (let source = 0; source < c.boats; source++) {
    const channel = source % c.channels, slot = Math.floor(source / c.channels), slots = Math.ceil(c.boats / c.channels);
    // Report generation happens at the assigned slot in TDMA; unslotted clocks have independent phases.
    const phase = kind === 'lora' && c.mac === 'tdma' ? slot * period / slots : r() * period;
    for (let t = phase; t < c.duration - 1e-8; t += period) {
      const m = { id: messages.length, source, generated: t, delivered: null, hops: null, path: [], got: new Map(), attempts: 0, cause: { weak: 0, collision: 0, halfDuplex: 0, queue: 0 }, channel };
      messages.push(m); heap.push({ t, type: 2, m });
    }
  }
  function scheduleBle(node, m, seg, hops, path, earliest) {
    const duration = segments[seg].airtime, length = duration * 3 + 0.0003;
    const start = Math.max(earliest, next[node]);
    if (start - earliest > c.queueMs / 1000) { stats.queue++; m.cause.queue++; return; }
    next[node] = start + length;
    heap.push({ t: start, type: 3, node, m, seg, hops, path, duration, length });
  }
  function flood(node, m, seg, hops, path, earliest) {
    for (let rep = 0; rep < c.repeats; rep++) scheduleBle(node, m, seg, hops, path, earliest + rep * 0.02 + r() * 0.01);
  }
  function mark(f, cause) { if (!f.failed) { f.failed = cause; stats[cause]++; f.m.cause[cause]++; } }
  function leakage(ch1, ch2) {
    if (ch1 === ch2) return 1;
    if (kind === 'ble') return 0;
    return Math.abs(ch1 - ch2) * c.channelSpacing * 1000 < c.bw ? 1 : 10 ** (-c.adjacent / 10);
  }
  function startTx(e) {
    if (e.t > until) return;
    const tx = { ...e, end: e.t + e.duration, receivers: [] };
    stats.radioTx++; txByNode[e.node]++; airtimeByChannel[e.channel] += e.duration;
    const from = kind === 'ble' ? 0 : c.boats;
    for (let rx = from; rx < count; rx++) {
      if (rx === e.node || (kind === 'ble' && rx < c.boats && !nodes[rx].relay)) continue;
      if (power(e.node, rx) < sens) { if (nodes[rx].collector) { stats.weak++; e.m.cause.weak++; } continue; }
      if (kind === 'ble') {
        if (radioUntil[rx] > e.t) { stats.halfDuplex++; e.m.cause.halfDuplex++; continue; }
        const a = e.t + scanPhase[rx], b = tx.end + scanPhase[rx];
        if (Math.floor(a / 0.01) !== Math.floor(b / 0.01) || Math.floor(a / 0.01) % 3 !== e.channel || a % 0.01 > 0.01 * c.scan / 100 || b % 0.01 > 0.01 * c.scan / 100) continue;
      }
      const f = { rx, signal: linear(e.node, rx), interference: 0, failed: null, m: e.m };
      for (const other of active) f.interference += linear(other.node, rx) * leakage(e.channel, other.channel);
      if (f.interference > 0 && f.signal / f.interference < threshold) mark(f, 'collision');
      tx.receivers.push(f);
    }
    for (const other of active) {
      const factor = leakage(other.channel, e.channel);
      for (const f of other.receivers) {
        if (kind === 'ble' && f.rx === e.node) { mark(f, 'halfDuplex'); continue; }
        f.interference += linear(e.node, f.rx) * factor;
        if (f.interference > 0 && f.signal / f.interference < threshold) mark(f, 'collision');
      }
    }
    active.add(tx); heap.push({ t: tx.end, type: 0, tx });
  }
  function finishTx(tx, t) {
    active.delete(tx);
    for (const other of active) for (const f of other.receivers) f.interference = Math.max(0, f.interference - linear(tx.node, f.rx) * leakage(other.channel, tx.channel));
    for (const f of tx.receivers) {
      if (f.failed) continue;
      const m = tx.m, rx = f.rx, path = [...tx.path, rx];
      if (nodes[rx].collector) {
        let got = m.got.get(rx); if (!got) { got = new Set(); m.got.set(rx, got); }
        got.add(tx.seg);
        if (got.size === segments.length && m.delivered === null) { m.delivered = t; m.hops = tx.hops; m.path = path; }
      } else if (kind === 'ble') {
        const key = m.id * 8 + tx.seg;
        if (!cache[rx].has(key)) {
          cache[rx].add(key); if (cache[rx].size > 256) cache[rx].delete(cache[rx].values().next().value);
          if (tx.hops < (c.ttl === 0 ? 1 : c.ttl)) flood(rx, m, tx.seg, tx.hops + 1, path, t + 0.005 + r() * 0.015);
        }
      }
    }
  }
  let capped = false;
  while (heap.length) {
    const e = heap.pop(); if (e.t > until) break;
    if (++stats.events > c.maxEvents) { capped = true; break; }
    if (e.type === 0) finishTx(e.tx, e.t);
    else if (e.type === 0.5) {
      propagation.advance(e.t);
      // Recheck in-flight packets too: long LoRa packets can cross several wave snapshots.
      for (const tx of active) for (const f of tx.receivers) {
        f.signal = linear(tx.node, f.rx); f.interference = 0;
        for (const other of active) if (other !== tx) f.interference += linear(other.node, f.rx) * leakage(tx.channel, other.channel);
        if (power(tx.node, f.rx) < sens) mark(f, 'weak');
        else if (f.interference > 0 && f.signal / f.interference < threshold) mark(f, 'collision');
      }
    }
    else if (e.type === 1) startTx(e);
    else if (e.type === 2) {
      e.m.reachableAtStart = Number.isFinite(topology()[e.m.source]);
      if (kind === 'lora') {
        const duration = segments[0].airtime;
        const start = Math.max(e.t + Math.abs(noise(r)) * c.jitter / 1000, next[e.m.source]);
        if (start - e.t > c.queueMs / 1000) { stats.queue++; e.m.cause.queue++; continue; }
        next[e.m.source] = start + duration;
        heap.push({ t: start, type: 1, node: e.m.source, m: e.m, seg: 0, hops: 1, path: [e.m.source], duration, channel: e.m.channel });
      } else {
        for (let seg = 0; seg < segments.length; seg++) { cache[e.m.source].add(e.m.id * 8 + seg); flood(e.m.source, e.m, seg, 1, [e.m.source], e.t + seg * 0.01); }
      }
    } else if (e.type === 3) {
      radioUntil[e.node] = e.t + e.length;
      for (const other of active) for (const f of other.receivers) if (f.rx === e.node) mark(f, 'halfDuplex');
      for (let ch = 0; ch < 3; ch++) heap.push({ ...e, t: e.t + ch * (e.duration + 0.00015), type: 1, channel: ch });
    }
  }
  const byBoat = Array.from({ length: c.boats }, (_, id) => ({ id, sent: 0, received: 0, timely: 0, path: [], hops: null, gap: 0, last: 0, reachable: !!everReachable[id], rssi: Math.max(...nodes.slice(c.boats).map(q => power(id, q.id))) }));
  const delays = [], hops = [], failures = { range: 0, interference: 0, congestion: 0, mesh: 0, late: 0 };
  let delivered = 0, timely = 0;
  for (const m of messages) {
    const b = byBoat[m.source]; b.sent++;
    if (m.delivered !== null) {
      delivered++; b.received++; const delay = m.delivered - m.generated; delays.push(delay); hops.push(m.hops);
      b.path = m.path; b.hops = m.hops;
      if (delay <= c.deadline) { timely++; b.timely++; } else failures.late++;
    } else if (m.reachableAtStart === false || m.cause.weak && !m.cause.collision && !m.cause.halfDuplex && !m.cause.queue) failures.range++;
    else if (m.cause.queue) failures.congestion++;
    else if (m.cause.collision || m.cause.halfDuplex) failures.interference++;
    else if (kind === 'lora') failures.range++;
    else failures.mesh++;
  }
  // Silence is measured from t=0 and includes boats that never reported. Not an AoI estimate.
  const arrivals = messages.filter(m => m.delivered !== null && m.delivered <= c.duration).sort((a, b) => a.delivered - b.delivered);
  const lastTimely = new Float64Array(c.boats), timelyGaps = new Float64Array(c.boats);
  for (const m of arrivals) {
    const b = byBoat[m.source];
    b.gap = Math.max(b.gap, m.delivered - b.last); b.last = m.delivered;
    if (m.delivered - m.generated <= c.deadline) {
      timelyGaps[b.id] = Math.max(timelyGaps[b.id], m.delivered - lastTimely[b.id]);
      lastTimely[b.id] = m.delivered;
    }
  }
  byBoat.forEach(b => {
    b.gap = Math.max(b.gap, c.duration - b.last);
    b.timelyGap = Math.max(timelyGaps[b.id], c.duration - lastTimely[b.id]);
  });
  const disconnected = byBoat.filter(b => b.received === 0).length;
  return { kind, capped, generated: messages.length, delivered, timely, pdr: timely / messages.length,
    eventual: delivered / messages.length, latency95: percentile(delays, 0.95), meanHops: hops.length ? hops.reduce((a, b) => a + b, 0) / hops.length : null,
    longestGap: Math.max(...byBoat.map(b => b.gap)), disconnected,
    missingTimely: byBoat.filter(b => b.timely === 0).length,
    longestTimelyGap: Math.max(...byBoat.map(b => b.timelyGap)),
    airtime: Array.from(airtimeByChannel, a => a / c.duration), txByNode: Array.from(txByNode),
    byBoat, failures, stats, packetMs: segments[0].airtime * 1000, segments: segments.length,
    trace: messages.filter(m => m.delivered !== null).slice(-80).map(m => ({ time: m.delivered, path: m.path, source: m.source, delay: m.delivered - m.generated })),
    sensitivity: sens, environmentFrames: propagation.updates, environmentStep: ENVIRONMENT_STEP };
}
export function evaluate(input) {
  const config = normalize(input), scene = makeScene(config);
  return { config, scene, lora: simulate(config, 'lora', scene), ble: simulate(config, 'ble', scene) };
}
export function objective(result, target = 'both') {
  if (target === 'both' ? result.lora.capped || result.ble.capped : result[target].capped) return null;
  return target === 'both' ? Math.min(result.lora.pdr, result.ble.pdr) : result[target].pdr;
}
export function rankResult(result, target = 'both') {
  const pdr = objective(result, target);
  if (pdr === null) return null;
  const reports = target === 'both' ? [result.ble, result.lora] : [result[target]];
  const latency = reports.map(report => report.latency95);
  return {
    missing: Math.max(...reports.map(report => report.missingTimely)),
    gap: Math.max(...reports.map(report => report.longestTimelyGap)),
    pdr,
    latency95: latency.includes(null) ? null : Math.max(...latency),
  };
}

// Negative means a is better. Priorities are strict and apply to both extrema.
export function compareRanks(a, b) {
  const p95a = a.latency95 ?? Infinity, p95b = b.latency95 ?? Infinity;
  const order = [a.missing - b.missing, a.gap - b.gap, b.pdr - a.pdr, p95a - p95b];
  return order.find(delta => Math.abs(delta) > 1e-9) ?? 0;
}
export function parameterValues(key, limit) {
  if (!Object.hasOwn(SPACE, key)) return [];
  const space = SPACE[key];
  const values = RANGED.has(key)
    ? Array.from({ length: Math.floor((space[1] - space[0]) / space[2] + 1e-8) + 1 }, (_, i) => Number((space[0] + i * space[2]).toFixed(3)))
    : [...space];
  if (!limit) return values;
  if (typeof values[0] === 'number') {
    return values.filter(value => Number.isFinite(limit.min) && Number.isFinite(limit.max) && value >= limit.min && value <= limit.max);
  }
  return Array.isArray(limit) ? values.filter(value => limit.includes(value)) : [];
}

export function normalizeSearchLimits(input) {
  const limits = {};
  for (const key of Object.keys(SPACE)) {
    if (!input?.[key]) continue;
    const values = parameterValues(key, input[key]);
    if (!values.length || values.length === parameterValues(key).length) continue;
    limits[key] = typeof values[0] === 'number' ? { min: values[0], max: values.at(-1) } : values;
  }
  return limits;
}
export class Explorer {
  constructor(base, keys, target = 'both', mode = 'both', strategy = 'hybrid', limits = {}) {
    this.base = normalize(base); this.target = target; this.mode = mode;
    const normalized = normalizeSearchLimits(limits);
    this.values = new Map();
    for (const key of new Set(keys)) {
      const values = parameterValues(key, normalized[key]);
      if (!values.length) continue;
      if (mode !== 'repeat' && !values.includes(this.base[key])) {
        const previous = this.base[key];
        this.base[key] = typeof values[0] === 'number'
          ? values.reduce((nearest, value) => Math.abs(previous - value) < Math.abs(previous - nearest) ? value : nearest)
          : values[0];
      }
      if (values.length > 1) this.values.set(key, values);
    }
    this.keys = [...this.values.keys()];
    this.strategy = ['hybrid', 'sequential', 'local', 'random'].includes(strategy) ? strategy : 'hybrid';
    this.r = rng(this.base.seed ^ 0xB937); this.best = null; this.worst = null; this.baseline = null;
    this.iteration = 0; this.since = 0; this.sweepIndex = 0; this.localIndex = 0; this.pending = null;
    this.sweep = this.keys.flatMap(key => this.values.get(key).filter(value => value !== this.base[key]).map(value => ({ key, value })));
  }
  get done() { return this.iteration > 0 && this.mode !== 'repeat' && (!this.keys.length || this.strategy === 'sequential' && this.sweepIndex >= this.sweep.length); }
  candidate() {
    if (this.done) return null;
    const proposal = (config, goal, phase, parent = null) => {
      config = normalize(config);
      const from = parent?.config || this.base, changed = Object.keys(config).filter(k => config[k] !== from[k]);
      this.pending = { config, goal, phase, changed, changes: changed.map(key => ({ key, from: from[key], to: config[key] })),
        parentIteration: parent?.iteration ?? 1, parentScore: parent?.score ?? null, parentRank: parent?.rank ?? null,
        sweepIndex: phase === 'sweep' ? this.sweepIndex + 1 : null, sweepTotal: this.sweep.length };
      return this.pending;
    };
    if (!this.iteration) return proposal(this.base, 'baseline', 'baseline');
    if (this.mode === 'repeat') return proposal({ ...this.base, seed: this.base.seed + this.iteration }, 'repeat', 'repeat', this.baseline);
    if (['hybrid', 'sequential'].includes(this.strategy) && this.sweepIndex < this.sweep.length) {
      const { key, value } = this.sweep[this.sweepIndex];
      // Every one-factor comparison starts from the ORIGINAL baseline, not the previous candidate.
      return proposal({ ...this.base, [key]: value }, 'sweep', 'sweep', this.baseline);
    }
    const goal = this.mode === 'both' ? (this.localIndex % 2 ? 'worst' : 'best') : this.mode;
    const incumbent = this[goal] || this.baseline, config = { ...(incumbent?.config || this.base) };
    const restart = this.strategy === 'random' || this.r() < 0.22;
    const shuffled = [...this.keys];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(this.r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const changedKeys = restart ? this.keys : shuffled.slice(0, this.r() < 0.25 ? 2 : 1);
    for (const key of changedKeys) {
      const values = this.values.get(key);
      const closest = values.reduce((best, value, i) => typeof value === 'number' && Math.abs(value - config[key]) < Math.abs(values[best] - config[key]) ? i : best, Math.max(0, values.indexOf(config[key])));
      const choices = restart ? values : values.filter((value, i) => value !== config[key] && Math.abs(i - closest) <= (RANGED.has(key) ? 3 : 1));
      config[key] = choices[Math.floor(this.r() * choices.length)];
    }
    if (this.strategy !== 'random' && this.keys.every(key => config[key] === (incumbent?.config || this.base)[key])) {
      const key = shuffled[0], values = this.values.get(key).filter(value => value !== config[key]);
      config[key] = values[Math.floor(this.r() * values.length)];
    }
    // Same geometry, motion and wave realization for every protocol candidate.
    config.seed = this.base.seed;
    return proposal(config, goal, this.strategy === 'random' ? 'random' : restart ? 'restart' : 'local', incumbent);
  }
  accept(result) {
    const rank = rankResult(result, this.target), score = rank?.pdr ?? null, proposal = this.pending;
    let improved = false; this.iteration++;
    const record = { ...result, rank, score, iteration: this.iteration };
    if (this.iteration === 1) this.baseline = record;
    let decision = score === null ? 'excluded' : proposal?.phase === 'sweep' ? 'compared' : proposal?.goal === 'repeat' ? 'sampled' : 'baseline';
    if (rank && ['best', 'worst'].includes(proposal?.goal)) {
      const delta = proposal.parentRank ? compareRanks(rank, proposal.parentRank) : 0;
      const better = !proposal.parentRank || (proposal.goal === 'best' ? delta < 0 : delta > 0);
      decision = better ? 'accepted' : 'retained';
    }
    if (rank) {
      if (!this.best || compareRanks(rank, this.best.rank) < 0) { this.best = record; improved = true; }
      if (!this.worst || compareRanks(rank, this.worst.rank) > 0) { this.worst = record; improved = true; }
    }
    if (proposal?.phase === 'sweep') this.sweepIndex++;
    else if (['best', 'worst'].includes(proposal?.goal)) this.localIndex++;
    this.since = improved ? 0 : this.since + 1; this.pending = null;
    return { rank, score, improved, iteration: this.iteration, decision,
      retainedIteration: ['best', 'worst'].includes(proposal?.goal) ? this[proposal.goal]?.iteration : null };
  }
}
