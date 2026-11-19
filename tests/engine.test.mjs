import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loraAirtime, bleSegments, pathLoss, simulate, evaluate, createFastEvaluator, Explorer, makeScene, normalize, objective, rankResult, compareRanks, parameterValues, normalizeSearchLimits, sensitivity, waveState, nodeState, createPropagation, antennaLoss } from '../engine.js';
import { routeLength } from '../ilca-course.js';

test('LoRa time on air matches the 24-byte firmware configuration and bandwidth scaling',()=>{
 assert.ok(Math.abs(loraAirtime(DEFAULTS)-.014144)<1e-12);
 assert.equal(loraAirtime({...DEFAULTS,bw:125}),loraAirtime(DEFAULTS)*4);
 assert.ok(loraAirtime({...DEFAULTS,sf:12})>loraAirtime(DEFAULTS)*10);
});
test('BLE vendor telemetry accounts for opcode, MIC, segmentation and advertising overhead',()=>{
 assert.equal(bleSegments(8).length,1);
 assert.equal(bleSegments(24).length,3);
 assert.equal(bleSegments(48).length,5);
 assert.deepEqual(bleSegments(24).map(p=>p.bytes),[29,29,24]);
 assert.equal(bleSegments(8)[0].airtime,.000376);
});
test('Path-loss envelope increases with distance and benefits from antenna height',()=>{
 assert.ok(pathLoss(1000,922.55,1,3)>pathLoss(100,922.55,1,3));
 assert.ok(pathLoss(1000,922.55,3,3)<pathLoss(1000,922.55,1,3));
});
test('LoRa sensitivity preserves published SF endpoints and labels intermediate values as interpolation',()=>{
 assert.equal(sensitivity({...DEFAULTS,sf:12,bw:500},'lora'),-129);
 assert.equal(sensitivity({...DEFAULTS,sf:12,bw:125},'lora'),-137);
 assert.equal(sensitivity({...DEFAULTS,sf:7,bw:500},'lora'),-117);
});
test('Same config and seed reproduce packet results and relay layout',()=>{
 const c={...DEFAULTS,boats:20,duration:2};
 assert.deepEqual(evaluate(c),evaluate(c));
 const scene=makeScene(normalize({...c,relays:25}));
 assert.equal(scene.nodes.filter(p=>p.relay).length,5);
});
test('Single-radio evaluation preserves the report and rank of the full evaluation',()=>{
 const config={...DEFAULTS,boats:20,duration:1,waveHeight:.5};
 const full=evaluate(config);
 for(const target of ['lora','ble']){
  const result=evaluate(config,target);
  assert.deepEqual(result,{config:full.config,scene:full.scene,[target]:full[target]});
  assert.deepEqual(rankResult(result,target),rankResult(full,target));
 }
});
test('Fast evaluation reuses only the radio whose inputs are unchanged',()=>{
 const evaluateFast=createFastEvaluator('both');
 const base=normalize({boats:30,layout:'ilcaStart',waveHeight:1,speed:5});
 const configs=[base,{...base,channels:4,mac:'aloha'},{...base,relays:40,repeats:3},{...base,seed:base.seed+1},
  {...base,channels:3,jitter:1},{...base,channels:4,duration:2},{...base,channels:3,waveHeight:2}];
 const reports=configs.map(config=>{
  const fast=evaluateFast(config), full=evaluate(config,'both',true);
  assert.deepEqual(rankResult(fast),rankResult(full));
  for(const radio of ['lora','ble']) {
   assert.deepEqual(fast[radio].fleet,full[radio].fleet);
   assert.deepEqual(fast[radio].diagnostics,full[radio].diagnostics);
  }
  return fast;
 });
 assert.strictEqual(reports[0].ble,reports[1].ble);
 assert.notStrictEqual(reports[0].lora,reports[1].lora);
 assert.strictEqual(reports[0].lora,reports[2].lora);
 assert.notStrictEqual(reports[0].ble,reports[2].ble);
 assert.notStrictEqual(reports[0].lora,reports[3].lora);
 assert.notStrictEqual(reports[0].ble,reports[3].ble);
});
test('Fast diagnostics distinguish missed slots, cutoff, collisions and weak links',()=>{
 const base={...DEFAULTS,boats:10,layout:'spread',spacing:10,fade:0,jitter:0};
 const cases=[
  [{reportTiming:'grouped',channels:4}, {unsent:6}],
  [{mac:'aloha',bw:250,channels:4,seed:6}, {overtime:1}],
  [{mac:'aloha',reportTiming:'synchronized',channels:1}, {collision:10}],
  [{power:-5,loss:15,spacing:200}, {weak:7}],
  [{hz:.5,mac:'aloha',seed:1}, {unplanned:5,overtime:1}]
 ];
 for(const [overrides,expected] of cases){
  const config={...base,...overrides};
  const {diagnostics,...report}=evaluate(config,'lora',true).lora;
  assert.deepEqual(report,evaluate(config,'lora').lora);
  assert.deepEqual(Object.fromEntries(Object.entries(diagnostics.counts).filter(([,count])=>count)),expected);
  assert.equal(Object.values(diagnostics.counts).reduce((a,b)=>a+b),report.fleet.target-report.fleet.rounds[0].received);
  if(expected.overtime){
   assert.ok(diagnostics.example.transmittedAt<1);
   assert.ok(diagnostics.example.endsAt>1);
  }
 }
 assert.equal(evaluate(base,'lora',true).lora.diagnostics,undefined);
 assert.equal(evaluate({...base,maxEvents:2},'lora',true).lora.diagnostics,undefined);
});
test('Small close fleet with clean TDMA delivers all reports',()=>{
 const r=simulate({...DEFAULTS,boats:10,spacing:10,fade:0,loss:0,jitter:0,duration:2,channels:1});
 assert.equal(r.generated,20);assert.equal(r.timely,20);assert.equal(r.disconnected,0);
});
test('Simultaneous requests can pass with slots but collide when transmitted together',()=>{
 const c={boats:20,layout:'spread',spacing:10,duration:2,hz:1,channels:2,fade:0,jitter:0,reportTiming:'synchronized'};
 const scheduled=simulate(c,'lora'), simultaneous=simulate({...c,mac:'aloha'},'lora');
 assert.equal(scheduled.fleet.complete,2);
 assert.deepEqual(scheduled.fleet.rounds,[{second:0,sent:20,received:20},{second:1,sent:20,received:20}]);
 assert.equal(simultaneous.transmitted,40);
 assert.equal(simultaneous.failures.unsent,0);
 assert.equal(simultaneous.failures.interference,40);
 assert.equal(simultaneous.fleet.complete,0);
 const grouped=simulate({...c,reportTiming:'grouped'},'lora');
 assert.deepEqual([...new Set(grouped.byBoat.map(b=>b.firstScheduled))],[0,.25,.5,.75]);
});
test('A carried-over packet cannot satisfy the previous round even when individually timely',()=>{
 const r=simulate({...DEFAULTS,duration:8,reportTiming:'grouped'},'lora');
 assert.equal(r.delivered,r.generated);
 assert.ok(r.timely>0);
 assert.equal(r.fleet.complete,0);
 assert.ok(r.fleet.rounds.every(round=>round.received<r.fleet.target));
});
test('One-second trials cut off later transmissions and count the configured fleet',()=>{
 const grouped=simulate({...DEFAULTS,duration:1,reportTiming:'grouped'},'lora');
 assert.equal(grouped.generated,100);
 assert.equal(grouped.transmitted,98);
 assert.equal(grouped.delivered,98);
 assert.equal(grouped.failures.unsent,2);
 assert.deepEqual(grouped.fleet.rounds,[{second:0,sent:98,received:98}]);
 const slow=simulate({...DEFAULTS,duration:1,hz:.5},'lora');
 assert.ok(slow.generated<100);
 assert.equal(slow.fleet.target,100);
 assert.equal(slow.fleet.complete,0);
});
test('Queue drops are distinct from transmitted packets missing at the receiver',()=>{
 const r=simulate({boats:100,layout:'ilcaBeat',duration:2,hz:5,sf:12,bw:125,queueMs:20},'lora');
 assert.equal(r.generated,1000);
 assert.equal(r.transmitted,200);
 assert.equal(r.failures.unsent,800);
 assert.equal(r.failures.interference,200);
 const delayed=simulate({boats:10,spacing:20,layout:'spread',duration:2,hz:.5,jitter:10,queueMs:20,seed:5},'lora');
 assert.equal(delayed.unsentBoats,1);
 assert.equal(delayed.transmitted,9);
 assert.equal(delayed.delivered,9);
 assert.equal(delayed.missingTimely,1);
 assert.equal(delayed.byBoat.find(boat=>boat.transmitted===0).scheduled,1);
});
test('The start line runs from the pin to the actual RC receiver in every layout',()=>{
 for(const layout of ['ilcaStart','ilcaBeat','ilcaMark','ilcaDownwind','ilcaLeeward','spread','start','split','leader','chain']){
  const config=normalize({boats:20,collectors:3,layout,fade:0,antennaShadow:0});
  const scene=makeScene(config),{pin,rcId}=scene.startLine,rc=scene.nodes[rcId];
  assert.equal(rcId,config.boats);
  assert.equal(rc.label,'RC');
  assert.equal(rc.collector,true);
  assert.equal(pin.y,rc.y);
  assert.ok(pin.x<rc.x);
  assert.deepEqual(makeScene({...config,seed:17}).startLine,scene.startLine);
  const signal=createPropagation(config,scene,'lora').power(0,rcId);
  const boat=scene.nodes[0],distance=Math.hypot(boat.x-rc.x,boat.y-rc.y);
  const height=nodeState(config,boat,0).mountHeight;
  assert.equal(signal,config.power-pathLoss(distance,922.55,height,config.receiverHeight)-config.loss);
 }
});
test('The default ILCA beat spreads the fleet around one course without moving the RC between phases',()=>{
 assert.equal(DEFAULTS.layout,'ilcaBeat');
 const scene=makeScene(DEFAULTS),rc=scene.nodes[scene.startLine.rcId];
 const start=makeScene({...DEFAULTS,layout:'ilcaStart'});
 const rounding=makeScene({...DEFAULTS,layout:'ilcaMark'});
 assert.ok(Math.abs(rc.x-scene.startLine.pin.x-636)<1e-9);
 assert.deepEqual(start.startLine,scene.startLine);
 assert.deepEqual(rounding.startLine,scene.startLine);
 assert.deepEqual(start.windward,rounding.windward);
 assert.ok(start.nodes.slice(0,DEFAULTS.boats).every(boat=>boat.y<0));
 assert.ok(scene.nodes.some(boat=>boat.x<0&&boat.heading<-.5));
 assert.ok(scene.nodes.some(boat=>boat.x>0&&boat.heading>.5));
 assert.ok(scene.nearest>start.nearest);
 assert.ok(rounding.farthest>scene.farthest);
});
test('Boats round M1, enter between both gate marks and exit around the assigned side',()=>{
 const config=normalize({layout:'ilcaMark',speed:6});
 const {nodes,windward,leeward}=makeScene(config);
 const [left,right]=leeward.marks;
 assert.equal(left.label,'3S');assert.equal(right.label,'3P');
 assert.ok(Math.abs(right.x-left.x-42.4)<1e-9);
 for(const boat of nodes.filter(node=>node.windwardExit>0)){
  const speed=nodeState(config,boat,0).speed;
  const poseAfter=waypoints=>nodeState(config,boat,routeLength({...boat,courseAhead:boat.courseAhead.slice(0,waypoints)})/speed+0.01);
  const northOfM1=poseAfter(3);
  const downwind=poseAfter(boat.windwardExit);
  const trackEntry=boat.courseAhead[boat.leewardEntry-1];
  const crossing=boat.courseAhead[boat.leewardEntry];
  const exit=poseAfter(boat.courseAhead.length);
  const mark=boat.gateSide<0?left:right;
  assert.ok(northOfM1.y>windward.y);
  assert.ok(downwind.x<windward.x && downwind.y<windward.y && Math.cos(downwind.heading)<0);
  assert.ok(trackEntry.y>leeward.y && trackEntry.x>left.x && trackEntry.x<right.x);
  assert.equal(crossing.y,leeward.y);
  assert.ok(crossing.x>left.x && crossing.x<right.x);
  assert.ok(boat.courseAhead[boat.leewardEntry+1].y<leeward.y);
  assert.ok((exit.x-mark.x)*boat.gateSide>0 && exit.y>leeward.y && Math.cos(exit.heading)>0);
 }
 for(const layout of ['ilcaDownwind','ilcaLeeward']){
  const scene=makeScene({...config,layout});
  assert.deepEqual(scene.leeward,leeward);
  const fleet=scene.nodes.slice(0,config.boats);
  assert.ok(fleet.every(node=>node.y>leeward.y && node.y<windward.y && Math.cos(node.heading)<0));
  assert.deepEqual(new Set(fleet.map(node=>node.gateSide)),new Set([-1,1]));
 }
});
test('The leeward gate offset is independent of windward distance and can cross the start line',()=>{
 const initial=makeScene(normalize({legLength:400}));
 const longLeg=makeScene(normalize({legLength:2200}));
 assert.equal(initial.leeward.y,93);
 assert.deepEqual(longLeg.leeward,initial.leeward);
 assert.notEqual(longLeg.windward.y,initial.windward.y);
 const config=normalize({layout:'ilcaMark',leewardOffset:-100,speed:6});
 const shifted=makeScene(config);
 assert.deepEqual(shifted.startLine,initial.startLine);
 assert.equal(shifted.leeward.y,-100);
 assert.ok(shifted.leeward.marks.every(mark=>mark.y===-100));
 const boat=shifted.nodes.find(node=>node.windwardExit>0);
 const turn=boat.courseAhead.slice(0,boat.leewardEntry+2);
 const speed=nodeState(config,boat,0).speed;
 const pose=nodeState(config,boat,routeLength({...boat,courseAhead:turn})/speed+0.01);
 assert.ok(pose.y<shifted.leeward.y);
 assert.equal(makeScene(normalize({leewardOffset:0})).leeward.y,0);
});
test('The same tack affects the displayed position and the radio path loss',()=>{
 const c=normalize({layout:'ilcaBeat',speed:7,fade:0,antennaShadow:0});
 const scene=makeScene(c),boat=scene.nodes.find(b=>b.courseAhead),rc=scene.nodes[scene.startLine.rcId];
 assert.ok(boat);
 const tack=boat.courseAhead[0];
 const distance=Math.hypot(tack.x-boat.x,tack.y-boat.y);
 const t=Math.ceil((distance/ (c.speed*boat.speedFactor*0.514444)+0.3)*10)/10;
 const pose=nodeState(c,boat,t);
 assert.equal(Math.sign(pose.heading),-Math.sign(boat.heading));
 assert.equal(pose.waypointsPassed,1);
 const link=createPropagation(c,scene,'lora');
 link.advance(t);
 const expected=c.power-pathLoss(Math.hypot(pose.x-rc.x,pose.y-rc.y),922.55,pose.height,c.receiverHeight)-c.loss;
 assert.ok(Math.abs(link.power(boat.id,rc.id)-expected)<1e-9);
});
test('LoRa and BLE end successful paths at receive-only collectors',()=>{
 const config=normalize({boats:20,collectors:3,spacing:10,relays:60,duration:2});
 const scene=makeScene(config);
 for(const kind of ['lora','ble']){
  const result=simulate(config,kind,scene);
  assert.ok(result.trace.length>0);
  assert.deepEqual(result.txByNode.slice(config.boats),[0,0,0]);
  for(const {source,path} of result.trace){
   assert.equal(path[0],source);
   assert.ok(path.slice(0,-1).every(id=>!scene.nodes[id].collector));
   assert.equal(scene.nodes[path.at(-1)].collector,true);
  }
 }
});
test('One-channel overload produces RF losses; two scheduled channels restore delivery',()=>{
 const c={...DEFAULTS,boats:100,spacing:10,fade:0,loss:0,jitter:0,duration:2,adjacent:80};
 const overloaded=simulate({...c,channels:1}),split=simulate({...c,channels:2});
 assert.ok(overloaded.pdr<.95);assert.equal(split.pdr,1);
 assert.ok(overloaded.stats.collision>0);
});
test('An isolated distant boat stays disconnected and counts in the silence metric',()=>{
 const c=normalize({...DEFAULTS,boats:10,duration:2,fade:0}),scene=makeScene(c);
 scene.nodes[0].x=100000;
 const r=simulate(c,'lora',scene);
 assert.equal(r.byBoat[0].received,0);assert.equal(r.byBoat[0].gap,c.duration);
 assert.ok(r.disconnected>=1);
});
test('No relays and direct-only TTL cannot invent multi-hop paths',()=>{
 const c={...DEFAULTS,boats:20,spacing:250,duration:2,relays:0,fade:0};
 for(const config of [c,{...c,relays:60,ttl:0}]){
  const r=simulate(config,'ble');
  assert.ok(r.byBoat.every(b=>b.path.length<=2));
  assert.ok(r.disconnected>0);
  assert.ok(r.byBoat.some(b=>!b.reachable));
  assert.ok(r.failures.range>0);
 }
});
test('Observed paths obey the hop budget and contain real relay nodes',()=>{
 const c=normalize({...DEFAULTS,boats:30,duration:2,spacing:80,relays:50,ttl:3}),scene=makeScene(c),r=simulate(c,'ble',scene);
 for(const b of r.byBoat)if(b.path.length){
  assert.ok(b.path.length-1<=c.ttl);
  assert.equal(b.path[0],b.id);
  assert.ok(scene.nodes[b.path.at(-1)].collector);
  b.path.slice(1,-1).forEach(id=>assert.ok(scene.nodes[id].relay));
 }
});
test('Every generated report is timely or in exactly one failure bucket',()=>{
 for(const kind of ['lora','ble']){
  const r=simulate({...DEFAULTS,boats:50,duration:2,hz:5,channels:1},kind);
  assert.equal(r.timely+Object.values(r.failures).reduce((a,b)=>a+b,0),r.generated);
  assert.equal(r.transmitted+r.failures.unsent,r.generated);
  assert.ok(r.transmitted>=r.delivered);
  assert.ok(r.delivered>=r.timely);assert.ok(r.pdr>=0 && r.pdr<=1);
  assert.ok(r.longestGap<=2);
 }
});
test('A calculation cap is visible and cannot become a best case',()=>{
 const r=evaluate({...DEFAULTS,maxEvents:2,duration:2});
 assert.equal(r.lora.capped,true);assert.equal(objective(r),null);
 const explorer=new Explorer(DEFAULTS,['sf']);explorer.accept(r);
 assert.equal(explorer.best,null);
});
test('Search holds unchecked conditions fixed and the best passing case improves monotonically',()=>{
 const base={...DEFAULTS,boats:20,duration:2},ex=new Explorer(base,['sf','channels','relays'],'lora');
 let best=null;
 for(let i=0;i<12;i++){
  const candidate=ex.candidate();
  for(const k of ['boats','spacing','hz','power','seed','ttl'])assert.equal(candidate.config[k],base[k]);
  ex.accept(evaluate(candidate.config));
  if(best)assert.ok(compareRanks(ex.best.rank,best)<=0);
  best=ex.best?.rank;
  if(best)assert.equal(best.feasible,true);
 }
});
test('Fixed-condition seed sampling works with no enabled search variables',()=>{
 const base={...DEFAULTS,boats:10,duration:2},ex=new Explorer(base,[],'ble','repeat');
 ex.accept(evaluate(ex.candidate().config));
 const proposal=ex.candidate();assert.equal(proposal.config.seed,base.seed+1);assert.equal(proposal.config.boats,10);
});
test('A capped unused protocol does not invalidate a single-protocol objective',()=>{
 const r={lora:{pdr:.9,capped:false},ble:{pdr:.2,capped:true}};
 assert.equal(objective(r,'lora'),.9);assert.equal(objective(r,'ble'),null);assert.equal(objective(r,'both'),null);
});

