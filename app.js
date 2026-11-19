import { DEFAULTS, SPACE, Explorer, MODEL_VERSION, rankResult, normalize, normalizeSearchLimits, parameterValues, isSliderParameter, makeScene, nodeState, createPropagation, antennaLoss } from './engine.js';
import { ILCA_LAYOUTS, routeLength } from './ilca-course.js';
const $ = id => document.getElementById(id);
const desktopInvoke = window.__TAURI__?.core?.invoke;
const labels = {ilcaStart:'ILCA · 스타트 밀집',ilcaBeat:'ILCA · 첫 업윈드',ilcaMark:'ILCA · 풍상 마크 회항',ilcaDownwind:'ILCA · 풍하 레그',ilcaLeeward:'ILCA · 풍하 게이트 회항',spread:'균일 격자',start:'압축 격자',split:'분리 격자',leader:'선두 독주',chain:'일렬 연결',tdma:'TDMA · 시각 동기',aloha:'ALOHA · 비동기',bow:'선수',stern:'선미',port:'좌현',starboard:'우현',default:'기본 분산',grouped:'4그룹 동시',synchronized:'전부 동시'};
const fields = [
 ['boats','배 척수','척','common'], ['spacing','대형 폭 기준','m','common'],
 ['layout','배치','','common'], ['collectors','수집기','대','common'],
 ['legLength','첫 업윈드 길이','m','common'], ['leewardOffset','풍하 게이트 위치','m','common'],
 ['speed','이동 속도 기준','kn','common'], ['waveHeight','파도 세기 · 유의파고 Hm0','m','common'],
 ['wavePeriod','대표 파도 주기','초','common'], ['reportTiming','송신 요청 시점','','common'],
 ['hz','배당 송신 빈도','Hz','link'], ['payload','순수 데이터','B','link'],
 ['power','송신 출력','dBm','model'], ['boatHeight','경기정 기준 높이','m','model'],
 ['boatHeightSpread','장착 높이 편차','m','model'],
 ['sf','Spreading factor','','lora'], ['bw','대역폭','kHz','lora'],
 ['cr','코딩률','','lora'], ['channels','독립 채널','개','lora'],
 ['mac','접근 방식','','lora'], ['jitter','송신 지터 척도','ms','lora'],
 ['relays','중계 배 비율','%','ble'], ['ttl','TTL · 0은 직접 수신','','ble'],
 ['repeats','송신 횟수 / 광고 이벤트','회','ble'], ['scan','수신 스캔 듀티','%','ble'],
 ['receiverHeight','수집기 안테나 높이','m','model'], ['loss','추가 전파 손실','dB','model'],
 ['antennaShadow','최대 차폐 손실','dB','model'], ['shadowSide','차폐 중심 방향','','model'],
 ['fade','링크 페이딩 σ','dB','link'], ['bleSensitivity','BLE 1M 수신감도','dBm','link'],
 ['channelSpacing','LoRa 채널 중심 간격','MHz','link'], ['adjacent','비중첩 채널 억압 가정','dB','link'],
 ['capture','간섭 대비 필요 전력차','dB','link'], ['queueMs','최대 송신 대기','ms','link']
];
const configurableKeys = new Set(fields.map(([key])=>key));
const defaultKeys = ['sf','bw','channels','relays','ttl','repeats'];
let saved = {}; try { saved = JSON.parse(localStorage.getItem('sailing-radio-lab-v1') || '{}'); } catch {}
const snapshotKey='sailing-radio-lab-best-v1';
let bestSnapshots=[];
let snapshotChoices=[];
try {
 const stored=JSON.parse(localStorage.getItem(snapshotKey)||'[]');
 if(Array.isArray(stored))bestSnapshots=stored;
} catch {}
// Switch the former default once; subsequently selected comparison grids stay selected.
if (!saved.modelVersion && saved.base?.layout === 'spread') saved.base.layout = DEFAULTS.layout;
if(saved.base && saved.base.boatHeightSpread===undefined){
 if(saved.base.boatHeight===1.2) saved.base.boatHeight=DEFAULTS.boatHeight;
 else if(saved.base.boatHeight!==undefined) saved.base.boatHeightSpread=0;
}
let base = normalize({...saved.base,duration:1,deadline:1}), keys = new Set((saved.keys || defaultKeys).filter(k=>configurableKeys.has(k))), target = saved.target || 'both';
let searchLimits = normalizeSearchLimits(saved.searchLimits);
let explorer, current = null, replay = null, records = [], running = false, busy = false, timer = null, generation = 0;
let kind = 'ble', selected = 0, view = 'current', evaluationMs = 0, needBaseline = false, validating = false;
let sceneTime = 0, sceneTimer = null, sceneStart = 0, lastStart = null, actualCadence = null, cadences = [], displayedPropagation = null;
let courseReplay = null;
let worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'}), jobId = 0;
let fastSession = null;
let lastFastReport = null, fastReportPage = 0;
const pending = new Map();
const narrowLayout = matchMedia('(max-width: 760px)');
const consoleView = document.querySelector('.console');
const workspace = document.querySelector('.workspace');
const tabs = Array.from(document.querySelectorAll('.dock-nav [role="tab"]'));
let activeTab = narrowLayout.matches ? 'map' : 'result';
function selectTab(name) {
 activeTab = name;
 workspace.dataset.view = name;
 const mapPanel = $('panel-map');
 if (narrowLayout.matches) {
  mapPanel.setAttribute('role', 'tabpanel');
  mapPanel.setAttribute('aria-labelledby', 'tab-map');
 } else {
  mapPanel.removeAttribute('role');
  mapPanel.removeAttribute('aria-labelledby');
 }
 for (const tab of tabs) {
  const isActive = tab.id === `tab-${name}`;
  tab.setAttribute('aria-selected', String(isActive));
  tab.tabIndex = isActive ? 0 : -1;
  if (tab.id !== 'tab-map') $(tab.getAttribute('aria-controls')).hidden = !isActive;
 }
}
for (const tab of tabs) {
 tab.onclick = () => selectTab(tab.id.slice(4));
 tab.onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const visible = tabs.filter(item => narrowLayout.matches || item.id !== 'tab-map');
  const position = visible.indexOf(tab);
  const next = { Home: 0, End: visible.length - 1, ArrowLeft: position - 1, ArrowRight: position + 1 }[event.key];
  const target = visible[(next + visible.length) % visible.length];
  target.click();
  target.focus();
 };
}
narrowLayout.addEventListener('change', event => selectTab(event.matches ? 'map' : activeTab === 'map' ? 'result' : activeTab));
selectTab(activeTab);
for (const section of ['antenna', 'link']) {
 $(`rf-${section}`).onclick = () => {
  const showAntenna = section === 'antenna';
  $('rf-antenna').setAttribute('aria-pressed', String(showAntenna));
  $('rf-link').setAttribute('aria-pressed', String(!showAntenna));
  $('antenna-settings').hidden = !showAntenna;
  $('link-controls').hidden = showAntenna;
 };
}
$('open-notes').onclick = () => $('model-notes').showModal();
$('open-trial').onclick = () => $('trial-details').showModal();
worker.onmessage = ({data}) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.error ? p.reject(new Error(data.error)) : p.resolve(data); };
worker.onerror = event => { showError(event.message || '계산 엔진 오류'); for (const p of pending.values()) p.reject(new Error('계산 엔진 오류')); pending.clear(); stop(); };
function request(config) { const id = ++jobId; return new Promise((resolve,reject) => {pending.set(id,{resolve,reject});worker.postMessage({id,config});}); }
const fmt = (n, digits=0) => Number(n).toLocaleString('ko-KR',{maximumFractionDigits:digits});
const pct = n => `${(n*100).toFixed(1)}%`;
function valueLabel(key,value,unit='') {
 if(key==='cr')return `4/${value}`;
 if(key==='leewardOffset')return value===0?'0m':`${value>0?'풍상':'풍하'} ${fmt(Math.abs(value),3)}m`;
 return `${labels[value] || fmt(value,3)}${unit ? ' '+unit : ''}`;
}
const layoutOptions = SPACE.layout.map(layout => new Option(labels[layout], layout));
$('map-layout').replaceChildren(...layoutOptions);
$('map-layout').onchange = () => setLayout($('map-layout').value);
function setLayout(layout) {
 base = { ...base, layout };
 resetSearch();
}
for (const [key,name,unit,group] of fields) {
 const field = document.createElement('div');
 field.className = 'field';
 const options = SPACE[key];
 const control = isSliderParameter(key)
  ? `<input id="p-${key}" type="range" min="${options[0]}" max="${options[1]}" step="${options[2]}" aria-label="${name}">`
  : `<select id="p-${key}" aria-label="${name}">${options.map(v=>`<option value="${v}">${valueLabel(key,v,unit)}</option>`).join('')}</select>`;
 const rangeButton = (endpoint, description) => `<button type="button" class="range-button" id="${endpoint}-${key}" aria-haspopup="dialog" aria-label="${name} ${description}"></button>`;
 const rangeControls = typeof options[0] === 'number'
  ? rangeButton('min','자동 탐색 최소값') + rangeButton('max','자동 탐색 최대값')
  : rangeButton('choices','자동 탐색 후보');
 field.innerHTML = `<div class="field-header"><label><input type="checkbox" id="auto-${key}" aria-label="${name} 자동 탐색" ${keys.has(key)?'checked':''}><span>${name}</span></label><output id="v-${key}"></output></div>${control}<div class="field-range">${rangeControls}</div>`;
 $(group+'-controls').appendChild(field);
 $('p-'+key).value=base[key];
 $('p-'+key).addEventListener('input',()=> $('v-'+key).textContent=valueLabel(key,readField(key),unit));
 $('p-'+key).addEventListener('change',()=> {
  if(key==='layout'){setLayout(readField(key));return;}
  base={...displayResult()?.config || base,[key]:readField(key)}; resetSearch();
 });
 for (const endpoint of ['min', 'max', 'choices']) {
  const button = $(`${endpoint}-${key}`);
  if (button) button.onclick = () => openSearchLimit(key, endpoint);
 }
 $('auto-'+key).addEventListener('change',()=> { $('auto-'+key).checked ? keys.add(key):keys.delete(key); base={...displayResult()?.config || base}; resetSearch();});
}
function readField(key){const value=$('p-'+key).value;return typeof SPACE[key][0]==='number'?Number(value):value;}

