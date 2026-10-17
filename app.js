import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  initializeAuth, onAuthStateChanged,
  signInWithEmailAndPassword, sendPasswordResetEmail, signOut, browserLocalPersistence
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
const OWNER_UID = "yMj6leDGaLRKlT1UdFTZ2mmZYi32";

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
let unsubscribers = [];
let syncRenderTimer = null;
let syncGeneration = 0;
let syncStates = {};
const SYNC_COLLECTIONS = ["bills","expenses","incomes"];
function updateSyncStatus(){
  if(!user)return;
  const statuses=SYNC_COLLECTIONS.map(name=>syncStates[name]||{ready:false,fromCache:false,pending:false,error:false});
  if(statuses.some(s=>s.error)){
    syncEl.textContent="Errore sincronizzazione · verifica connessione e permessi";
    return;
  }
  if(!navigator.onLine){
    syncEl.textContent=statuses.every(s=>s.ready)?"Offline · dati locali (da verificare)":"Offline · connessione assente";
    return;
  }
  if(!statuses.every(s=>s.ready)){
    syncEl.textContent="Caricamento dati…";
    return;
  }
  if(statuses.some(s=>s.pending)){
    syncEl.textContent="Modifiche in attesa di sincronizzazione…";
    return;
  }
  syncEl.textContent=statuses.some(s=>s.fromCache)?"Dati locali · sincronizzazione in corso…":"Dati sincronizzati";
}
window.addEventListener("online",updateSyncStatus);
window.addEventListener("offline",updateSyncStatus);
let state = { bills:[], expenses:[], incomes:[] };

