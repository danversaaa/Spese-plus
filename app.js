import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  initializeAuth, onAuthStateChanged,
  signInWithEmailAndPassword, signOut, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, addDoc, deleteDoc, updateDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const badConfig = Object.values(firebaseConfig).some(v => String(v).includes("INCOLLA_"));
if (badConfig) {
  document.body.innerHTML = `<div style="max-width:760px;margin:50px auto;font-family:system-ui;padding:20px">
  <h1>Configurazione Firebase mancante</h1>
  <p>Apri <b>firebase-config.js</b> e incolla la configurazione Web App del tuo progetto Firebase.</p>
  <p>Nel pacchetto trovi <b>LEGGIMI_FIREBASE.txt</b> con i passaggi esatti.</p></div>`;
  throw new Error("Firebase non configurato");
}

const fb = initializeApp(firebaseConfig);
// Auth minimale: Casa+ usa solo email/password, quindi evitiamo le dipendenze
// per popup/redirect caricate da getAuth(). La persistenza locale è configurata
// direttamente all'inizializzazione e non viene più attesa a ogni login.
const auth = initializeAuth(fb,{persistence:browserLocalPersistence});
// Configura questo UID dopo aver creato l’unico account in Firebase Authentication.
const OWNER_UID = "L4fFMpxAl1RWVc8wdjxRqlwdMzl2";


// Cache Firestore persistente: al riavvio i dati già letti possono comparire
// dalla cache locale mentre Firestore aggiorna in background.
let db;
try{
  db=initializeFirestore(fb,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})});
}catch(err){
  console.warn("Cache Firestore persistente non disponibile, uso cache memoria",err);
  db=getFirestore(fb);
}

const authView = document.querySelector("#authView");
const appView = document.querySelector("#appView");
const pageEl = document.querySelector("#page");
const titleEl = document.querySelector("#pageTitle");
const syncEl = document.querySelector("#syncStatus");
const modal = document.querySelector("#modal");
const yearSelect = document.querySelector("#yearSelect");

let registerMode = false;
let user = null;
let page = "dashboard";
let selectedYear = new Date().getFullYear();
let utilitySummaryYear = selectedYear;
let unsubscribers = [];
let syncRenderTimer = null;
let state = { bills:[], expenses:[], incomes:[] };
let readingsUtilityFilter = "Tutte";
let billUtilityFilter = "Luce";

const utilities = ["Luce"];
const readingUtilities = ["Luce","Acqua","Gas"];
const readingUnits = ["kWh","m³","Smc"];
const statuses = ["Pagata","Da pagare","Scaduta","Rateizzata","Contestata"];
const months = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
const euro = new Intl.NumberFormat("it-IT",{style:"currency",currency:"EUR"});

function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function money(v){return euro.format(Number(v||0))}
function fmtDate(s){if(!s)return "—";const [y,m,d]=s.split("-");return d?`${d}/${m}/${y}`:s}
function fmtReadingDate(s){
  if(!s)return "—";
  const parts=String(s).split("-");
  if(parts.length!==3)return s;
  const [y,m,d]=parts.map(Number);
  const dt=new Date(y,m-1,d);
  if(Number.isNaN(dt.getTime()))return s;
  return new Intl.DateTimeFormat("it-IT",{day:"numeric",month:"long",year:"numeric"}).format(dt);
}
const monthNamesLong=["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];
function normalizeMonthKey(s){
  const v=String(s||"");
  const m=v.match(/^(\d{4})-(\d{2})/);
  if(!m)return "";
  const mm=Number(m[2]);
  return mm>=1&&mm<=12?`${m[1]}-${m[2]}`:"";
}
function splitMonthKey(key){
  const k=normalizeMonthKey(key);
  if(!k)return {year:"",month:""};
  const [year,month]=k.split("-");
  return {year:Number(year),month:Number(month)};
}
function buildMonthKey(year,month){
  if(!year||!month)return "";
  return `${Number(year)}-${String(Number(month)).padStart(2,"0")}`;
}
function monthIndex(key){
  const k=normalizeMonthKey(key);if(!k)return null;
  const [y,m]=k.split("-").map(Number);return y*12+(m-1);
}
function monthLabel(key){
  const k=normalizeMonthKey(key);if(!k)return "";
  const [y,m]=k.split("-").map(Number);return `${months[m-1].toUpperCase()} ${y}`;
}
function effectivePeriodEnd(start,end){
  const s=normalizeMonthKey(start),e=normalizeMonthKey(end);
  return s&&!e?s:e;
}
function validPeriod(start,end){
  const s=normalizeMonthKey(start);
  if(!s)return false;
  const a=monthIndex(s),b=monthIndex(effectivePeriodEnd(s,end));
  return a!==null&&b!==null&&a<=b;
}
function periodMonths(start,end){
  if(!validPeriod(start,end))return [];
  const s=normalizeMonthKey(start),e=effectivePeriodEnd(s,end);
  const a=monthIndex(s),b=monthIndex(e),out=[];
  for(let x=a;x<=b;x++){
    const y=Math.floor(x/12),m=x%12+1;
    out.push({anno:y,mese:m,key:`${y}-${String(m).padStart(2,"0")}`});
  }
  return out;
}
function monthOnlyOptions(selected="",allowBlank=true){
  const sel=Number(selected)||0;
  let html=allowBlank?'<option value="">Mese…</option>':"";
  for(let m=1;m<=12;m++){
    html+=`<option value="${m}" ${m===sel?"selected":""}>${monthNamesLong[m-1]}</option>`;
  }
  return html;
}
function yearOnlyOptions(selected="",allowBlank=true){
  const sel=Number(selected)||0,currentYear=new Date().getFullYear();
  let html=allowBlank?'<option value="">Anno…</option>':"";
  for(let y=currentYear+3;y>=currentYear-8;y--){
    html+=`<option value="${y}" ${y===sel?"selected":""}>${y}</option>`;
  }
  return html;
}
function formatPeriod(b){
  const s=normalizeMonthKey(b.periodoInizio),e=normalizeMonthKey(b.periodoFine);
  if(validPeriod(s,e)){
    const finalEnd=effectivePeriodEnd(s,e);
    return s===finalEnd?monthLabel(s):`${monthLabel(s)} – ${monthLabel(finalEnd)}`;
  }
  return b.periodo||"—";
}
function automaticCompetences(start,end,amount){
  const p=periodMonths(start,end),total=Number(amount||0);
  if(!p.length||!Number.isFinite(total)||total<0)return [];
  const totalCents=Math.round(total*100),base=Math.floor(totalCents/p.length),rem=totalCents%p.length;
  const byYear={};
  p.forEach((x,i)=>{
    const cents=base+(i<rem?1:0);
    if(!byYear[x.anno])byYear[x.anno]={anno:x.anno,importo:0,mesi:0};
    byYear[x.anno].importo+=cents/100;
    byYear[x.anno].mesi+=1;
  });
  return Object.values(byYear).map(x=>({...x,importo:Math.round(x.importo*100)/100}));
}
function monthlyCompetenceAmount(b,year,month){
  const annual=competenceAmount(b,year);
  if(!annual)return 0;
  if(!validPeriod(b.periodoInizio,b.periodoFine))return Number(b.mese)===Number(month)?annual:0;
  const inYear=periodMonths(b.periodoInizio,b.periodoFine).filter(x=>Number(x.anno)===Number(year));
  if(!inYear.some(x=>Number(x.mese)===Number(month)))return 0;
  return annual/inYear.length;
}
function sum(a,key="importo"){return a.reduce((x,o)=>x+Number(o[key]||0),0)}
function isPaid(b){return String(b.stato||"").trim().toLowerCase()==="pagata"}
function isOverdue(b){return !isPaid(b)&&b.scadenza&&new Date(b.scadenza+"T23:59:59")<new Date()}
function billCompetences(b){
  const rows=Array.isArray(b.competenze)?b.competenze.map(c=>({anno:Number(c?.anno),importo:Number(c?.importo||0)})).filter(c=>Number.isFinite(c.anno)&&c.anno>1900&&Number.isFinite(c.importo)&&c.importo>=0):[];
  if(rows.length)return rows;
  const y=Number(b.anno),v=Number(b.importo||0);
  return Number.isFinite(y)&&y>1900?[{anno:y,importo:v}]:[];
}
function competenceAmount(b,year){return billCompetences(b).filter(c=>Number(c.anno)===Number(year)).reduce((a,c)=>a+Number(c.importo||0),0)}
function hasCompetenceYear(b,year){return billCompetences(b).some(c=>Number(c.anno)===Number(year))}
function paymentYear(b){const s=String(b.dataPagamento||"");return /^\d{4}-/.test(s)?Number(s.slice(0,4)):null}
function formatCompetences(b){const c=billCompetences(b);return c.length?c.map(x=>`${x.anno}: ${money(x.importo)}`).join(" · "):"—"}
function utilIcon(u){
  const k=String(u||"").toLowerCase();
  const common='viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  if(k.includes('luce')||k.includes('elettr'))return `<svg class="uicon-svg" ${common}><path d="M9 18h6"/><path d="M10 22h4"/><path d="M8.2 15.2A7 7 0 1 1 15.8 15.2C14.7 16.1 14 17 14 18h-4c0-1-.7-1.9-1.8-2.8Z"/></svg>`;
  if(k.includes('acqua'))return `<svg class="uicon-svg" ${common}><path d="M12 2.5S6.5 9 6.5 14a5.5 5.5 0 0 0 11 0c0-5-5.5-11.5-5.5-11.5Z"/><path d="M9.5 15.5c.4 1.2 1.3 1.8 2.5 1.9"/></svg>`;
  if(k.includes('gas'))return `<svg class="uicon-svg" ${common}><path d="M13.2 2.5c.7 3.6-2.8 5.2-2.1 8.2.3 1.4 1.3 2.3 2.5 2.3 1.7 0 2.8-1.7 2.5-3.8 2.5 2.4 3.5 5.2 2.4 7.9-1.1 2.8-3.6 4.4-6.6 4.4-3.9 0-6.8-2.7-6.8-6.5 0-4.5 3.2-7.5 8.1-12.5Z"/><path d="M12.1 21.3c-1.7-1.1-2.5-2.5-2.1-4 .3-1.1 1.2-2 2.5-3.1-.1 1.8 1.9 2.2 1.9 4 0 1.3-.8 2.4-2.3 3.1Z"/></svg>`;
  if(k.includes('fibra')||k.includes('internet')||k.includes('telefono'))return `<svg class="uicon-svg" ${common}><path d="M3.5 9.5a13 13 0 0 1 17 0"/><path d="M6.8 13a8 8 0 0 1 10.4 0"/><path d="M10 16.5a3 3 0 0 1 4 0"/><circle cx="12" cy="20" r=".8" fill="currentColor" stroke="none"/></svg>`;
  if(k.includes('tari')||k.includes('rifiut'))return `<svg class="uicon-svg" ${common}><path d="M4 7h16"/><path d="M9 7l1-3h4l1 3"/><path d="M7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></svg>`;
  if(k.includes('condominio'))return `<svg class="uicon-svg" ${common}><path d="M5 21V5l7-3 7 3v16"/><path d="M8 7h1M8 11h1M8 15h1M15 7h1M15 11h1M15 15h1"/><path d="M10 21v-4h4v4"/></svg>`;
  return `<svg class="uicon-svg" ${common}><circle cx="12" cy="12" r="7"/><path d="M12 8v4l2.5 2"/></svg>`;
}
function badge(s){const c=s==="Pagata"?"good":s==="Da pagare"?"warn":s==="Scaduta"?"bad":"";return `<span class="badge ${c}">${esc(s||"Bozza")}</span>`}
function parseEuroFromText(v){
  const m=String(v||"").match(/(?:€\s*)?(\d{1,4}(?:\.\d{3})*,\d{2}|\d{1,4}[.,]\d{2})/);
  if(!m)return null;
  const n=Number(m[1].replace(/\./g,"").replace(",","."));
  return Number.isFinite(n)?n:null;
}
function normalizeBillRecord(raw){
  const b={...raw};
  // Compatibilità con documenti creati dalle versioni precedenti dell'app.
  b.utenza=b.utenza||b.utility||b.tipo||"Altro";
  b.importo=(b.importo??b.amount??b.totale??null);
  b.stato=b.stato||b.status||b.paymentStatus||"";
  b.dataPagamento=b.dataPagamento||b.paymentDate||b.data_pagamento||b.paidDate||"";
  b.scadenza=b.scadenza||b.dueDate||b.dataScadenza||"";
  b.dataEmissione=b.dataEmissione||b.issueDate||b.data||"";
  b.note=b.note||b.notes||"";
  b.periodo=b.periodo||b.period||"";
  b.metodo=b.metodo||b.paymentMethod||"";

  // Lo stato salvato dall'utente è sempre autorevole.
  // Non forziamo lo stato in base a utenza, importo, anno o scadenza.
  const amount=Number(b.importo);
  const u=String(b.utenza||"").toLowerCase();

  // Correzioni confermate dall'utente per settembre 2026. Si applicano solo
  // alle due vecchie bollette identificabili in modo univoco dai loro dati.
  if(!isPaid(b) && u==="acqua" && Math.abs(amount-48.07)<0.001 && String(b.scadenza)==="2026-08-31"){
    b.stato="Pagata";b.dataPagamento="2026-09-16";
    // Mantiene la competenza originale della bolletta (Acqua: luglio 2026),
    // ma garantisce che il riepilogo annuale la includa correttamente.
    b.anno=2026;b.mese=Number(b.mese)||7;b.competenze=[{anno:2026,importo:amount}];b._compatRecovered=true;
  }
  if(!isPaid(b) && u==="fibra" && Math.abs(amount-27.95)<0.001 && String(b.scadenza)==="2026-08-27"){
    b.stato="Pagata";b.dataPagamento="2026-09-16";
    // Fibra resta di competenza agosto 2026; il pagamento è settembre.
    b.anno=2026;b.mese=Number(b.mese)||8;b.competenze=[{anno:2026,importo:amount}];b._compatRecovered=true;
  }
  return b;
}
function pathFor(name){return collection(db,"users",user.uid,name)}
function docFor(name,id){return doc(db,"users",user.uid,name,id)}

document.querySelector("#tabLogin").onclick=()=>setAuthMode(false);

function setAuthMode(reg){
  registerMode=false;
  document.querySelector("#tabLogin").classList.toggle("active",!reg);

  document.querySelector("#authSubmit").textContent="Accedi";
}
document.querySelector("#authForm").onsubmit=async e=>{
  e.preventDefault();
  const email=document.querySelector("#email").value.trim();
  const password=document.querySelector("#password").value;
  const msg=document.querySelector("#authMsg");
  const submit=document.querySelector("#authSubmit");
  msg.textContent="Accesso in corso…";
  submit.disabled=true;
  const defaultLabel="Accedi";
  submit.textContent="Accesso…";
  try{
    await signInWithEmailAndPassword(auth,email,password);
    msg.textContent="Accesso riuscito. Caricamento dati…";
  }catch(err){
    console.error("Errore Firebase Auth",err);
    msg.textContent=translateAuthError(err?.code||"errore-sconosciuto");
  }finally{
    submit.disabled=false;
    if(!user) submit.textContent=defaultLabel;
  }
};
document.querySelector("#logoutBtn").onclick=()=>signOut(auth);
function translateAuthError(code){
  if(code?.includes("invalid-credential"))return "Email o password non corretti.";
  if(code?.includes("email-already-in-use"))return "Questa email è già registrata.";
  if(code?.includes("weak-password"))return "Usa una password di almeno 6 caratteri.";
  if(code?.includes("network-request-failed"))return "Problema di rete. Controlla la connessione e riprova.";
  if(code?.includes("too-many-requests"))return "Troppi tentativi ravvicinati. Attendi qualche minuto e riprova.";
  if(code?.includes("user-disabled"))return "Questo account è stato disabilitato.";
  if(code?.includes("operation-not-allowed"))return "Accesso Email/Password non abilitato in Firebase Authentication.";
  return "Errore di accesso: "+code;
}

onAuthStateChanged(auth, u=>{
  unsubscribers.forEach(x=>x());unsubscribers=[];
  user=u;
  if(!u){authView.classList.remove("hidden");appView.classList.add("hidden");return}
  if(OWNER_UID === "INSERISCI_UID_COGNATO" || u.uid !== OWNER_UID){
    authView.classList.remove("hidden");appView.classList.add("hidden");
    document.querySelector("#authMsg").textContent=OWNER_UID === "INSERISCI_UID_COGNATO"
      ? "Configurazione iniziale incompleta: imposta l’UID autorizzato."
      : "Account non autorizzato.";
    signOut(auth);return;
  }
  document.querySelector("#authMsg").textContent="";
  authView.classList.add("hidden");appView.classList.remove("hidden");
  // Mostra subito l’interfaccia; i dati Firestore arrivano in background.
  render();
  subscribeAll();
});

function subscribeAll(){
  syncEl.textContent="Sincronizzazione cloud…";
  ["bills","expenses","incomes"].forEach(name=>{
    const un=onSnapshot(pathFor(name), snap=>{
      state[name]=snap.docs.map(d=>{const row={id:d.id,...d.data()};return name==="bills"?normalizeBillRecord(row):row;});
      syncEl.textContent="Dati sincronizzati";
      refreshYears();
      clearTimeout(syncRenderTimer);
      syncRenderTimer=setTimeout(()=>render(),35);
    }, err=>{syncEl.textContent="Errore sincronizzazione";console.error(err)});
    unsubscribers.push(un);
  });
}

function refreshYears(){
  const years=[];
  state.bills.forEach(b=>{billCompetences(b).forEach(c=>years.push(Number(c.anno)));const py=paymentYear(b);if(py)years.push(py)});
  [...state.expenses,...state.incomes].forEach(x=>{const y=Number(String(x.date||"").slice(0,4));if(y)years.push(y)});
  years.push(new Date().getFullYear());
  years.push(selectedYear);
  const ys=[...new Set(years.filter(Boolean))].sort((a,b)=>b-a);
  if(!ys.includes(selectedYear))selectedYear=ys[0];
  if(!ys.includes(utilitySummaryYear))utilitySummaryYear=selectedYear;
  yearSelect.innerHTML=ys.map(y=>`<option ${y===selectedYear?"selected":""}>${y}</option>`).join("");
}
yearSelect.onchange=e=>{selectedYear=Number(e.target.value);render()};
function availableBillYears(){
  const years=[];
  state.bills.forEach(b=>{billCompetences(b).forEach(c=>years.push(Number(c.anno)));const py=paymentYear(b);if(py)years.push(py)});
  years.push(new Date().getFullYear(),utilitySummaryYear);
  return [...new Set(years.filter(Boolean))].sort((a,b)=>b-a);
}
function utilitySummaryYearOptions(){return availableBillYears().map(y=>`<option value="${y}" ${Number(y)===Number(utilitySummaryYear)?'selected':''}>${y}</option>`).join('')}
window.changeUtilitySummaryYear=value=>{utilitySummaryYear=Number(value)||new Date().getFullYear();selectedYear=utilitySummaryYear;ensureYearInSelector(selectedYear);renderDashboard()};

function setActiveNav(){
  document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));
  const direct=document.querySelector(`nav button[data-page="${page}"]`);
  if(direct) direct.classList.add("active");
  else if(["statistiche","impostazioni"].includes(page)){
    document.querySelector('nav button[data-page="altro"]')?.classList.add("active");
  }
}
window.goPage=p=>{
  if(!["dashboard","spese","entrate","bollette","statistiche","impostazioni","altro"].includes(p))p="dashboard";
  if(p==="bollette"){billHomeScope=null;billStatusTab="all";}
  page=p;setActiveNav();render();window.scrollTo({top:0,behavior:"smooth"});
};
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  if(b.dataset.action==="newbill"){window.openQuickAdd();return}
  if(b.dataset.page)window.goPage(b.dataset.page);
});
window.openQuickAdd=()=>showModal(`<div class="modal-head"><h2>Aggiungi</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="quick-add-grid quick-add-two"><button onclick="window.closeModal();window.editExpense()"><b>+ Nuova spesa</b></button><button onclick="window.closeModal();window.editIncome()"><b>+ Nuova entrata</b></button><button onclick="window.closeModal();window.editBill()"><b>+ Bolletta luce</b></button></div>`);