function syncSearchLimitLabels() {
 for (const [key,name,unit] of fields) {
  const values = parameterValues(key, searchLimits[key]);
  if (typeof values[0] === 'number') {
   for (const [endpoint, description, value] of [['min','최소',values[0]], ['max','최대',values.at(-1)]]) {
    const button = $(`${endpoint}-${key}`);
    const text = `${description} ${valueLabel(key,value,unit)}`;
    button.textContent = text;
    button.setAttribute('aria-label', `${name} 자동 탐색 ${text}`);
    button.dataset.edited = String(Object.hasOwn(searchLimits,key));
   }
  } else {
   const button = $(`choices-${key}`);
   button.textContent = `후보 ${values.length}/${SPACE[key].length} ↗`;
   button.setAttribute('aria-label', `${name} 자동 탐색 후보 ${values.length}개`);
   button.dataset.edited = String(Object.hasOwn(searchLimits,key));
  }
 }
}

let editingRange = null;
function openSearchLimit(key, focusEndpoint) {
 editingRange = fields.find(field=>field[0]===key);
 $('range-title').textContent = `${editingRange[1]} · 자동 탐색 범위`;
 renderRangeInputs(searchLimits[key]);
 $('range-dialog').showModal();
 $(`range-input-${focusEndpoint}`)?.focus();
}
function renderRangeInputs(limit) {
 const [key,,unit] = editingRange;
 const full = parameterValues(key);
 const selected = parameterValues(key,limit);
 const inputs = $('range-inputs');
 if (typeof full[0] === 'number') {
  const field = (endpoint,label,value) => {
   const id = `range-input-${endpoint}`;
   const control = isSliderParameter(key)
    ? `<input id="${id}" type="number" min="${full[0]}" max="${full.at(-1)}" step="any" value="${value}" required>`
    : `<select id="${id}">${full.map(v=>`<option value="${v}"${v===value?' selected':''}>${valueLabel(key,v,unit)}</option>`).join('')}</select>`;
   return `<label>${label}${unit?` (${unit})`:''}${control}</label>`;
  };
  inputs.className = 'range-input-grid';
  inputs.innerHTML = field('min','최소값',selected[0]) + field('max','최대값',selected.at(-1));
 } else {
  inputs.className = 'range-choice-grid';
  inputs.innerHTML = full.map(value=>`<label><input type="checkbox" value="${value}" ${selected.includes(value)?'checked':''}>${valueLabel(key,value,unit)}</label>`).join('');
 }
 updateRangePreview();
}
function readSearchLimit() {
 const [key] = editingRange;
 if (typeof SPACE[key][0] !== 'number') {
  return Array.from($('range-inputs').querySelectorAll('input:checked'), input=>input.value);
 }
 const min = $('range-input-min'), max = $('range-input-max');
 return {min:min.value!==''&&min.validity.valid?Number(min.value):NaN, max:max.value!==''&&max.validity.valid?Number(max.value):NaN};
}
function updateRangePreview() {
 const [key,,unit] = editingRange;
 const values = parameterValues(key,readSearchLimit());
 const summary = values.length === 1 ? '한 값으로 고정' : `${values.length}개 후보`;
 const extent = typeof values[0] === 'number'
  ? ` · ${valueLabel(key,values[0],unit)}${values.length>1?` ~ ${valueLabel(key,values.at(-1),unit)}`:''}` : '';
 $('range-preview').textContent = values.length ? summary+extent : '탐색 가능한 값이 없습니다. 범위나 후보를 다시 지정하세요.';
 $('apply-range').disabled = !values.length;
}
$('range-inputs').oninput = updateRangePreview;
$('close-range').onclick = () => $('range-dialog').close();
$('reset-range').onclick = () => renderRangeInputs();
$('range-form').onsubmit = event => {
 event.preventDefault();
 const [key] = editingRange;
 const limit = readSearchLimit();
 if (!parameterValues(key,limit).length) return;
 const updated = normalizeSearchLimits({...searchLimits,[key]:limit});
 $('range-dialog').close();
 if (JSON.stringify(updated[key]) === JSON.stringify(searchLimits[key])) return;
 searchLimits = updated;
 if (keys.has(key)) resetSearch();
 else { syncSearchLimitLabels(); persist(); }
};
function syncFields(config){
 for(const [key,,unit] of fields){$('p-'+key).value=config[key];$('v-'+key).textContent=valueLabel(key,config[key],unit);}
 $('seed').value=config.seed;$('map-layout').value=config.layout;
 const {boatHeight,boatHeightSpread}=config;
 const range=boatHeightSpread ? `${fmt(boatHeight-boatHeightSpread,2)}–${fmt(boatHeight+boatHeightSpread,2)}` : fmt(boatHeight,2);
 $('mounting-range').textContent=`경기정 안테나 수면 기준 ${range}m`;
 const ilca=ILCA_LAYOUTS.includes(config.layout);
 $('p-legLength').disabled=!ilca;
 $('p-leewardOffset').disabled=!ilca;
 $('p-spacing').setAttribute('aria-label',ilca?'대형 폭 기준':'배 간격 척도');
}
function resolveStrategy(strategy, version) {
 if (strategy==='hybrid' && !['0.7.0','0.8.0','0.8.1','0.9.0','0.9.2',MODEL_VERSION].includes(version)) return 'random';
 return ['hybrid','sequential','local','random'].includes(strategy)?strategy:'random';
}
function persist(){ try{localStorage.setItem('sailing-radio-lab-v1',JSON.stringify({modelVersion:MODEL_VERSION,base,keys:[...keys],searchLimits,target,strategy:$('strategy').value}));}catch{} }
function showError(message){$('error').hidden=false;$('error').textContent=message;}
function stop(){running=false;clearTimeout(timer);timer=null;updateButtons();}
function completedLabel(){
 if(explorer.keys.length)return '설정한 순차 비교 완료';
 return keys.size?'체크한 값이 모두 고정됨':'자동 탐색 변수 없음';
}
function updateButtons(){
 if(fastSession)return;
 $('fast-run').disabled=validating;
 $('run').textContent=running?'탐색 정지':'탐색';
 $('run').disabled=!current || validating;
 $('validate').disabled=busy || running || !displayResult();
 $('run-state').textContent=validating?'다른 시드 검증 중':busy?'조건 평가 중':explorer?.done?completedLabel():running?'자동 탐색 중':'일시정지';
 $('run-state').dataset.active=String(running || busy);
 $('open-trial').disabled=!displayResult();
 $('course-playback').disabled=busy && !courseReplay;
 $('case-view').querySelector('option[value="best"]').disabled=!explorer?.best;
 $('best-card').disabled=!explorer?.best;
 $('snapshot-replay').disabled=busy||!$('snapshot-select').value;
}
function resetSearch(){
 stop();clearSceneReplay();lastStart=null;actualCadence=null;cadences=[];generation++;records=[];current=null;replay=null;view='current';$('case-view').value='current';syncCourseMode(null);
 $('map-case').textContent='기준 평가 중';$('map-case').dataset.tone='';
 $('case-verdict').hidden=true;$('metric-fleet').textContent='—';$('metric-packet-flow').textContent='—';
 $('metric-search-total').textContent='성공 횟수 0회';
 $('metric-received').textContent=$('metric-isolated').textContent=$('metric-unsent').textContent='—';
 target=$('objective').value;explorer=new Explorer({...base,duration:1,deadline:1},[...keys],target,$('search-mode').value,$('strategy').value,searchLimits);
 base=explorer.base;needBaseline=true;
 $('validation-result').textContent='탐색 중에는 같은 시드로 비교합니다.';
 $('error').hidden=true;persist();syncFields(base);syncSearchLimitLabels();updateButtons();drawHistory();
 if(!busy) stepSearch();
}
async function stepSearch(){
 if(busy)return;const proposal=explorer.candidate();if(!proposal){stop();render();return;}
 needBaseline=false;busy=true;const token=generation,start=performance.now();if(running&&lastStart!==null){cadences.push(start-lastStart);if(cadences.length>10)cadences.shift();actualCadence=cadences.reduce((a,b)=>a+b,0)/cadences.length;}lastStart=start;updateButtons();
 try{
  const data=await request(proposal.config);if(token!==generation)return;
  evaluationMs=data.elapsed;const accepted=explorer.accept(data.result);current={...data.result,rank:accepted.rank,iteration:accepted.iteration,proposal,acceptance:accepted};
  records.push({iteration:accepted.iteration,score:accepted.score,rank:accepted.rank,best:explorer.best?.score??null,config:data.result.config,lora:data.result.lora.pdr,ble:data.result.ble.pdr,goal:proposal.goal,proposal,acceptance:accepted,elapsedMs:data.elapsed});
  if(records.length>2000)records.shift();if(explorer.done)stop();render();
  if(accepted.improved)saveBestSnapshot(current);
 }catch(error){if(token===generation){showError(error.message);stop();}}
 finally{
  busy=false;updateButtons();
  if(needBaseline){stepSearch();return;}
  if(running && token===generation)timer=setTimeout(stepSearch,Math.max(0,Number($('pace').value)-(performance.now()-start)));
 }
}
$('run').onclick=()=>{
 if(running){stop();return;}
 if(explorer.done)resetSearch();
 running=true;lastStart=null;view='current';$('case-view').value=view;
 updateButtons();
 if(!busy)timer=setTimeout(stepSearch,Number($('pace').value));
};
function stopFast(session){
 session.stopping=true;
 $('fast-run').textContent='정지 중';
 $('fast-run').disabled=true;
 session.worker.postMessage({type:'fast-stop'});
}
const fastCauseLabels={unsent:'미송신',overtime:'1초 초과',collision:'충돌',weak:'신호 부족',unplanned:'송신 예정 없음',other:'기타'};
const fastReportPageSize=4;
function renderFastReport(){
 const {reports,iteration,passed,excluded,saved,target:scope}=lastFastReport;
 const report=reports[$('fast-report-radio').value];
 const failed=iteration-passed-excluded;
 const skipped=excluded?` · 계산 한도 제외 ${fmt(excluded)}회`:'';
 $('fast-report-summary').textContent=`${targetLabel(scope)} · 평가 ${fmt(iteration)}회 · 성공 ${fmt(passed)}회 · 실패 ${fmt(failed)}회 · 새 스냅샷 ${fmt(saved)}개${skipped}`;
 for(const cause of ['unsent','overtime','collision','weak'])$(`fast-cause-${cause}`).textContent=`${fmt(report.counts[cause]??0)}건`;
 $('fast-report-other').textContent=['unplanned','other'].filter(cause=>report.counts[cause]).map(cause=>`${fastCauseLabels[cause]} ${fmt(report.counts[cause])}건`).join(' · ');
 $('fast-report-other').hidden=!$('fast-report-other').textContent;
 const nearest=report.nearest;
 $('fast-report-nearest').hidden=!nearest;
 if(nearest){
  const {example}=nearest;
  const timing=example.cause==='overtime' && example.transmittedAt!==null && example.endsAt!==null
   ? ` · 송신 시작 ${fmt(example.transmittedAt*1000,1)}ms · 예상 종료 ${fmt(example.endsAt*1000,1)}ms`:'';
  $('fast-report-nearest').textContent=`가장 근접 #${fmt(nearest.iteration)} · ${fmt(nearest.received)}/${fmt(nearest.expected)}척 수신 · ${fmt(example.boat)}번 배 ${fastCauseLabels[example.cause]}${timing}`;
 }
 const {rows}=report;
 $('fast-report-empty').hidden=Boolean(rows.length);
 $('fast-report-table').hidden=!rows.length;
 const totalPages=Math.ceil(rows.length/fastReportPageSize);
 $('fast-report-pages').hidden=totalPages<=1;
 $('fast-report-prev').disabled=fastReportPage===0;
 $('fast-report-next').disabled=fastReportPage+1>=totalPages;
 $('fast-report-page').textContent=`${fmt(fastReportPage+1)} / ${fmt(totalPages)}`;
 const entries=[];
 const end=rows.length-fastReportPage*fastReportPageSize;
 for(let i=end-1;i>=Math.max(0,end-fastReportPageSize);i--){
  const {iteration,received,expected,counts}=rows[i];
  const reasons=Object.entries(counts).filter(([,count])=>count>0)
   .map(([cause,count])=>`${fastCauseLabels[cause]} ${fmt(count)}건`).join(' · ');
  const tr=document.createElement('tr');
  for(const value of [`#${fmt(iteration)}`,`${fmt(received)}/${fmt(expected)}척`,reasons]){
   const td=document.createElement('td');
   td.textContent=value;
   tr.append(td);
  }
  entries.push(tr);
 }
 $('fast-report-rows').replaceChildren(...entries);
}
function openFastReport(){
 fastReportPage=0;
 renderFastReport();
 $('fast-report').showModal();
}
$('open-fast-report').onclick=openFastReport;
$('fast-report-radio').onchange=()=>{fastReportPage=0;renderFastReport();};
$('fast-report-prev').onclick=()=>{fastReportPage--;renderFastReport();};
$('fast-report-next').onclick=()=>{fastReportPage++;renderFastReport();};
function finishFast(session,error){
 session.worker.terminate();
 fastSession=null;
 delete consoleView.dataset.fast;
 workspace.hidden=false;
 $('fast-panel').hidden=true;
 $('fast-run').textContent='고속 탐색';
 $('pace').disabled=false;
 $('iteration').textContent=fmt(explorer.iteration);
 $('last-fast-status').textContent=`고속 탐색 · 평가 ${fmt(session.iteration)}회 · 성공 ${fmt(session.passed)}회 · 새 스냅샷 ${fmt(session.saved)}개`;
 $('last-fast-status').hidden=false;
 if(error)showError(error);
 render();
 updateButtons();
 if(!error || session.iteration){
  const {reports,iteration,passed,excluded,saved,target}=session;
  lastFastReport={reports,iteration,passed,excluded,saved,target};
  const radios=Object.keys(reports);
  const firstRadio=radios.reduce((current,radio)=>reports[radio].rows.length>reports[current].rows.length?radio:current);
  $('fast-report-radio').replaceChildren(...radios.map(radio=>new Option(targetLabel(radio),radio)));
  $('fast-report-radio').value=firstRadio;
  $('fast-report-picker').hidden=radios.length<2;
  $('open-fast-report').hidden=false;
  openFastReport();
 }
}
$('fast-run').onclick=()=>{
 if(fastSession){stopFast(fastSession);return;}
 stop();
 stopScene();
 const mode=$('search-mode').value;
 const config=mode==='repeat'?base:explorer.best?.config??base;
 const fastWorker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
 const radios=target==='both'?['lora','ble']:[target];
 const reports=Object.fromEntries(radios.map(radio=>[radio,{rows:[],counts:{},nearest:null}]));
 const session={worker:fastWorker,target,iteration:0,passed:0,saved:0,excluded:0,reports};
 lastFastReport=null;
 $('open-fast-report').hidden=true;
 $('last-fast-status').hidden=true;
 fastSession=session;
 $('error').hidden=true;
 consoleView.dataset.fast='true';
 workspace.hidden=true;
 $('fast-panel').hidden=false;
 $('fast-target').textContent=`${targetLabel(target)} · 1초 전원 수신`;
 for(const id of ['iteration','fast-iterations','fast-successes','fast-saved'])$(id).textContent='0';
 $('run').disabled=true;
 $('pace').disabled=true;
 $('fast-run').textContent='고속 탐색 정지';
 $('run-state').textContent='고속 탐색 중';
 $('run-state').dataset.active='true';
 fastWorker.onmessage=({data})=>{
  if(fastSession!==session)return;
  session.iteration=data.iteration;
  session.passed=data.passed;
  session.excluded=data.excluded;
  for(const [radio,report] of Object.entries(data.reports)){
   const collected=session.reports[radio];
   collected.rows.push(...report.rows);
   collected.counts=report.counts;
   collected.nearest=report.nearest;
  }
  if(!session.error){
   try{
    for(const snapshot of data.snapshots){
     if(saveBestSnapshot(snapshot,session.target))session.saved++;
    }
   }catch(error){
    session.error=error.message;
    if(data.type==='fast-progress'&&!session.stopping)stopFast(session);
   }
  }
  $('iteration').textContent=$('fast-iterations').textContent=fmt(session.iteration);
  $('fast-successes').textContent=fmt(session.passed);
  $('fast-saved').textContent=fmt(session.saved);
  if(data.type==='fast-done'){
   const error=['complete','stopped'].includes(data.reason)?null:`고속 탐색 오류 · ${data.reason}`;
   finishFast(session,session.error??error);
  }
 };
 fastWorker.onerror=event=>{
  if(fastSession===session)finishFast(session,`고속 탐색 오류 · ${event.message}`);
 };
 fastWorker.postMessage({type:'fast-start',config,target,keys:[...keys],mode,strategy:$('strategy').value,limits:searchLimits});
};
$('objective').value=target;$('objective').onchange=()=>resetSearch();$('search-mode').onchange=()=>resetSearch();
$('strategy').value=resolveStrategy(saved.strategy,saved.modelVersion);$('strategy').onchange=()=>resetSearch();
$('pace').onchange=()=>{persist();if(running&&!busy){clearTimeout(timer);timer=setTimeout(stepSearch,Number($('pace').value));}render();};
$('seed').onchange=()=>{base={...base,seed:Number($('seed').value)};resetSearch();};
$('case-view').onchange=()=>{view=$('case-view').value;render();};
function switchKind(next){kind=next;$('view-ble').setAttribute('aria-pressed',String(kind==='ble'));$('view-lora').setAttribute('aria-pressed',String(kind==='lora'));render();}
$('view-ble').onclick=()=>switchKind('ble');$('view-lora').onclick=()=>switchKind('lora');
$('show-links').onchange=()=>{
 $('route-key').hidden=!$('show-links').checked;
 drawSea();
};
$('boat-select').onchange=()=>{selected=Number($('boat-select').value);drawSea();showBoat();};
 $('best-card').onclick=()=>{
  if(!explorer.best)return;
  view='best';
  $('case-view').value=view;
  if(narrowLayout.matches)selectTab('map');
  render();
 };