const utilities = ["Luce"];
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
document.querySelector("#resetPasswordBtn").onclick=async()=>{
  const emailInput=document.querySelector("#email");
  const email=emailInput.value.trim();
  const msg=document.querySelector("#authMsg");
  const btn=document.querySelector("#resetPasswordBtn");
  if(!email){
    msg.textContent="Inserisci la tua email e poi premi Password dimenticata?.";
    emailInput.focus();
    return;
  }
  btn.disabled=true;
  msg.textContent="Invio dell'email di recupero…";
  try{
    await sendPasswordResetEmail(auth,email);
    msg.textContent="Se l'indirizzo è registrato, riceverai un'email per scegliere una nuova password. Controlla anche lo spam.";
  }catch(err){
    console.error("Recupero password",err);
    if(err?.code==="auth/invalid-email")msg.textContent="Indirizzo email non valido.";
    else if(err?.code==="auth/too-many-requests")msg.textContent="Troppi tentativi: riprova più tardi.";
    else if(err?.code==="auth/network-request-failed")msg.textContent="Connessione assente: riprova quando sei online.";
    else msg.textContent="Impossibile inviare l'email di recupero. Riprova più tardi.";
  }finally{btn.disabled=false;}
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
  syncGeneration++;
  clearTimeout(syncRenderTimer);
  unsubscribers.forEach(x=>x());unsubscribers=[];
  syncStates={};
  // Non mostrare mai a un nuovo account i movimenti rimasti in memoria
  // dalla sessione precedente: i dati Firestore sono separati per UID.
  state={bills:[],expenses:[],incomes:[]};
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
  const generation=syncGeneration;
  syncStates=Object.fromEntries(SYNC_COLLECTIONS.map(name=>[name,{ready:false,fromCache:false,pending:false,error:false}]));
  updateSyncStatus();
  SYNC_COLLECTIONS.forEach(name=>{
    const un=onSnapshot(pathFor(name),{includeMetadataChanges:true},snap=>{
      if(generation!==syncGeneration)return;
      state[name]=snap.docs.map(d=>{
        const row={id:d.id,...d.data()};
        return name==="bills"?normalizeBillRecord(row):row;
      });
      syncStates[name]={ready:true,fromCache:snap.metadata.fromCache,pending:snap.metadata.hasPendingWrites,error:false};
      updateSyncStatus();
      refreshYears();
      clearTimeout(syncRenderTimer);
      syncRenderTimer=setTimeout(()=>{if(generation===syncGeneration)render()},35);
    },err=>{
      if(generation!==syncGeneration)return;
      syncStates[name]={...syncStates[name],error:true};
      updateSyncStatus();
      console.error("Sincronizzazione "+name,err);
    });
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
  yearSelect.innerHTML=ys.map(y=>`<option ${y===selectedYear?"selected":""}>${y}</option>`).join("");
}
yearSelect.onchange=e=>{selectedYear=Number(e.target.value);render()};
function setActiveNav(){
  document.querySelectorAll("nav button").forEach(x=>x.classList.remove("active"));
  const direct=document.querySelector(`nav button[data-page="${page}"]`);
  if(direct) direct.classList.add("active");
  else if(["spese","entrate"].includes(page)){
    document.querySelector('nav button[data-page="movimenti"]')?.classList.add("active");
  }else if(["statistiche","impostazioni","bollette"].includes(page)){
    document.querySelector('nav button[data-page="altro"]')?.classList.add("active");
  }
}
window.goPage=p=>{
  if(!["dashboard","movimenti","categorie","spese","entrate","bollette","statistiche","impostazioni","altro"].includes(p))p="dashboard";
  if(p==="bollette"){billHomeScope=null;billStatusTab="all";}
  if(p==="spese"&&!categoryShortcutPending)financeFilter="Tutte";
  categoryShortcutPending=false;
  page=p;setActiveNav();render();window.scrollTo({top:0,behavior:"smooth"});
};
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>{
  if(b.dataset.action==="quickadd"){window.openQuickAdd();return}
  if(b.dataset.page)window.goPage(b.dataset.page);
});
window.openQuickAdd=()=>showModal(`<div class="modal-head"><h2>Aggiungi</h2><button class="mini" onclick="window.closeModal()">×</button></div><div class="quick-add-grid quick-add-two"><button onclick="window.closeModal();window.editExpense()"><b>+ Nuova spesa</b></button><button onclick="window.closeModal();window.editIncome()"><b>+ Nuova entrata</b></button><button onclick="window.closeModal();window.editBill()"><b>+ Bolletta luce</b></button></div>`);

function render(){
  if(!user)return;
  document.body.dataset.page=page;
  titleEl.textContent=({dashboard:"Spese+",movimenti:"Movimenti",categorie:"Categorie",bollette:"Bollette Luce",spese:"Spese",entrate:"Entrate",statistiche:"Statistiche",impostazioni:"Impostazioni",altro:"Altro"})[page]||"Spese+";
  ({dashboard:renderFinanceDashboard,movimenti:renderFinanceMovements,categorie:renderFinanceCategories,bollette:renderBills,spese:renderExpenses,entrate:renderIncomes,statistiche:renderFinanceStats,impostazioni:renderFinanceSettings,altro:renderFinanceMore})[page]();
}

function paymentMonth(b){
  const s=String(b.dataPagamento||"");
  const m=s.match(/^(\d{4})-(\d{2})/);
  return m?{year:Number(m[1]),month:Number(m[2])}:null;
}
function paidInMonth(b,year,month){const p=paymentMonth(b);return isPaid(b)&&p&&p.year===Number(year)&&p.month===Number(month)}

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
let categoryShortcutPending=false;
function financeKey(y=selectedYear,m=financeMonth){return buildMonthKey(y,m)}
function financeAmount(v){const n=Number(v);return Number.isFinite(n)?n:0}
function sumAmounts(items){return items.reduce((sum,x)=>sum+financeAmount(x.amount),0)}
function financeMonthItems(items,key){return items.filter(x=>String(x.date||"").slice(0,7)===key)}
function paidLightMonth(key){
  // La data di pagamento determina il mese del movimento e del saldo.
  // Una bolletta = un solo movimento virtuale, mai una spesa duplicata in Firestore.
  return state.bills.filter(b=>String(b.utenza||"").trim().toLowerCase()==="luce" && isPaid(b)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(b.dataPagamento||""))
    && String(b.dataPagamento).slice(0,7)===key);
}
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
  if(page==="spese")financeFilter="Tutte";
  ensureYearInSelector(selectedYear);render();
};
function financeMonthHeader(){return `<div class="finance-month-bar"><button class="ghost" onclick="window.changeFinanceMonth(-1)" aria-label="Mese precedente">‹</button><b>${monthNamesLong[financeMonth-1]} ${selectedYear}</b><button class="ghost" onclick="window.changeFinanceMonth(1)" aria-label="Mese successivo">›</button></div>`}
function financeCategoryTotals(key){
  const totals=new Map();
  financeMonthItems(state.expenses,key).forEach(x=>totals.set(x.category||"Altro",(totals.get(x.category||"Altro")||0)+financeAmount(x.amount)));
  const light=financeSummary(key).electricity;if(light)totals.set("Luce",(totals.get("Luce")||0)+light);
  return [...totals.entries()].sort((a,b)=>b[1]-a[1]);
}
// Confronti sulle SPESE: una variazione positiva di costo è sfavorevole.
// Si includono anche le categorie presenti soltanto nel mese precedente.
function financeCategoryComparisons(key=financeKey(),previousKey=previousFinanceKey()){
  const current=new Map(financeCategoryTotals(key));
  const previous=new Map(financeCategoryTotals(previousKey));
  return [...new Set([...current.keys(),...previous.keys()])].map(name=>{
    const amount=Math.round((current.get(name)||0)*100)/100;
    const before=Math.round((previous.get(name)||0)*100)/100;
    const difference=Math.round((amount-before)*100)/100;
    const percentage=before>0?Math.round((difference/before)*1000)/10:null;
    const status=difference<0?'saving':difference>0?(before===0?'new':'increase'):'same';
    return {name,amount,before,difference,percentage,status};
  }).sort((a,b)=>b.amount-a.amount||b.before-a.before||a.name.localeCompare(b.name,'it'));
}
function financeComparisonBadge(item){
  const abs=money(Math.abs(item.difference));
  if(item.status==='saving')return `<span class="sp-compare-badge sp-compare-saving">↓ Risparmio ${abs} (${Math.abs(item.percentage).toLocaleString('it-IT',{maximumFractionDigits:1})}%)</span>`;
  if(item.status==='increase')return `<span class="sp-compare-badge sp-compare-increase">↑ Spesa maggiore ${abs} (+${item.percentage.toLocaleString('it-IT',{maximumFractionDigits:1})}%)</span>`;
  if(item.status==='new')return `<span class="sp-compare-badge sp-compare-neutral">Nuova spesa ${abs} · % non calcolabile</span>`;
  return `<span class="sp-compare-badge sp-compare-neutral">Spesa invariata · 0%</span>`;
}
function financeComparisonCards(items){
  return items.map(item=>{
    const click=item.name==='Luce'?'window.goPage(\'bollette\')':`window.openFinanceCategory(${JSON.stringify(item.name).replace(/"/g,'&quot;')})`;
    return `<article class="sp-compare-card">
      <div class="sp-compare-heading"><span class="sp-activity-icon sp-icon-${financeCategoryTone(item.name)}">${FINANCE_ICONS[item.name]||'•'}</span><b>${esc(item.name)}</b></div>
      <div class="sp-compare-amounts"><div><small>Mese selezionato</small><strong>${money(item.amount)}</strong></div><div><small>Mese precedente</small><strong>${money(item.before)}</strong></div></div>
      <div class="sp-compare-foot">${financeComparisonBadge(item)}<button type="button" onclick="${click}" aria-label="Apri ${esc(item.name)}">Dettagli ›</button></div>
    </article>`;
  }).join('');
}
function financeCategoryComparisonPanel(limit=0){
  const items=financeCategoryComparisons(),shown=limit?items.slice(0,limit):items;
  const now=new Date();
  const partial=selectedYear===now.getFullYear()&&financeMonth===now.getMonth()+1;
  return `<section class="sp-panel sp-compare-panel"><div class="sp-panel-head"><h2>Confronto per categoria</h2>${limit?'<button type="button" onclick="window.goPage(\'categorie\')">Vedi tutte ›</button>':''}</div>
    <p class="sp-compare-description">${esc(monthLabel(financeKey()))} rispetto a ${esc(monthLabel(previousFinanceKey()))}. ${partial?'Mese in corso: confronto provvisorio.':'Un importo inferiore indica un risparmio.'}</p>
    ${shown.length?`<div class="sp-compare-grid">${financeComparisonCards(shown)}</div>`:'<p class="sp-empty">Nessuna spesa nei due mesi da confrontare.</p>'}</section>`;
}
function financeIconSvg(name){
  const paths={
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M10 2h4l.7 2.4 2 .9 2.2-1.2 2.8 2.8-1.2 2.2.9 2L24 12l-2.6.9-.9 2 1.2 2.2-2.8 2.8-2.2-1.2-2 .9L14 22h-4l-.7-2.4-2-.9-2.2 1.2-2.8-2.8 1.2-2.2-.9-2L0 12l2.6-.9.9-2-1.2-2.2 2.8-2.8 2.2 1.2 2-.9z" transform="translate(1 1) scale(.91)"/>',
    user:'<circle cx="12" cy="8" r="4"/><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2z"/>',
    list:'<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    stats:'<path d="M4 20V12h4v8M10 20V4h4v16M16 20v-11h4v11"/>',
    bolt:'<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    plus:'<path d="M12 4v16M4 12h16"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M7 14h3M14 14h3"/>',
    wallet:'<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M3 10h18M15 15h3M6 6V4h12"/>',
    bag:'<path d="M5 9h14l-1 12H6zM9 9V7a3 3 0 0 1 6 0v2"/>',
    arrow:'<path d="M9 18l6-6-6-6"/>',
    receipt:'<path d="M5 2h14v20l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8M8 16h5"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]||paths.grid}</svg>`;
}
function financeTile(title,icon,tone,action){
  return `<button type="button" class="sp-tile sp-tone-${tone}" onclick="${action}"><span class="sp-tile-icon">${financeIconSvg(icon)}</span><b>${title}</b><span class="sp-tile-chevron">›</span></button>`;
}
function financeHomeRows(items,kind,limit=4){
  const sorted=[...items].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,limit);
  if(!sorted.length)return `<p class="sp-empty">Ancora nessuna ${kind==='income'?'entrata':'spesa'} registrata in questo mese.</p>`;
  return sorted.map(x=>{
    const income=kind==='income',bill=kind==='bill';
    const name=bill?'Bolletta Luce':(x.description||x.category||(income?'Entrata':'Spesa'));
    const icon=bill?'⚡':income?'€':(FINANCE_ICONS[x.category]||'•');
    const tone=bill?'light':income?'green':financeCategoryTone(x.category);
    const click=bill?`window.editBill('${x.id}')`:income?`window.editIncome('${x.id}')`:`window.editExpense('${x.id}')`;
    return `<button type="button" class="sp-activity-row" onclick="${click}"><span class="sp-activity-icon sp-icon-${tone}">${icon}</span><span class="sp-activity-main"><b>${esc(name)}</b><small>${fmtDate(x.date)}${bill?' · Luce':x.category?' · '+esc(x.category):''}</small></span><strong class="${income?'sp-positive':'sp-negative'}">${income?'+':'−'} ${money(bill?x.amount:x.amount)}</strong><span class="sp-chevron">›</span></button>`;
  }).join('');
}
function financeCategoryTone(name){return ({'Alimentari':'green','Pranzi e cene':'blue','Trasporti':'amber','Casa':'pink','Salute':'pink','Tempo libero':'violet','Abbonamenti':'blue','Shopping':'amber','Luce':'pink'})[name]||'gray'}
function renderFinanceDashboard(){
  const now=new Date(),key=financeKey(),prev=previousFinanceKey(),cur=financeSummary(key),old=financeSummary(prev);
  const expenses=financeMonthItems(state.expenses,key);
  const incomes=financeMonthItems(state.incomes,key);
  const light=cur.light.map(b=>({id:b.id,date:b.dataPagamento,amount:financeAmount(b.importo),category:'Luce'}));
  const recentExpenses=[...expenses.map(x=>({...x,kind:'expense'})),...light.map(x=>({...x,kind:'bill'}))].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,4);
  const monthTitle=monthNamesLong[financeMonth-1].toUpperCase()+' '+selectedYear;
  pageEl.innerHTML=`<div class="sp-home">
    <section class="sp-welcome"><div><h1>${homeGreeting(now)}, <b>Peppe</b></h1><p>${longItalianDate(now)}</p></div><div class="sp-welcome-actions"><button type="button" aria-label="Impostazioni" onclick="window.goPage('impostazioni')">${financeIconSvg('settings')}</button><button type="button" aria-label="Account" onclick="window.goPage('impostazioni')">${financeIconSvg('user')}</button></div></section>
    <section class="sp-blue-card">
      <div class="sp-blue-head"><div class="sp-month-switch"><button type="button" onclick="window.changeFinanceMonth(-1)" aria-label="Mese precedente">‹</button><span>${monthTitle}</span><button type="button" onclick="window.changeFinanceMonth(1)" aria-label="Mese successivo">›</button></div><button type="button" class="sp-blue-details" onclick="window.goPage('movimenti')">Vedi dettagli ›</button></div>
      <div class="sp-blue-pair"><button type="button" onclick="window.goPage('entrate')"><span>Entrate nel mese</span><strong>${money(cur.income)}</strong><i>›</i></button><button type="button" onclick="window.goPage('spese')"><span>Spese nel mese</span><strong>${money(cur.expenses)}</strong><i>›</i></button></div>
      <div class="sp-blue-balance"><span>Disponibile nel mese</span><strong class="${cur.balance<0?'sp-balance-negative':''}">${money(cur.balance)}</strong><small>Entrate − spese del mese</small></div>
    </section>
    <div class="sp-tiles">${financeTile('Nuova spesa','plus','rose','window.editExpense()')}${financeTile('Nuova entrata','plus','mint','window.editIncome()')}${financeTile('Categorie','list','cream',"window.goPage('categorie')")}${financeTile('Statistiche','stats','lavender',"window.goPage('statistiche')")}${financeTile('Bollette Luce','bolt','ice',"window.goPage('bollette')")}${financeTile('Movimenti','receipt','white',"window.goPage('movimenti')")}</div>
    <section class="sp-panel"><div class="sp-panel-head"><h2>Spese recenti</h2><button type="button" onclick="window.goPage('spese')">Vedi tutte ›</button></div>${recentExpenses.length?recentExpenses.map(x=>financeHomeRows([x],x.kind,1)).join(''):'<p class="sp-empty">Nessuna spesa registrata nel mese.</p>'}</section>
    <section class="sp-panel"><div class="sp-panel-head"><h2>Entrate recenti</h2><button type="button" onclick="window.goPage('entrate')">Vedi tutte ›</button></div>${financeHomeRows(incomes,'income',3)}</section>
    <section class="sp-panel sp-trend-panel"><div class="sp-panel-head"><h2>Confronto mensile</h2><button type="button" onclick="window.goPage('statistiche')">Statistiche ›</button></div><p>Spese di ${esc(monthLabel(prev))}: <b>${money(old.expenses)}</b></p><p>Spese di ${esc(monthLabel(key))}: <b>${money(cur.expenses)}</b></p><small>${esc(financeTrend(cur.expenses,old.expenses))}</small></section>
  </div>`;
}
function renderFinanceMovements(){
  const key=financeKey(),s=financeSummary(key);
  const all=[...financeMonthItems(state.expenses,key).map(x=>({...x,kind:'expense'})),...financeMonthItems(state.incomes,key).map(x=>({...x,kind:'income'})),...s.light.map(b=>({id:b.id,amount:b.importo,date:b.dataPagamento,kind:'bill'}))].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  pageEl.innerHTML=`<div class="finance-screen sp-subpage">${financeMonthHeader()}<div class="sp-sub-kpis"><div><small>Entrate</small><b class="sp-positive">${money(s.income)}</b></div><div><small>Spese</small><b class="sp-negative">${money(s.expenses)}</b></div></div><section class="sp-panel"><div class="sp-panel-head"><h2>Movimenti del mese</h2><button type="button" onclick="window.openQuickAdd()">+ Aggiungi</button></div>${all.length?all.map(x=>financeHomeRows([x],x.kind,1)).join(''):'<p class="sp-empty">Nessun movimento registrato.</p>'}</section>${financeCategoryComparisonPanel(3)}</div>`;
}
function renderFinanceCategories(){
  pageEl.innerHTML=`<div class="finance-screen sp-subpage">${financeMonthHeader()}${financeCategoryComparisonPanel()}</div>`;
}
window.openFinanceCategory=name=>{
  financeFilter=FINANCE_CATEGORIES.includes(name)?name:"Tutte";
  categoryShortcutPending=true;
  window.goPage('spese');
};