test('Failing any one-second round blocks a candidate even with excellent aggregate metrics',()=>{
 const ex=new Explorer(DEFAULTS,['sf'],'lora','best','local');ex.r=()=>.9;
 const failedFleet={target:100,complete:1,rounds:[{received:100},{received:99}]};
 const runs=[
  [.99,{fleet:failedFleet,longestTimelyGap:.02}],
  [.80,{missingTimely:0,longestTimelyGap:1}],
  [.95,{fleet:failedFleet,longestTimelyGap:.01}],
  [.85,{missingTimely:0,longestTimelyGap:1,latency95:.8}],
  [.85,{missingTimely:0,longestTimelyGap:1,latency95:.02}],
 ];
 const outcomes=runs.map(([pdr,metrics])=>ex.accept(scored(ex.candidate().config,pdr,metrics)).decision);
 assert.deepEqual(outcomes,['out','accepted','out','accepted','accepted']);
 assert.equal(ex.best.iteration,5);
 assert.equal(ex.iteration,5);
 assert.equal(ex.passed,3);
});

test('Selecting both radios uses the less favourable value of each ranking metric',()=>{
 const {lora,ble}=scored(DEFAULTS,.9,{missingTimely:1,longestTimelyGap:2,latency95:.4});
 Object.assign(ble,{pdr:.8,missingTimely:0,longestTimelyGap:3,latency95:.1,fleet:{target:100,complete:0,rounds:[{received:99}]}});
 assert.deepEqual(rankResult({lora,ble}),{feasible:false,fleetComplete:0,fleetFloor:.99,missing:1,gap:3,pdr:.8,latency95:.4});
 assert.equal(rankResult({lora,ble},'lora').feasible,true);
 assert.equal(rankResult({lora,ble:{...ble,capped:true}}),null);
});