function render(){
  if(!user)return;
  document.body.dataset.page=page;
  titleEl.textContent=({dashboard:"Spese+",bollette:"Bollette Luce",spese:"Spese",entrate:"Entrate",statistiche:"Statistiche",impostazioni:"Impostazioni",altro:"Altro"})[page]||"Spese+";
  ({dashboard:renderFinanceDashboard,bollette:renderBills,spese:renderExpenses,entrate:renderIncomes,statistiche:renderFinanceStats,impostazioni:renderFinanceSettings,altro:renderFinanceMore})[page]();
}
function yearBills(){return state.bills.filter(b=>hasCompetenceYear(b,selectedYear))}
function monthDivisor(){const n=new Date(),y=selectedYear;if(y<n.getFullYear())return 12;if(y>n.getFullYear())return 1;return n.getMonth()+1}

function paymentMonth(b){
  const s=String(b.dataPagamento||"");
  const m=s.match(/^(\d{4})-(\d{2})/);
  return m?{year:Number(m[1]),month:Number(m[2])}:null;
}
function paidInMonth(b,year,month){const p=paymentMonth(b);return isPaid(b)&&p&&p.year===Number(year)&&p.month===Number(month)}
function currentMonthAmount(b,year,month){return monthlyCompetenceAmount(b,year,month)}

function parseConsumptionNumber(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  let s=String(value).trim().replace(/\s/g,'');
  if(!s)return null;
  // Formati italiani: 1.234,56 / 391,5. Formati standard: 1234.56.
  if(s.includes(',')&&s.includes('.'))s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(','))s=s.replace(',','.');
  s=s.replace(/[^0-9.+-]/g,'');
  const n=Number(s);
  return Number.isFinite(n)?n:null;
}
function billPeriodSortKey(b){
  const end=effectivePeriodEnd(b.periodoInizio,b.periodoFine);
  if(end)return `${end}-31`;
  const start=normalizeMonthKey(b.periodoInizio);
  if(start)return `${start}-31`;
  if(/^\d{4}-\d{2}-\d{2}/.test(String(b.dataEmissione||'')))return String(b.dataEmissione).slice(0,10);
  if(/^\d{4}-\d{2}-\d{2}/.test(String(b.scadenza||'')))return String(b.scadenza).slice(0,10);
  const y=Number(b.anno),m=Number(b.mese);
  if(Number.isFinite(y)&&y>1900&&Number.isFinite(m)&&m>=1&&m<=12)return `${y}-${String(m).padStart(2,'0')}-31`;
  return '';
}
function percentageChange(current,previous){
  const cur=parseConsumptionNumber(current),prev=parseConsumptionNumber(previous);
  if(cur===null||prev===null||cur<=0||prev<=0)return null;
  return Math.round(((cur-prev)/prev)*100);
}
function billConsumptionTrend(utility){
  const key=String(utility||'').toLowerCase();
  const arr=state.bills
    .filter(b=>String(b.utenza||'').toLowerCase()===key)
    .map(b=>({b,value:parseConsumptionNumber(b.consumo),sortKey:billPeriodSortKey(b)}))
    .filter(x=>x.value!==null&&x.value>0&&x.sortKey)
    .sort((a,b)=>b.sortKey.localeCompare(a.sortKey));
  if(arr.length<2)return null;
  return percentageChange(arr[0].value,arr[1].value);
}
function readingTrend(utility){
  const key=String(utility||'').toLowerCase();
  // Luce e Gas: la Home confronta prima di tutto i consumi delle ultime due bollette.
  // È la stessa fonte mostrata/modificata nella sezione Bollette.
  if(key==='luce'||key==='gas'){
    const billTrend=billConsumptionTrend(utility);
    if(billTrend!==null)return billTrend;
  }
  // Acqua (e fallback Luce/Gas): usa le letture contatore. Per l'acqua
  // confrontiamo le medie giornaliere ricalcolate, per periodi di durata diversa.
  const isWater=key==='acqua';
  const metric=r=>{
    if(isWater){
      const wm=waterMetrics(r);
      return parseConsumptionNumber(wm.mediaRaw ?? wm.media);
    }
    return parseConsumptionNumber(r.consumo);
  };
  const arr=state.readings
    .filter(r=>String(r.utenza||'').toLowerCase()===key)
    .map(r=>({r,value:metric(r)}))
    .filter(x=>x.value!==null&&x.value>0)
    .sort((a,b)=>String(b.r.periodoAl||b.r.data||'').localeCompare(String(a.r.periodoAl||a.r.data||'')));
  if(arr.length<2)return null;
  return percentageChange(arr[0].value,arr[1].value);
}
function longItalianDate(d=new Date()){
  const weekdays=["Domenica","Lunedì","Martedì","Mercoledì","Giovedì","Venerdì","Sabato"];
  return `${weekdays[d.getDay()]} ${d.getDate()} ${monthNamesLong[d.getMonth()].toLowerCase()} ${d.getFullYear()}`;
}
function homeGreeting(d=new Date()){
  const h=d.getHours();
  if(h>=5&&h<12)return "Buongiorno";
  if(h>=12&&h<18)return "Buon pomeriggio";
  return "Buonasera";
}

