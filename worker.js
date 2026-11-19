import { createFailureCounts, createFastEvaluator, evaluate, Explorer, radioUsesParameter } from './engine.js';
let fast = null;

function sendFastUpdate(type, reason) {
  const { explorer, snapshots, reports, excluded } = fast;
  self.postMessage({ type, reason, iteration: explorer.iteration, passed: explorer.passed, snapshots, reports, excluded });
  for (const report of Object.values(reports)) report.rows = [];
  fast.snapshots = [];
  fast.lastUpdate = performance.now();
}

function finishFast(reason) {
  sendFastUpdate('fast-done', reason);
  fast = null;
}

function recordFailure(result, iteration) {
  for (const [kind, report] of Object.entries(fast.reports)) {
    const { diagnostics, fleet } = result[kind];
    if (!diagnostics) continue;
    const { counts, example } = diagnostics;
    const expected = fleet.rounds.length * fleet.target;
    const received = fleet.rounds.reduce((sum, round) => sum + round.received, 0);
    const row = { iteration, received, expected, counts };
    report.rows.push(row);
    for (const cause of Object.keys(counts)) report.counts[cause] += counts[cause];

    const nearest = report.nearest;
    if (!nearest || expected - received < nearest.expected - nearest.received) {
      report.nearest = { ...row, example };
    }
  }
}

function runBatch() {
  if (!fast) return;
  const { explorer, evaluateCandidate } = fast;
  const end = performance.now() + 65;
  try {
    do {
      const proposal = explorer.candidate();
      if (!proposal) {
        finishFast('complete');
        return;
      }
      const result = evaluateCandidate(proposal.config);
      const accepted = explorer.accept(result);
      if (accepted.improved) {
        fast.snapshots.push({ config: result.config, rank: accepted.rank, iteration: accepted.iteration });
      } else if (!accepted.rank) {
        fast.excluded++;
      } else if (!accepted.rank.feasible) {
        recordFailure(result, accepted.iteration);
      }
    } while (performance.now() < end);
    if (fast.snapshots.length || performance.now() - fast.lastUpdate >= 200) sendFastUpdate('fast-progress');
    setTimeout(runBatch, 0);
  } catch (error) {
    finishFast(error.message || String(error));
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'fast-start') {
    const { config, target, mode, strategy, limits, keys } = data;
    const relevant = keys.filter(key => radioUsesParameter(target, key));
    const radios = target === 'both' ? ['lora', 'ble'] : [target];
    const reports = Object.fromEntries(radios.map(radio => [radio, { counts: createFailureCounts(), rows: [], nearest: null }]));
    fast = { explorer: new Explorer(config, relevant, target, mode, strategy, limits), evaluateCandidate: createFastEvaluator(target), snapshots: [], reports, excluded: 0, lastUpdate: performance.now() };
    runBatch();
    return;
  }
  if (data.type === 'fast-stop') {
    if (fast) finishFast('stopped');
    return;
  }
  try { const start = performance.now(); const result = evaluate(data.config);
    self.postMessage({ id: data.id, result, elapsed: performance.now() - start });
  } catch (error) { self.postMessage({ id: data.id, error: error.stack || String(error) }); }
};