test('Late-only LoRa arrivals do not count as timely fleet coverage or reset the timely gap',()=>{
 const result=simulate({boats:10,spacing:10,layout:'spread',sf:10,bw:125,payload:8,channels:4,hz:.5,
   duration:4,deadline:.1,fade:0,waveHeight:0,antennaShadow:0});
 assert.ok(result.delivered>0);
 assert.equal(result.timely,0);
 assert.equal(result.missingTimely,10);
 assert.equal(result.longestTimelyGap,4);
 assert.ok(result.disconnected<result.missingTimely);
});

test('Heading changes antenna shadow only where it crosses the link bearing',()=>{
 const receiver={x:0,y:100,heading:0,roll:0,collector:true};
 const boat={x:0,y:0,heading:0,roll:0,collector:false};
 const config=normalize({antennaShadow:8,shadowSide:'stern'});
 const turned={...boat,heading:Math.PI};
 assert.equal(antennaLoss(config,boat,receiver),0);
 assert.equal(antennaLoss(config,turned,receiver),8);
 assert.equal(antennaLoss(config,receiver,turned),8);
 assert.equal(antennaLoss({...config,antennaShadow:0},turned,receiver),0);
 const link = heading => {
  const scene={nodes:[{...boat,heading,id:0},{...receiver,id:1}]};
  return createPropagation({...config,fade:0,speed:0,waveHeight:0},scene,'lora').power(0,1);
 };
 assert.equal(link(0)-link(Math.PI),8);
});