// ======================= Spese+ • Gestione finanziaria =======================
const FINANCE_CATEGORIES=["Alimentari","Pranzi e cene","Trasporti","Casa","Salute","Tempo libero","Abbonamenti","Shopping","Altro"];
const FINANCE_ICONS={"Alimentari":"🛒","Pranzi e cene":"🍽️","Trasporti":"🚌","Casa":"⌂","Salute":"♡","Tempo libero":"◉","Abbonamenti":"▣","Shopping":"◈","Altro":"•••","Luce":"⚡"};
let financeMonth=new Date().getMonth()+1;
let financeFilter="Tutte";
function financeKey(y=selectedYear,m=financeMonth){return buildMonthKey(y,m)}
function financeAmount(v){const n=Number(v);return Number.isFinite(n)?n:0}
function sumAmounts(items){return items.reduce((sum,x)=>sum+financeAmount(x.amount),0)}
function financeMonthItems(items,key){return items.filter(x=>String(x.date||"").slice(0,7)===key)}
function paidLightMonth(key){return state.bills.filter(b=>b.utenza==="Luce"&&isPaid(b)&&String(b.dataPagamento||"").slice(0,7)===key)}
function financeSummary(key){
  const expenses=financeMonthItems(state.expenses,key);
  const incomes=financeMonthItems(state.incomes,key);
  const light=paidLightMonth(key);
  const income=sumAmounts(incomes),otherExpenses=sumAmounts(expenses);
  const electricity=light.reduce((sum,b)=>sum+financeAmount(b.importo),0);
  return {income,expenses:otherExpenses+electricity,electricity,balance:income-otherExpenses-electricity,light,otherExpenses};
}
function previousFinanceKey(){const idx=selectedYear*12+financeMonth-2;return buildMonthKey(Math.floor(idx/12),(idx%12)+1)}
function financeTrend(current,previous){
  if(previous===0)return current===0?"Nessuna variazione":"Nessun confronto disponibile";
  const pct=(current-previous)/previous*100;
  const abs=Math.abs(pct).toLocaleString("it-IT",{maximumFractionDigits:1});
  return pct>0?`↑ +${abs}% rispetto al mese scorso`:pct<0?`↓ −${abs}% rispetto al mese scorso`:"Invariato rispetto al mese scorso";
}
window.changeFinanceMonth=delta=>{
  const index=selectedYear*12+financeMonth-1+Number(delta);
  selectedYear=Math.floor(index/12);financeMonth=index%12+1;
  ensureYearInSelector(selectedYear);render();
};
function financeMonthHeader(){return `<div class="finance-month-bar"><button class="ghost" onclick="window.changeFinanceMonth(-1)" aria-label="Mese precedente">‹</button><b>${monthNamesLong[financeMonth-1]} ${selectedYear}</b><button class="ghost" onclick="window.changeFinanceMonth(1)" aria-label="Mese successivo">›</button></div>`}
function financeCategoryTotals(key){
  const totals=new Map();
  financeMonthItems(state.expenses,key).forEach(x=>totals.set(x.category||"Altro",(totals.get(x.category||"Altro")||0)+financeAmount(x.amount)));
  const light=financeSummary(key).electricity;if(light)totals.set("Luce",(totals.get("Luce")||0)+light);
  return [...totals.entries()].sort((a,b)=>b[1]-a[1]);
}
function renderFinanceDashboard(){
  const key=financeKey(),prev=previousFinanceKey(),cur=financeSummary(key),old=financeSummary(prev);
  const categories=financeCategoryTotals(key);
  const pending=state.bills.filter(b=>b.utenza==="Luce"&&!isPaid(b));
  pageEl.innerHTML=`<div class="finance-screen">
    ${financeMonthHeader()}
    <section class="finance-hero"><span>DISPONIBILE NEL MESE</span><strong class="${cur.balance<0?'finance-negative':''}">${money(cur.balance)}</strong><small>Entrate − spese sostenute</small></section>
    <div class="finance-two"><button class="finance-summary-card" onclick="window.goPage('entrate')"><span>Entrate</span><b>${money(cur.income)}</b><small>Stipendio e altre entrate</small></button><button class="finance-summary-card" onclick="window.goPage('spese')"><span>Spese</span><b>${money(cur.expenses)}</b><small>${esc(financeTrend(cur.expenses,old.expenses))}</small></button></div>
    <section class="card section"><div class="section-head"><div><h2>Confronto con il mese scorso</h2><p class="muted">${esc(monthLabel(prev))} → ${esc(monthLabel(key))}</p></div></div>
      <div class="finance-comparison"><div><span>Mese precedente</span><b>${money(old.expenses)}</b></div><div><span>Mese attuale</span><b>${money(cur.expenses)}</b></div></div><p class="muted">${esc(financeTrend(cur.expenses,old.expenses))}</p></section>
    <section class="card section"><div class="section-head"><h2>Spese per categoria</h2><button class="ghost" onclick="window.goPage('statistiche')">Statistiche ›</button></div>
      ${categories.length?categories.map(([name,total])=>`<div class="finance-category-row"><span class="finance-category-icon">${FINANCE_ICONS[name]||'•'}</span><span>${esc(name)}</span><strong>${money(total)}</strong></div>`).join(''):'<p class="muted">Nessuna spesa registrata nel mese.</p>'}
    </section>
    <section class="card section"><div class="section-head"><h2>Bollette Luce</h2><button class="ghost" onclick="window.goPage('bollette')">Apri ›</button></div><p>Pagate nel mese: <b>${money(cur.electricity)}</b></p><p class="muted">${pending.length} bollette ancora da pagare (non sottratte dal saldo finché non risultano pagate).</p></section>
    <div class="finance-two"><button class="primary" onclick="window.editExpense()">+ Nuova spesa</button><button class="ghost" onclick="window.editIncome()">+ Entrata</button></div>
  </div>`;
}
function financeItemRows(items,kind){
  if(!items.length)return '<div class="home-empty">Nessuna registrazione per questo mese.</div>';
  return [...items].sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))).map(x=>`<button class="finance-entry-row" onclick="window.${kind==='expense'?'editExpense':'editIncome'}('${x.id}')"><span class="finance-entry-icon">${kind==='expense'?(FINANCE_ICONS[x.category]||'•'):'€'}</span><span class="finance-entry-main"><b>${esc(x.description||x.category||'Voce')}</b><small>${fmtDate(x.date)} · ${esc(x.category||'Entrata')}</small></span><strong>${kind==='expense'?'-':'+'}${money(x.amount)}</strong><span>›</span></button>`).join('');
}
function renderExpenses(){
  const key=financeKey(),items=financeMonthItems(state.expenses,key);
  const shown=financeFilter==='Tutte'?items:items.filter(x=>x.category===financeFilter);
  const sum=sumAmounts(shown),light=financeSummary(key).electricity;
  pageEl.innerHTML=`<div class="finance-screen">${financeMonthHeader()}
    <section class="finance-hero"><span>SPESE REGISTRATE</span><strong>${money(sum+ (financeFilter==='Tutte'?light:0))}</strong><small>Bollette Luce pagate incluse nel totale generale</small></section>
    <section class="card section"><div class="section-head"><h2>Le tue spese</h2><button class="primary" onclick="window.editExpense()">+ Aggiungi</button></div>
      <label class="field">Categoria<select onchange="window.setFinanceFilter(this.value)">${['Tutte',...FINANCE_CATEGORIES].map(c=>`<option value="${esc(c)}" ${c===financeFilter?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      ${financeItemRows(shown,'expense')}
      ${financeFilter==='Tutte'&&light?`<button class="finance-entry-row" onclick="window.goPage('bollette')"><span class="finance-entry-icon">⚡</span><span class="finance-entry-main"><b>Bolletta Luce</b><small>Pagamenti del mese</small></span><strong>-${money(light)}</strong><span>›</span></button>`:''}
    </section></div>`;
}
window.setFinanceFilter=v=>{financeFilter=v;renderExpenses()};
function renderIncomes(){
  const key=financeKey(),items=financeMonthItems(state.incomes,key);
  pageEl.innerHTML=`<div class="finance-screen">${financeMonthHeader()}<section class="finance-hero"><span>ENTRATE DEL MESE</span><strong>${money(sumAmounts(items))}</strong><small>Stipendio e altre entrate</small></section><section class="card section"><div class="section-head"><h2>Entrate</h2><button class="primary" onclick="window.editIncome()">+ Aggiungi</button></div>${financeItemRows(items,'income')}</section></div>`;
}
function financeEdit(kind,id){
  const expense=kind==='expense',name=expense?'expenses':'incomes';
  const old=id?state[name].find(x=>x.id===id):null;
  if(id&&!old)return;
  const defaultDay=financeKey()===new Date().toISOString().slice(0,7)?new Date().getDate():1;
  const item=old||{date:`${financeKey()}-${String(defaultDay).padStart(2,'0')}`,description:expense?'':'Stipendio',category:expense?'Alimentari':'Stipendio',amount:''};
  const categories=expense?FINANCE_CATEGORIES:['Stipendio','Altre entrate','Rimborso','Extra'];
  showModal(`<div class="modal-head"><h2>${id?'Modifica':'Nuova'} ${expense?'spesa':'entrata'}</h2><button class="mini" onclick="window.closeModal()">×</button></div>
    <div class="formgrid"><label class="field">Data<input type="date" id="finDate" value="${esc(item.date)}"></label>
    <label class="field">Importo €<input type="number" id="finAmount" min="0.01" step="0.01" value="${esc(item.amount)}" placeholder="0,00"></label>
    <label class="field">Categoria<select id="finCategory">${categories.map(c=>`<option value="${esc(c)}" ${item.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
    <label class="field span2">Descrizione<input id="finDescription" maxlength="140" value="${esc(item.description)}" placeholder="${expense?'Es. Supermercato':'Es. Stipendio ottobre'}"></label>
    <label class="field span2">Note (facoltative)<input id="finNotes" maxlength="500" value="${esc(item.notes||'')}"></label></div>
    ${expense?'<p class="muted">La Luce si registra soltanto nella sezione Bollette, per evitare di conteggiarla due volte.</p>':'<p class="muted">Registra lo stipendio per ogni mese in cui viene ricevuto.</p>'}
    <div class="modal-foot">${id?`<button class="danger" onclick="window.deleteFinance('${kind}','${id}')">Elimina</button>`:''}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveFinance('${kind}','${id||''}')">Salva</button></div>`);
}
window.editExpense=id=>financeEdit('expense',id);
window.editIncome=id=>financeEdit('income',id);
window.saveFinance=async(kind,id)=>{
  const name=kind==='expense'?'expenses':'incomes';
  const val=x=>document.querySelector(x)?.value||'';
  const amount=Number(val('#finAmount')),date=val('#finDate'),category=val('#finCategory');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(amount)||amount<=0||!category){alert('Inserisci una data e un importo maggiore di zero.');return;}
  const data={date,amount:Math.round(amount*100)/100,category,description:val('#finDescription').trim(),notes:val('#finNotes').trim(),updatedAt:serverTimestamp()};
  try{if(id)await updateDoc(docFor(name,id),data);else await addDoc(pathFor(name),{...data,createdAt:serverTimestamp()});closeModal();}
  catch(e){console.error(e);alert('Salvataggio non riuscito: verifica la connessione e le regole Firebase.');}
};
window.deleteFinance=async(kind,id)=>{
  if(!confirm('Eliminare definitivamente questa registrazione?'))return;
  try{await deleteDoc(docFor(kind==='expense'?'expenses':'incomes',id));closeModal();}catch(e){alert('Eliminazione non riuscita.');}
};
function renderFinanceStats(){
  const cur=financeSummary(financeKey());const categories=financeCategoryTotals(financeKey());
  const max=Math.max(1,...categories.map(x=>x[1]));
  const last=[];for(let n=5;n>=0;n--){const i=selectedYear*12+financeMonth-1-n;const key=buildMonthKey(Math.floor(i/12),i%12+1);last.push({key,...financeSummary(key)})}
  pageEl.innerHTML=`<div class="finance-screen">${financeMonthHeader()}<section class="card section"><h2>Andamento ultimi 6 mesi</h2>${last.map(x=>`<div class="finance-stat-row"><span>${esc(monthLabel(x.key))}</span><div class="finance-stat-track"><i style="width:${Math.min(100,100*x.expenses/Math.max(1,...last.map(z=>z.expenses)))}%"></i></div><strong>${money(x.expenses)}</strong></div>`).join('')}</section><section class="card section"><h2>Spese per categoria</h2>${categories.length?categories.map(([name,value])=>`<div class="finance-stat-row"><span>${esc(name)}</span><div class="finance-stat-track"><i style="width:${Math.min(100,100*value/max)}%"></i></div><strong>${money(value)}</strong></div>`).join(''):'<p class="muted">Nessun dato disponibile.</p>'}</section><section class="card section"><h2>Bilancio mensile</h2><p>Entrate: <b>${money(cur.income)}</b></p><p>Uscite: <b>${money(cur.expenses)}</b></p><p>Disponibile: <b>${money(cur.balance)}</b></p></section></div>`;
}
function renderFinanceMore(){pageEl.innerHTML=`<div class="card section"><h2>Altre funzioni</h2><div class="more-grid"><button class="more-item" onclick="window.goPage('statistiche')"><span class="more-icon">▥</span><span><strong>Statistiche</strong><small>Confronti mensili e categorie</small></span><span class="more-chevron">›</span></button><button class="more-item" onclick="window.goPage('impostazioni')"><span class="more-icon">⚙</span><span><strong>Impostazioni</strong><small>Account e backup</small></span><span class="more-chevron">›</span></button></div></div>`}
function renderFinanceSettings(){pageEl.innerHTML=`<div class="card section"><h2>Account</h2><p>${esc(user?.email||'')}</p><p class="muted">Accesso riservato all’unico utente autorizzato.</p></div><div class="card section" style="margin-top:14px"><h2>Backup</h2><p class="muted">Esporta bollette Luce, spese ed entrate in formato JSON.</p><button class="primary" onclick="window.exportBackup()">Scarica backup</button></div>`}
// ======================= Fine gestione Spese+ =======================

function renderDashboard(){
  const now=new Date();
  const homeMonth=selectedYear===now.getFullYear()?now.getMonth()+1:1;
  const competenceBills=state.bills.filter(b=>billTouchesMonth(b,selectedYear,homeMonth));
  // Nel riquadro Home separiamo tre concetti:
  // 1) pagato nel mese = dataPagamento nel mese selezionato;
  // 2) da pagare nel mese = bollette ancora aperte con SCADENZA nel mese selezionato;
  // 3) totale annuale = competenza dell'anno selezionato.
  const monthPaidCash=state.bills.filter(b=>paidInMonth(b,selectedYear,homeMonth)).reduce((a,b)=>a+Number(b.importo||0),0);
  const dueInSelectedMonth=state.bills.filter(b=>{
    if(isPaid(b)||!b.scadenza)return false;
    const m=String(b.scadenza).match(/^(\d{4})-(\d{2})/);
    return !!m&&Number(m[1])===Number(selectedYear)&&Number(m[2])===Number(homeMonth);
  });
  const monthDueByDeadline=dueInSelectedMonth.reduce((a,b)=>a+Number(b.importo||0),0);
  const overdueTotal=state.bills.filter(b=>isOverdue(b)).reduce((a,b)=>a+Number(b.importo||0),0);
  const annualTotal=state.bills.filter(b=>hasCompetenceYear(b,selectedYear)).reduce((a,b)=>a+competenceAmount(b,selectedYear),0);
  const upcoming=state.bills.filter(b=>!isPaid(b)&&b.scadenza).sort((a,b)=>String(a.scadenza).localeCompare(String(b.scadenza))).slice(0,3);
  const recentPaid=state.bills.filter(b=>isPaid(b)&&b.dataPagamento).sort((a,b)=>String(b.dataPagamento).localeCompare(String(a.dataPagamento))).slice(0,4);
  const upcomingHtml=upcoming.length?upcoming.map(b=>`<button class="home-row" onclick="window.editBill('${b.id}')"><span class="home-row-icon ${utilityTone(b.utenza)}">${utilIcon(b.utenza)}</span><span class="home-row-main"><b>${esc(b.utenza)}</b><small>${isOverdue(b)?'Scaduta':'Scade il'} ${fmtDate(b.scadenza)}</small></span><strong>${money(b.importo)}</strong><i>›</i></button>`).join(""):`<div class="home-empty">Nessuna scadenza aperta.</div>`;
  const activity=recentPaid.map(b=>`<button class="home-row" onclick="window.editBill('${b.id}')"><span class="home-row-icon ${utilityTone(b.utenza)}">${utilIcon(b.utenza)}</span><span class="home-row-main"><b>${esc(b.utenza)}</b><small>Pagata il ${fmtDate(b.dataPagamento)}</small></span><strong>${money(b.importo)}</strong><i>›</i></button>`).join('');
  const consumptionHtml=['Luce','Acqua','Gas'].map(u=>{const t=readingTrend(u);const cls=t===null?'neutral':t>0?'up':'down';const arrow=t===null?'•':t>0?'↑':'↓';const signed=t===null?'—':`${t>0?'+':''}${t}%`;return `<button class="consumption-card" onclick="window.goPage('letture')"><span>${utilIcon(u)} <b>${u}</b></span><strong class="${cls}">${arrow} ${signed}</strong><small>${t===null?'rispetto al periodo<br>precedente':t>0?'consumato di più rispetto<br>al periodo precedente':'consumato di meno rispetto<br>al periodo precedente'}</small></button>`}).join('');
  pageEl.innerHTML=`
    <section class="legacy-home-photo"><img src="./home-house.jpg" alt="Casa sul mare"></section>
    <section class="home-welcome"><div><h2>${homeGreeting(now)}, <b>Daniele</b></h2><p>${longItalianDate(now)}</p></div></section>
    <section class="home-blue-card"><div class="blue-top"><b>${monthNamesLong[homeMonth-1].toUpperCase()} ${selectedYear}</b><button onclick="window.goPage('bollette')">Vedi dettagli ›</button></div><div class="blue-body blue-metrics"><button type="button" class="blue-metric home-metric-button" onclick="window.openHomeMetric('paid',${selectedYear},${homeMonth})"><span>Pagato nel mese</span><strong>${money(monthPaidCash)}</strong><small>per data di pagamento</small><i class="metric-chevron">›</i></button><button type="button" class="blue-metric annual-metric home-metric-button" onclick="window.openHomeMetric('annual',${selectedYear},${homeMonth})"><span>Spese annuali totali</span><strong>${money(annualTotal)}</strong><small>competenza ${selectedYear}</small><i class="metric-chevron">›</i></button></div><div class="blue-split"><button type="button" class="home-metric-button split-metric" onclick="window.openHomeMetric('due',${selectedYear},${homeMonth})"><span>Da pagare nel mese</span><b><i class="orange-dot"></i>${money(monthDueByDeadline)}</b><i class="metric-chevron">›</i></button><button type="button" class="home-metric-button split-metric" onclick="window.openHomeMetric('overdue',${selectedYear},${homeMonth})"><span>Scadute</span><b><i class="red-dot"></i>${money(overdueTotal)}</b><i class="metric-chevron">›</i></button></div></section>
    <section class="home-clean-section utility-summary-section"><div class="clean-head"><h2>Riepilogo utenze</h2><select class="summary-year-select" aria-label="Anno riepilogo utenze" onchange="window.changeUtilitySummaryYear(this.value)">${utilitySummaryYearOptions()}</select></div><div class="home-utility-grid">${utilities.map(u=>{const list=state.bills.filter(b=>String(b.utenza||'').toLowerCase()===u.toLowerCase()&&hasCompetenceYear(b,utilitySummaryYear));const paid=list.filter(isPaid).reduce((a,b)=>a+competenceAmount(b,utilitySummaryYear),0);const due=list.filter(b=>!isPaid(b)).reduce((a,b)=>a+competenceAmount(b,utilitySummaryYear),0);return `<button class="home-utility-card" onclick="window.showUtilityBills('${u}')"><span class="home-utility-icon ${utilityTone(u)}">${utilIcon(u)}</span><span><b>${esc(u)}</b><small>${list.length} ${list.length===1?'bolletta':'bollette'}${due>0?` · da pagare ${money(due)}`:''}</small></span><strong>${money(paid)}</strong><i>›</i></button>`}).join('')}</div></section>
    <section class="home-clean-section"><div class="clean-head"><h2>Da non dimenticare</h2><button onclick="window.openUnpaidBills()">Vedi tutte ›</button></div><div class="home-list boxed-list">${upcomingHtml}</div></section>
    <section class="home-clean-section"><div class="clean-head"><h2>I tuoi consumi</h2><button onclick="window.goPage('letture')">Vedi grafici ›</button></div><div class="consumption-grid">${consumptionHtml}</div></section>
    <section class="home-clean-section"><div class="clean-head"><h2>Attività recenti</h2><button onclick="window.goPage('bollette')">Vedi tutte ›</button></div><div class="home-list boxed-list">${activity||'<div class="home-empty">Nessuna attività recente.</div>'}</div></section>`;
}


window.showUtilityBills=u=>{
  const list=state.bills
    .filter(b=>isPaid(b)&&b.utenza===u&&hasCompetenceYear(b,utilitySummaryYear))
    .sort((a,b)=>String(b.dataPagamento||b.dataEmissione||"").localeCompare(String(a.dataPagamento||a.dataEmissione||"")));
  const total=list.reduce((s,b)=>s+competenceAmount(b,utilitySummaryYear),0);
  const rows=list.length?list.map(b=>`
    <button type="button" class="utility-bill-row" onclick="window.closeModal();window.editBill('${b.id}')">
      <span class="utility-bill-main">
        <b>${utilIcon(b.utenza)} ${esc(formatPeriod(b))}</b>
        <small>${b.dataPagamento?`Pagata ${fmtDate(b.dataPagamento)}`:`${esc(b.stato||"")}`}${b.note?` · ${esc(b.note)}`:""}</small>
      </span>
      <span class="utility-bill-values">
        <strong>${money(competenceAmount(b,utilitySummaryYear))}</strong>
        <small>su ${money(b.importo)}</small>
      </span>
    </button>`).join(""):`<div class="empty">Nessuna bolletta pagata di competenza ${utilitySummaryYear}.</div>`;
  showModal(`<div class="modal-head"><div><div class="modal-kicker">Riepilogo ${utilitySummaryYear}</div><h2>${utilIcon(u)} ${esc(u)}</h2></div><button class="mini" onclick="window.closeModal()">×</button></div>
    <div class="utility-modal-total"><span>Totale di competenza</span><strong>${money(total)}</strong></div>
    <div class="utility-bill-list">${rows}</div>
    <div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Chiudi</button></div>`);
};


let billSort={key:"dataEmissione",dir:"desc"};
let billViewMonth=new Date().getMonth()+1;
let billStatusTab="all";
let showOtherDue=false;
let billHomeScope=null;

function effectiveBillStatus(b){
  return isOverdue(b)&&!isPaid(b)?"Scaduta":String(b.stato||"");
}
function billSortValue(b,key){
  switch(key){
    case "utenza": return String(b.utenza||"").toLocaleLowerCase("it");
    case "periodo": {
      const k=normalizeMonthKey(b.periodoInizio);
      return k?monthIndex(k):String(b.periodo||"").toLocaleLowerCase("it");
    }
    case "scadenza": return String(b.scadenza||"9999-99-99");
    case "importo": return Number(b.importo||0);
    case "stato": {
      const s=effectiveBillStatus(b);
      const order={Scaduta:0,"Da pagare":1,Rateizzata:2,Contestata:3,Pagata:4};
      return order[s]??99;
    }
    case "competenza": {
      const c=billCompetences(b);
      return c.length?Math.min(...c.map(x=>Number(x.anno)||9999)):9999;
    }
    case "dataEmissione":
    default: return String(b.dataEmissione||"");
  }
}
function sortedBills(arr){
  const dir=billSort.dir==="asc"?1:-1;
  return [...arr].sort((a,b)=>{
    const av=billSortValue(a,billSort.key),bv=billSortValue(b,billSort.key);
    if(typeof av==="number"&&typeof bv==="number")return (av-bv)*dir;
    return String(av).localeCompare(String(bv),"it",{numeric:true,sensitivity:"base"})*dir;
  });
}
function sortArrow(key){
  return billSort.key===key?(billSort.dir==="asc"?" ↑":" ↓"):"";
}
function billsWithUnpaidFirst(arr){
  const unpaid=arr.filter(b=>!isPaid(b)).sort((a,b)=>{
    const ao=isOverdue(a)?0:1,bo=isOverdue(b)?0:1;
    if(ao!==bo)return ao-bo;
    return String(a.scadenza||"9999-99-99").localeCompare(String(b.scadenza||"9999-99-99"));
  });
  const paid=sortedBills(arr.filter(isPaid));
  return [...unpaid,...paid];
}
function sortableBillTh(label,key,compact=false){
  if(compact)return `<th>${label}</th>`;
  return `<th><button type="button" class="sort-th" onclick="window.setBillSort('${key}')">${label}${sortArrow(key)}</button></th>`;
}

function tableBills(arr, compact=false){
  if(!arr.length)return `<div class="empty">Nessuna bolletta.</div>`;
  return `<div class="table-wrap bills-table"><table><thead><tr>${sortableBillTh("Utenza","utenza",compact)}${sortableBillTh("Periodo","periodo",compact)}${sortableBillTh("Scadenza","scadenza",compact)}${sortableBillTh("Importo","importo",compact)}${sortableBillTh("Stato","stato",compact)}${sortableBillTh("Competenza","competenza",compact)}${compact?"":"<th></th>"}</tr></thead><tbody>${arr.map(b=>`<tr>
  <td class="bill-utility">${utilIcon(b.utenza)} ${esc(b.utenza)}</td><td class="bill-period">${esc(formatPeriod(b))}</td><td class="bill-due ${isOverdue(b)?"overdue":""}">${fmtDate(b.scadenza)}</td><td class="bill-amount right">${money(b.importo)}</td><td class="bill-status">${isOverdue(b)&&!isPaid(b)?'<span class="badge bad">Scaduta</span>':badge(b.stato)}</td><td class="bill-year">${formatCompetences(b)}</td>
  ${compact?"":`<td class="bill-actions"><div class="actions"><button class="mini" onclick="window.editBill('${b.id}')">✎</button><button class="mini" onclick="window.dupBill('${b.id}')">⧉</button><button class="mini danger" onclick="window.delBill('${b.id}')">×</button></div></td>`}</tr>`).join("")}</tbody></table></div>`;
}

function billTouchesMonth(b,year,month){
  if(validPeriod(b.periodoInizio,b.periodoFine)){
    return periodMonths(b.periodoInizio,b.periodoFine).some(x=>Number(x.anno)===Number(year)&&Number(x.mese)===Number(month));
  }
  return Number(b.anno)===Number(year)&&Number(b.mese)===Number(month);
}
function monthBillAmount(b,year,month){
  const v=monthlyCompetenceAmount(b,year,month);
  return Math.round(Number(v||0)*100)/100;
}
function utilityTone(u){
  const x=String(u||"").toLowerCase();
  if(x.includes("luce")||x.includes("elettr"))return "tone-luce";
  if(x.includes("gas"))return "tone-gas";
  if(x.includes("acqua"))return "tone-acqua";
  if(x.includes("fibra")||x.includes("internet")||x.includes("telefono"))return "tone-fibra";
  if(x.includes("tari")||x.includes("rifiut"))return "tone-tari";
  return "tone-altro";
}
function monthBillCard(b,year,month){
  const byPaymentDate=paidInMonth(b,year,month)&&!billTouchesMonth(b,year,month);
  const quota=byPaymentDate?Number(b.importo||0):monthBillAmount(b,year,month)||Number(b.importo||0);
  const multi=validPeriod(b.periodoInizio,b.periodoFine)&&periodMonths(b.periodoInizio,b.periodoFine).length>1;
  const overdue=isOverdue(b)&&!isPaid(b);
  const status=overdue?'<span class="bill-status-pill overdue-pill">Scaduta</span>':(isPaid(b)?'<span class="bill-status-pill paid-pill">Pagata</span>':'<span class="bill-status-pill due-pill">Da pagare</span>');
  let meta,amountNote;
  if(isPaid(b)){
    meta=`Competenza: ${esc(formatPeriod(b))}`;
    amountNote=`<small class="bill-payment-date">Pagata il ${fmtDate(b.dataPagamento)}</small>`;
  }else{
    meta=b.scadenza
      ? `<span class="bill-deadline-label">${overdue?'SCADUTA':'SCADENZA'}</span><strong class="bill-deadline-date">${fmtDate(b.scadenza)}</strong>`
      : `<span class="bill-deadline-label neutral">SCADENZA</span><strong class="bill-deadline-date neutral">Non indicata</strong>`;
    amountNote=multi?`<small>Quota del mese · totale ${money(b.importo)}</small>`:`<small>Competenza: ${esc(formatPeriod(b))}</small>`;
  }
  return `<article class="monthly-bill-card ${!isPaid(b)?(overdue?'bill-card-overdue':'bill-card-due'):'bill-card-paid'}" onclick="window.editBill('${b.id}')">
    <div class="monthly-bill-icon ${utilityTone(b.utenza)}">${utilIcon(b.utenza)}</div>
    <div class="monthly-bill-main"><div class="monthly-bill-title">${esc(b.utenza||"Bolletta")}</div><div class="monthly-bill-meta ${overdue?'overdue':''}">${meta}</div>${amountNote}</div>
    <div class="monthly-bill-side"><strong>${money(quota)}</strong>${status}<span class="bill-chevron">›</span></div>
  </article>`;
}
function ensureYearInSelector(year){
  if(!yearSelect)return;
  const values=[...yearSelect.options].map(o=>Number(o.value||o.textContent));
  if(!values.includes(Number(year))){
    const opt=document.createElement("option");opt.value=String(year);opt.textContent=String(year);yearSelect.appendChild(opt);
  }
  yearSelect.value=String(year);
}
window.changeBillMonth=delta=>{
  const idx=selectedYear*12+(billViewMonth-1)+Number(delta||0);
  selectedYear=Math.floor(idx/12);
  billViewMonth=(idx%12)+1;
  ensureYearInSelector(selectedYear);
  renderBills();
};
window.setBillStatusTab=tab=>{billHomeScope=null;billStatusTab=tab;renderBills()};
window.setBillViewMonth=m=>{billHomeScope=null;billViewMonth=Number(m)||billViewMonth;renderBills()};
window.openHomeMetric=(metric,year,month)=>{
  selectedYear=Number(year)||selectedYear;
  billViewMonth=Number(month)||billViewMonth;
  ensureYearInSelector(selectedYear);
  billHomeScope=null;
  if(metric==='paid') billStatusTab='paid';
  else if(metric==='annual'){billStatusTab='all';billHomeScope={type:'annual',year:selectedYear};}
  else if(metric==='due'){billStatusTab='due';billHomeScope={type:'due-month',year:selectedYear,month:billViewMonth};}
  else if(metric==='overdue') billStatusTab='overdue';
  page='bollette';setActiveNav();render();window.scrollTo({top:0,behavior:'smooth'});
};
window.toggleOtherDue=()=>{showOtherDue=!showOtherDue;renderBills()};

window.clearHomeBillScope=()=>{billHomeScope=null;renderBills()};
window.openUnpaidBills=()=>{
  billHomeScope=null;billStatusTab="due";page="bollette";setActiveNav();render();window.scrollTo({top:0,behavior:"smooth"});
};

function renderBills(){
  const paidByYear=state.bills.filter(b=>b.utenza==="Luce"&&isPaid(b)&&String(b.dataPagamento||'').startsWith(`${selectedYear}-`));
  const allBills=billHomeScope?.type==='annual'
    ? state.bills.filter(b=>hasCompetenceYear(b,billHomeScope.year))
    : state.bills.filter(b=>b.utenza==="Luce");
  const dueBills=billHomeScope?.type==='due-month'
    ? state.bills.filter(b=>{
        if(isPaid(b)||!b.scadenza)return false;
        const m=String(b.scadenza).match(/^(\d{4})-(\d{2})/);
        return !!m&&Number(m[1])===Number(billHomeScope.year)&&Number(m[2])===Number(billHomeScope.month);
      })
    : state.bills.filter(b=>b.utenza==="Luce"&&!isPaid(b));
  const overdueBills=state.bills.filter(b=>b.utenza==="Luce"&&!isPaid(b)&&isOverdue(b)&&String(b.scadenza||'').startsWith(`${selectedYear}-`));
  const paidCash=paidByYear.reduce((a,b)=>a+Number(b.importo||0),0);
  const monthTitle=`${monthNamesLong[billViewMonth-1]} ${selectedYear}`;
  const monthOptions=monthNamesLong.map((m,i)=>`<option value="${i+1}" ${i+1===billViewMonth?'selected':''}>${m} ${selectedYear}</option>`).join('');
  pageEl.innerHTML=`
    <section class="bills-page-head"><div><h1>Bollette</h1><p>Solo utenza Luce: consumi, importi e scadenze.</p></div><div class="bills-head-actions"><button class="primary desktop-new-bill" type="button" onclick="window.editBill()"><span aria-hidden="true">＋</span> Nuova bolletta</button><button id="billSearchBtn" class="bills-search-icon" type="button" aria-label="Cerca bollette" onclick="window.openBillSearch()"><span aria-hidden="true">⌕</span></button></div></section>
    <div class="bill-month-tabs four-tabs"><button class="${billStatusTab==='all'?'active':''}" onclick="window.setBillStatusTab('all')">Tutte</button><button class="${billStatusTab==='due'?'active':''}" onclick="window.setBillStatusTab('due')">Da pagare</button><button class="${billStatusTab==='paid'?'active':''}" onclick="window.setBillStatusTab('paid')">Pagate</button><button class="${billStatusTab==='overdue'?'active':''}" onclick="window.setBillStatusTab('overdue')">Scadute</button></div>

    <div id="billSearchWrap" class="bill-global-search" aria-hidden="true"><input id="searchBill" type="search" placeholder="Cerca bolletta, utenza, importo, periodo…" autocomplete="off"><button id="billSearchClose" type="button" aria-label="Chiudi ricerca">×</button></div>
    ${billHomeScope?.type==='annual'?`<div class="home-filter-note"><span>Spese di competenza ${billHomeScope.year}</span><button onclick="window.clearHomeBillScope()">Mostra tutte ×</button></div>`:billHomeScope?.type==='due-month'?`<div class="home-filter-note"><span>Scadenze da pagare · ${monthNamesLong[billHomeScope.month-1]} ${billHomeScope.year}</span><button onclick="window.clearHomeBillScope()">Mostra tutte ×</button></div>`:''}
    ${billStatusTab==='paid'?`<section class="paid-month-panel"><div class="paid-panel-head"><h2>Pagate nel ${selectedYear} <span>ⓘ</span></h2><span class="bill-year-scope">Tutto l’anno</span></div><div class="paid-summary"><span class="paid-check">✓</span><div><b id="paidCountText">${paidByYear.length} ${paidByYear.length===1?'bolletta pagata':'bollette pagate'}</b><small>Totale pagato nel ${selectedYear}</small><strong id="paidCashText">${money(paidCash)}</strong></div></div><div id="paidFeatureList" class="paid-feature-list"></div></section>`:`<section class="bills-list-panel"><div class="bills-list-head"><h2>${billStatusTab==='all'?'Tutte le bollette':billStatusTab==='due'?'Da pagare':'Scadute'}</h2><span class="bill-list-count" id="billListCount"></span></div><div id="billMonthGroups"></div></section>`}`;

  const apply=()=>{
    const q=(document.querySelector('#searchBill')?.value||'').toLocaleLowerCase('it').trim();
    const match=b=>{
      if(String(b.utenza||'').toLowerCase()!=="luce")return false;
      if(!q)return true;
      const hay=[b.utenza,b.fornitore,b.periodo,formatPeriod(b),b.scadenza,b.dataPagamento,b.importo,b.stato,b.metodo,b.note,formatCompetences(b)].map(v=>String(v??'').toLocaleLowerCase('it')).join(' ');
      return hay.includes(q);
    };
    if(billStatusTab==='paid'){
      const arr=[...paidByYear.filter(match)].sort((a,b)=>String(b.dataPagamento||'').localeCompare(String(a.dataPagamento||'')));
      const total=arr.reduce((a,b)=>a+Number(b.importo||0),0);
      const count=document.querySelector('#paidCountText');
      const cash=document.querySelector('#paidCashText');
      const target=document.querySelector('#paidFeatureList');
      if(count)count.textContent=`${arr.length} ${arr.length===1?'bolletta pagata':'bollette pagate'}`;
      if(cash)cash.textContent=money(total);
      if(target)target.innerHTML=arr.length?arr.map(b=>monthBillCard(b,selectedYear,billViewMonth)).join(''):`<div class="home-empty">${q?'Nessun risultato per la ricerca.':`Nessun pagamento registrato nel ${selectedYear}.`}</div>`;
      return;
    }
    let source=billStatusTab==='due'?dueBills:billStatusTab==='overdue'?overdueBills:allBills;
    const matched=source.filter(match);
    const arr=billStatusTab==='all'
      ? billsWithUnpaidFirst(matched)
      : (billStatusTab==='due'||billStatusTab==='overdue')
        ? [...matched].sort((a,b)=>String(a.scadenza||"9999-99-99").localeCompare(String(b.scadenza||"9999-99-99")))
        : sortedBills(matched);
    const count=document.querySelector('#billListCount');
    if(count)count.textContent=billStatusTab==='all'?`${arr.length} totali`:`${arr.length}`;
    const target=document.querySelector('#billMonthGroups');
    if(target)target.innerHTML=arr.length?`<div class="monthly-bill-list">${arr.map(b=>monthBillCard(b,selectedYear,billViewMonth)).join('')}</div>`:`<div class="home-empty">${q?'Nessun risultato per la ricerca.':'Nessuna bolletta da mostrare.'}</div>`;
  };
  const input=document.querySelector('#searchBill');
  const searchBtn=document.querySelector('#billSearchBtn');
  const searchClose=document.querySelector('#billSearchClose');
  if(input)input.addEventListener('input',apply);
  if(searchClose)searchClose.addEventListener('click',window.closeBillSearch);
  window._applyBillSearch=apply;
  apply();
}
window.setBillUtilityFilter=value=>{billUtilityFilter="Luce";if(window._applyBillSearch)window._applyBillSearch();};


window.openBillSearch=()=>{
  const wrap=document.querySelector('#billSearchWrap');
  const input=document.querySelector('#searchBill');
  if(!wrap||!input)return;
  wrap.classList.add('open');
  wrap.setAttribute('aria-hidden','false');
  requestAnimationFrame(()=>input.focus());
};
window.closeBillSearch=()=>{
  const wrap=document.querySelector('#billSearchWrap');
  const input=document.querySelector('#searchBill');
  if(input){input.value='';input.blur();}
  if(wrap){wrap.classList.remove('open');wrap.setAttribute('aria-hidden','true');}
  if(window._applyBillSearch)window._applyBillSearch();
};

window.editBill=id=>{
  const b=id?state.bills.find(x=>x.id===id):{utenza:"Luce",stato:"Da pagare",anno:selectedYear,importo:""};
  if(b&&b.utenza!=="Luce"){alert("In Spese+ è consentita soltanto l’utenza Luce.");return;}
  const opts=(a,v)=>a.map(x=>`<option ${x===v?"selected":""}>${x}</option>`).join("");
  const hasNewPeriod=validPeriod(b.periodoInizio,b.periodoFine);
  const oldComps=billCompetences(b);
  const autoComps=hasNewPeriod?automaticCompetences(b.periodoInizio,b.periodoFine,b.importo):[];
  const initialComps=(b.competenzeFonte==="manuale"&&oldComps.length?oldComps:(autoComps.length?autoComps:oldComps.length?oldComps:[{anno:selectedYear,importo:Number(b.importo||0)}]));
  const manualInitially=b.competenzeFonte==="manuale"||(!hasNewPeriod&&Array.isArray(b.competenze)&&b.competenze.length>0);
  const compRows=initialComps.map((c,i)=>competenceRowHtml(c.anno,c.importo,i)).join("");
  const freePeriod=!hasNewPeriod&&!!String(b.periodo||'').trim();
  const periodMode=freePeriod?'free':'months';
  const startParts=splitMonthKey(b.periodoInizio||"");
  const endParts=splitMonthKey(b.periodoFine||"");
  const startYear=startParts.year||Number(b.anno)||selectedYear;
  showModal(`<div class="modal-head"><h2>${id?"Modifica":"Nuova"} bolletta</h2><button class="mini" onclick="window.closeModal()">×</button></div>
  <div class="notice"><b>Periodo di competenza:</b> scegli mese e anno in <b>DAL</b>. <b>AL è facoltativo</b>: se lo lasci vuoto, la bolletta viene considerata riferita a un solo mese.</div>
  <div class="formgrid">
    <label class="field">Utenza<select id="fUtenza">${opts(utilities,b.utenza)}</select></label>
    <label class="field">Data emissione<input id="fEmissione" type="date" value="${b.dataEmissione||""}"></label>
    <div class="field span2 period-field"><span>Periodo di competenza</span>
      <select id="fPeriodMode" onchange="window.periodModeChanged()"><option value="months" ${periodMode==='months'?'selected':''}>Mese / intervallo</option><option value="free" ${periodMode==='free'?'selected':''}>Dicitura libera</option></select>
      <div id="periodMonthsBox" class="period-range ${periodMode==='free'?'hidden':''}">
        <div class="period-point"><b>DAL</b><div class="month-year-pair"><select id="fStartMonth" onchange="window.periodPickerChanged('start')">${monthOnlyOptions(startParts.month,true)}</select><select id="fStartYear" onchange="window.periodPickerChanged('start')">${yearOnlyOptions(startYear,false)}</select></div></div>
        <div class="period-point"><b>AL <small>(facoltativo)</small></b><div class="month-year-pair"><select id="fEndMonth" onchange="window.periodPickerChanged('end')">${monthOnlyOptions(endParts.month,true)}</select><select id="fEndYear" onchange="window.periodPickerChanged('end')">${yearOnlyOptions(endParts.year,true)}</select></div></div>
      </div>
      <div id="periodFreeBox" class="period-free-box ${periodMode==='free'?'':'hidden'}"><label>Dicitura<input id="fPeriodoLibero" value="${esc(freePeriod?b.periodo:'')}" placeholder="Es. 1° acconto"></label><label>Anno di competenza<select id="fPeriodoAnno">${yearOnlyOptions(Number(b.anno)||selectedYear,false)}</select></label></div>
      <input id="fPeriodoInizio" type="hidden" value="${normalizeMonthKey(b.periodoInizio||'')}"><input id="fPeriodoFine" type="hidden" value="${normalizeMonthKey(b.periodoFine||'')}">
    </div>
    <label class="field">Scadenza<input id="fScadenza" type="date" value="${b.scadenza||""}"></label>
    <label class="field">Data pagamento<input id="fPagamento" type="date" value="${b.dataPagamento||""}"></label>
    <label class="field">Importo totale €<input id="fImporto" type="number" step=".01" min="0" value="${b.importo??""}" oninput="window.billTotalChanged()"></label>
    <label class="field">Stato<select id="fStato">${opts(statuses,b.stato)}</select></label>
    <label class="field">Consumo<input id="fConsumo" value="${esc(b.consumo||"")}"></label>
    <label class="field">Unità<input id="fUnita" value="${esc(b.unita||"")}"></label>
    <label class="field">Metodo pagamento<input id="fMetodo" value="${esc(b.metodo||"")}"></label>
    <div class="field span3 competence-field">
      <span>Ripartizione annuale</span>
      <div class="competence-auto">
        <div id="autoCompetencePreview" class="auto-competence-preview"></div>
        <button type="button" class="ghost compact-btn" onclick="window.toggleManualCompetence()"><span id="manualToggleLabel">${manualInitially?"Usa calcolo automatico":"Modifica ripartizione"}</span></button>
      </div>
      <div id="manualCompetenceBox" class="competence-box ${manualInitially?"":"hidden"}">
        <div class="manual-note">Usa questa sezione solo se vuoi correggere gli importi calcolati automaticamente.</div>
        <div id="competenceRows">${compRows}</div>
        <div class="competence-actions"><button type="button" class="ghost" onclick="window.addCompetenceRow()">+ Aggiungi anno</button><div id="competenceSummary" class="competence-summary"></div></div>
      </div>
    </div>
    <label class="field span3">Note<textarea id="fNote">${esc(b.note||"")}</textarea></label>
  </div>
  <div class="modal-foot">${id?`<button class="danger" onclick="window.closeModal();window.delBill('${id}')">Elimina</button><button class="ghost" onclick="window.closeModal();window.dupBill('${id}')">Duplica</button>`:""}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveBill('${id||""}')">Salva</button></div>`);
  window.manualCompetenceMode=manualInitially;
  window.periodModeChanged();
};

function competenceRowHtml(anno,importo,index){return `<div class="competence-row" data-index="${index}"><label>Anno<input class="comp-year" type="number" min="2000" max="2100" value="${Number(anno)||selectedYear}" oninput="window.updateCompetenceSummary()"></label><label>Quota €<input class="comp-amount" type="number" min="0" step=".01" value="${Number(importo||0).toFixed(2)}" oninput="window.updateCompetenceSummary()"></label><button type="button" class="mini danger comp-remove" onclick="window.removeCompetenceRow(this)" aria-label="Rimuovi quota">×</button></div>`}
window.manualCompetenceMode=false;
window.addCompetenceRow=()=>{const box=document.querySelector("#competenceRows");if(!box)return;const years=[...box.querySelectorAll(".comp-year")].map(x=>Number(x.value)).filter(Boolean);const y=years.length?Math.max(...years)+1:selectedYear;box.insertAdjacentHTML("beforeend",competenceRowHtml(y,0,box.children.length));window.updateCompetenceSummary()};
window.removeCompetenceRow=btn=>{const rows=document.querySelectorAll(".competence-row");if(rows.length<=1){alert("Deve restare almeno una quota di competenza.");return}btn.closest(".competence-row")?.remove();window.updateCompetenceSummary()};
window.readCompetences=()=>[...document.querySelectorAll(".competence-row")].map(r=>({anno:Number(r.querySelector(".comp-year").value),importo:Number(r.querySelector(".comp-amount").value||0)}));

window.periodModeChanged=()=>{const free=document.querySelector('#fPeriodMode')?.value==='free';document.querySelector('#periodMonthsBox')?.classList.toggle('hidden',free);document.querySelector('#periodFreeBox')?.classList.toggle('hidden',!free);window.periodChanged();};
window.periodPickerChanged=which=>{
  const sm=Number(document.querySelector("#fStartMonth")?.value||0);
  const sy=Number(document.querySelector("#fStartYear")?.value||0);
  const emEl=document.querySelector("#fEndMonth");
  const eyEl=document.querySelector("#fEndYear");
  let em=Number(emEl?.value||0),ey=Number(eyEl?.value||0);

  if(which==="end"&&em&&!ey&&sy){
    ey=sy;
    if(eyEl)eyEl.value=String(sy);
  }
  if(which==="end"&&!em&&eyEl){
    eyEl.value="";
    ey=0;
  }

  const start=buildMonthKey(sy,sm);
  const end=buildMonthKey(ey,em);
  const s=document.querySelector("#fPeriodoInizio"),e=document.querySelector("#fPeriodoFine");
  if(s)s.value=start;
  if(e)e.value=end;
  window.periodChanged();
};
window.currentAutoCompetences=()=>{if(document.querySelector('#fPeriodMode')?.value==='free'){const y=Number(document.querySelector('#fPeriodoAnno')?.value||selectedYear),a=Number(document.querySelector('#fImporto')?.value||0);return y?[{anno:y,importo:a,mesi:0}]:[]}return automaticCompetences(document.querySelector('#fPeriodoInizio')?.value,document.querySelector('#fPeriodoFine')?.value,Number(document.querySelector('#fImporto')?.value||0));};
window.renderAutoCompetencePreview=()=>{
  const el=document.querySelector("#autoCompetencePreview");if(!el)return;
  const free=document.querySelector('#fPeriodMode')?.value==='free';
  const a=document.querySelector("#fPeriodoInizio")?.value,b=document.querySelector("#fPeriodoFine")?.value;
  if(!free&&(a||b)&&!validPeriod(a,b)){el.innerHTML=`<span class="auto-bad">Controlla i mesi del periodo.</span>`;return}
  const parts=window.currentAutoCompetences();
  if(!parts.length){el.innerHTML=`<span class="muted">${free?'Inserisci anno e importo per calcolare la competenza.':'Seleziona almeno mese e anno in DAL per calcolare automaticamente la competenza.'}</span>`;return}
  el.innerHTML=`<b>Calcolo automatico</b><div class="auto-pills">${parts.map(c=>`<span>${c.anno} · ${money(c.importo)} <small>${c.mesi} mesi</small></span>`).join("")}</div>`;
};
window.syncManualRowsFromAuto=()=>{
  const parts=window.currentAutoCompetences();if(!parts.length)return;
  const box=document.querySelector("#competenceRows");if(!box)return;
  box.innerHTML=parts.map((c,i)=>competenceRowHtml(c.anno,c.importo,i)).join("");
  window.updateCompetenceSummary();
};
window.toggleManualCompetence=()=>{
  window.manualCompetenceMode=!window.manualCompetenceMode;
  const box=document.querySelector("#manualCompetenceBox"),lab=document.querySelector("#manualToggleLabel");
  box?.classList.toggle("hidden",!window.manualCompetenceMode);
  if(lab)lab.textContent=window.manualCompetenceMode?"Usa calcolo automatico":"Modifica ripartizione";
  if(window.manualCompetenceMode)window.syncManualRowsFromAuto();
};
window.updateCompetenceSummary=()=>{
  const el=document.querySelector("#competenceSummary");if(!el)return;
  const total=Number(document.querySelector("#fImporto")?.value||0),parts=window.readCompetences(),q=parts.reduce((a,c)=>a+Number(c.importo||0),0),diff=Math.round((total-q)*100)/100;
  el.classList.toggle("ok",Math.abs(diff)<.011);el.classList.toggle("bad",Math.abs(diff)>=.011);
  el.textContent=Math.abs(diff)<.011?`Quote: ${money(q)} ✓`:`Quote: ${money(q)} · differenza ${money(diff)}`;
};
window.periodChanged=()=>{
  window.renderAutoCompetencePreview();
  if(window.manualCompetenceMode)window.updateCompetenceSummary();
};
window.billTotalChanged=()=>{
  window.renderAutoCompetencePreview();
  if(window.manualCompetenceMode)window.updateCompetenceSummary();
};

window.saveBill=async id=>{
  const v=x=>document.querySelector(x)?.value||"";
  const importo=Number(v("#fImporto")||0),periodMode=v("#fPeriodMode")||"months",periodoInizio=periodMode==='free'?'':v("#fPeriodoInizio"),periodoFine=periodMode==='free'?'':v("#fPeriodoFine"),periodoLibero=v("#fPeriodoLibero").trim(),periodoAnno=Number(v("#fPeriodoAnno")||selectedYear);
  if(importo<0||!Number.isFinite(importo)){alert("Controlla l'importo.");return}
  if(v("#fStato")==="Pagata"&&!v("#fPagamento")){alert("Per una bolletta pagata inserisci la data del pagamento: serve a calcolare correttamente il saldo mensile.");return}
  if(periodMode==='free'&&!periodoLibero){alert("Inserisci la dicitura della competenza, ad esempio 1° acconto.");return}
  if(periodMode!=='free'&&(periodoInizio||periodoFine)&&!validPeriod(periodoInizio,periodoFine)){alert("Controlla DAL e AL del periodo di competenza.");return}
  let competenze,fonte;
  if(window.manualCompetenceMode){
    competenze=window.readCompetences();fonte="manuale";
    if(!competenze.length||competenze.some(c=>!Number.isInteger(c.anno)||c.anno<2000||c.anno>2100||!Number.isFinite(c.importo)||c.importo<0)){alert("Controlla la ripartizione manuale.");return}
    const seen=new Set();for(const c of competenze){if(seen.has(c.anno)){alert("Inserisci una sola quota per ciascun anno.");return}seen.add(c.anno)}
    const quotaTot=competenze.reduce((a,c)=>a+c.importo,0);if(Math.abs(quotaTot-importo)>.011){alert(`La somma delle quote (${money(quotaTot)}) deve essere uguale all'importo totale (${money(importo)}).`);return}
  }else{
    competenze=periodMode==='free'?[{anno:periodoAnno,importo}]:automaticCompetences(periodoInizio,periodoFine,importo);fonte=periodMode==='free'?"libera":"automatica";
    if(!competenze.length){
      const old=id?state.bills.find(x=>x.id===id):null;
      competenze=old?billCompetences(old):[{anno:selectedYear,importo}];
      fonte=old?"legacy":"automatica";
    }
  }
  const oldBill=id?state.bills.find(x=>x.id===id):null;
  const periodo=periodMode==='free'?periodoLibero:(validPeriod(periodoInizio,periodoFine)?formatPeriod({periodoInizio,periodoFine}):(oldBill?.periodo||""));
  const mese=periodMode==='free'?Number(oldBill?.mese||0):(validPeriod(periodoInizio,periodoFine)?Number(normalizeMonthKey(periodoInizio).slice(5,7)):Number(oldBill?.mese||new Date().getMonth()+1));
  const data={utenza:"Luce",dataEmissione:v("#fEmissione"),periodo,periodoInizio,periodoFine,scadenza:v("#fScadenza"),dataPagamento:v("#fPagamento"),importo,stato:v("#fStato"),mese,anno:competenze[0]?.anno||selectedYear,competenze:competenze.map(c=>({anno:Number(c.anno),importo:Number(c.importo)})),competenzeFonte:fonte,consumo:v("#fConsumo"),unita:v("#fUnita"),metodo:v("#fMetodo"),note:v("#fNote"),updatedAt:serverTimestamp()};
  if(id)await updateDoc(docFor("bills",id),data);else await addDoc(pathFor("bills"),{...data,createdAt:serverTimestamp()});
  closeModal();
};
window.dupBill=async id=>{const b=state.bills.find(x=>x.id===id);if(!b)return;const c={...b};delete c.id;await addDoc(pathFor("bills"),{...c,note:(c.note?c.note+" • ":"")+"Duplicata",createdAt:serverTimestamp(),updatedAt:serverTimestamp()})};
window.delBill=async id=>{if(confirm("Eliminare questa bolletta?"))await deleteDoc(docFor("bills",id))};

function renderBudget(){
  const rows=months.map((m,i)=>{
    const b=state.budgets.find(x=>Number(x.mese)===i+1&&Number(x.anno)===selectedYear)||{};
    return `<tr><td><b>${m}</b></td>${utilities.map(u=>`<td class="right">${money(b[u]||0)}</td>`).join("")}<td class="right"><b>${money(utilities.reduce((a,u)=>a+Number(b[u]||0),0))}</b></td><td><div class="actions"><button class="mini" onclick="window.editBudget('${b.id||""}',${i+1})" aria-label="Modifica budget ${m}">✎</button>${b.id?`<button class="mini danger" onclick="window.delBudget('${b.id}')" aria-label="Elimina budget ${m}">×</button>`:""}</div></td></tr>`
  }).join("");
  pageEl.innerHTML=`<div class="card section"><div class="section-head"><div><h2>Budget ${selectedYear}</h2><p class="muted">Tocca la matita per modificare il budget di un mese.</p></div></div><div class="table-wrap generic-edit-table"><table><thead><tr><th>Mese</th>${utilities.map(u=>`<th>${u}</th>`).join("")}<th>Totale</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

window.editBudget=(id,mese)=>{
  const b=id?state.budgets.find(x=>x.id===id):{anno:selectedYear,mese:Number(mese)||1};
  if(!b)return;
  showModal(`<div class="modal-head"><h2>Budget ${months[Number(b.mese||1)-1]} ${Number(b.anno||selectedYear)}</h2><button class="mini" onclick="window.closeModal()">×</button></div>
  <div class="formgrid">
    <label class="field">Anno<input id="bgAnno" type="number" min="2000" max="2100" value="${Number(b.anno||selectedYear)}"></label>
    <label class="field">Mese<select id="bgMese">${months.map((m,i)=>`<option value="${i+1}" ${Number(b.mese)===i+1?"selected":""}>${m}</option>`).join("")}</select></label>
    <div class="span3 budget-edit-grid">${utilities.map(u=>`<label class="field">${utilIcon(u)} ${u}<input class="budget-util" data-util="${u}" type="number" min="0" step=".01" value="${Number(b[u]||0)}"></label>`).join("")}</div>
  </div>
  <div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveBudget('${id||""}')">Salva</button></div>`);
};
window.saveBudget=async id=>{
  const anno=Number(document.querySelector('#bgAnno')?.value),mese=Number(document.querySelector('#bgMese')?.value);
  if(!Number.isInteger(anno)||anno<2000||anno>2100||!Number.isInteger(mese)||mese<1||mese>12){alert('Controlla anno e mese.');return}
  const data={anno,mese,updatedAt:serverTimestamp()};
  document.querySelectorAll('.budget-util').forEach(el=>data[el.dataset.util]=Number(el.value||0));
  if(Object.values(data).some((v,k)=>false))return;
  const duplicate=state.budgets.find(x=>x.id!==id&&Number(x.anno)===anno&&Number(x.mese)===mese);
  if(duplicate&&!confirm(`Esiste già un budget per ${months[mese-1]} ${anno}. Vuoi sostituirlo?`))return;
  if(duplicate){await updateDoc(docFor('budgets',duplicate.id),data);if(id)await deleteDoc(docFor('budgets',id));}
  else if(id)await updateDoc(docFor('budgets',id),data);
  else await addDoc(pathFor('budgets'),{...data,createdAt:serverTimestamp()});
  closeModal();
};
window.delBudget=async id=>{if(confirm('Eliminare questo budget mensile?'))await deleteDoc(docFor('budgets',id))};

function readingPeriodLabel(r){
  const dal=r.periodoDal||r.dal||'';
  const al=r.periodoAl||r.al||'';
  if(dal&&al)return `${fmtReadingDate(dal)} – ${fmtReadingDate(al)}`;
  if(dal)return `Dal ${fmtReadingDate(dal)}`;
  if(al)return `Fino al ${fmtReadingDate(al)}`;
  return '—';
}
function readingUnitForUtility(utility){
  const u=String(utility||'').toLowerCase();
  if(u==='luce')return 'kWh';
  if(u==='acqua')return 'm³';
  if(u==='gas')return 'Smc';
  return '';
}

function waterReadingDate(r){
  return r.periodoAl||r.data||r.periodoDal||r.al||r.dal||'';
}
function waterMetrics(r){
  if(String(r?.utenza||'').toLowerCase()!=='acqua') return {consumo:'',media:'',giorni:''};
  const current=Number(String(r.lettura??'').replace(',','.'));
  if(!Number.isFinite(current)) return {consumo:'',media:'',giorni:''};
  const currentEnd=waterReadingDate(r);
  const start=r.periodoDal||r.dal||'';
  const candidates=state.readings.filter(x=>x.id!==r.id&&String(x.utenza||'').toLowerCase()==='acqua'&&x.lettura!==''&&x.lettura!=null)
    .map(x=>({r:x,key:waterReadingDate(x)})).filter(x=>x.key&&currentEnd&&x.key<currentEnd);
  let eligible=candidates.filter(x=>!start||x.key<=start);
  if(!eligible.length) eligible=candidates;
  eligible.sort((a,b)=>b.key.localeCompare(a.key));
  const prev=eligible[0]?.r;
  if(!prev) return {consumo:'',media:'',giorni:''};
  const previous=Number(String(prev.lettura).replace(',','.'));
  if(!Number.isFinite(previous)||current<previous) return {consumo:'',media:'',giorni:''};
  // Il consumo deriva dalla differenza fra le due letture del contatore.
  const consumption=current-previous;

  // La media, invece, deve rispettare ESATTAMENTE il periodo Dal/Al inserito
  // nella registrazione corrente. Solo se il periodo manca usiamo le date
  // delle letture come ripiego per i vecchi dati.
  const periodStart=r.periodoDal||r.dal||waterReadingDate(prev);
  const periodEnd=r.periodoAl||r.al||currentEnd;
  const d1=new Date(`${periodStart}T12:00:00`), d2=new Date(`${periodEnd}T12:00:00`);
  const diffDays=Math.round((d2-d1)/86400000);
  if(!Number.isFinite(diffDays)||diffDays<=0) return {consumo:'',media:'',giorni:'',previous};
  const days=diffDays;
  const mediaRaw=consumption/days;
  const clean=n=>Number(n.toFixed(3)).toString();
  return {consumo:clean(consumption),media:clean(mediaRaw),mediaRaw,giorni:String(days),previous};
}

function readingPrimaryValue(r){
  const u=String(r.utenza||'');
  const unit=r.unita||readingUnitForUtility(u);
  if(u==='Acqua'){
    const value=r.lettura!==undefined&&r.lettura!==''?`${esc(r.lettura)} ${esc(unit)}`:'—';
    return {label:'Lettura',value};
  }
  const value=r.consumo!==undefined&&r.consumo!==''?`${esc(r.consumo)} ${esc(unit)}`:'—';
  return {label:'Consumo',value};
}
function renderReadings(){
  const allReadings=[...state.readings].filter(r=>readingUtilities.some(u=>u.toLowerCase()===String(r.utenza||'').toLowerCase()));
  const arr=allReadings.filter(r=>readingsUtilityFilter==='Tutte'||String(r.utenza||'').toLowerCase()===readingsUtilityFilter.toLowerCase()).sort((a,b)=>(b.data||b.periodoAl||'').localeCompare(a.data||a.periodoAl||''));
  const filterButtons=['Tutte','Acqua','Luce','Gas'].map(u=>`<button class="reading-filter-chip ${readingsUtilityFilter===u?'active':''}" onclick="window.setReadingsFilter('${u}')">${u==='Tutte'?'Tutte':`${utilIcon(u)} ${u}`}</button>`).join('');
  const desktopRows=arr.map(r=>{const unit=r.unita||readingUnitForUtility(r.utenza);const wm=String(r.utenza||'').toLowerCase()==='acqua'?waterMetrics(r):null;const consumo=wm?wm.consumo:r.consumo;const media=wm?wm.media:r.media;const giorni=wm?wm.giorni:r.giorni;return `<tr><td>${fmtReadingDate(r.data)}</td><td>${readingPeriodLabel(r)}</td><td>${utilIcon(r.utenza)} ${esc(r.utenza)}</td><td>${esc(r.lettura)}${r.lettura!==undefined&&r.lettura!==''&&unit?` ${esc(unit)}`:''}</td><td>${esc(consumo)}${consumo!==undefined&&consumo!==''&&unit?` ${esc(unit)}`:''}</td><td>${esc(giorni)}</td><td>${esc(media)}${media!==undefined&&media!==''&&unit?` ${esc(unit)}/g`:''}</td><td>${esc(r.note)}</td><td><div class="actions"><button class="mini" onclick="window.editReading('${r.id}')">✎</button><button class="mini danger" onclick="window.delReading('${r.id}')">×</button></div></td></tr>`}).join("");
  const mobileCards=arr.map(r=>{
    const metric=readingPrimaryValue(r);
    const isWater=String(r.utenza||'').toLowerCase()==='acqua';
    const wm=isWater?waterMetrics(r):null;
    const consumo=isWater&&wm?.consumo!==''?`<span><small>Consumo</small><b>${esc(wm.consumo)} m³</b></span>`:'';
    const media=isWater&&wm?.media!==''?`<span><small>Media</small><b>${esc(wm.media)} m³/g</b></span>`:'';
    const notes=r.note?`<p class="reading-mobile-note">${esc(r.note)}</p>`:'';
    return `<article class="reading-mobile-card">
      <div class="reading-mobile-top"><span class="reading-mobile-icon ${utilityTone(r.utenza)}">${utilIcon(r.utenza)}</span><div><b>${esc(r.utenza)}</b><small>${fmtReadingDate(r.data)}</small></div><div class="reading-mobile-actions"><button class="mini" aria-label="Modifica" onclick="window.editReading('${r.id}')">✎</button><button class="mini danger" aria-label="Elimina" onclick="window.delReading('${r.id}')">×</button></div></div>
      <div class="reading-mobile-period"><small>Periodo</small><b>${readingPeriodLabel(r)}</b></div>
      <div class="reading-mobile-values"><span><small>${metric.label}</small><b>${metric.value}</b></span>${consumo}${media}</div>${notes}
    </article>`;
  }).join('');
  pageEl.innerHTML=`<div class="card section readings-section"><div class="section-head readings-head"><div><h2>Letture contatori</h2><p class="muted">Luce e gas: consumo del periodo. Acqua: lettura del contatore. Giorni e media vengono calcolati automaticamente.</p></div><button class="primary" onclick="window.editReading()">+ Nuova lettura</button></div>
    <div class="reading-filter-bar">${filterButtons}</div>
    ${arr.length?`<div class="readings-mobile-list">${mobileCards}</div><div class="table-wrap generic-edit-table readings-desktop-table"><table><thead><tr><th>Data</th><th>Periodo</th><th>Utenza</th><th>Lettura</th><th>Consumo</th><th>Giorni</th><th>Media</th><th>Note</th><th></th></tr></thead><tbody>${desktopRows}</tbody></table></div>`:`<div class="readings-empty">Nessuna lettura ${readingsUtilityFilter==='Tutte'?'registrata.':`di ${esc(readingsUtilityFilter)} registrata.`}</div>`}
  </div>`;
}
window.setReadingsFilter=filter=>{
  readingsUtilityFilter=['Tutte','Acqua','Luce','Gas'].includes(filter)?filter:'Tutte';
  renderReadings();
};
window.renderReadingDynamicFields=()=>{
  const utility=document.querySelector('#rdUtenza')?.value||'';
  const box=document.querySelector('#rdDynamicFields');
  if(!box)return;
  const editingId=document.querySelector('#rdEditingId')?.value||'';
  const original=editingId?state.readings.find(x=>x.id===editingId):null;
  if(!utility){
    box.innerHTML='<div class="reading-select-hint">Seleziona prima l’utenza.</div>';
    return;
  }
  if(utility==='Acqua'){
    box.innerHTML=`<label class="field span2">Lettura (m³)<input id="rdLettura" type="number" inputmode="decimal" step="any" value="${esc(original?.utenza==='Acqua'?(original?.lettura??''):'')}"></label>`;
  }else{
    const unit=utility==='Gas'?'Smc':'kWh';
    box.innerHTML=`<label class="field span2">Consumo (${unit})<input id="rdConsumo" type="number" inputmode="decimal" step="any" value="${esc(original?.utenza===utility?(original?.consumo??''):'')}"></label>`;
  }
};
window.updateReadingFields=window.renderReadingDynamicFields;
window.updateReadingUnit=window.renderReadingDynamicFields;
window.editReading=id=>{
  const today=new Date().toISOString().slice(0,10);
  const r=id?state.readings.find(x=>x.id===id):{utenza:'',data:today};
  if(!r)return;
  const opt=`<option value="">Seleziona utenza</option>`+readingUtilities.map(u=>`<option value="${u}" ${u===r.utenza?'selected':''}>${u}</option>`).join('');
  showModal(`<div class="modal-head"><h2>${id?'Modifica':'Nuova'} lettura</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <input id="rdEditingId" type="hidden" value="${esc(id||'')}">
    <label class="field">Data<input id="rdData" type="date" value="${r.data||''}"></label>
    <label class="field">Utenza<select id="rdUtenza" onchange="window.renderReadingDynamicFields()">${opt}</select></label>
    <label class="field">Periodo dal<input id="rdPeriodoDal" type="date" value="${r.periodoDal||r.dal||''}"></label>
    <label class="field">Periodo al<input id="rdPeriodoAl" type="date" value="${r.periodoAl||r.al||''}"></label>
    <div id="rdDynamicFields" class="span2 reading-dynamic-fields"></div>
    <label class="field span2">Note<textarea id="rdNote">${esc(r.note||'')}</textarea></label>
  </div><div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveReading('${id||''}')">Salva</button></div>`);
  window.renderReadingDynamicFields();
};
window.saveReading=async id=>{
  const v=x=>document.querySelector(x)?.value||'';
  const periodoDal=v('#rdPeriodoDal'), periodoAl=v('#rdPeriodoAl');
  let giorni='';
  if(periodoDal&&periodoAl){
    const d1=new Date(`${periodoDal}T12:00:00`),d2=new Date(`${periodoAl}T12:00:00`);
    if(d2<d1){alert('La fine del periodo non può essere precedente all’inizio.');return}
    giorni=String(Math.round((d2-d1)/86400000)+1);
  }
  const utenza=v('#rdUtenza');
  if(!utenza){alert('Seleziona l’utenza.');return}
  const isWater=utenza==='Acqua';
  const unita=readingUnitForUtility(utenza);
  const lettura=isWater?v('#rdLettura'):'';
  let media='', waterConsumption='', waterDays=giorni;
  if(isWater&&lettura){
    const wm=waterMetrics({id,utenza:'Acqua',lettura,periodoDal,periodoAl,data:v('#rdData')});
    media=wm.media; waterConsumption=wm.consumo; waterDays=wm.giorni||giorni;
  }
  const data={
    data:v('#rdData'),utenza,unita,periodoDal,periodoAl,
    lettura,
    consumo:isWater?waterConsumption:v('#rdConsumo'),
    giorni:isWater?waterDays:giorni,
    media,
    note:v('#rdNote'),updatedAt:serverTimestamp()
  };
  if(!data.data){alert('Inserisci la data.');return}
  if(!data.periodoDal||!data.periodoAl){alert('Inserisci il periodo, dal e al.');return}
  if(isWater&&!data.lettura){alert('Inserisci la lettura dell’acqua in m³.');return}
  if(!isWater&&!data.consumo){alert(`Inserisci il consumo ${utenza==='Luce'?'in kWh':'in Smc'}.`);return}
  if(id)await updateDoc(docFor('readings',id),data);else await addDoc(pathFor('readings'),{...data,createdAt:serverTimestamp()});
  closeModal();
};
window.delReading=async id=>{if(confirm('Eliminare questa lettura?'))await deleteDoc(docFor('readings',id))};

function renderShopping(){
  const open=[...state.shopping].filter(x=>!x.done).sort((a,b)=>String(a.createdAt?.seconds||0).localeCompare(String(b.createdAt?.seconds||0)));
  const done=[...state.shopping].filter(x=>x.done);
  const row=x=>`<div class="shopping-row ${x.done?'done':''}"><button class="shopping-check" onclick="window.toggleShopping('${x.id}',${!x.done})">${x.done?'✓':''}</button><button class="shopping-main" onclick="window.editShopping('${x.id}')"><b>${esc(x.name)}</b><small>${x.qty&&x.qty!=='1'?`Quantità: ${esc(x.qty)}`:'Da comprare'}</small></button><button class="shopping-delete" onclick="window.delShopping('${x.id}')">×</button></div>`;
  pageEl.innerHTML=`<section class="shopping-head card"><div><p>${open.length} ${open.length===1?'prodotto da comprare':'prodotti da comprare'}</p></div><button class="primary" onclick="window.editShopping()">+ Aggiungi</button></section>
  <section class="card shopping-list">${open.length?open.map(row).join(''):'<div class="shopping-empty"><span class="shopping-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h2l1.5 9h9.8l1.7-6.5H7"></path><circle cx="9" cy="18.5" r="1.25"></circle><circle cx="16.5" cy="18.5" r="1.25"></circle></svg></span><b>La lista è vuota</b><span>Aggiungi il primo prodotto.</span></div>'}</section>
  ${done.length?`<section class="shopping-bought"><div class="clean-head"><h2>Acquistati</h2><button onclick="window.clearBought()">Elimina acquistati</button></div><div class="card shopping-list">${done.map(row).join('')}</div></section>`:''}
  <section class="card alexa-card"><div class="alexa-orb">◉</div><div><b>Alexa</b><p>La lista è già predisposta per essere collegata alla skill Casa+. Il collegamento vocale verrà attivato nella fase Alexa.</p></div><span class="alexa-status">Da collegare</span></section>`;
}
window.editShopping=id=>{
  const x=id?state.shopping.find(v=>v.id===id):{qty:'1'};if(!x)return;
  showModal(`<div class="modal-head"><h2>${id?'Modifica prodotto':'Aggiungi alla spesa'}</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid"><label class="field span2">Prodotto<input id="shName" value="${esc(x.name||'')}" placeholder="Prodotto"></label><label class="field">Quantità<input id="shQty" value="${esc(x.qty||'1')}" placeholder="1"></label></div><div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveShopping('${id||''}')">Salva</button></div>`);
  setTimeout(()=>document.querySelector('#shName')?.focus(),50);
};
window.saveShopping=async id=>{const name=document.querySelector('#shName')?.value.trim()||'';if(!name){alert('Inserisci il prodotto.');return}const data={name,qty:document.querySelector('#shQty')?.value.trim()||'1',updatedAt:serverTimestamp()};if(id)await updateDoc(docFor('shopping',id),data);else await addDoc(pathFor('shopping'),{...data,done:false,source:'app',createdAt:serverTimestamp()});closeModal()};
window.toggleShopping=async(id,done)=>updateDoc(docFor('shopping',id),{done,completedAt:done?serverTimestamp():null,updatedAt:serverTimestamp()});
window.delShopping=async id=>{if(confirm('Eliminare questo prodotto dalla lista?'))await deleteDoc(docFor('shopping',id))};
window.clearBought=async()=>{if(!confirm('Eliminare tutti i prodotti acquistati?'))return;await Promise.all(state.shopping.filter(x=>x.done).map(x=>deleteDoc(docFor('shopping',x.id))))};

const jobRooms=['Cucina','Soggiorno','Entrata','Stanza amore','Stanza mia','Bagno mio','Bagno amore','Camera da letto','Balcone monte','Balcone mare'];
const jobStatuses=['Da fare','In corso','Fatto'];
function renderJobs(){
  const todo=state.jobs.filter(j=>j.stato!=="Fatto"),done=state.jobs.filter(j=>j.stato==="Fatto");
  pageEl.innerHTML=`<div class="kpis" style="grid-template-columns:repeat(3,1fr)">
  <div class="card kpi"><div class="lab">DA FARE</div><div class="val">${todo.length}</div></div>
  <div class="card kpi"><div class="lab">COMPLETATI</div><div class="val">${done.length}</div></div>
  <div class="card kpi"><div class="lab">COSTO STIMATO</div><div class="val">${money(sum(todo,"costo"))}</div></div></div>
  <div class="card section"><div class="section-head"><div><h2>Lavori casa</h2><p class="muted">Attività, materiali, costi e stato.</p></div><button class="primary" onclick="window.editJob()">+ Nuovo lavoro</button></div><div class="table-wrap generic-edit-table"><table><thead><tr><th>Attività</th><th>Stanza</th><th>Materiali</th><th>Costo</th><th>Stato</th><th></th></tr></thead><tbody>${state.jobs.map(j=>`<tr><td>${esc(j.attivita)}</td><td>${esc(j.stanza)}</td><td>${esc(j.materiali)}</td><td>${j.costo==null||j.costo===''?"—":money(j.costo)}</td><td>${badge(j.stato)}</td><td><div class="actions"><button class="mini" onclick="window.editJob('${j.id}')">✎</button><button class="mini danger" onclick="window.delJob('${j.id}')">×</button></div></td></tr>`).join("")}</tbody></table></div></div>`;
}
window.editJob=id=>{
  const j=id?state.jobs.find(x=>x.id===id):{stato:'Da fare'};if(!j)return;
  const statuses=[...new Set([...jobStatuses,j.stato].filter(Boolean))].map(x=>`<option ${x===j.stato?'selected':''}>${esc(x)}</option>`).join('');
  showModal(`<div class="modal-head"><h2>${id?'Modifica':'Nuovo'} lavoro</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field span2">Attività<input id="jbAttivita" value="${esc(j.attivita||'')}"></label>
    <label class="field">Stanza<input id="jbStanza" list="jobRoomList" value="${esc(j.stanza||'')}"><datalist id="jobRoomList">${jobRooms.map(x=>`<option value="${x}">`).join('')}</datalist></label>
    <label class="field span2">Materiali<input id="jbMateriali" value="${esc(j.materiali||'')}"></label>
    <label class="field">Costo stimato €<input id="jbCosto" type="number" min="0" step=".01" value="${j.costo??''}"></label>
    <label class="field">Stato<select id="jbStato">${statuses}</select></label>
    <label class="field span2">Note<textarea id="jbNote">${esc(j.note||'')}</textarea></label>
  </div><div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveJob('${id||''}')">Salva</button></div>`);
};
window.saveJob=async id=>{
  const v=x=>document.querySelector(x)?.value||'';const raw=v('#jbCosto');
  const data={attivita:v('#jbAttivita').trim(),stanza:v('#jbStanza').trim(),materiali:v('#jbMateriali').trim(),costo:raw===''?'':Number(raw),stato:v('#jbStato'),note:v('#jbNote'),updatedAt:serverTimestamp()};
  if(!data.attivita){alert("Inserisci l'attività da fare.");return}if(raw!==''&&!Number.isFinite(data.costo)){alert('Controlla il costo.');return}
  if(id)await updateDoc(docFor('jobs',id),data);else await addDoc(pathFor('jobs'),{...data,createdAt:serverTimestamp()});closeModal();
};
window.delJob=async id=>{if(confirm('Eliminare questo lavoro?'))await deleteDoc(docFor('jobs',id))};

function renderTariffs(){
  pageEl.innerHTML=`<div class="card section"><div class="section-head"><div><h2>Tariffe e contratti</h2><p class="muted">Fornitori e condizioni delle utenze.</p></div><button class="primary" onclick="window.editTariff()">+ Nuova tariffa</button></div><div class="table-wrap generic-edit-table"><table><thead><tr><th>Utenza</th><th>Fornitore</th><th>Quota fissa</th><th>Costo unitario</th><th>Unità</th><th>Note</th><th></th></tr></thead><tbody>${state.tariffs.map(t=>`<tr><td>${utilIcon(t.utenza)} ${esc(t.utenza)}</td><td>${esc(t.fornitore)}</td><td>${money(t.quotaFissa)}</td><td>${Number(t.costoUnitario||0).toLocaleString("it-IT")}</td><td>${esc(t.unita)}</td><td>${esc(t.note)}</td><td><div class="actions"><button class="mini" onclick="window.editTariff('${t.id}')">✎</button><button class="mini danger" onclick="window.delTariff('${t.id}')">×</button></div></td></tr>`).join("")}</tbody></table></div></div>`;
}
window.editTariff=id=>{
  const t=id?state.tariffs.find(x=>x.id===id):{utenza:'Luce'};if(!t)return;
  const opt=utilities.map(u=>`<option ${u===t.utenza?'selected':''}>${u}</option>`).join('');
  showModal(`<div class="modal-head"><h2>${id?'Modifica':'Nuova'} tariffa</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field">Utenza<select id="tfUtenza">${opt}</select></label>
    <label class="field span2">Fornitore<input id="tfFornitore" value="${esc(t.fornitore||'')}"></label>
    <label class="field">Quota fissa €<input id="tfQuota" type="number" min="0" step=".0001" value="${t.quotaFissa??''}"></label>
    <label class="field">Costo unitario<input id="tfCosto" type="number" min="0" step=".000001" value="${t.costoUnitario??''}"></label>
    <label class="field">Unità<input id="tfUnita" value="${esc(t.unita||'')}"></label>
    <label class="field span3">Note<textarea id="tfNote">${esc(t.note||'')}</textarea></label>
  </div><div class="modal-foot"><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveTariff('${id||''}')">Salva</button></div>`);
};
window.saveTariff=async id=>{
  const v=x=>document.querySelector(x)?.value||'';const q=v('#tfQuota'),c=v('#tfCosto');
  const data={utenza:v('#tfUtenza'),fornitore:v('#tfFornitore').trim(),quotaFissa:q===''?0:Number(q),costoUnitario:c===''?0:Number(c),unita:v('#tfUnita').trim(),note:v('#tfNote'),updatedAt:serverTimestamp()};
  if((q!==''&&!Number.isFinite(data.quotaFissa))||(c!==''&&!Number.isFinite(data.costoUnitario))){alert('Controlla i valori della tariffa.');return}
  if(id)await updateDoc(docFor('tariffs',id),data);else await addDoc(pathFor('tariffs'),{...data,createdAt:serverTimestamp()});closeModal();
};
window.delTariff=async id=>{if(confirm('Eliminare questa tariffa?'))await deleteDoc(docFor('tariffs',id))};

async function exportBackup(){
  const backup={exportedAt:new Date().toISOString()};
  for(const n of ["bills","expenses","incomes"])backup[n]=state[n];
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`spese-plus-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
window.exportBackup=exportBackup;


let agendaWeekStart="";
let agendaView="month";
let agendaMonthAnchor="";
let agendaSelectedDate="";
function isoLocal(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`}
function dateFromIso(s){const [y,m,d]=String(s||"").split("-").map(Number);return new Date(y,m-1,d)}
function mondayOf(d){const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());const wd=x.getDay()||7;x.setDate(x.getDate()-wd+1);return x}
function agendaStart(){if(agendaWeekStart)return dateFromIso(agendaWeekStart);return mondayOf(new Date())}
function eventCategoryIcon(c){return ({Auto:"🚗",Casa:"⌂",Personale:"●",Salute:"+",Appuntamento:"□",Altro:"•",Turno:"▣"})[c]||"•"}
function agendaItemsForDate(date){
  const manual=state.events.filter(e=>e.date===date).map(e=>({kind:e.type==='shift'?'shift':'event',...e}));
  const bills=state.bills.filter(b=>!isPaid(b)&&b.scadenza===date).map(b=>({kind:"bill",id:b.id,title:`${b.utenza} · ${money(b.importo)}`,time:"",category:"Bolletta",note:"Scadenza bolletta"}));
  const order={shift:0,event:1,bill:2};
  return [...manual,...bills].sort((a,b)=>(order[a.kind]??9)-(order[b.kind]??9)||String(a.time||"99:99").localeCompare(String(b.time||"99:99")));
}
function agendaItemHtml(x){
  if(x.kind==='bill')return `<button class="agenda-item bill-event" onclick="window.editBill('${x.id}')"><span class="agenda-time agenda-bill-badge">B</span><span><b>${esc(x.title)}</b><small>Bolletta da pagare</small></span><i>›</i></button>`;
  if(x.kind==='shift')return `<button class="agenda-item shift-event shift-${String(x.shift||'').toLowerCase().replace(/[^a-z]/g,'')}" onclick="window.editWorkShift('${x.id}')"><span class="agenda-time">Turno</span><span><b>${esc(x.shift||'Turno')}</b><small>Turno di lavoro${x.note?` · ${esc(x.note)}`:''}</small></span><i>›</i></button>`;
  return `<button class="agenda-item" onclick="window.editEvent('${x.id}')"><span class="agenda-time">${esc(x.time||'Tutto il giorno')}</span><span><b><i class="event-list-dot"></i>${esc(x.title)}</b><small>${esc(x.category||'Impegno')}${x.note?` · ${esc(x.note)}`:''}</small></span><i>›</i></button>`;
}
function monthAgendaMarkers(items){
  const shift=items.find(x=>x.kind==='shift');
  const bills=items.filter(x=>x.kind==='bill');
  const events=items.filter(x=>x.kind==='event');
  return `${shift?`<span class="month-shift shift-${String(shift.shift||'').toLowerCase().replace(/[^a-z]/g,'')}">${esc(shift.shift||'Turno')}</span>`:''}<span class="month-markers">${bills.length?'<i class="bill-badge">B</i>':''}${events.length?'<i class="event-dot"></i>':''}</span>`;
}
function agendaViewToggle(){return `<div class="agenda-view-toggle"><button class="${agendaView==='week'?'active':''}" onclick="window.setAgendaView('week')">Settimana</button><button class="${agendaView==='month'?'active':''}" onclick="window.setAgendaView('month')">Mese</button></div>`}
function renderAgenda(){
  const today=isoLocal(new Date());
  if(agendaView==='month'){
    let anchor=agendaMonthAnchor?dateFromIso(agendaMonthAnchor):new Date();
    anchor=new Date(anchor.getFullYear(),anchor.getMonth(),1);agendaMonthAnchor=isoLocal(anchor);
    if(!agendaSelectedDate||dateFromIso(agendaSelectedDate).getMonth()!==anchor.getMonth()||dateFromIso(agendaSelectedDate).getFullYear()!==anchor.getFullYear()){
      agendaSelectedDate=(today.slice(0,7)===agendaMonthAnchor.slice(0,7))?today:isoLocal(anchor);
    }
    const firstGrid=mondayOf(anchor);const cells=[];for(let i=0;i<42;i++){const d=new Date(firstGrid);d.setDate(firstGrid.getDate()+i);cells.push(d)}
    const selectedItems=agendaItemsForDate(agendaSelectedDate);
    pageEl.innerHTML=`<section class="agenda-head"><div><h1>Agenda</h1><p>Appuntamenti e scadenze.</p></div><div class="agenda-head-actions"><button class="ghost agenda-turn-btn" onclick="window.editWorkShift()">+ Turno</button><button class="primary" onclick="window.editEvent()">+ Impegno</button></div></section>
      ${agendaViewToggle()}
      <section class="agenda-weekbar agenda-monthbar"><button onclick="window.changeAgendaMonth(-1)">‹</button><div><b>${monthNamesLong[anchor.getMonth()]} ${anchor.getFullYear()}</b><small>Vista mensile</small></div><button onclick="window.changeAgendaMonth(1)">›</button></section>
      <section class="month-calendar card"><div class="month-weekdays">${['LUN','MAR','MER','GIO','VEN','SAB','DOM'].map(x=>`<span>${x}</span>`).join('')}</div><div class="month-grid">${cells.map(d=>{const key=isoLocal(d),items=agendaItemsForDate(key),outside=d.getMonth()!==anchor.getMonth();return `<button class="month-day ${outside?'outside':''} ${key===today?'today':''} ${key===agendaSelectedDate?'selected':''}" onclick="window.selectAgendaDate('${key}')"><b>${d.getDate()}</b>${monthAgendaMarkers(items)}</button>`}).join('')}</div></section>
      <section class="agenda-selected card"><div class="clean-head"><h2>${fmtDate(agendaSelectedDate)}</h2><span>${selectedItems.length} ${selectedItems.length===1?'impegno':'impegni'}</span></div><div class="agenda-items">${selectedItems.length?selectedItems.map(agendaItemHtml).join(''):'<div class="agenda-empty">Nessun impegno in questa data.</div>'}</div></section>`;
    return;
  }
  const start=agendaStart();agendaWeekStart=isoLocal(start);const end=new Date(start);end.setDate(start.getDate()+6);
  const days=[];for(let i=0;i<7;i++){const d=new Date(start);d.setDate(start.getDate()+i);days.push(d)}
  pageEl.innerHTML=`<section class="agenda-head"><div><h1>Agenda</h1><p>Appuntamenti e scadenze della settimana.</p></div><div class="agenda-head-actions"><button class="ghost agenda-turn-btn" onclick="window.editWorkShift()">+ Turno</button><button class="primary" onclick="window.editEvent()">+ Impegno</button></div></section>
  ${agendaViewToggle()}
  <section class="agenda-weekbar"><button onclick="window.changeAgendaWeek(-1)">‹</button><div><b>${fmtDate(isoLocal(start))} – ${fmtDate(isoLocal(end))}</b><small>Settimana</small></div><button onclick="window.changeAgendaWeek(1)">›</button></section>
  <div class="agenda-days">${days.map(d=>{const key=isoLocal(d),items=agendaItemsForDate(key);return `<section class="agenda-day ${key===today?'today':''}"><div class="agenda-date"><span>${['DOM','LUN','MAR','MER','GIO','VEN','SAB'][d.getDay()]}</span><b>${d.getDate()}</b><small>${monthNamesLong[d.getMonth()]}</small></div><div class="agenda-items">${items.length?items.map(agendaItemHtml).join(''):`<div class="agenda-empty">Nessun impegno</div>`}</div></section>`}).join('')}</div>`;
}
window.setAgendaView=v=>{agendaView=v==='month'?'month':'week';renderAgenda()};
window.changeAgendaWeek=delta=>{const d=agendaStart();d.setDate(d.getDate()+Number(delta)*7);agendaWeekStart=isoLocal(d);renderAgenda()};
window.changeAgendaMonth=delta=>{let d=agendaMonthAnchor?dateFromIso(agendaMonthAnchor):new Date();d=new Date(d.getFullYear(),d.getMonth()+Number(delta),1);agendaMonthAnchor=isoLocal(d);agendaSelectedDate=isoLocal(d);renderAgenda()};
window.selectAgendaDate=date=>{agendaSelectedDate=date;renderAgenda()};
window.editEvent=id=>{
  const e=id?state.events.find(x=>x.id===id):{title:"",date:agendaSelectedDate||isoLocal(new Date()),time:"",category:"Appuntamento",note:""};if(!e)return;
  const cats=["Appuntamento","Auto","Casa","Personale","Salute","Altro"];
  showModal(`<div class="modal-head"><div><div class="modal-kicker">Agenda</div><h2>${id?'Modifica':'Nuovo'} impegno</h2></div><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field span2">Titolo<input id="evTitle" value="${esc(e.title||'')}" placeholder="Titolo impegno"></label>
    <label class="field">Categoria<select id="evCategory">${cats.map(c=>`<option ${c===e.category?'selected':''}>${c}</option>`).join('')}</select></label>
    <label class="field">Data<input id="evDate" type="date" value="${e.date||isoLocal(new Date())}"></label>
    <label class="field">Ora <small>(facoltativa)</small><input id="evTime" type="time" value="${e.time||''}"></label>
    <label class="field span3">Note<textarea id="evNote" placeholder="Note facoltative">${esc(e.note||'')}</textarea></label>
  </div><div class="modal-foot">${id?`<button class="danger" onclick="window.deleteEvent('${id}')">Elimina</button>`:''}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveEvent('${id||''}')">Salva</button></div>`);
};
window.saveEvent=async id=>{const title=document.querySelector('#evTitle')?.value.trim(),date=document.querySelector('#evDate')?.value;if(!title){alert('Inserisci il titolo dell’impegno.');return}if(!date){alert('Inserisci la data.');return}const data={title,date,time:document.querySelector('#evTime')?.value||'',category:document.querySelector('#evCategory')?.value||'Altro',note:document.querySelector('#evNote')?.value.trim()||'',updatedAt:serverTimestamp()};if(id)await updateDoc(docFor('events',id),data);else await addDoc(pathFor('events'),{...data,createdAt:serverTimestamp()});closeModal();};
window.deleteEvent=async id=>{if(confirm('Eliminare questo impegno?')){await deleteDoc(docFor('events',id));closeModal();}};