function displayResult(){return view==='best'?explorer?.best:view==='replay'?replay:current;}
function fleetScore(report){return `${report.fleet.complete}/${report.fleet.rounds.length}`;}
function fleetPassed(report){return report.fleet.complete===report.fleet.rounds.length;}
function targetLabel(value){return value==='both'?'BLE·LoRa 모두':value==='ble'?'BLE Mesh':'LoRa';}
function configSummary(c){return `${c.boats}척 · ${c.spacing}m · 파고 ${c.waveHeight}m · ${c.speed}kn · SF${c.sf}/${c.bw}k · ${c.channels}ch · 중계 ${c.relays}% / TTL ${c.ttl} / ${c.repeats}회`;}
function snapshotSelection(){
 const selectedValue=$('snapshot-select').value;
 return selectedValue===''?null:snapshotChoices[Number(selectedValue)];
}
function saveBestSnapshot(result,snapshotTarget=target){
 if(!result.rank?.feasible)return false;
 const configKey=JSON.stringify(result.config);
 if(bestSnapshots.some(snapshot=>snapshot.target===snapshotTarget && snapshot.modelVersion===MODEL_VERSION && JSON.stringify(snapshot.config)===configKey))return false;
 const snapshot={savedAt:new Date().toISOString(),modelVersion:MODEL_VERSION,iteration:result.iteration,target:snapshotTarget,config:result.config,rank:result.rank};
 storeSnapshot(snapshot);
 return true;
}
function storeSnapshot(snapshot){
 const next=[snapshot,...bestSnapshots];
 try{
  localStorage.setItem(snapshotKey,JSON.stringify(next));
 }catch(error){throw new Error(`스냅샷 저장 실패 · ${error.message}`);}
 bestSnapshots=next;
 $('open-snapshots').textContent=`스냅샷 ${fmt(bestSnapshots.length)}개`;
}
async function loadValidationSnapshot(){
 try{
  const response=await fetch(new URL('./lora-100-best-snapshot.json',import.meta.url));
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const snapshot=await response.json();
  if(!bestSnapshots.some(saved=>saved.id===snapshot.id))storeSnapshot(snapshot);
 }catch(error){showError(`검증 스냅샷을 열지 못했습니다 · ${error.message}`);}
}
function showSnapshotSummary(){
 const snapshot=snapshotSelection();
 const heldOut=snapshot?.validation?.heldOut;
 const nominal=heldOut?.jitter?.[snapshot.config.jitter];
 const nominalLabel=nominal?`\n기준 지터 ${snapshot.config.jitter}ms · ${fmt(nominal.pass)}/${fmt(nominal.total)}회 통과`:'';
 const validation=heldOut?`\n별도 시드 검증 ${fmt(heldOut.pass)}/${fmt(heldOut.total)}회 통과${nominalLabel}`:'';
 $('snapshot-summary').textContent=snapshot
  ?`${configSummary(snapshot.config)}\n${snapshot.config.duration}초 시험 · ${labels[snapshot.config.reportTiming]} · ${labels[snapshot.config.mac]} · 시드 ${snapshot.config.seed}\n${rankSummary(snapshot.rank,false)}${validation}`
  :'아직 전원 수신 조건을 통과한 스냅샷이 없습니다.';
 $('snapshot-replay').disabled=!snapshot||busy;
}
$('open-snapshots').textContent=bestSnapshots.length?`스냅샷 ${fmt(bestSnapshots.length)}개`:'스냅샷';
$('open-snapshots').onclick=()=>{
 snapshotChoices=bestSnapshots;
 $('snapshot-select').replaceChildren(...snapshotChoices.map((snapshot,index)=>new Option(snapshot.label??`${new Date(snapshot.savedAt).toLocaleString('ko-KR')} · ${targetLabel(snapshot.target)} · #${snapshot.iteration}`,index)));
 $('snapshot-picker').hidden=!snapshotChoices.length;
 showSnapshotSummary();
 $('best-snapshots').showModal();
};
$('snapshot-select').onchange=showSnapshotSummary;
$('snapshot-replay').onclick=()=>{
 const snapshot=snapshotSelection();
 if(busy||!snapshot)return;
 $('best-snapshots').close();
 replayCase(snapshot,true);
};
function rankSummary(rank, includeMissing=true) {
 if (!rank) return '평가 제외';
 const delay = rank.latency95 === null ? '—' : `${fmt(rank.latency95 * 1000)}ms`;
 const coverage=includeMissing?`미갱신 ${rank.missing}척 · `:'';
 return `전원 수신 ${pct(rank.fleetComplete)} · ${coverage}공백 ${rank.gap.toFixed(2)}초 · 도착 ${pct(rank.pdr)} · P95 ${delay}`;
}
function showDisplayedCase(result){
 const goal=result.proposal?.goal;
 const savedLabel=view==='best'||result.snapshot?'보관한 최선':null;
 const candidates={baseline:'기준 평가',best:'탐색 후보',sweep:'순차 비교 후보',repeat:'새 시드 평가'};
 const label=savedLabel ?? candidates[goal] ?? '현재 평가';
 const replayPrefix=view==='replay'?(result.snapshot?'스냅샷 ':'이력 '):'';
 const badge=$('map-case');
 badge.textContent=`${replayPrefix}#${result.iteration} · ${label}`;
 badge.dataset.tone=savedLabel?'best':goal??'';
 const verdict=$('case-verdict');
 verdict.hidden=false;
 verdict.dataset.state=!result.rank?'excluded':result.rank.feasible?'pass':'out';
 const judgedTarget=result.snapshot?.target??target;
 const scope=judgedTarget==='both'?'양쪽 조건':targetLabel(judgedTarget);
 verdict.textContent=!result.rank?'평가 제외':`${scope} ${result.rank.feasible?'통과':'탈락'}`;
 verdict.title=`${targetLabel(judgedTarget)} · 매 1초 전원 수신 기준`;
}
function stopScene(){clearInterval(sceneTimer);sceneTimer=null;$('scene-play').textContent='장면 재생';$('scene-play').setAttribute('aria-pressed','false');}
function clearSceneReplay(){
 stopScene();
 courseReplay=null;
 sceneTime=0;
}
function syncCourseMode(result){
 const active=Boolean(courseReplay);
 $('panel-map').dataset.scene=active?'course':'radio';
 $('course-playback').hidden=!result?.scene.windward;
 $('course-playback').textContent=active?'통신 화면':'코스 재생';
 $('course-case').hidden=!active;
 if(active)$('course-case').textContent=courseReplay.config.layout==='ilcaLeeward'?'G3 풍하 게이트 회항':'M1 풍상 → G3 풍하 게이트';
 $('course-legend').hidden=!active;
 const excluded=result?.[kind].capped;
 $('radio-legend').hidden=active||Boolean(excluded);
 $('excluded-legend').hidden=active||!excluded;
 $('boat-reception').hidden=active||!result;
 $('scene-time').setAttribute('aria-label',active?'코스 재생 시간':'지도 재생 시간 · 수신 수치는 평가 구간 전체 집계');
}
function coursePose(node){
 const time=Math.min(sceneTime,courseReplay.finishTimes[node.id] ?? sceneTime);
 return nodeState(courseReplay.config,node,time);
}
function startScene(){
 const result=displayResult();
 if(!result)return;
 const rate=courseReplay?courseReplay.duration/16:1;
 if(sceneTime>=(courseReplay?.duration ?? result.config.duration))sceneTime=0;
 sceneStart=performance.now()-sceneTime*1000/rate;
 $('scene-play').textContent='장면 정지';$('scene-play').setAttribute('aria-pressed','true');
 sceneTimer=setInterval(()=>{
  const activeResult=displayResult();
  if(!activeResult){stopScene();return;}
  const end=courseReplay?.duration ?? activeResult.config.duration;
  sceneTime=Math.min(end,Math.floor((performance.now()-sceneStart)*rate/100)/10);
  drawSea();showBoat();
  if(sceneTime>=end)stopScene();
 },courseReplay?40:100);
}
$('course-playback').onclick=()=>{
 const result=displayResult();
 if(courseReplay){
  clearSceneReplay();
 }else{
  if(!result?.scene.windward || busy)return;
  stop();stopScene();sceneTime=0;
  const layout=result.config.layout==='ilcaLeeward'?'ilcaLeeward':'ilcaMark';
  const config={...result.config,layout,speed:result.config.speed || 5};
  const scene=result.config.layout===layout?result.scene:makeScene(config);
  const fleet=scene.nodes.slice(0,config.boats);
  if(layout==='ilcaMark' && !fleet[selected].windwardExit){
   const approaching=fleet.find(boat=>boat.windwardExit>0);
   if(approaching){selected=approaching.id;$('boat-select').value=selected;}
  }
  const finishTimes=fleet.map(boat=>routeLength(boat)/nodeState(config,boat,0).speed);
  const duration=Math.ceil(Math.max(...finishTimes)*10)/10;
  const waypoints=fleet.flatMap(boat=>boat.courseAhead);
  const branches=[fleet.find(boat=>boat.gateSide<0),fleet.find(boat=>boat.gateSide>0)];
  courseReplay={result,config,scene,finishTimes,duration,waypoints,branches};
 }
 syncCourseMode(result);drawSea();showBoat();updateButtons();
 if(courseReplay)startScene();
};
$('scene-time').oninput=()=>{stopScene();sceneTime=Number($('scene-time').value);drawSea();showBoat();};
$('scene-play').onclick=()=>{
 if(sceneTimer)stopScene();
 else startScene();
};
function render(){
 if(fastSession)return;
 const result=displayResult();if(!result)return;
 if(courseReplay && courseReplay.result!==result)clearSceneReplay();
 syncCourseMode(result);
 const c=result.config,s=result[kind];syncFields(c);
 $('iteration').textContent=fmt(explorer.iteration);
 const deadline=`${fmt(c.deadline,2)}초`;
 $('coverage-label').textContent=`${c.collectors===1?'RC':'수집기'} 정시 수신 · ${fmt(c.duration,2)}초 전체`;
 $('coverage-label').title=`${fmt(s.scheduledBoats)}척에 송신 예정이 있었습니다. 배별 수신은 ${deadline} 안에 도착한 패킷 기준입니다.`;
 const oneSecond=s.fleet.rounds.length===1;
 $('metric-fleet-label').textContent=oneSecond?'이번 1초 수신':'전원 수신 성공 구간';
 $('metric-fleet').textContent=s.capped?'평가 제외':oneSecond?`${fmt(s.fleet.rounds[0].received)}/${fmt(s.fleet.target)}척`:`${fleetScore(s)}구간`;
 $('metric-fleet').dataset.state=s.capped?'excluded':fleetPassed(s)?'pass':'out';
 $('metric-search-total').textContent=`성공 횟수 ${fmt(explorer.passed)}회`;
 $('metric-search-total').title=`${targetLabel(target)} 전원 수신에 성공한 누적 횟수`;
 $('metric-packet-flow').textContent=s.capped?'이벤트 한도 초과':`예정 ${fmt(s.generated)} · 송신 ${fmt(s.transmitted)} · 정시 ${fmt(s.timely)}건`;
 $('metric-packet-flow').title=s.capped?'':`송신 예정 ${fmt(s.generated)}건, 실제 송신 ${fmt(s.transmitted)}건, 수신 ${fmt(s.delivered)}건(정시 ${fmt(s.timely)}건)`;
 $('metric-received').textContent=s.capped?'—':`${fmt(s.scheduledBoats-s.missingTimely)}척`;
 $('metric-isolated').textContent=s.capped?'—':`${fmt(s.missingTimely-s.unsentBoats)}척`;
 $('metric-unsent').textContent=s.capped?'—':`${fmt(s.unsentBoats)}척`;
 $('metric-gap').textContent=s.capped?'수신 판정 제외':`예정 ${fmt(s.scheduledBoats)}척 · 최장 공백 ${s.longestTimelyGap.toFixed(2)}초`;
 $('metric-latency').textContent=s.capped?'—':s.latency95===null?'미도착':`${fmt(s.latency95*1000)}ms`;
 $('metric-hops').textContent=s.capped?'':s.meanHops===null?'전달 경로 없음':`평균 ${s.meanHops.toFixed(1)}홉 · ${s.segments}개 세그먼트`;
 showDisplayedCase(result);
 $('map-distance').textContent=`최근접 평균 ${fmt(result.scene.nearest)}m · 수집기까지 최대 ${fmt(result.scene.farthest)}m`;
 const options=$('boat-select');if(options.options.length!==c.boats){options.innerHTML=Array.from({length:c.boats},(_,i)=>`<option value="${i}">배 ${i+1}</option>`).join('');}
 selected=Math.min(selected,c.boats-1);options.value=selected;showBoat();
 const proposal=result.proposal,acceptance=result.acceptance;
 const changes=(proposal?.changes||[]).map(({key,from,to})=>{const f=fields.find(f=>f[0]===key);return `${f?.[1]||key} ${valueLabel(key,from,f?.[2])} → ${valueLabel(key,to,f?.[2])}`;});
 const phase={baseline:'기준 조건 저장',sweep:`한 항목 순차 비교 ${proposal?.sweepIndex}/${proposal?.sweepTotal}`,local:'보관한 해 주변 탐색',restart:'다른 구간 무작위 탐색',random:'전체 범위 무작위',repeat:'동일 조건 · 새 시드'}[proposal?.phase]||'';
 const decision=acceptance?.decision==='accepted'?`개선 채택 · 다음 후보의 출발점 #${acceptance.retainedIteration}`:acceptance?.decision==='retained'?`개선 없음 · 후보는 이력에 기록, 다음 후보는 보관한 #${acceptance.retainedIteration}에서 출발`:acceptance?.decision==='compared'?'비교 기록 · 다음 항목은 기준 #1에서 다시 시작':acceptance?.decision==='sampled'?'새 시드 표본 기록':'기준 저장';
 const trialHeading=`#${result.iteration} · ${phase}`;
 const reference=proposal?.parentRank?`\n비교 기준 #${proposal.parentIteration} · ${rankSummary(proposal.parentRank)}`:'';
 const trialStatus=!result.rank?'이벤트 한도 초과 · 평가 제외':!result.rank.feasible?'탈락 · 매 1초 전원 수신 조건 미달':decision;
 if (proposal?.phase === 'baseline' && !s.capped) {
  $('candidate-description').textContent = `기준 설정 · ${result.rank?.feasible?'전원 수신 조건 통과':trialStatus}`;
 } else {
  $('candidate-description').textContent=proposal?`${trialHeading}\n${changes.length>2?`${changes.length}개 항목 변경`:changes.join(' / ')||'변경 없음'}\n${trialStatus}`:configSummary(c);
 }
 const seconds=s.capped?'':`\n\n${targetLabel(kind)} · 구간별 송신 → 수신 / 평가 대상\n${s.fleet.rounds.map(round=>`${round.second}–${round.second+1}초 · ${round.sent} → ${round.received} / ${s.fleet.target}척`).join('\n')}`;
 const detail=proposal?`${trialHeading}\n\n${changes.join('\n')||'변경 없음'}\n${rankSummary(result.rank)}${reference}\n${trialStatus}\n\n${configSummary(c)}`:configSummary(c);
 $('trial-full').textContent=detail+seconds;
 const environmentKeys=['boats','spacing','legLength','leewardOffset','layout','collectors','speed','waveHeight','wavePeriod','boatHeight','loss','reportTiming'].filter(k=>keys.has(k));
 $('search-guidance').textContent=$('search-mode').value==='repeat'?'설정은 고정하고 시드만 바꿔 결과의 흔들림을 봅니다.':environmentKeys.length?`환경 변수 ${environmentKeys.length}개도 변경 중 · 통신 설정만의 개선과 구분해 해석하세요.`:'배치·이동·파도·시드를 고정하고 선택한 통신 설정을 비교합니다.';
 $('cadence-status').textContent=`계산 ${fmt(evaluationMs)}ms${actualCadence!==null?` · 평균 간격 ${(actualCadence/1000).toFixed(2)}초`:''}`;
 $('environment-caption').textContent=`${labels[c.layout]}${result.scene.windward?' · 가상 대형':''} / 파고 ${c.waveHeight}m · 기준 속도 ${c.speed}kn · 모의 ${c.duration}초`;
 $('compare-results').innerHTML=['lora','ble'].map(k=>`<div class="radio-result" data-kind="${k}"><span>${targetLabel(k)}</span><div class="track"><span style="width:${result[k].pdr*100}%"></span></div><small>${result[k].capped?'—':oneSecond?(fleetPassed(result[k])?'통과':'탈락'):`${fleetScore(result[k])}구간`}</small><strong>${result[k].capped?'제외':pct(result[k].pdr)}</strong></div>`).join('')+`<div class="load-description">LoRa ${result.lora.packetMs.toFixed(2)}ms/패킷 · ${c.channels}ch<br>선택 방식의 채널 부하 ${s.airtime.map(v=>fmt(v*100)+'%').join(' / ')} (중첩 포함)</div>`;
 const causeNames={unsent:'예정됐으나 송신 없음',range:'전파 범위 · 중계 경로 단절',interference:'간섭 · 송수신 겹침',congestion:'송신·중계 큐 초과',mesh:'수신 누락 · 분할 미완료',late:'기한 초과 수신'};
 $('failure-bars').innerHTML=s.capped?'<p class="muted">이벤트 한도 초과 · 원인 집계 제외</p>':Object.entries(s.failures).filter(([,v])=>v>0).map(([k,v])=>`<div class="failure-line"><span>${causeNames[k]}</span><strong>${fmt(v)}개</strong></div>`).join('')||'<div class="failure-line"><span>관측 구간 내 미도착 없음</span><strong>0개</strong></div>';
 const best=explorer.best;
 $('best-score').textContent=best?'통과':'—';
 $('best-config').textContent=best?`#${best.iteration} · ${rankSummary(best.rank,false)}\n${configSummary(best.config)}`:'전원 수신 조건을 통과한 회차 없음';
 $('search-status').textContent=`${explorer.done?(keys.size?'순차 완료 · ':'자동 변수 없음 · '):''}${target==='both'?'방식별 불리한 값':target==='ble'?'BLE Mesh':'LoRa'} · ${keys.size}개 변수 · ${explorer.since}회 순위 갱신 없음`;
 drawSea();drawHistory();updateButtons();
}
function showBoat(){
 const result=displayResult();if(!result)return;
 if(courseReplay){
  const boat=coursePose(courseReplay.scene.nodes[selected]);
  const mark=boat.gateSide<0?'3S 왼쪽':'3P 오른쪽';
  const stage=sceneTime>=courseReplay.finishTimes[selected]?`${mark} 회항 완료`
   :boat.waypointsPassed>boat.leewardEntry?`${mark} 회항`
   :boat.waypointsPassed===boat.leewardEntry?'G3 게이트 진입'
   :boat.waypointsPassed>=boat.windwardExit?(courseReplay.config.layout==='ilcaLeeward'?'G3 접근':'풍하 레그'):'M1 풍상 마크 회항';
  const detail=`${stage} · ${fmt(boat.speed/.514444,1)}kn`;
  $('boat-detail').textContent=detail;$('boat-detail').title=detail;
  return;
 }
 const stats=result[kind],b=stats.byBoat[selected];
 const reception=$('boat-reception');
 const status=stats.capped?'excluded':!b.scheduled?'not-scheduled':!b.transmitted?'unsent':b.timely?'received':b.received?'late':'missed';
 const statusNames={excluded:'평가 제외','not-scheduled':'송신 예정 없음',unsent:'미송신',received:'수신',late:'기한 초과',missed:'송신 후 미수신'};
 reception.dataset.status=status;reception.textContent=statusNames[status];
 reception.title=stats.capped?'이벤트 한도 초과':`송신 예정 ${b.scheduled}건, 실제 송신 ${b.transmitted}건, 수신 ${b.received}건(정시 ${b.timely}건)`;
 if(displayedPropagation?.result!==result||displayedPropagation?.kind!==kind)displayedPropagation={result,kind,channel:createPropagation(result.config,result.scene,kind)};
 const channel=displayedPropagation.channel;channel.advance(sceneTime);
 const config=result.config, rcId=result.scene.startLine.rcId;
 const pose=nodeState(config,result.scene.nodes[selected],sceneTime),rc=nodeState(config,result.scene.nodes[rcId],sceneTime);
 const relative=Math.atan2(rc.x-pose.x,rc.y-pose.y)-pose.heading;
 const bearing=Math.round((relative*180/Math.PI%360+360)%360)%360;
 const loss=antennaLoss(config,pose,rc).toFixed(1);
 const path=b.path.length?b.path.map(i=>i<config.boats?String(i+1):result.scene.nodes[i].label).join(' → '):'전달 경로 없음';
 const flow=stats.capped?'':`예정 ${b.scheduled} · 송신 ${b.transmitted} · 수신 ${b.received}${b.received>b.timely?`(정시 ${b.timely})`:''}건 · `;
 const detail=`${flow}장착 ${pose.mountHeight.toFixed(2)}m · RC 방위 ${bearing}° · 방향 손실 ${loss}dB · RSSI ${channel.power(selected,rcId).toFixed(0)}dBm · ${path}`;
 $('boat-detail').textContent=detail;
 $('boat-detail').title=`${detail} · 유효 수직 높이 ${pose.height.toFixed(2)}m · ${(pose.speed/.514444).toFixed(1)}kn · 기울기 ${(pose.roll*180/Math.PI).toFixed(0)}° · 상대방위 0°는 선수`;
}
function canvasContext(canvas){const dpr=Math.min(window.devicePixelRatio||1,2),w=canvas.clientWidth,h=canvas.clientHeight; if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);} const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);return {ctx,w,h};}
function color(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
let hitPoints=[];
function courseClock(seconds){
 const whole=Math.floor(seconds);
 return `${Math.floor(whole/60)}:${String(whole%60).padStart(2,'0')}`;
}
function drawSea(){
 const result=displayResult();if(!result)return;const {ctx,w,h}=canvasContext($('sea'));if(w<90||h<75)return;
 const c=courseReplay?.config ?? result.config,scene=courseReplay?.scene ?? result.scene,stats=result[kind];
 const end=courseReplay?.duration ?? c.duration;
 sceneTime=Math.min(sceneTime,end);
 $('scene-time').max=end;$('scene-time').value=sceneTime;
 $('scene-clock').textContent=courseReplay?`${courseClock(sceneTime)} / ${courseClock(end)}`:`지도 ${sceneTime.toFixed(1)} / ${end.toFixed(1)}초`;
 const {startLine:{pin,rcId},windward,leeward}=scene;
 const nodes=scene.nodes.map(node=>courseReplay?coursePose(node):nodeState(c,node,sceneTime));
 const rc=nodes[rcId];
 const nearStart=c.layout==='ilcaStart';
 const nearGate=c.layout==='ilcaLeeward';
 const fitNodes=nearGate?scene.nodes.slice(0,c.boats+1):scene.nodes;
 const bounds=[pin,...fitNodes,...(courseReplay?.waypoints ?? fitNodes.map(node=>nodeState(c,node,end)))];
 const showWindward=windward&&!nearStart&&!nearGate;
 const showGate=leeward&&!nearStart;
 if(showWindward)bounds.push(windward);
 if(showGate)bounds.push(...leeward.marks);
 const chosenBoat=scene.nodes[selected];
 const hasRunRoute=chosenBoat.leewardEntry!==undefined;
 if(hasRunRoute && !courseReplay)bounds.push(...chosenBoat.courseAhead);
 const xvals=bounds.map(p=>p.x),yvals=bounds.map(p=>p.y);
 const minX=Math.min(...xvals),maxX=Math.max(...xvals),minY=Math.min(...yvals),maxY=Math.max(...yvals);
 const minimumSpan=nearGate?140:c.spacing*3;
 const sx=Math.max(minimumSpan,maxX-minX),sy=Math.max(minimumSpan,maxY-minY),scale=Math.min((w-54)/sx,(h-68)/sy);
 const mx=(minX+maxX)/2,my=(minY+maxY)/2,verticalCenter=h/2+(nearStart?10:-13);
 const X=x=>w/2+(x-mx)*scale,Y=y=>verticalCenter-(y-my)*scale;
 const rcX = X(rc.x), rcY = Y(rc.y);
 const extent = Math.max(...bounds.map(p=>Math.hypot(p.x-rc.x,p.y-rc.y)));
 drawReceiverRanges(ctx,rcX,rcY,scale,extent,w,h);
 if(showWindward && !courseReplay){
  ctx.strokeStyle=color('--map-guide');ctx.globalAlpha=.55;ctx.lineWidth=1;ctx.setLineDash([3,5]);
  ctx.beginPath();ctx.moveTo(X(leeward.x),Y(leeward.y));ctx.lineTo(X(windward.x),Y(windward.y));ctx.stroke();
  ctx.setLineDash([]);ctx.globalAlpha=1;
 }
 if(!courseReplay && !stats.capped && $('show-links').checked){
  const successfulPaths=new Map();
  for(const b of stats.byBoat){for(let i=1;i<b.path.length;i++){const a=b.path[i-1],z=b.path[i];successfulPaths.set(`${a}-${z}`,[a,z]);}}
  ctx.strokeStyle=color('--blue');ctx.lineWidth=.8;ctx.globalAlpha=.18;
  for(const [from,to] of successfulPaths.values()){
   drawPacketHop(ctx,X(nodes[from].x),Y(nodes[from].y),X(nodes[to].x),Y(nodes[to].y),3);
  }
  ctx.globalAlpha=1;
  const chosen=stats.byBoat[selected];
  ctx.strokeStyle=color('--blue');ctx.lineWidth=2;
  for(let i=1;i<chosen.path.length;i++){
   const from=nodes[chosen.path[i-1]],to=nodes[chosen.path[i]];
   drawPacketHop(ctx,X(from.x),Y(from.y),X(to.x),Y(to.y),8);
  }
 }
 if(hasRunRoute){
  if(courseReplay){
   const alternateBranch=courseReplay.branches[chosenBoat.gateSide<0?1:0];
   drawSailingRoute(ctx,alternateBranch,X,Y,gateColor(alternateBranch.gateSide),alternateBranch.leewardEntry);
  }
  drawSailingRoute(ctx,chosenBoat,X,Y,courseReplay?gateColor(chosenBoat.gateSide):'--blue');
 }
 drawStartLine(ctx,X(pin.x),rcX,rcY,rc.x-pin.x,nearStart);
 if(showWindward)drawCourseMark(ctx,X(windward.x),Y(windward.y),'M1 풍상 마크');
 hitPoints=[];ctx.font='11px system-ui';
 for(const node of nodes){
  const x=X(node.x),y=Y(node.y);hitPoints.push({id:node.id,x,y});
  if(node.id===rcId)continue;
  if(node.collector){ctx.fillStyle=color('--blue');ctx.fillRect(x-5,y-5,10,10);ctx.fillStyle=color('--text');ctx.textAlign='left';ctx.fillText(node.label,x+10,y+4);continue;}
  const b=stats.byBoat[node.id],p=b.transmitted?b.timely/b.transmitted:0;
  const missed=!courseReplay&&!stats.capped&&b.transmitted>0&&b.timely===0;
  const fill=color(courseReplay?gateColor(node.gateSide):stats.capped||!b.transmitted?'--muted':p>=.9?'--best':p>0?'--partial':'--worst');
  if(!courseReplay && c.speed>0 && sceneTime>0){
   const initial=scene.nodes[node.id];
   ctx.strokeStyle=fill;ctx.globalAlpha=.55;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(X(initial.x),Y(initial.y));
   for(let i=0;i<node.waypointsPassed;i++)ctx.lineTo(X(initial.courseAhead[i].x),Y(initial.courseAhead[i].y));
   ctx.lineTo(x,y);ctx.stroke();ctx.globalAlpha=1;
  }
  if(!courseReplay && kind==='ble' && node.relay){ctx.strokeStyle=fill;ctx.globalAlpha=.65;ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}
  ctx.save();ctx.translate(x,y);ctx.rotate(node.heading);ctx.scale(Math.max(.35,Math.cos(node.roll)),1);
  ctx.beginPath();ctx.moveTo(0,-5);ctx.lineTo(3.7,4);ctx.lineTo(0,2.5);ctx.lineTo(-3.7,4);ctx.closePath();
  if(missed){ctx.strokeStyle=fill;ctx.lineWidth=1.45;ctx.stroke();}
  else{ctx.fillStyle=fill;ctx.fill();}
  ctx.restore();
  if(node.id===selected){ctx.strokeStyle=color('--text');ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.stroke();ctx.textAlign='left';ctx.fillStyle=color('--text');ctx.fillText(`배 ${node.id+1}`,x+14,y-8);}
  else if(c.boats<=30){ctx.fillStyle=color('--muted');ctx.textAlign='left';ctx.fillText(String(node.id+1),x+8,y+4);}
 }
 if(showGate)drawLeewardGate(ctx,leeward,X,Y,rcY);
 const raw=75/scale,mag=10**Math.floor(Math.log10(raw)),bar=Math.max(mag,Math.floor(raw/mag)*mag),pixels=bar*scale;
 const scaleRight=w-12,scaleLeft=scaleRight-pixels,scaleY=h-10;
 ctx.strokeStyle=color('--muted');ctx.lineWidth=1;ctx.beginPath();
 ctx.moveTo(scaleLeft,scaleY-4);ctx.lineTo(scaleLeft,scaleY);ctx.lineTo(scaleRight,scaleY);ctx.lineTo(scaleRight,scaleY-4);ctx.stroke();
 ctx.fillStyle=color('--muted');ctx.textAlign='center';ctx.fillText(`${fmt(bar)} m`,(scaleLeft+scaleRight)/2,scaleY-8);
 const outcome=stats.capped?'이벤트 한도 초과로 수신 평가 제외.'
  :`기한 내 수신 ${stats.scheduledBoats-stats.missingTimely}척, 송신 후 기한 내 도착 0건 ${stats.missingTimely-stats.unsentBoats}척, 미송신 ${stats.unsentBoats}척. 예정 ${stats.generated}건 중 실제 송신 ${stats.transmitted}건.`;
 const mapDescription=courseReplay?`${$('course-case').textContent} 코스 재생. 경기정 ${c.boats}척.`
  :`${$('map-case').textContent}. ${labels[c.layout]}, ${kind==='ble'?'BLE Mesh':'LoRa'}. ${outcome}`;
 const marksDescription=showGate?` G3 풍하 게이트는 스타트 라인 기준 ${valueLabel('leewardOffset',leeward.y)}. 왼쪽 3S와 오른쪽 3P 사이로 진입합니다.`:'';
 $('sea').setAttribute('aria-label',`${mapDescription} 스타트 라인 왼쪽은 핀마크, 오른쪽은 수신 전용 RC 보트.${showWindward?' 풍상 마크 M1.':''}${marksDescription}`);
}
function gateColor(side){return side<0?'--blue':'--partial';}
function drawCourseMark(ctx,x,y,label,labelY=y+4,align='left'){
 ctx.save();
 ctx.fillStyle=color('--water');ctx.fillRect(x-3.5,y-3.5,7,7);
 ctx.strokeStyle=color('--pin');ctx.lineWidth=1.5;ctx.strokeRect(x-3.5,y-3.5,7,7);
 ctx.fillStyle=color('--text');ctx.font='600 11px system-ui';ctx.textAlign=align;
 const labelX=x+(align==='right'?-8:8);
 ctx.strokeStyle=color('--water');ctx.lineJoin='round';ctx.lineWidth=3;ctx.strokeText(label,labelX,labelY);
 ctx.fillText(label,labelX,labelY);
 ctx.restore();
}
function drawLeewardGate(ctx,gate,X,Y,rcY){
 const y=Y(gate.y),[left,right]=gate.marks;
 const labelY=Math.abs(y-rcY)<23?Math.min(y,rcY)-8:y+4;
 ctx.save();
 ctx.strokeStyle=color('--pin');ctx.lineWidth=1;ctx.setLineDash([2,3]);
 ctx.beginPath();ctx.moveTo(X(left.x),y);ctx.lineTo(X(right.x),y);ctx.stroke();
 ctx.setLineDash([]);
 drawCourseMark(ctx,X(left.x),y,left.label,labelY,'right');
 drawCourseMark(ctx,X(right.x),y,right.label,labelY);
 ctx.restore();
}
function drawSailingRoute(ctx,boat,X,Y,tone,first=0){
 const waypoints=boat.courseAhead.slice(first);
 const origin=first?boat.courseAhead[first-1]:boat;
 ctx.save();
 ctx.strokeStyle=color(tone);ctx.globalAlpha=.78;ctx.lineWidth=1.5;ctx.setLineDash([4,4]);
 ctx.beginPath();ctx.moveTo(X(origin.x),Y(origin.y));
 for(const waypoint of waypoints)ctx.lineTo(X(waypoint.x),Y(waypoint.y));
 ctx.stroke();ctx.setLineDash([]);
 let from=origin;
 for(const to of waypoints){
  const x=X(from.x), y=Y(from.y),dx=X(to.x)-x,dy=Y(to.y)-y;
  if(Math.hypot(dx,dy)>32)drawPacketHop(ctx,x+dx*.33,y+dy*.33,x+dx*.67,y+dy*.67,3);
  from=to;
 }
 ctx.restore();
}
function drawReceiverRanges(ctx, x, y, scale, extent, width, height) {
 const wanted = Math.max(extent/4, 46/scale);
 const order = 10**Math.floor(Math.log10(wanted));
 const step = [1,2,2.5,5,10].map(v=>v*order).reduce((nearest,v)=>
  Math.abs(v-wanted)<Math.abs(nearest-wanted)?v:nearest);
 ctx.save();
 ctx.strokeStyle=color('--map-line');
 ctx.fillStyle=color('--map-guide');
 ctx.lineWidth=1;
 ctx.font='11px system-ui';
 ctx.textAlign='left';
 for(let i=1;i<=4;i++){
  const distance=step*i, radius=distance*scale;
  if(distance>extent*1.12)break;
  ctx.beginPath();ctx.arc(x,y,radius,0,2*Math.PI);ctx.stroke();
  const labelX=x+radius*.28,labelY=y-radius*Math.sqrt(1-.28**2)-5;
  if(labelX<width-62 && labelY>17 && labelY<height-25){
   ctx.fillText(`${i===1?'RC ':''}${fmt(distance)} m`,labelX+4,labelY);
  }
 }
 ctx.restore();
}
function drawPacketHop(ctx, fromX, fromY, toX, toY, arrowSize) {
 const dx=toX-fromX,dy=toY-fromY;
 const length=Math.hypot(dx,dy);
 ctx.beginPath();
 ctx.moveTo(fromX,fromY);
 ctx.lineTo(toX,toY);
 if(length>arrowSize*3){
  // Put the arrow before the receiver icon so it remains visible on overlapping links.
  const ux=dx/length,uy=dy/length;
  const x=toX-dx*.28,y=toY-dy*.28;
  const baseX=x-ux*arrowSize,baseY=y-uy*arrowSize,wing=arrowSize*.58;
  ctx.moveTo(baseX-uy*wing,baseY+ux*wing);
  ctx.lineTo(x,y);
  ctx.lineTo(baseX+uy*wing,baseY-ux*wing);
 }
 ctx.stroke();
}
function drawStartLine(ctx, left, right, y, length, labelsAbove) {
 const pinTone=color('--pin'), rcTone=color('--blue');
 const labelY=labelsAbove?y-14:y+21;
 ctx.lineWidth=1.5;
 ctx.strokeStyle=color('--text');
 ctx.setLineDash([7,4]);
 ctx.beginPath();
 ctx.moveTo(left,y);
 ctx.lineTo(right,y);
 ctx.stroke();
 ctx.setLineDash([]);

 if(right-left<94){
  const center=(left+right)/2;
  ctx.font='700 11px system-ui';
  for(const [endpoint,labelX,tone,label,align] of [[left,center-10,pinTone,'핀마크','right'],[right,center+10,rcTone,'RC · 수신','left']]){
   ctx.strokeStyle=ctx.fillStyle=tone;
   ctx.lineWidth=1;
   ctx.fillRect(endpoint-1,y-2,2,4);
   ctx.beginPath();
   ctx.moveTo(endpoint,y);
   ctx.lineTo(labelX,labelsAbove?y-8:y+13);
   ctx.stroke();
   ctx.textAlign=align;
   ctx.fillText(label,labelX,labelY);
  }
  return;
 }

 ctx.fillStyle=pinTone;
 ctx.beginPath();
 ctx.moveTo(left,y-7);
 ctx.lineTo(left+6,y);
 ctx.lineTo(left,y+7);
 ctx.lineTo(left-6,y);
 ctx.closePath();
 ctx.fill();

 ctx.fillStyle=rcTone;
 ctx.beginPath();
 ctx.moveTo(right,y-9);
 ctx.lineTo(right+7,y-2);
 ctx.lineTo(right+6,y+7);
 ctx.lineTo(right-6,y+7);
 ctx.lineTo(right-7,y-2);
 ctx.closePath();
 ctx.fill();
 ctx.fillStyle=color('--water');
 ctx.fillRect(right-3,y-1,6,5);

 ctx.font='700 11px system-ui';
 ctx.fillStyle=pinTone;
 ctx.textAlign='left';
 ctx.fillText('핀마크',left-8,labelY);
 ctx.fillStyle=rcTone;
 ctx.textAlign='right';
 ctx.fillText('RC 보트 · 수신',right+8,labelY);
 if(right-left>175){
  ctx.fillStyle=color('--text');
  ctx.textAlign='center';
  ctx.fillText(`스타트 라인 · ${fmt(length)}m`,(left+right)/2,labelY);
 }
}
$('sea').addEventListener('click',e=>{const rect=$('sea').getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;const result=displayResult();if(!result)return;let nearest=null,d=20;for(const p of hitPoints){const distance=Math.hypot(p.x-x,p.y-y);if(p.id<result.config.boats && distance<d){nearest=p.id;d=distance;}}if(nearest!==null){selected=nearest;$('boat-select').value=selected;showBoat();drawSea();}});
const historyCanvases=document.querySelectorAll('.history-canvas');
const historyPoints=new WeakMap();
function drawHistory(){
 const list=records.slice(-200);
 for(const canvas of historyCanvases)drawHistoryChart(canvas,list);
}
function drawHistoryChart(canvas,list){
 historyPoints.delete(canvas);
 if(canvas.clientWidth<60||canvas.clientHeight<50)return;
 const {ctx,w,h}=canvasContext(canvas),left=38,right=w-12,top=12,bottom=h-21;
 const ticks=h<82?[0,1]:[0,.5,1];
 ctx.font='11px system-ui';ctx.strokeStyle=color('--border');ctx.fillStyle=color('--muted');ctx.lineWidth=.7;
 for(const v of ticks){const y=bottom-(bottom-top)*v;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.textAlign='right';ctx.fillText(`${v*100}%`,left-7,y+4);}
 if(!list.length){
  ctx.textAlign='center';ctx.fillText('평가 대기',(left+right)/2,(top+bottom)/2-7);
  return;
 }
 const low=list[0].iteration,high=Math.max(low+1,list.at(-1).iteration),X=i=>left+(i-low)/(high-low)*(right-left),Y=v=>bottom-v*(bottom-top);
 ctx.strokeStyle=color('--best');ctx.lineWidth=1.5;ctx.beginPath();let begun=false;
 for(const r of list){if(r.best===null)continue;begun?ctx.lineTo(X(r.iteration),Y(r.best)):ctx.moveTo(X(r.iteration),Y(r.best));begun=true;}
 ctx.stroke();
 const points=[];
 ctx.fillStyle=color('--blue');ctx.strokeStyle=color('--worst');ctx.lineWidth=1.25;
 for(const r of list){if(r.score===null)continue;const p={x:X(r.iteration),y:Y(r.score),record:r};points.push(p);ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);if(r.rank.feasible)ctx.fill();else ctx.stroke();}
 if(!points.length){
  ctx.fillStyle=color('--muted');ctx.textAlign='center';ctx.fillText('표시할 도착률 없음',(left+right)/2,(top+bottom)/2-7);
 }
 const selectedPoint=view==='replay' && !replay?.snapshot && points.find(p=>p.record.iteration===replay?.iteration);
 if(selectedPoint){
  ctx.strokeStyle=color('--text');ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(selectedPoint.x,selectedPoint.y,5,0,Math.PI*2);ctx.stroke();
 }
 historyPoints.set(canvas,points);
 ctx.fillStyle=color('--muted');ctx.textAlign='left';ctx.fillText(`#${low}`,left,h-6);
 if(list.length>1){ctx.textAlign='right';ctx.fillText(`#${list.at(-1).iteration} 평가`,right,h-6);}
}
function replayHistoryPoint(event){
 const canvas=event.currentTarget,points=historyPoints.get(canvas);
 if(busy || !points?.length)return;
 const x=event.clientX-canvas.getBoundingClientRect().left;
 const picked=points.reduce((a,b)=>Math.abs(a.x-x)<Math.abs(b.x-x)?a:b).record;
 replayCase(picked);
}
async function replayCase(picked,fromSnapshot=false){
 stop();busy=true;updateButtons();const token=generation;
 try{const data=await request(picked.config);if(token!==generation)return;replay={...data.result,rank:fromSnapshot?rankResult(data.result,picked.target):picked.rank,iteration:picked.iteration,proposal:picked.proposal,acceptance:picked.acceptance,snapshot:fromSnapshot?picked:null};
 const select=$('case-view');const label=fromSnapshot?'스냅샷 다시 보기':'이력 다시 보기';
 const option=select.querySelector('option[value="replay"]');
 if(option)option.textContent=label;else select.add(new Option(label,'replay'));
 view='replay';select.value=view;
 if(narrowLayout.matches)selectTab('map');
 if(fromSnapshot&&picked.target!=='both')switchKind(picked.target);
 else render();
 }catch(error){showError(error.message);}finally{busy=false;updateButtons();if(needBaseline)stepSearch();}
}
for(const canvas of historyCanvases)canvas.addEventListener('click',replayHistoryPoint);
$('open-history').onclick=()=>{$('tab-history').click();$('tab-history').focus();};
$('validate').onclick=async()=>{
 const result=displayResult();if(!result || busy)return;stop();busy=validating=true;updateButtons();const token=generation,values=[];
 try{for(let i=0;i<5;i++){ $('validation-result').textContent=`다른 시드 검증 ${i+1}/5`;const data=await request({...result.config,seed:result.config.seed+(i+1)*104729});if(token!==generation)return;const rank=rankResult(data.result,target);if(rank)values.push(rank);}
 if(values.length){const range=(key,f)=>`${f(Math.min(...values.map(v=>v[key])))}–${f(Math.max(...values.map(v=>v[key])))}`;$('validation-result').textContent=`조건 #${result.iteration} · 다른 ${values.length}개 시드 · 미갱신 ${range('missing',String)}척 · 공백 ${range('gap',v=>v.toFixed(2))}초 · 도착률 ${range('pdr',pct)}`;}else $('validation-result').textContent=`조건 #${result.iteration} 계산 한도 초과 · 검증 결과 없음`;
 }catch(error){showError(error.message);}finally{busy=validating=false;updateButtons();if(needBaseline)stepSearch();}
};
$('export').onclick=async()=>{
 const summary = record => record ? {config:record.config,score:record.score,rank:record.rank,iteration:record.iteration} : null;
 const data={modelVersion:MODEL_VERSION,createdAt:new Date().toISOString(),base,keys:[...keys],searchLimits,target,mode:$('search-mode').value,strategy:$('strategy').value,paceMs:Number($('pace').value),current:displayResult()?.config,best:summary(explorer.best),records};
 const filename=`radio-search-${Date.now()}.json`,contents=JSON.stringify(data,null,2);
 if(desktopInvoke){
  try{await desktopInvoke('save_record',{filename,contents});}
  catch(error){showError(error.message ?? String(error));}
  return;
 }
 const blob=new Blob([contents],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
};
function importRecord(contents){
 const data=JSON.parse(contents);
 if(!['0.1.0','0.2.0','0.3.0','0.4.0','0.5.0','0.6.0','0.7.0','0.8.0','0.8.1','0.9.0','0.9.2',MODEL_VERSION].includes(data?.modelVersion) || !data.current && !data.base)throw new Error('지원하는 모델 버전의 탐색 기록이 아닙니다.');
 const loadedKeys=Array.isArray(data.keys)?data.keys:defaultKeys;
 base=normalize({antennaShadow:0,boatHeight:1.2,boatHeightSpread:0,...(data.current||data.base),duration:1,deadline:1});keys=new Set(loadedKeys.filter(k=>configurableKeys.has(k)));searchLimits=normalizeSearchLimits(data.searchLimits);target=['both','lora','ble'].includes(data.target)?data.target:'both';$('objective').value=target;
 $('strategy').value=['hybrid','sequential','local','random'].includes(data.strategy)?data.strategy:'random';$('search-mode').value=data.mode==='repeat'?'repeat':'best';
 if([100,200,500,1000,2000,5000].includes(data.paceMs))$('pace').value=data.paceMs;
 for(const key of Object.keys(SPACE))if($('auto-'+key))$('auto-'+key).checked=keys.has(key);
 resetSearch();$('validation-result').textContent='저장한 조건을 불러왔습니다. 새 탐색으로 재평가합니다.';
}
$('import').onclick=async()=>{
 if(!desktopInvoke){$('import-file').click();return;}
 try{
  const contents=await desktopInvoke('open_record');
  if(contents!==null)importRecord(contents);
 }catch(error){showError(error.message ?? String(error));}
};
$('import-file').onchange=async()=>{
 const file=$('import-file').files[0];if(!file)return;
 try{
  if(file.size>5e6)throw new Error('5MB 이하 기록을 선택해 주세요.');
  importRecord(await file.text());
 }catch(error){showError(error.message);}finally{$('import-file').value='';}
};
const observer=new ResizeObserver(()=>{if(!fastSession){drawSea();drawHistory();}});observer.observe($('sea'));
for(const canvas of historyCanvases)observer.observe(canvas);
resetSearch();
loadValidationSnapshot();