test('Heel direction is relative to each hull and antenna coupling is reciprocal',()=>{
 const config=normalize({antennaShadow:0});
 const a={x:0,y:0,heading:0,roll:Math.PI/4};
 const b={x:0,y:100,heading:0,roll:Math.PI/4};
 assert.ok(antennaLoss(config,a,b)<1e-9);
 const opposite={...a,heading:Math.PI};
 const loss=antennaLoss(config,opposite,b);
 assert.ok(loss>20);
 assert.ok(Math.abs(loss-antennaLoss(config,b,opposite))<1e-9);
});

test('Zero waves and zero speed preserve the stationary loss model across time',()=>{
 const c=normalize({boats:10,fade:0,waveHeight:0,speed:0,antennaShadow:0,boatHeightSpread:0}),scene=makeScene(c),link=createPropagation(c,scene,'lora');
 const a=scene.nodes[0],b=scene.nodes[10];
 const expected=c.power-pathLoss(Math.hypot(a.x-b.x,a.y-b.y),922.55,c.boatHeight,c.receiverHeight)-c.loss;
 assert.equal(link.power(0,10),expected);link.advance(10);assert.equal(link.power(0,10),expected);assert.equal(link.updates,1);
 assert.deepEqual(waveState(c,4,8,10),{elevation:0,roll:0,fade:0});
 assert.equal(nodeState(c,a,10).x,a.x);assert.equal(nodeState(c,a,10).y,a.y);
});
test('Fleet mount heights stay in the expected range and zero spread makes them uniform',()=>{
 const c=normalize({collectors:3}),scene=makeScene(c);
 const heights=scene.nodes.slice(0,c.boats).map(boat=>nodeState(c,boat,0).mountHeight);
 assert.ok(heights.every(height=>height>=.6 && height<=1));
 assert.ok(new Set(heights).size>1);
 assert.deepEqual(heights,makeScene(c).nodes.slice(0,c.boats).map(boat=>nodeState(c,boat,0).mountHeight));
 assert.ok(scene.nodes.filter(boat=>boat.collector).every(boat=>nodeState(c,boat,0).mountHeight===c.receiverHeight));
 assert.ok(scene.nodes.slice(0,c.boats).every(boat=>nodeState({...c,boatHeightSpread:0},boat,0).mountHeight===.8));
});
test('An individual mounting height changes both radio link budgets',()=>{
 const c=normalize({fade:0,waveHeight:0,speed:0,antennaShadow:0});
 const rc={id:2,x:0,y:0,collector:true};
 const lower={id:0,x:0,y:1000,heightOffset:-1};
 const higher={...lower,id:1,heightOffset:1};
 const scene={nodes:[lower,higher,rc]};
 for(const kind of ['ble','lora']){
  const link=createPropagation(c,scene,kind);
  assert.ok(Math.abs(link.power(1,2)-link.power(0,2)-20*Math.log10(1/.6))<1e-9);
 }
});
test('Motion is continuous and reproducible, and radio settings do not alter tracks',()=>{
 const c=normalize({boats:10,speed:6}),scene=makeScene(c),a=scene.nodes[0],p=nodeState(c,a,2),q=nodeState(c,a,4);
 assert.ok(p.speed>=6*.7*.514444 && p.speed<=6*1.3*.514444);
 assert.ok(Math.abs((q.x-a.x)-2*(p.x-a.x))<1e-9);
 assert.ok(Math.abs((q.y-a.y)-2*(p.y-a.y))<1e-9);
 assert.deepEqual(makeScene({...c,sf:12,bw:125}),scene);
 assert.equal(nodeState(c,scene.nodes[10],10).speed,0);
});
test('Illustrative wave elevation follows the declared long-record Hm0 scale',()=>{
 const c=normalize({waveHeight:1.5});let sum=0,squares=0;const n=10000;
 for(let i=0;i<n;i++){const z=waveState(c,0,0,i*.137).elevation;sum+=z;squares+=z*z;}
 const rms=Math.sqrt(squares/n-(sum/n)**2);assert.ok(Math.abs(rms-c.waveHeight/4)<.01);
});
test('Waves change real link power at 0.1-second snapshots, without resampling static shadowing',()=>{
 const c=normalize({boats:10,waveHeight:1,fade:0}),scene=makeScene(c),a=createPropagation(c,scene,'ble'),b=createPropagation(c,scene,'ble');
 const first=a.power(0,10);assert.equal(a.power(10,0),first);
 a.advance(.09);assert.equal(a.power(0,10),first);
 a.advance(.1);b.advance(.1);assert.notEqual(a.power(0,10),first);assert.equal(a.power(0,10),b.power(0,10));
 assert.ok(Math.abs(a.linear(0,10)-10**(a.power(0,10)/10))<1e-15);
 a.advance(0);assert.equal(a.power(0,10),first);
});
test('Long LoRa packets fail when waves break reception after a valid start',()=>{
 const c=normalize({boats:10,spacing:10,layout:'spread',waveHeight:1.5,wavePeriod:4,speed:0,boatHeight:.4,boatHeightSpread:0,receiverHeight:3,sf:12,bw:125,hz:.5,fade:0,loss:3,power:8,seed:11,duration:2,jitter:0,channels:4,deadline:5});
 const scene=makeScene(c);scene.nodes[0].x=2500;scene.nodes[0].y=0;
 scene.nodes.slice(1,10).forEach(n=>{n.x=1e7;n.y=1e7;});
 const link=createPropagation(c,scene,'lora');assert.ok(link.power(0,10)>sensitivity(c,'lora'));
 const waves=simulate(c,'lora',scene),calm=simulate({...c,waveHeight:0},'lora',scene);
 assert.equal(calm.byBoat[0].received,1);assert.equal(waves.byBoat[0].received,0);
 assert.equal(waves.byBoat[0].reachable,true);assert.ok(waves.environmentFrames>1);
});
test('Moving wave scenarios reproduce both protocols and retain packet accounting',()=>{
 const c={boats:20,speed:8,waveHeight:1.5,duration:2},a=evaluate(c);assert.deepEqual(a,evaluate(c));
 for(const k of ['ble','lora'])assert.equal(a[k].timely+Object.values(a[k].failures).reduce((x,y)=>x+y,0),a[k].generated);
});