const workShiftTypes=['Mattina','Pomeriggio','Notte','Libero','C.Turno'];
window.editWorkShift=id=>{
  const e=id?state.events.find(x=>x.id===id):{date:agendaSelectedDate||isoLocal(new Date()),shift:'Mattina',note:''};if(!e)return;
  showModal(`<div class="modal-head"><div><div class="modal-kicker">Agenda · lavoro</div><h2>${id?'Modifica':'Nuovo'} turno</h2></div><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field span2">Turno<select id="shiftType">${workShiftTypes.map(t=>`<option ${t===e.shift?'selected':''}>${t}</option>`).join('')}</select></label>
    <label class="field">Data<input id="shiftDate" type="date" value="${e.date||isoLocal(new Date())}"></label>
    <label class="field span3">Note <small>(facoltative)</small><textarea id="shiftNote" placeholder="Note facoltative">${esc(e.note||'')}</textarea></label>
  </div><div class="modal-foot">${id?`<button class="danger" onclick="window.deleteEvent('${id}')">Elimina</button>`:''}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveWorkShift('${id||''}')">Salva turno</button></div>`);
};
window.saveWorkShift=async id=>{
  const date=document.querySelector('#shiftDate')?.value,shift=document.querySelector('#shiftType')?.value||'Mattina';
  if(!date){alert('Inserisci la data del turno.');return}
  const existing=state.events.find(e=>e.type==='shift'&&e.date===date&&e.id!==id);
  if(existing&&!confirm('In questa data è già presente un turno. Vuoi aggiungerne comunque un altro?'))return;
  const data={type:'shift',shift,title:`Turno ${shift}`,date,time:'',category:'Turno',note:document.querySelector('#shiftNote')?.value.trim()||'',updatedAt:serverTimestamp()};
  if(id)await updateDoc(docFor('events',id),data);else await addDoc(pathFor('events'),{...data,createdAt:serverTimestamp()});closeModal();
};