function financeItemRows(items,kind){
  if(!items.length)return '<div class="home-empty">Nessuna registrazione per questo mese.</div>';
  return [...items].sort((a,b)=>String(b.date||"").localeCompare(String(a.date||""))).map(x=>`<button class="finance-entry-row" onclick="window.${kind==='expense'?'editExpense':'editIncome'}('${x.id}')"><span class="finance-entry-icon">${kind==='expense'?(FINANCE_ICONS[x.category]||'•'):'€'}</span><span class="finance-entry-main"><b>${esc(x.description||x.category||'Voce')}</b><small>${fmtDate(x.date)} · ${esc(x.category||'Entrata')}</small></span><strong>${kind==='expense'?'-':'+'}${money(x.amount)}</strong><span>›</span></button>`).join('');
}
function renderExpenses(){
  const key=financeKey(),items=financeMonthItems(state.expenses,key);
  const shown=financeFilter==='Tutte'?items:items.filter(x=>x.category===financeFilter);
  const sum=sumAmounts(shown),light=financeSummary(key).electricity;
  const filtered=financeFilter!=="Tutte";
  pageEl.innerHTML=`<div class="finance-screen">${financeMonthHeader()}
    <section class="finance-hero"><span>${filtered?'SPESE FILTRATE':'SPESE REGISTRATE'}</span><strong>${money(sum+ (filtered?0:light))}</strong><small>${filtered?'Totale della categoria selezionata':'Bollette Luce pagate incluse nel totale generale'}</small></section>
    <section class="card section"><div class="section-head"><h2>Le tue spese</h2><button class="primary" onclick="window.editExpense()">+ Aggiungi</button></div>
      <label class="field">Categoria<select onchange="window.setFinanceFilter(this.value)">${['Tutte',...FINANCE_CATEGORIES].map(c=>`<option value="${esc(c)}" ${c===financeFilter?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      ${filtered?`<div class="sp-filter-notice"><span>Filtro attivo: <strong>${esc(financeFilter)}</strong> · ${shown.length} ${shown.length===1?'movimento':'movimenti'}</span><button type="button" onclick="window.clearFinanceFilter()">Mostra tutte ×</button></div>`:''}
      ${financeItemRows(shown,'expense')}
      ${financeFilter==='Tutte'&&light?`<button class="finance-entry-row" onclick="window.goPage('bollette')"><span class="finance-entry-icon">⚡</span><span class="finance-entry-main"><b>Bolletta Luce</b><small>Pagamenti del mese</small></span><strong>-${money(light)}</strong><span>›</span></button>`:''}
    </section>${filtered?`<section class="sp-panel sp-compare-panel"><div class="sp-panel-head"><h2>Confronto con il mese scorso</h2></div><div class="sp-compare-grid">${financeComparisonCards(financeCategoryComparisons().filter(x=>x.name===financeFilter))}</div></section>`:''}</div>`;
}
window.setFinanceFilter=v=>{financeFilter=FINANCE_CATEGORIES.includes(v)?v:"Tutte";renderExpenses()};
window.clearFinanceFilter=()=>{financeFilter="Tutte";renderExpenses()};
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
function renderFinanceMore(){pageEl.innerHTML=`<div class="card section"><h2>Altre funzioni</h2><div class="more-grid"><button class="more-item" onclick="window.goPage('entrate')"><span class="more-icon">€</span><span><strong>Entrate</strong><small>Stipendio e altre entrate</small></span><span class="more-chevron">›</span></button><button class="more-item" onclick="window.goPage('spese')"><span class="more-icon">▤</span><span><strong>Spese</strong><small>Elenco e filtri</small></span><span class="more-chevron">›</span></button><button class="more-item" onclick="window.goPage('bollette')"><span class="more-icon">⚡</span><span><strong>Bollette Luce</strong><small>Pagamenti e scadenze</small></span><span class="more-chevron">›</span></button><button class="more-item" onclick="window.goPage('statistiche')"><span class="more-icon">▥</span><span><strong>Statistiche</strong><small>Confronti mensili e categorie</small></span><span class="more-chevron">›</span></button><button class="more-item" onclick="window.goPage('impostazioni')"><span class="more-icon">⚙</span><span><strong>Impostazioni</strong><small>Account e backup</small></span><span class="more-chevron">›</span></button></div></div>`}
function renderFinanceSettings(){pageEl.innerHTML=`<div class="card section"><h2>Account</h2><p>${esc(user?.email||'')}</p><p class="muted">Accesso riservato all’unico utente autorizzato.</p></div><div class="card section" style="margin-top:14px"><h2>Backup</h2><p class="muted">Esporta bollette Luce, spese ed entrate in formato JSON.</p><button class="primary" onclick="window.exportBackup()">Scarica backup</button></div>`}
// ======================= Fine gestione Spese+ =======================

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
  const status=v("#fStato");
  const paidDate=status==="Pagata"?v("#fPagamento"):"";
  const data={utenza:"Luce",dataEmissione:v("#fEmissione"),periodo,periodoInizio,periodoFine,scadenza:v("#fScadenza"),dataPagamento:paidDate,importo,stato:status,mese,anno:competenze[0]?.anno||selectedYear,competenze:competenze.map(c=>({anno:Number(c.anno),importo:Number(c.importo)})),competenzeFonte:fonte,consumo:v("#fConsumo"),unita:v("#fUnita"),metodo:v("#fMetodo"),note:v("#fNote"),updatedAt:serverTimestamp()};
  try{
    syncEl.textContent="Salvataggio bolletta…";
    if(id)await updateDoc(docFor("bills",id),data);
    else await addDoc(pathFor("bills"),{...data,createdAt:serverTimestamp()});
    closeModal();
    updateSyncStatus();
  }catch(error){
    console.error("Errore salvataggio bolletta",error);
    syncEl.textContent="Salvataggio non riuscito";
    alert("Bolletta non salvata. Verifica la connessione e le autorizzazioni Firebase.");
  }
};
window.dupBill=async id=>{const b=state.bills.find(x=>x.id===id);if(!b)return;const c={...b};delete c.id;await addDoc(pathFor("bills"),{...c,note:(c.note?c.note+" • ":"")+"Duplicata",createdAt:serverTimestamp(),updatedAt:serverTimestamp()})};
window.delBill=async id=>{if(confirm("Eliminare questa bolletta?"))await deleteDoc(docFor("bills",id))};

async function exportBackup(){
  const backup={exportedAt:new Date().toISOString()};
  for(const n of ["bills","expenses","incomes"])backup[n]=state[n];
  const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`spese-plus-backup-${new Date().toISOString().slice(0,10)}.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
window.exportBackup=exportBackup;


function showModal(html){modal.innerHTML=`<div class="modal">${html}</div>`;modal.classList.remove("hidden")}
function closeModal(){modal.classList.add("hidden");modal.innerHTML=""}window.closeModal=closeModal;

if("serviceWorker" in navigator){
  let swReloaded=false;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(swReloaded)return;
    swReloaded=true;
    // Una sola ricarica quando entra in controllo il nuovo Service Worker.
    // Non interrompere la sessione in corso: la versione aggiornata sarà visibile al prossimo avvio.
  });
  const updateSpesePlus=async()=>{
    try{
      const reg=await navigator.serviceWorker.register("./sw.js?v=1.2.0",{updateViaCache:"none"});
      await reg.update();
    }catch(e){console.warn(e)}
  };
  window.addEventListener("load",updateSpesePlus);
  window.addEventListener("pageshow",updateSpesePlus);
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")updateSpesePlus()});
}