function scored(config,score,metrics={}) {
 const report={pdr:score,capped:false,missingTimely:0,longestTimelyGap:2,latency95:.2,
   fleet:{target:100,complete:1,rounds:[{received:100}]},...metrics};
 return {config:normalize(config),lora:{...report},ble:{...report}};
}
test('Ordered diagnosis resets all other parameters to baseline and stops after one pass',()=>{
 const ex=new Explorer(DEFAULTS,['sf','bw'],'lora','best','sequential'),configs=[];
 while(!ex.done){const p=ex.candidate();configs.push(p.config);ex.accept(scored(p.config,.5));}
 assert.deepEqual(configs.slice(1).map(c=>[c.sf,c.bw]),[[8,500],[9,500],[10,500],[11,500],[12,500],[7,125],[7,250]]);
 for(const c of configs)assert.equal(c.seed,DEFAULTS.seed);
 assert.equal(ex.candidate(),null);
});
test('Rejected local trials keep the best passing condition as their starting point',()=>{
  const ex=new Explorer(DEFAULTS,['sf'],'lora','best','local');ex.r=()=>.9;
  ex.accept(scored(ex.candidate().config,.5));
  const improved=ex.candidate(),goodScore=.8;
  assert.equal(ex.accept(scored(improved.config,goodScore)).decision,'accepted');
  const rejected=ex.candidate();assert.equal(rejected.parentIteration,2);
  assert.equal(ex.accept(scored(rejected.config,.5)).decision,'retained');
  const next=ex.candidate();assert.equal(next.parentIteration,2);assert.equal(next.parentScore,goodScore);
  assert.equal(next.changes[0].from,improved.config.sf);assert.equal(ex.best.config.sf,improved.config.sf);
});
test('Hybrid search transitions from diagnosis into joint search while holding environment fixed',()=>{
 const c=normalize({speed:5,waveHeight:1,wavePeriod:5}),ex=new Explorer(c,['channels'],'both','both','hybrid');
 for(let i=0;i<4;i++){const p=ex.candidate();ex.accept(scored(p.config,.5));}
 const p=ex.candidate();assert.ok(['local','restart'].includes(p.phase));
 for(const key of ['boats','spacing','speed','waveHeight','wavePeriod','seed'])assert.equal(p.config[key],c[key]);
 assert.equal(ex.done,false);
});
test('No selected variable finishes after baseline, except explicit seed repetition',()=>{
 const ex=new Explorer(DEFAULTS,[]);ex.accept(scored(ex.candidate().config,.5));assert.equal(ex.done,true);assert.equal(ex.candidate(),null);
});