function carMaintenanceStatus(x){return x?.status==='planned'?'planned':'done'}
function carPlannedMonthLabel(value){
  if(!/^\d{4}-\d{2}$/.test(String(value||'')))return '';
  const [y,m]=String(value).split('-').map(Number);
  return `${months[m-1].toUpperCase()} ${y}`;
}
function carMileageRows(){
  const rows=[...state.carMileage]
    .filter(x=>normalizeMonthKey(x.month)&&Number.isFinite(Number(x.odometer)))
    .sort((a,b)=>String(a.month).localeCompare(String(b.month)));
  return rows.map((x,i)=>{
    const previous=i>0?rows[i-1]:null;
    const delta=previous?Number(x.odometer)-Number(previous.odometer):null;
    return {...x,delta:Number.isFinite(delta)&&delta>=0?delta:null};
  });
}
function renderCarMaintenance(){
  const all=[...state.carMaintenance];
  const done=all.filter(x=>carMaintenanceStatus(x)==='done');
  const planned=all.filter(x=>carMaintenanceStatus(x)==='planned');
  const doneSorted=[...done].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const plannedSorted=[...planned].sort((a,b)=>String(a.plannedMonth||a.date||'9999-99').localeCompare(String(b.plannedMonth||b.date||'9999-99')));
  const arr=[...plannedSorted,...doneSorted];
  const annualYear=new Date().getFullYear();
  const annualSpent=done.filter(x=>String(x.date||'').startsWith(`${annualYear}-`)).reduce((s,x)=>s+Number(x.cost||0),0);
  const mileage=carMileageRows();
  const mileageDesc=[...mileage].reverse();
  const latestMileage=mileageDesc[0];
  const annualKm=mileage.filter(x=>String(x.month||'').startsWith(`${annualYear}-`)&&Number.isFinite(x.delta)).reduce((s,x)=>s+x.delta,0);
  pageEl.innerHTML=`<section class="car-head"><div><p>Tagliandi, gomme, revisioni e interventi.</p></div><button class="primary" onclick="window.editCarMaintenance()">+ Intervento</button></section>
    <div class="car-kpis"><div class="card"><small>Interventi eseguiti</small><strong>${done.length}</strong></div><div class="card"><small>Spesa ${annualYear}</small><strong>${money(annualSpent)}</strong></div><button class="card car-kpi-mileage" onclick="window.editCarMileage()"><span><small>Ultimi km</small><strong>${latestMileage?Number(latestMileage.odometer).toLocaleString('it-IT'):'—'}</strong></span><em>+ Inserisci mese</em></button></div>
    <section class="card car-mileage-card"><div class="car-mileage-head"><div><small>CHILOMETRI</small><h3>Andamento mensile</h3></div><div class="car-mileage-year"><span>Km ${annualYear}</span><strong>${annualKm.toLocaleString('it-IT')}</strong></div></div>
      <div class="car-mileage-list">${mileageDesc.length?mileageDesc.map(x=>`<button class="car-mileage-row" onclick="window.editCarMileage('${x.id}')"><span><b>${monthLabel(x.month)}</b><small>Contachilometri ${Number(x.odometer).toLocaleString('it-IT')} km</small></span><span><small>Percorsi</small><strong>${Number.isFinite(x.delta)?x.delta.toLocaleString('it-IT')+' km':'—'}</strong></span><i>›</i></button>`).join(''):'<div class="home-empty">Inserisci la prima rilevazione mensile del contachilometri.</div>'}</div>
    </section>
    <section class="card car-list">${arr.length?arr.map(x=>{
      const isPlanned=carMaintenanceStatus(x)==='planned';
      const when=isPlanned?(carPlannedMonthLabel(x.plannedMonth)||'Periodo da definire'):fmtDate(x.date);
      return `<button class="car-row ${isPlanned?'car-row-planned':''}" onclick="window.editCarMaintenance('${x.id}')"><span class="car-icon">${isPlanned?'◷':'🚗'}</span><span><b>${esc(x.type||'Intervento')}${isPlanned?` <mark class="car-status-badge">Da fare</mark>`:''}</b><small>${isPlanned?'Previsto: ':''}${when}${!isPlanned&&x.km?` · ${Number(x.km).toLocaleString('it-IT')} km`:''}${x.workshop?` · ${esc(x.workshop)}`:''}</small>${!isPlanned&&(x.nextDate||x.nextKm)?`<em>Prossimo: ${x.nextDate?fmtDate(x.nextDate):''}${x.nextDate&&x.nextKm?' · ':''}${x.nextKm?Number(x.nextKm).toLocaleString('it-IT')+' km':''}</em>`:''}${isPlanned&&x.note?`<em>${esc(x.note)}</em>`:''}</span><strong>${!isPlanned&&x.cost!==''&&x.cost!=null?money(x.cost):'—'}</strong><i>›</i></button>`;
    }).join(''):'<div class="home-empty">Nessun intervento registrato.</div>'}</section>`;
}
window.editCarMileage=id=>{
  const current=id?state.carMileage.find(r=>r.id===id):{month:normalizeMonthKey(isoLocal(new Date())),odometer:''};
  if(!current)return;
  showModal(`<div class="modal-head"><div><div class="modal-kicker">Auto · chilometri</div><h2>${id?'Modifica':'Nuova'} rilevazione</h2></div><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field span2">Mese<input id="carMileageMonth" type="month" value="${esc(current.month||'')}"></label>
    <label class="field">Contachilometri<input id="carMileageOdometer" type="number" min="0" step="1" inputmode="numeric" value="${current.odometer??''}" placeholder="Es. 85000"></label>
    <div class="car-mileage-help span3">Inserisci il valore totale indicato dal contachilometri. Casa+ calcola automaticamente i km percorsi rispetto alla rilevazione precedente e il totale annuale.</div>
  </div><div class="modal-foot">${id?`<button class="danger" onclick="window.deleteCarMileage('${id}')">Elimina</button>`:''}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveCarMileage('${id||''}')">Salva</button></div>`);
};
window.saveCarMileage=async id=>{
  const month=normalizeMonthKey(document.querySelector('#carMileageMonth')?.value||'');
  const raw=document.querySelector('#carMileageOdometer')?.value||'';
  const odometer=Number(raw);
  if(!month){alert('Seleziona il mese.');return}
  if(raw===''||!Number.isFinite(odometer)||odometer<0){alert('Inserisci un chilometraggio valido.');return}
  const duplicate=state.carMileage.find(x=>normalizeMonthKey(x.month)===month&&x.id!==id);
  if(duplicate){alert('Hai già inserito il chilometraggio per questo mese. Apri la rilevazione esistente per modificarla.');return}
  const ordered=state.carMileage.filter(x=>x.id!==id&&normalizeMonthKey(x.month)&&Number.isFinite(Number(x.odometer))).sort((a,b)=>String(a.month).localeCompare(String(b.month)));
  const previous=[...ordered].reverse().find(x=>String(x.month)<month);
  const next=ordered.find(x=>String(x.month)>month);
  if(previous&&odometer<Number(previous.odometer)){alert(`Il valore non può essere inferiore alla rilevazione precedente (${Number(previous.odometer).toLocaleString('it-IT')} km).`);return}
  if(next&&odometer>Number(next.odometer)){alert(`Il valore non può superare la rilevazione successiva (${Number(next.odometer).toLocaleString('it-IT')} km).`);return}
  const data={month,odometer:Math.round(odometer),updatedAt:serverTimestamp()};
  if(id)await updateDoc(docFor('carMileage',id),data);else await addDoc(pathFor('carMileage'),{...data,createdAt:serverTimestamp()});
  closeModal();
};
window.deleteCarMileage=async id=>{if(confirm('Eliminare questa rilevazione chilometrica?')){await deleteDoc(docFor('carMileage',id));closeModal();}};
window.toggleCarMaintenanceFields=()=>{
  const planned=document.querySelector('#carStatus')?.value==='planned';
  document.querySelector('#carDoneFields')?.classList.toggle('hidden',planned);
  document.querySelector('#carPlannedFields')?.classList.toggle('hidden',!planned);
  document.querySelector('#carFutureFields')?.classList.toggle('hidden',planned);
};
window.editCarMaintenance=id=>{
  const x=id?state.carMaintenance.find(r=>r.id===id):{type:'Tagliando',status:'done',date:isoLocal(new Date()),plannedMonth:'',km:'',cost:'',workshop:'',nextDate:'',nextKm:'',note:''};if(!x)return;
  const status=carMaintenanceStatus(x);
  const types=['Tagliando','Cambio olio','Gomme','Freni','Revisione','Batteria','Distribuzione','Manutenzione','Riparazione','Altro'];
  showModal(`<div class="modal-head"><div><div class="modal-kicker">Auto</div><h2>${id?'Modifica':'Nuovo'} intervento</h2></div><button class="mini" onclick="window.closeModal()">×</button></div><div class="formgrid">
    <label class="field span2">Intervento<select id="carType">${types.map(t=>`<option ${t===x.type?'selected':''}>${t}</option>`).join('')}</select></label>
    <label class="field">Stato<select id="carStatus" onchange="window.toggleCarMaintenanceFields()"><option value="done" ${status==='done'?'selected':''}>Eseguito</option><option value="planned" ${status==='planned'?'selected':''}>Da fare</option></select></label>
    <div id="carDoneFields" class="form-subgrid span3 ${status==='planned'?'hidden':''}">
      <label class="field">Data<input id="carDate" type="date" value="${x.date||isoLocal(new Date())}"></label>
      <label class="field">Chilometri<input id="carKm" type="number" min="0" step="1" value="${x.km??''}" placeholder="Es. 85000"></label>
      <label class="field">Costo €<input id="carCost" type="number" min="0" step="0.01" value="${x.cost??''}"></label>
    </div>
    <div id="carPlannedFields" class="form-subgrid span3 ${status==='planned'?'':'hidden'}">
      <label class="field span2">Mese previsto<input id="carPlannedMonth" type="month" value="${x.plannedMonth||''}"></label>
      <div class="car-planned-help">Puoi programmare una manutenzione anche senza scegliere un giorno preciso. Quando la esegui, riapri la voce e cambia lo stato in <b>Eseguito</b>.</div>
    </div>
    <label class="field span2">Officina / fornitore<input id="carWorkshop" value="${esc(x.workshop||'')}" placeholder="Facoltativo"></label>
    <div id="carFutureFields" class="form-subgrid span3 ${status==='planned'?'hidden':''}">
      <label class="field">Prossima data<input id="carNextDate" type="date" value="${x.nextDate||''}"></label>
      <label class="field">Prossimi km<input id="carNextKm" type="number" min="0" step="1" value="${x.nextKm??''}"></label>
    </div>
    <label class="field span3">Note<textarea id="carNote" placeholder="Ricambi, dettagli, promemoria…">${esc(x.note||'')}</textarea></label>
  </div><div class="modal-foot">${id?`<button class="danger" onclick="window.deleteCarMaintenance('${id}')">Elimina</button>`:''}<span class="modal-spacer"></span><button class="ghost" onclick="window.closeModal()">Annulla</button><button class="primary" onclick="window.saveCarMaintenance('${id||''}')">Salva</button></div>`);
  window.toggleCarMaintenanceFields();
};
window.saveCarMaintenance=async id=>{
  const v=q=>document.querySelector(q)?.value||'';
  const status=v('#carStatus')==='planned'?'planned':'done';
  const km=v('#carKm'),cost=v('#carCost'),nextKm=v('#carNextKm');
  const data={type:v('#carType'),status,date:status==='done'?v('#carDate'):'',plannedMonth:status==='planned'?v('#carPlannedMonth'):'',km:status==='done'&&km!==''?Number(km):'',cost:status==='done'&&cost!==''?Number(cost):'',workshop:v('#carWorkshop').trim(),nextDate:status==='done'?v('#carNextDate'):'',nextKm:status==='done'&&nextKm!==''?Number(nextKm):'',note:v('#carNote').trim(),updatedAt:serverTimestamp()};
  if(status==='done'&&!data.date){alert('Inserisci la data dell’intervento.');return}
  if(status==='planned'&&!data.plannedMonth){alert('Inserisci il mese previsto per la manutenzione.');return}
  if(status==='done'&&((km!==''&&!Number.isFinite(data.km))||(cost!==''&&!Number.isFinite(data.cost))||(nextKm!==''&&!Number.isFinite(data.nextKm)))){alert('Controlla chilometri e costo.');return}
  if(id)await updateDoc(docFor('carMaintenance',id),data);else await addDoc(pathFor('carMaintenance'),{...data,createdAt:serverTimestamp()});closeModal();
};
window.deleteCarMaintenance=async id=>{if(confirm('Eliminare questo intervento?')){await deleteDoc(docFor('carMaintenance',id));closeModal();}};