test('Range edits follow supported steps and reject an interval with no supported value',()=>{
 assert.deepEqual(parameterValues('power',{min:3,max:9}),[4,6,8]);
 assert.deepEqual(parameterValues('bw',{min:125,max:250}),[125,250]);
 assert.deepEqual(parameterValues('bw',{min:130,max:180}),[]);
 assert.deepEqual(normalizeSearchLimits({power:{min:3,max:9},bw:{min:130,max:180},
  shadowSide:['port','bogus','bow'],antennaShadow:{min:0,max:20}}),{power:{min:4,max:8},shadowSide:['bow','port']});
});

test('All search strategies enforce numeric limits, categorical choices and locked values',()=>{
 const base={...DEFAULTS,power:18,shadowSide:'stern',receiverHeight:4,duration:8,boatHeightSpread:.25};
 const limits={power:{min:4,max:8},shadowSide:['bow','port'],receiverHeight:{min:2,max:2},
  duration:{min:15,max:30},boatHeightSpread:{min:0,max:0}};
 for(const strategy of ['random','hybrid','sequential','local']){
  const ex=new Explorer(base,['power','shadowSide','receiverHeight','duration'],'lora','both',strategy,limits);
  const sampledPowers=new Set();
  for(let i=0;i<40&&!ex.done;i++){
   const {config}=ex.candidate();
   assert.ok([4,6,8].includes(config.power));assert.ok(['bow','port'].includes(config.shadowSide));
   assert.equal(config.receiverHeight,2);assert.equal(config.boatHeightSpread,.25);
   assert.ok([15,30].includes(config.duration));assert.equal(config.seed,base.seed);
   sampledPowers.add(config.power);ex.accept(scored(config,i/40));
  }
  assert.equal(sampledPowers.size,3);
 }
});

test('A fixed limit evaluates one pinned baseline, while repeat keeps its explicit configuration',()=>{
 const base={...DEFAULTS,power:12},limits={power:{min:4,max:4}};
 const random=new Explorer(base,['power'],'lora','both','random',limits);
 const only=random.candidate();assert.equal(only.config.power,4);random.accept(scored(only.config,.5));
 assert.equal(random.candidate(),null);
 const repeat=new Explorer(base,['power'],'lora','repeat','random',limits);
 const baseline=repeat.candidate();assert.equal(baseline.config.power,12);repeat.accept(scored(baseline.config,.5));
 const replay=repeat.candidate();assert.equal(replay.config.power,12);assert.notEqual(replay.config.seed,base.seed);
});