function renderMore(){
  pageEl.innerHTML=`<div class="card section"><h2>Tutto il resto</h2><div class="more-grid">
    <button class="more-item" onclick="window.goPage('agenda')"><span class="more-icon">□</span><span><strong>Agenda</strong><small>Vista settimanale e mensile</small></span><span class="more-chevron">›</span></button>
    <button class="more-item" onclick="window.goPage('auto')"><span class="more-icon">🚗</span><span><strong>Manutenzione auto</strong><small>Interventi, costi e prossime scadenze</small></span><span class="more-chevron">›</span></button>
    <button class="more-item" onclick="window.goPage('letture')"><span class="more-icon">◫</span><span><strong>Letture contatori</strong><small>Consumi e letture registrate</small></span><span class="more-chevron">›</span></button>
    <button class="more-item" onclick="window.goPage('tariffe')"><span class="more-icon">€</span><span><strong>Tariffe</strong><small>Fornitori e condizioni</small></span><span class="more-chevron">›</span></button>
    <button class="more-item" onclick="window.goPage('impostazioni')"><span class="more-icon">⚙</span><span><strong>Impostazioni</strong><small>Account, backup e sicurezza</small></span><span class="more-chevron">›</span></button>
  </div></div>`;
}

function renderSettings(){
  const count={bills:state.bills.length,budgets:state.budgets.length,shopping:state.shopping.length,events:state.events.length,carMaintenance:state.carMaintenance.length,carMileage:state.carMileage.length,readings:state.readings.length,tariffs:state.tariffs.length};
  pageEl.innerHTML=`<div class="settings-grid">
  <div class="card section"><h2>Cloud</h2><div class="notice successbox">Account: <b>${esc(user.email)}</b><br>Dati sincronizzati con Firebase.</div>
  <p>Bollette: <b>${count.bills}</b><br>Budget: <b>${count.budgets}</b><br>Lista spesa: <b>${count.shopping}</b><br>Impegni: <b>${count.events}</b><br>Manutenzioni auto: <b>${count.carMaintenance}</b><br>Rilevazioni km: <b>${count.carMileage}</b><br>Letture: <b>${count.readings}</b><br>Tariffe: <b>${count.tariffs}</b></p></div>
  <div class="card section"><h2>Backup</h2><p class="muted">Scarica una copia JSON dei dati attualmente sincronizzati.</p><button class="ghost" onclick="window.exportBackup()">Scarica backup</button></div>
  </div>
  <div class="card section" style="margin-top:14px"><h2>Interfaccia</h2><div class="notice successbox">Casa+ 2.7 attivo. Identità visiva originale blu petrolio con riepilogo mensile unico. Riepilogo Bollette mensile con quote di competenza, filtri Pagate/Da pagare e arretrati di altri mesi. Il periodo usa selettori separati di mese e anno; AL è facoltativo. Le bollette sono ordinabili per tutte le colonne.</div></div>
  <div class="card section" style="margin-top:14px"><h2>Sicurezza</h2><div class="notice">I dati sono salvati nel tuo spazio Firestore personale e non sono più inclusi nei file pubblici dell'app.</div></div>`;
}

function showModal(html){modal.innerHTML=`<div class="modal">${html}</div>`;modal.classList.remove("hidden")}
function closeModal(){modal.classList.add("hidden");modal.innerHTML=""}window.closeModal=closeModal;

if("serviceWorker" in navigator){
  let swReloaded=false;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(swReloaded)return;
    swReloaded=true;
    // Una sola ricarica quando entra in controllo il nuovo Service Worker.
    window.location.reload();
  });
  const updateSpesePlus=async()=>{
    try{
      const reg=await navigator.serviceWorker.register("./sw.js?v=1.0.1",{updateViaCache:"none"});
      await reg.update();
    }catch(e){console.warn(e)}
  };
  window.addEventListener("load",updateSpesePlus);
  window.addEventListener("pageshow",updateSpesePlus);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")updateSpesePlus()});
}
