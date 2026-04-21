let lastBPTime = 0;
let lastActionTime = {};


const actionOnce = new Set();
function logActionOnce(key, text) {
  if (actionOnce.has(key)) return;
  actionOnce.add(key);
  logAction(text);
}


// --- UX helpers (chips, sounds, tooltips) ---
let audioCtx = null;
let audioEnabled = false;
function ensureAudio() {
  if (audioEnabled) return true;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioEnabled = true;
    return true;
  } catch (_) {
    return false;
  }
}
function playTone(freq, durationMs, type = "sine", gain = 0.025) {
  if (!ensureAudio() || !audioCtx) return;
  let gPeak = gain;
  try {
    // Phone (~≤600px) keeps current levels; desktop/tablet is slightly louder for small speakers.
    if (!window.matchMedia("(max-width: 600px)").matches) {
      gPeak = Math.min(0.055, gain * 1.4);
    }
  } catch (_) {}
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gPeak, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.02);
}
function soundClick() {
  playTone(740, 35, "triangle", 0.018);
}
function soundGood() {
  playTone(660, 55, "sine", 0.018);
  setTimeout(() => playTone(990, 60, "sine", 0.016), 55);
}
function soundBad() {
  playTone(180, 90, "square", 0.020);
}


function getActiveSimStage() {
  const s = document.querySelector(".screen.active");
  if (!s) return null;
  return s.querySelector(".simStage");
}
function pushEffectChip(text, tone = "good") {
  const stage = getActiveSimStage();
  if (!stage) return;
  const wrap = stage.querySelector(".effectChips");
  if (!wrap) return;


  const el = document.createElement("div");
  el.className = `effectChip effectChip--${tone}`;
  el.innerHTML = `<span class="chipIcon" aria-hidden="true"></span><span>${text}</span>`;
  wrap.appendChild(el);


  // cap chips to avoid clutter
  const max = 4;
  while (wrap.children.length > max) wrap.removeChild(wrap.firstChild);


  setTimeout(() => {
    el.style.transition = "opacity 260ms ease, transform 260ms ease";
    el.style.opacity = "0";
    el.style.transform = "translate3d(0,-6px,0)";
    setTimeout(() => el.remove(), 300);
  }, 2200);
}


function snapshotVitals() {
  return {
    spo2: sim.vitals.spo2,
    sbp: sim.vitals.sbp,
    hr: sim.vitals.hr,
    rr: sim.vitals.rr,
    pain: sim.patient.pain,
  };
}


let sim = {
  phase: "start",
  /** Scenario start time (ms). Used for action timeline timestamps. */
  scenarioStartMs: 0,
  /** Set right before a user-triggered action; used for effect chips. */
  preActionSnapshot: null,
  lastUserActionMs: 0,
  /** Tracks "not indicated / unnecessary" interventions for scoring + debrief. */
  unnecessaryLog: [],
  /** Accumulated lung congestion from fluid load (any patient); drives rales + SpO₂ drop. */
  _lungFluidStrain: 0,
  /** Tracks symptomatic bradycardia detection + treatment for scoring/teaching. */
  _brady: { symptomaticSeconds: 0, atropineGivenWhenIndicated: false },
  /** Tracks aspirin being given while AMS (PO safety teaching). */
  _asaGivenWhenAltered: false,


  /** "practice" | "ce" | null — set from launcher; not cleared by resetSim() */
  runMode: null,
  /** CE only: forced ECG pattern until scenario restarts from launcher */
  ceForcedCaseType: null,
  lastScenarioScore: null,


  caseType: null,
  transportMode: null,
  destination: null,
  transportSecondsRemaining: 0,


  badActions: 0,
  recklessActions: 0,


  patient: {
    age: 0,
    complaint: "",
    shortnessOfBreath: false,


    history: [],
    allergy: "No allergies",


    chf: false,
    pde5: false,
    rvInvolvement: false,


    nausea: false,
    lungSounds: "clear",
    mentalStatus: "alert",


    rhythmMode: "sinus",
    rhythmLabel: "Sinus rhythm",


    currentDialogue: "",
    pain: 0,


    /** null | "mild" | "moderate" | "severe" — STEMI cases only; raises stakes + drift. */
    stemiSeverity: null,
    /** SBP lost per second in some high-risk STEMIs; blunted by fluids/pressors. */
    hemodynamicDrift: 0,
    /** True → HR starts in symptomatic brady range (atropine-relevant). */
    symptomaticBrady: false,


    /** Severe STEMI: drift may start later (scene vs transport). */
    pendingHemodynamicDrift: 0,
    /** "immediate" | "delayed_scene" | "transport" */
    driftStartMode: "immediate",
  },


  vitals: { hr: 0, spo2: 0, sbp: 0, dbp: 0, rr: 0 },
  baselineVitals: {},
  displayedBp: { sbp: null, dbp: null },


  vitalsInterval: null,
  transportInterval: null,


  bpCycleOn: false,
  bpCycleInterval: null,
  /** UI tick while cycling (countdown label). */
  bpCycleUiInterval: null,
  /** Timestamp (ms) when the next automatic BP read runs. */
  bpCycleNextReadAt: 0,


  hypotensionSeconds: 0,
  hypoxiaSeconds: 0,
  /** Seconds (1/tick in vitals loop) patient was alert — used so aspirin isn’t scored if they were altered/unresponsive almost the whole time. */
  alertContactSeconds: 0,


  interventions: {
    oxygenMode: "room_air",
    /** Meaningful when NC (1–6) or NRB (10–15). */
    oxygenLpm: 0,


    ivEstablished: false,
    ivAttempts: 0,
    /** 0, 1, or 2 successful IV lines placed (left then right). */
    ivSuccessCount: 0,
    /** Whether a dedicated fluid line has been started at least once. */
    fluidsLineUsed: false,
    /** Whether a dedicated pressor line has been started at least once. */
    pressorLineUsed: false,


    fluidRunning: false,
    fluidTarget: 0,
    fluidGiven: 0,
    fluidRateMlPerMin: 0,


    aspirinGiven: false,
    nitroCount: 0,
    zofranGiven: false,
    narcoticDoses: 0,
    atropineCount: 0,


    pressorActive: false,
    pressorMed: "norepi",
    pressorRate: 0,


    /** Push-dose epinephrine (quick BP bump); scenario-limited. */
    pushEpiCount: 0,
  },


  alarms: {
    active: false,
    reasons: [],
    lastBeepAt: 0,
  },


  /** Array of { tMs: number, text: string } */
  actionsLog: [],
};


function clearSimEffectChips() {
  document.querySelectorAll(".effectChips").forEach((el) => {
    el.innerHTML = "";
  });
}


function setFeedbackToastForScreen(screenId) {
  const fb = document.getElementById("feedbackBox");
  if (!fb) return;
  const sim = screenId === "ambulanceScreen" || screenId === "transportScreen";
  if (sim) {
    fb.style.visibility = "";
    fb.style.opacity = fb.innerText.trim() ? "1" : "0.6";
  } else {
    fb.innerText = "";
    fb.style.opacity = "0";
    fb.style.visibility = "hidden";
  }
}


function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
  if (id === "ambulanceScreen" || id === "transportScreen") {
    updateSimSceneOverlays();
    setFeedbackToastForScreen(id);
  } else {
    clearSimEffectChips();
    setFeedbackToastForScreen(id);
  }
  closeMobileDrawers();
}


function isPhoneLayout() {
  return window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
}


function getActiveSimScreen() {
  return document.querySelector("#ambulanceScreen.screen.active, #transportScreen.screen.active");
}


function closeMobileDrawers() {
  const s = getActiveSimScreen();
  if (s) {
    s.classList.remove("mobileDrawer--monitorOpen", "mobileDrawer--txOpen", "mobileDrawer--dripsOpen");
  }
}


function toggleMobileDrawer(which) {
  if (!isPhoneLayout()) return;
  const s = getActiveSimScreen();
  if (!s) return;


  const cls =
    which === "monitor"
      ? "mobileDrawer--monitorOpen"
      : which === "tx"
      ? "mobileDrawer--txOpen"
      : "mobileDrawer--dripsOpen";


  const opening = !s.classList.contains(cls);
  s.classList.remove("mobileDrawer--monitorOpen", "mobileDrawer--txOpen", "mobileDrawer--dripsOpen");
  if (opening) s.classList.add(cls);


  // If opening treatments and no tab is active, open Assessment by default.
  if (opening && which === "tx") {
    const cur = s.getAttribute("data-active-tab") || "";
    if (!cur) showTab("assessment");
  }
}


// Capture user actions from sim buttons for chips + sounds.
document.addEventListener(
  "click",
  (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;
    // Only respond to clicks inside the app container.
    if (!document.getElementById("app")?.contains(btn)) return;


    // Enable audio on first user gesture.
    ensureAudio();
    soundClick();


    // If the click is in the sim action area (or right-side drips/O₂ panel), snapshot vitals for "what changed" chips.
    const inSimActions = !!btn.closest(".simActions");
    const inSimRight = !!btn.closest(".simRight");
    const isTransportNav = btn.classList.contains("transportBtn");
    if (inSimActions || inSimRight || isTransportNav) {
      sim.preActionSnapshot = snapshotVitals();
      sim.lastUserActionMs = Date.now();
    }
  },
  { capture: true }
);


/** Syncs O2 overlays with `sim.interventions.oxygenMode` (ambulance + transport). */
function updateSimSceneOverlays() {
  const ncOn = sim.interventions.oxygenMode === "nc";
  const nrbOn = sim.interventions.oxygenMode === "nrb";
  const ivLeftOn = (sim.interventions.ivSuccessCount || 0) >= 1;
  const ivRightOn = (sim.interventions.ivSuccessCount || 0) >= 2;
  const dripCount = (sim.interventions.fluidsLineUsed ? 1 : 0) + (sim.interventions.pressorLineUsed ? 1 : 0);
  // Bags are driven by IV side, not by "fluids vs meds":
  // - First drip uses LEFT IV -> show left bag only if LEFT IV exists.
  // - Second drip uses RIGHT IV -> show right bag only if RIGHT IV exists.
  const fluidsLeftOn = ivLeftOn && dripCount >= 1;
  const dripRightOn = ivRightOn && dripCount >= 2;
  document.querySelectorAll(".simStageNcOverlay").forEach((el) => {
    el.classList.toggle("simStageNcOverlay--on", ncOn);
    el.setAttribute("aria-hidden", ncOn ? "false" : "true");
  });
  document.querySelectorAll(".simStageNrbOverlay").forEach((el) => {
    el.classList.toggle("simStageNrbOverlay--on", nrbOn);
    el.setAttribute("aria-hidden", nrbOn ? "false" : "true");
  });
  document.querySelectorAll(".simStageIvLeftOverlay").forEach((el) => {
    el.classList.toggle("simStageIvLeftOverlay--on", ivLeftOn);
    el.setAttribute("aria-hidden", ivLeftOn ? "false" : "true");
  });
  document.querySelectorAll(".simStageIvRightOverlay").forEach((el) => {
    el.classList.toggle("simStageIvRightOverlay--on", ivRightOn);
    el.setAttribute("aria-hidden", ivRightOn ? "false" : "true");
  });
  document.querySelectorAll(".simStageFluidsLeftOverlay").forEach((el) => {
    el.classList.toggle("simStageFluidsLeftOverlay--on", fluidsLeftOn);
    el.setAttribute("aria-hidden", fluidsLeftOn ? "false" : "true");
  });
  document.querySelectorAll(".simStageDripRightOverlay").forEach((el) => {
    el.classList.toggle("simStageDripRightOverlay--on", dripRightOn);
    el.setAttribute("aria-hidden", dripRightOn ? "false" : "true");
  });


  const ivButtons = document.querySelectorAll('button[data-action="iv"]');
  const lockIv = (sim.interventions.ivSuccessCount || 0) >= 2;
  ivButtons.forEach((btn) => {
    btn.disabled = lockIv;
  });
}


function getDripLineCount() {
  return (sim.interventions.fluidsLineUsed ? 1 : 0) + (sim.interventions.pressorLineUsed ? 1 : 0);
}


function ensureDripLine(kind) {
  const ivCount = sim.interventions.ivSuccessCount || 0;
  if (ivCount < 1) {
    showFeedback("No IV access.");
    sim.badActions++;
    return false;
  }


  const alreadyUsed = kind === "fluids" ? sim.interventions.fluidsLineUsed : sim.interventions.pressorLineUsed;
  if (alreadyUsed) return true;


  const usedCount = getDripLineCount();
  if (usedCount === 0) {
    if (kind === "fluids") sim.interventions.fluidsLineUsed = true;
    else sim.interventions.pressorLineUsed = true;
    updateSimSceneOverlays();
    return true;
  }


  if (usedCount === 1 && ivCount < 2) {
    showFeedback("Need a second IV for another drip.");
    sim.badActions++;
    return false;
  }


  if (kind === "fluids") sim.interventions.fluidsLineUsed = true;
  else sim.interventions.pressorLineUsed = true;
  updateSimSceneOverlays();
  return true;
}


function logAction(text) {
  const now = Date.now();
  const start = sim.scenarioStartMs || now;
  sim.actionsLog.push({ tMs: Math.max(0, now - start), text });
}


function formatActionTime(tMs) {
  const totalSec = Math.max(0, Math.floor((tMs || 0) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}


function showFeedback(message) {
  const box = document.getElementById("feedbackBox");
  if (!box) return;


  // Ensure visible even if a style reset hid it.
  box.style.display = "block";
  box.style.visibility = "visible";
  box.style.zIndex = "99999";

  box.innerText = message;
  box.style.opacity = "1";
  setTimeout(() => (box.style.opacity = "0.6"), 1500);

  // Visual severity cue (green vs red). Keep logic aligned with sound triggers below.
  const msg = String(message || "").toLowerCase();
  const isBad =
    msg.includes("allergic") ||
    msg.includes("contraindicated") ||
    msg.includes("not indicated") ||
    msg.includes("failed") ||
    msg.includes("no iv access") ||
    msg.includes("need a second iv") ||
    msg.includes("oxygen not required") ||
    msg.includes("incorrect");
  box.classList.toggle("feedbackBad", isBad);

  // Sound cues (subtle):
  if (
    isBad
  ) {
    soundBad();
  } else if (
    msg.includes("given") ||
    msg.includes("applied") ||
    msg.includes("established") ||
    msg.includes("started") ||
    msg.includes("correct")
  ) {
    soundGood();
  }
}


function typeText(element, text, speed = 25) {
  let i = 0;
  element.innerHTML = "";
  const interval = setInterval(() => {
    element.innerHTML += text.charAt(i);
    i++;
    if (i >= text.length) clearInterval(interval);
  }, speed);
}


function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[rand(0, arr.length - 1)];
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
/** Pain score is always a whole number 0–10 (no decimals). */
function clampPain(value) {
  return clamp(Math.round(value), 0, 10);
}


/** IV fluid rate baseline for BP scaling (mL/min). */
const FLUID_RATE_REF_ML_MIN = 125;
/** Slider + "Open" preset both cap here (max flow). */
const FLUID_SLIDER_MAX_ML_MIN = 300;
/** Pressor drip effect per second — lowered so titration feels gradual. */
const PRESSOR_TICK_MUL = 0.48;
/** Total bolus target cannot exceed this in one scenario (prevents infinite fluid fix). */
const SCENARIO_MAX_FLUID_ML = 2000;
/** First ~500 mL is “reversible trial volume” — strain builds slowly (assess between boluses). */
const FLUID_STRAIN_VOLUME_BUFFER_ML = 520;


const O2_NC_MIN_LPM = 1;
const O2_NC_MAX_LPM = 6;
const O2_NRB_MIN_LPM = 10;
const O2_NRB_MAX_LPM = 15;
const O2_SPO2_TARGET = 95;


/**
 * Max SpO₂ NC can realistically support in this sim (low-flow: small steps).
 * 1–3 L/min → small gains; 4–6 L/min → a bit more, but NC never replaces NRB for severe hypoxia.
 */
function ncSpo2Ceiling(lpm) {
  const x = clamp(Number(lpm) || O2_NC_MIN_LPM, O2_NC_MIN_LPM, O2_NC_MAX_LPM);
  if (x <= 3) return 84 + (x - 1) * 1.5;
  return 87 + (x - 3);
}


/**
 * NRB ceilings: 10–13 L/min improves meaningfully; 14–15 L/min can reach mid/high‑90s.
 */
function nrbSpo2Ceiling(lpm) {
  const x = clamp(Number(lpm) || O2_NRB_MIN_LPM, O2_NRB_MIN_LPM, O2_NRB_MAX_LPM);
  if (x >= 15) return 97;
  if (x === 14) return 95;
  return 90 + (x - 10);
}


/** SpO₂ drifts toward device ceiling; cannot jump from 70s to mid‑90s on NC alone. */
function applyOxygenSpo2Tick() {
  const mode = sim.interventions.oxygenMode;
  const lpm = sim.interventions.oxygenLpm;


  if (mode === "room_air") {
    sim.vitals.spo2 -= 0.15;
    return;
  }


  const s = sim.vitals.spo2;
  const ceiling = mode === "nc" ? ncSpo2Ceiling(lpm) : nrbSpo2Ceiling(lpm);
  const gap = ceiling - s;
  if (gap <= 0) {
    sim.vitals.spo2 -= 0.06;
    return;
  }


  const isNc = mode === "nc";
  const isNcLow = isNc && lpm <= 3;
  const nrbHigh = mode === "nrb" && lpm >= 14;


  let baseRate = isNc ? (isNcLow ? 0.052 : 0.082) : lpm <= 13 ? 0.13 : nrbHigh ? 0.2 : 0.15;
  let delta = gap * baseRate;
  if (gap < 2) delta *= 0.38;


  const maxStep = isNc ? (isNcLow ? 0.16 : 0.26) : lpm >= 15 ? 0.65 : lpm >= 14 ? 0.55 : 0.45;
  delta = Math.min(delta, maxStep);


  sim.vitals.spo2 += delta;
}


function getCaseLabel() {
  if (sim.caseType === "inferior") return "Inferior STEMI";
  if (sim.caseType === "anterior") return "Anterior STEMI";
  if (sim.caseType === "lateral") return "Lateral STEMI";
  return "No STEMI";
}


/** True for inferior / anterior / lateral STEMI patterns (not NSTEMI). */
function isStemiCase() {
  return sim.caseType === "inferior" || sim.caseType === "anterior" || sim.caseType === "lateral";
}


function getPatientNotesHTML() {
  const flags = [
    sim.patient.chf ? "CHF" : null,
    sim.patient.pde5 ? "Recent ED meds (PDE5)" : null,
    sim.patient.rvInvolvement ? "Possible RV involvement" : null,
    sim.patient.nausea && !sim.interventions.zofranGiven ? "Nausea" : null,
  ].filter(Boolean);


  return `
    <strong>History:</strong> ${sim.patient.history.join(", ")}<br>
    <strong>Allergy:</strong> ${sim.patient.allergy}<br>
    <strong>ECG:</strong> ${getCaseLabel()}<br>
    <strong>STEMI load:</strong> ${
      sim.patient.stemiSeverity
        ? sim.patient.stemiSeverity.charAt(0).toUpperCase() + sim.patient.stemiSeverity.slice(1)
        : "—"
    }<br>
    <strong>Rhythm:</strong> ${sim.patient.rhythmLabel}<br>
    <strong>CHF:</strong> ${sim.patient.chf ? "Yes" : "No"}<br>
    <strong>PDE5:</strong> ${sim.patient.pde5 ? "Yes" : "No"}<br>
    <strong>RV involvement:</strong> ${sim.patient.rvInvolvement ? "Possible" : "No"}<br>
    <strong>Lung sounds:</strong> ${sim.patient.lungSounds}<br>
    <strong>Symptoms:</strong> ${flags.length ? flags.join(", ") : "—"}
  `;
}


function clearBpCycleEngine() {
  if (sim.bpCycleInterval) {
    clearInterval(sim.bpCycleInterval);
    sim.bpCycleInterval = null;
  }
  if (sim.bpCycleUiInterval) {
    clearInterval(sim.bpCycleUiInterval);
    sim.bpCycleUiInterval = null;
  }
  sim.bpCycleNextReadAt = 0;
}


function resetSim() {
  if (sim.vitalsInterval) clearInterval(sim.vitalsInterval);
  if (sim.transportInterval) clearInterval(sim.transportInterval);
  clearBpCycleEngine();


  actionOnce.clear();


  sim.phase = "start";
  sim.scenarioStartMs = 0;
  sim.preActionSnapshot = null;
  sim.lastUserActionMs = 0;
  sim.unnecessaryLog = [];
  sim.caseType = null;
  sim.transportMode = null;
  sim.destination = null;
  sim.transportSecondsRemaining = 0;


  sim._lungFluidStrain = 0;
  sim._brady = { symptomaticSeconds: 0, atropineGivenWhenIndicated: false };
  sim._asaGivenWhenAltered = false;


  sim.lastScenarioScore = null;


  sim.badActions = 0;
  sim.recklessActions = 0;


  sim.patient = {
    age: 0,
    complaint: "",
    shortnessOfBreath: false,


    history: [],
    allergy: "No allergies",


    chf: false,
    pde5: false,
    rvInvolvement: false,


    nausea: false,
    lungSounds: "clear",
    mentalStatus: "alert",


    rhythmMode: "sinus",
    rhythmLabel: "Sinus rhythm",


    currentDialogue: "",
    pain: 0,


    stemiSeverity: null,
    hemodynamicDrift: 0,
    symptomaticBrady: false,
    pendingHemodynamicDrift: 0,
    driftStartMode: "immediate",
  };


  sim.vitals = { hr: 0, spo2: 0, sbp: 0, dbp: 0, rr: 0 };
  sim.baselineVitals = {};
  sim.displayedBp = { sbp: null, dbp: null };


  sim.hypotensionSeconds = 0;
  sim.hypoxiaSeconds = 0;
  sim.alertContactSeconds = 0;


  sim.bpCycleOn = false;


  sim.interventions = {
    oxygenMode: "room_air",
    oxygenLpm: 0,


    ivEstablished: false,
    ivAttempts: 0,
    ivSuccessCount: 0,
    fluidsLineUsed: false,
    pressorLineUsed: false,


    fluidRunning: false,
    fluidTarget: 0,
    fluidGiven: 0,
    fluidRateMlPerMin: 0,


    aspirinGiven: false,
    nitroCount: 0,
    zofranGiven: false,
    narcoticDoses: 0,
    atropineCount: 0,


    pressorActive: false,
    pressorMed: "norepi",
    pressorRate: 0,


    pushEpiCount: 0,
  };


  sim.alarms = { active: false, reasons: [], lastBeepAt: 0 };
  sim.actionsLog = [];


  updateBpCycleLabel();
  setAlarmBanner([]);


  const caseStore = document.getElementById("scenarioCaseType");
  if (caseStore) caseStore.value = "";


  const fb = document.getElementById("feedbackBox");
  if (fb) {
    fb.innerText = "";
    fb.style.opacity = "0.6";
  }


  if (typeof rhythmEngine !== "undefined") {
    rhythmEngine.running = false;
    if (rhythmEngine.rafId) {
      cancelAnimationFrame(rhythmEngine.rafId);
      rhythmEngine.rafId = null;
    }
    rhythmEngine.started = false;
    rhythmEngine.lastTs = 0;
    rhythmEngine.t = 0;
    rhythmEngine.streams.clear();
  }


  updateSimSceneOverlays();
}


function markUnnecessary(key, message, severity = "bad") {
  // severity: "bad" (score hit) or "reckless" (bigger score hit)
  if (severity === "reckless") sim.recklessActions++;
  else sim.badActions++;


  logActionOnce(`unnec-${key}`, message);
  // Avoid duplicates in debrief.
  if (!sim.unnecessaryLog.includes(message)) sim.unnecessaryLog.push(message);
}


function generatePatient() {
  sim.patient.age = rand(42, 84);
  const age = sim.patient.age;


  sim.patient.shortnessOfBreath = Math.random() < 0.35;
  sim.patient.complaint = "Chest pain";
  sim.patient.pain = clampPain(rand(4, 9));


  // nausea: less random baseline
  sim.patient.nausea = Math.random() < 0.15;
  sim.patient.chf = Math.random() < 0.18;


  // PDE5: rare + age dependent
  let pde5Chance = 0.0;
  if (age <= 55) pde5Chance = 0.03;
  else if (age <= 70) pde5Chance = 0.01;
  else pde5Chance = 0.002;
  sim.patient.pde5 = Math.random() < pde5Chance;


  // Aspirin allergy rare (weighted)
  const allergyRoll = Math.random();
  if (allergyRoll < 0.88) sim.patient.allergy = "No allergies";
  else if (allergyRoll < 0.93) sim.patient.allergy = "Penicillin";
  else if (allergyRoll < 0.965) sim.patient.allergy = "Sulfa";
  else if (allergyRoll < 0.99) sim.patient.allergy = "Morphine";
  else sim.patient.allergy = "Aspirin";


  if (sim.runMode === "ce" && sim.ceForcedCaseType) {
    sim.caseType = sim.ceForcedCaseType;
  } else {
    sim.caseType = pick(["inferior", "anterior", "lateral", "nstemi"]);
  }
  sim.patient.rvInvolvement = sim.caseType === "inferior" && Math.random() < 0.35;


  sim.patient.stemiSeverity = null;
  sim.patient.hemodynamicDrift = 0;
  sim.patient.pendingHemodynamicDrift = 0;
  sim.patient.driftStartMode = "immediate";
  if (sim.caseType !== "nstemi") {
    const sRoll = Math.random();
    if (sRoll < 0.40) sim.patient.stemiSeverity = "mild";
    else if (sRoll < 0.74) sim.patient.stemiSeverity = "moderate";
    else sim.patient.stemiSeverity = "severe";
  }


  // rhythm mode
  const rhythmRoll = Math.random();
  if (rhythmRoll < 0.12) sim.patient.rhythmMode = "afib";
  else if (rhythmRoll < 0.24) sim.patient.rhythmMode = "sinus_arrhythmia";
  else if (rhythmRoll < 0.40) sim.patient.rhythmMode = "sinus_pac";
  else if (rhythmRoll < 0.52) sim.patient.rhythmMode = "pvc";
  else sim.patient.rhythmMode = "sinus";


  let spo2 = rand(89, 98);
  let hr = rand(58, 102);
  let sbp = rand(96, 148);
  let rr = rand(14, 24);


  if (sim.caseType === "inferior") sbp = rand(92, 120);
  if (sim.patient.rvInvolvement) sbp = rand(86, 112);


  if (sim.patient.stemiSeverity === "moderate") {
    sbp -= rand(6, 14);
    hr += rand(2, 8);
  } else if (sim.patient.stemiSeverity === "severe") {
    sbp -= rand(12, 26);
    hr += rand(4, 14);
    const driftAmt = 0.062;
    const dMode = Math.random();
    // Severe STEMI more often destabilizes en-route (adds time pressure).
    if (dMode < 0.40) {
      sim.patient.hemodynamicDrift = driftAmt;
      sim.patient.driftStartMode = "immediate";
    } else if (dMode < 0.65) {
      sim.patient.hemodynamicDrift = 0;
      sim.patient.pendingHemodynamicDrift = driftAmt;
      sim.patient.driftStartMode = "delayed_scene";
    } else {
      sim.patient.hemodynamicDrift = 0;
      sim.patient.pendingHemodynamicDrift = driftAmt;
      sim.patient.driftStartMode = "transport";
    }
  } else if (sim.patient.stemiSeverity === "mild") {
    sbp -= rand(0, 6);
  }


  if (sim.patient.shortnessOfBreath) {
    spo2 = Math.max(84, spo2 - rand(2, 6));
    rr = Math.min(30, rr + rand(2, 5));
  }


  if (sim.patient.rhythmMode === "afib") hr = rand(80, 140);
  if (Math.random() < 0.2) hr = rand(48, 58);


  sim.patient.symptomaticBrady = false;
  if (sim.patient.rhythmMode !== "afib" && Math.random() < 0.13) {
    sim.patient.symptomaticBrady = true;
    hr = rand(42, 54);
    sim.patient.rhythmMode = "sinus";
  }


  sbp = clamp(sbp, 66, 175);
  hr = clamp(hr, 38, 165);


  sim.vitals = { hr, spo2, sbp, dbp: Math.round(sbp * 0.58), rr };
  sim.baselineVitals = { ...sim.vitals };


  sim.patient.lungSounds = "clear";
  updateRhythmLabel();


  const hx = ["Hypertension","Diabetes","CAD","Previous MI","High cholesterol","Smoker","No significant history"];
  sim.patient.history = [pick(hx)];
  if (sim.patient.chf) sim.patient.history.push("CHF");
}


function choosePracticeMode() {
  sim.runMode = "practice";
  sim.ceForcedCaseType = null;
  showScreen("startScreen");
}


function chooseCEMode() {
  sim.runMode = "ce";
  sim.ceForcedCaseType = null;
  showScreen("ceAckScreen");
}


function ceAckContinue() {
  showScreen("ceEcgScreen");
}


function beginCEWithCase(caseKey) {
  sim.ceForcedCaseType = caseKey;
  showCEObjectives();
}

const CE_OBJECTIVES = {
  inferior: {
    title: "CE objectives — Inferior STEMI",
    sim: ["Recognize inferior STEMI", "Treat patient safely", "Avoid contraindications", "Transport appropriately"],
    lesson: ["Inferior leads/territory", "RV caution", "ACS priorities"],
    quiz: ["Pass knowledge check", "Unlock mock certificate"],
  },
  anterior: {
    title: "CE objectives — Anterior STEMI",
    sim: ["Recognize anterior STEMI", "Treat patient safely", "Avoid contraindications", "Transport appropriately"],
    lesson: ["Anterior leads/territory", "High-risk ACS", "ACS priorities"],
    quiz: ["Pass knowledge check", "Unlock mock certificate"],
  },
  lateral: {
    title: "CE objectives — Lateral STEMI",
    sim: ["Recognize lateral STEMI", "Treat patient safely", "Avoid contraindications", "Transport appropriately"],
    lesson: ["Lateral leads/territory", "Destination urgency", "ACS priorities"],
    quiz: ["Pass knowledge check", "Unlock mock certificate"],
  },
  nstemi: {
    title: "CE objectives — NSTEMI (no STEMI)",
    sim: ["Identify no-STEMI ECG", "Treat patient safely", "Avoid contraindications", "Transport appropriately"],
    lesson: ["ACS without ST elevation", "Risk/serial testing concept", "ACS priorities"],
    quiz: ["Pass knowledge check", "Unlock mock certificate"],
  },
};

function showCEObjectives() {
  const key = sim.ceForcedCaseType || "nstemi";
  const o = CE_OBJECTIVES[key] || CE_OBJECTIVES.nstemi;

  const titleEl = document.getElementById("ceObjectivesTitle");
  const simEl = document.getElementById("ceObjSim");
  const lessonEl = document.getElementById("ceObjLesson");
  const quizEl = document.getElementById("ceObjQuiz");

  if (titleEl) titleEl.textContent = o.title;
  if (simEl) simEl.innerHTML = o.sim.map((t) => `<li>${t}</li>`).join("");
  if (lessonEl) lessonEl.innerHTML = o.lesson.map((t) => `<li>${t}</li>`).join("");
  if (quizEl) quizEl.innerHTML = o.quiz.map((t) => `<li>${t}</li>`).join("");

  showScreen("ceObjectivesScreen");
}

function ceObjectivesBegin() {
  startScenario();
}


function goToLauncher() {
  sim.runMode = null;
  sim.ceForcedCaseType = null;
  sim.lastScenarioScore = null;
  showScreen("launcherScreen");
}


function restartFromEndScreen() {
  startScenario();
}


function startScenario() {
  resetSim();
  generatePatient();
  sim.phase = "dispatch";
  sim.scenarioStartMs = Date.now();


  const dispatch = document.getElementById("dispatchText");
  const text = `Dispatch: ${sim.patient.age}-year-old with chest pain${
    sim.patient.shortnessOfBreath ? " and shortness of breath" : ""
  }`;


  typeText(dispatch, text);
  showScreen("dispatchScreen");
}


function goEnRoute() {
  sim.phase = "enroute";
  showScreen("enRouteScreen");
}


function arriveOnScene() {
  sim.phase = "scene";
  document.getElementById("sceneText").innerText = `${sim.patient.age} y/o patient appears uncomfortable.`;


  document.getElementById("scenePrompt").innerText =
    sim.patient.shortnessOfBreath
      ? 'Patient: "My chest hurts and I can\'t catch my breath."'
      : 'Patient: "My chest hurts."';


  showScreen("sceneScreen");
}


/* Primary survey */
const primaryQuestionBank = {
  correct: ["Assess airway", "Assess breathing", "Primary assessment (ABCs)", "Look for life threats"],
  wrong: ["Give nitroglycerin", "Take vitals", "Check glucose", "Give pain medication", "Start IV fluids immediately"],
};
let currentPrimaryCorrect = null;


function goToPrimary() {
  sim.phase = "primary";
  renderPrimaryChoices();
  showScreen("primaryScreen");
}


function renderPrimaryChoices() {
  const container = document.getElementById("primaryChoices");
  if (!container) return;


  container.innerHTML = "";
  const correct = pick(primaryQuestionBank.correct);
  currentPrimaryCorrect = correct;


  let wrongChoices = [];
  while (wrongChoices.length < 3) {
    const w = pick(primaryQuestionBank.wrong);
    if (!wrongChoices.includes(w)) wrongChoices.push(w);
  }


  const choices = [correct, ...wrongChoices].sort(() => Math.random() - 0.5);


  choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.innerText = choice;
    btn.onclick = () => handlePrimaryAnswer(choice);
    container.appendChild(btn);
  });
}


function handlePrimaryAnswer(answer) {
  if (answer === currentPrimaryCorrect) {
    logAction("Primary survey performed correctly");
    showFeedback("Primary Survey: Correct — ABCs first.");
  } else {
    logAction("Incorrect primary priority");
    sim.badActions++;
    showFeedback("Primary Survey: Incorrect — delayed primary assessment.");
  }
  setTimeout(goToECG, 800);
}


/* ECG */
function goToECG() {
  sim.phase = "ecg";
  updateECGDisplay();
  showScreen("ecgScreen");
}


function updateECGDisplay() {
  const el = document.getElementById("ecgFindings");
  if (!el) return;


  if (sim.caseType === "inferior") el.innerText = "ST elevation in leads II, III, aVF";
  else if (sim.caseType === "anterior") el.innerText = "ST elevation in leads V1–V4";
  else if (sim.caseType === "lateral") el.innerText = "ST elevation in leads I, aVL, V5, V6";
  else el.innerText = "No ST elevation present";
}


function handleECGAnswer(answer) {
  if (answer === sim.caseType) {
    logAction("Correct ECG interpretation");
    showFeedback("12-Lead ECG: Correct.");
  } else {
    logAction("Incorrect ECG interpretation");
    sim.badActions++;
    showFeedback(`12-Lead ECG: Incorrect — correct answer was ${getCaseLabel()}.`);
  }
  setTimeout(showFocusedAssessment, 900);
}


/* Focused assessment */
function showFocusedAssessment() {
  sim.phase = "focused";
  fillFocusedAssessment();
  updateFocusedVitals();
  showScreen("focusedAssessmentScreen");
}


function fillFocusedAssessment() {
  const faPatient = document.getElementById("faPatient");
  const faGeneral = document.getElementById("faGeneral");
  const faHistory = document.getElementById("faHistory");


  if (faPatient) faPatient.innerHTML = `<strong>Patient:</strong> ${sim.patient.age} y/o`;


  if (faGeneral) {
    faGeneral.innerHTML = `
      <strong>General:</strong><br>
      Chest pain${sim.patient.shortnessOfBreath ? ", SOB" : ""}, alert
    `;
  }


  if (faHistory) {
    faHistory.innerHTML = getPatientNotesHTML();
  }
}


function updateFocusedVitals() {
  const el = document.getElementById("vitalsDisplayFocused");
  if (!el) return;


  const bpText =
    sim.displayedBp.sbp === null ? "-- / --" : `${Math.round(sim.displayedBp.sbp)}/${Math.round(sim.displayedBp.dbp)}`;


  const f = getMonitorAlarmFlags();
  const bpClass = f.lowBp || f.highBp ? " hudVital--alarm" : "";
  const hrClass = f.brady || f.tachy ? " hudVital--alarm" : "";
  const spo2 = Math.round(sim.vitals.spo2);
  const spo2WarnRoomAir = sim.interventions.oxygenMode === "room_air" && spo2 <= 94;
  let spo2Class = "hudSpo2Line";
  if (f.lowSpo2) spo2Class += " hudVital--alarm";
  else if (spo2WarnRoomAir) spo2Class += " hudVital--warn";


  el.innerHTML = `
    BP: <span class="hudVitalLine${bpClass}">${bpText}</span><br>
    HR: <span class="hudVitalLine${hrClass}">${Math.round(sim.vitals.hr)}</span><br>
    RR: ${Math.round(sim.vitals.rr)}<br>
    SpO2: <span class="${spo2Class}">${spo2}</span><br>
    Rhythm: ${sim.patient.rhythmLabel}<br>
    Pain: ${sim.patient.pain}/10
  `;
}


function continueFromAssessment() {
  sim.phase = "ambulance";
  logAction("Moved patient to ambulance");


  showScreen("ambulanceScreen");


  setFluidRatePreset("slow");
  updateAllDisplays();
  // Start with no tab open so the scene is visible.
  showTab("__none__");


  startVitalsEngine();
  startRhythmRenderer();
}


function showTab(tabName) {
  const activeScreen = document.querySelector(".screen.active");
  if (!activeScreen) return;


  const current = activeScreen.getAttribute("data-active-tab") || "";
  const isTogglingOff = current === tabName;


  activeScreen.querySelectorAll(".tabContent").forEach((t) => {
    t.classList.remove("active");
    t.style.display = "none";
  });


  if (isTogglingOff) {
    activeScreen.setAttribute("data-active-tab", "");
    return;
  }


  const tab = activeScreen.querySelector(`.tabContent[data-tab="${tabName}"]`);
  if (tab) {
    activeScreen.setAttribute("data-active-tab", tabName);
    tab.classList.add("active");
    tab.style.display = "flex";
  } else {
    activeScreen.setAttribute("data-active-tab", "");
  }
}


function assessLungs() {
  const msg = sim.patient.lungSounds === "rales" ? "Lung sounds: Rales bilaterally." : "Lung sounds: Clear bilaterally.";
  logAction("Lung sounds assessed");
  showFeedback(msg);
}


function checkMentalStatus() {
  let msg = "Patient is alert and responding.";
  if (sim.patient.mentalStatus === "altered") msg = "Patient is altered (responds slowly).";
  if (sim.patient.mentalStatus === "unresponsive") msg = "Patient is unresponsive to verbal stimuli.";
  logAction("Mental status checked");
  showFeedback(msg);
}


function updateRhythmLabel() {
  const hr = sim.vitals.hr;


  if (sim.patient.rhythmMode === "afib") {
    sim.patient.rhythmLabel = "A-fib";
    return;
  }


  if (sim.patient.rhythmMode === "pvc") {
    if (hr < 60) sim.patient.rhythmLabel = "Sinus brady w/ occasional PVCs";
    else if (hr > 100) sim.patient.rhythmLabel = "Sinus tach w/ occasional PVCs";
    else sim.patient.rhythmLabel = "Sinus rhythm w/ occasional PVCs";
    return;
  }


  if (sim.patient.rhythmMode === "sinus_pac") {
    if (hr < 60) sim.patient.rhythmLabel = "Sinus brady w/ occasional PACs";
    else if (hr > 100) sim.patient.rhythmLabel = "Sinus tach w/ occasional PACs";
    else sim.patient.rhythmLabel = "Sinus rhythm w/ occasional PACs";
    return;
  }


  if (sim.patient.rhythmMode === "sinus_arrhythmia") {
    sim.patient.rhythmLabel = "Sinus arrhythmia";
    return;
  }


  if (hr < 60) sim.patient.rhythmLabel = "Sinus bradycardia";
  else if (hr > 100) sim.patient.rhythmLabel = "Sinus tachycardia";
  else sim.patient.rhythmLabel = "Sinus rhythm";
}


function startVitalsEngine() {
  if (sim.vitalsInterval) clearInterval(sim.vitalsInterval);


  sim.vitalsInterval = setInterval(() => {
    if (sim.patient.pendingHemodynamicDrift > 0) {
      const startMs = sim.scenarioStartMs || Date.now();
      const elapsed = Date.now() - startMs;
      let activate = false;
      if (sim.patient.driftStartMode === "delayed_scene") {
        activate =
          (sim.phase === "ambulance" && elapsed > 42000) || sim.phase === "transport";
      } else if (sim.patient.driftStartMode === "transport") {
        activate = sim.phase === "transport";
      }
      if (activate) {
        sim.patient.hemodynamicDrift = sim.patient.pendingHemodynamicDrift;
        sim.patient.pendingHemodynamicDrift = 0;
        logActionOnce("hemoDriftEscalate", "Patient becoming more hemodynamically unstable.");
        showFeedback("Patient looks worse — BP falling.");
      }
    }


    applyOxygenSpo2Tick();


    if (sim.interventions.fluidRunning && sim.interventions.fluidRateMlPerMin > 0) {
      const ratePerSec = sim.interventions.fluidRateMlPerMin / 60;
      sim.interventions.fluidGiven += ratePerSec;


      if (sim.interventions.fluidGiven >= sim.interventions.fluidTarget) {
        sim.interventions.fluidGiven = sim.interventions.fluidTarget;
        sim.interventions.fluidRunning = false;
      }


      const fr = sim.interventions.fluidRateMlPerMin;
      const rateScale = Math.min(fr / FLUID_RATE_REF_ML_MIN, 2.25);
      let fSbp = 0.18 * rateScale;
      let fDbp = 0.1 * rateScale;
      if (sim.patient.stemiSeverity === "severe") {
        fSbp *= 0.72;
        fDbp *= 0.72;
      } else if (sim.patient.stemiSeverity === "moderate") {
        fSbp *= 0.85;
        fDbp *= 0.85;
      }
      sim.vitals.sbp += fSbp;
      sim.vitals.dbp += fDbp;
    }


    let drift = sim.patient.hemodynamicDrift || 0;
    if (drift > 0) {
      if (sim.interventions.pressorActive && sim.interventions.pressorRate >= 5) drift *= 0.38;
      if (sim.interventions.fluidRunning && sim.interventions.fluidRateMlPerMin >= FLUID_RATE_REF_ML_MIN) drift *= 0.52;
      sim.vitals.sbp -= drift;
    }


    const fr = sim.interventions.fluidRateMlPerMin;
    const given = sim.interventions.fluidGiven;
    let strain = sim._lungFluidStrain || 0;
    let strainInc = 0;
    if (given > 280) {
      strainInc += ((given - 280) / 11000) * (sim.interventions.fluidRunning ? 1.05 : 0.65);
    }
    if (sim.interventions.fluidRunning && fr > 0) {
      let ratePart = (fr / FLUID_SLIDER_MAX_ML_MIN) * 0.42 + (given / 4200) * 0.1;
      if (given < FLUID_STRAIN_VOLUME_BUFFER_ML) ratePart *= 0.28;
      strainInc += ratePart;
    }
    if (sim.patient.chf) strainInc *= 1.22;
    if (given < FLUID_STRAIN_VOLUME_BUFFER_ML) strainInc *= 0.32;
    strain += strainInc;
    strain = Math.min(strain, 100);
    sim._lungFluidStrain = strain;


    const ralesThreshold = sim.patient.chf ? 44 : 52;
    if (strain >= ralesThreshold && given >= 380) sim.patient.lungSounds = "rales";
    else if (strain < 14 && !sim.patient.chf) sim.patient.lungSounds = "clear";
    else if (strain < 18 && sim.patient.chf && given < 400) sim.patient.lungSounds = "clear";


    const ox = sim.interventions.oxygenMode;
    const oxAirPenalty = ox === "nrb" ? 0.32 : ox === "nc" ? 0.52 : 1;
    if (strain > 40) {
      sim.vitals.spo2 -= (strain - 40) * 0.012 * oxAirPenalty;
    }
    if (strain > 36) sim.vitals.rr += 0.018 + (strain - 36) * 0.002;
    if (strain > 44 && sim.patient.lungSounds === "rales") {
      sim.vitals.spo2 -= 0.08 * oxAirPenalty;
    }
    if (strain > 48 && given >= 600) {
      logActionOnce("fluidCongestion", "Pulmonary congestion from fluid load (worsening work of breathing).");
    }


    if (sim.interventions.nitroCount > 0) {
      sim.vitals.sbp -= 0.25;
      sim.vitals.dbp -= 0.12;
    }


    if (sim.interventions.pressorActive && sim.interventions.pressorRate > 0) {
      const r = sim.interventions.pressorRate;
      const hypoBoost = sim.vitals.sbp < 88 ? 1.32 : sim.vitals.sbp < 100 ? 1.12 : 1;
      const pm = PRESSOR_TICK_MUL * hypoBoost;
      if (sim.interventions.pressorMed === "norepi") {
        sim.vitals.sbp += (0.22 + r * 0.035) * pm;
        sim.vitals.dbp += (0.1 + r * 0.02) * pm;
      } else if (sim.interventions.pressorMed === "dopamine") {
        sim.vitals.hr += (0.1 + r * 0.03) * pm;
        sim.vitals.sbp += (0.12 + r * 0.02) * pm;
      } else if (sim.interventions.pressorMed === "epi") {
        sim.vitals.hr += (0.14 + r * 0.04) * pm;
        sim.vitals.sbp += (0.16 + r * 0.028) * pm;
      }
    }


    if (sim.interventions.atropineCount > 0) {
      sim.vitals.hr += 0.35 * Math.min(sim.interventions.atropineCount, 3);
    }
    if (sim.patient.rhythmMode === "afib") sim.vitals.hr += rand(-2, 2) * 0.6;


    sim.vitals.hr += rand(-1, 1) * 0.25;
    sim.vitals.spo2 += rand(-1, 1) * 0.15;
    sim.vitals.sbp += rand(-1, 1) * 0.35;
    sim.vitals.dbp += rand(-1, 1) * 0.20;


    sim.vitals.hr = clamp(sim.vitals.hr, 30, 180);
    sim.vitals.spo2 = clamp(sim.vitals.spo2, 70, 100);
    sim.vitals.sbp = clamp(sim.vitals.sbp, 55, 210);
    sim.vitals.dbp = clamp(sim.vitals.dbp, 35, 140);
    sim.vitals.rr = clamp(sim.vitals.rr, 6, 40);
    sim.patient.pain = clampPain(sim.patient.pain);


    if (sim.vitals.sbp < 75) sim.hypotensionSeconds += 1;
    else sim.hypotensionSeconds = 0;


    // Timed deterioration (gentle): sustained hypoxia on room air worsens.
    const onRoomAir = sim.interventions.oxygenMode === "room_air";
    if (onRoomAir && sim.vitals.spo2 < 90) sim.hypoxiaSeconds += 1;
    else sim.hypoxiaSeconds = 0;


    if (sim.hypoxiaSeconds >= 12) {
      sim.vitals.spo2 -= 0.20;
      sim.vitals.rr += 0.12;
      if (sim.hypoxiaSeconds >= 22 && sim.patient.mentalStatus === "alert" && Math.random() < 0.08) {
        sim.patient.mentalStatus = "altered";
        logActionOnce("hypoxiaAltered", "Mental status worsened (hypoxia)");
      }
    }


    // Pain can creep up by 1 if untreated severe pain (no narcotics).
    if (sim.patient.pain >= 7 && sim.interventions.narcoticDoses === 0 && Math.random() < 0.10) {
      sim.patient.pain = clampPain(sim.patient.pain + 1);
    }


    // --- Perfusion / mental status ladder (gives warning signs before full "unresponsive") ---
    const hrNow = sim.vitals.hr;
    const sbpNow = sim.vitals.sbp;
    const symptomaticBradyNow =
      hrNow < 50 && (sim.patient.symptomaticBrady || sim.patient.mentalStatus !== "alert" || sbpNow < 100);
    if (symptomaticBradyNow) sim._brady.symptomaticSeconds += 1;

    // Earlier "worsening" signs when perfusion is dropping.
    if (sbpNow < 92 && sim.patient.mentalStatus === "alert") sim.patient.mentalStatus = "altered";
    if (hrNow < 44 && sbpNow < 100 && sim.patient.mentalStatus === "alert") sim.patient.mentalStatus = "altered";

    // Unresponsiveness becomes more likely when hypotension is sustained, especially en-route.
    if (sim.hypotensionSeconds >= 7) {
      const base = sim.phase === "transport" ? 0.55 : 0.32;
      const severeBoost = sim.patient.stemiSeverity === "severe" ? 0.12 : 0;
      const p = Math.min(0.82, base + severeBoost);
      if (sim.patient.mentalStatus !== "unresponsive" && Math.random() < p) {
        sim.patient.mentalStatus = "unresponsive";
        logActionOnce("unresponsive", "Patient became unresponsive (hypotension)");
        showFeedback("Patient became unresponsive.");
        pushEffectChip("UNRESPONSIVE", "bad");
        soundBad();
      }
    }


    if (sim.vitals.sbp > 95 && sim.patient.mentalStatus === "unresponsive") sim.patient.mentalStatus = "altered";
    if (sim.vitals.sbp > 105 && sim.patient.mentalStatus === "altered") sim.patient.mentalStatus = "alert";


    if (sim.patient.mentalStatus === "alert") sim.alertContactSeconds += 1;


    updateRhythmLabel();
    updateAllDisplays();
  }, 1000);
}


function updateAllDisplays() {
  updateAmbulanceMonitor();
  updateFocusedVitals();
  fillFocusedAssessment();
  updatePatientDialogue();
  updateFluidDisplays();
  updateOxygenDisplays();
  updatePressorDisplays();
  updateBpCycleLabel();
  updateAlarms();
  updateMedButtonStates();
  maybeShowEffectChips();
}


function maybeShowEffectChips() {
  if (!sim.preActionSnapshot || !sim.lastUserActionMs) return;
  if (Date.now() - sim.lastUserActionMs > 1200) return;


  const before = sim.preActionSnapshot;
  const after = snapshotVitals();
  sim.preActionSnapshot = null; // show once


  const chips = [];
  const dSpo2 = after.spo2 - before.spo2;
  const dPain = after.pain - before.pain;
  const dSbp = after.sbp - before.sbp;
  const dHr = after.hr - before.hr;


  if (Math.abs(dSpo2) >= 0.8) chips.push({ t: `SpO₂ ${dSpo2 > 0 ? "↑" : "↓"}`, tone: dSpo2 > 0 ? "good" : "warn" });
  if (Math.abs(dPain) >= 1) chips.push({ t: `Pain ${dPain < 0 ? "↓" : "↑"}`, tone: dPain < 0 ? "good" : "warn" });
  if (Math.abs(dSbp) >= 1.8) chips.push({ t: `BP ${dSbp > 0 ? "↑" : "↓"}`, tone: dSbp > 0 ? "good" : "warn" });
  if (Math.abs(dHr) >= 1.8) chips.push({ t: `HR ${dHr > 0 ? "↑" : "↓"}`, tone: "warn" });


  // If nothing measurable changed, still give a small "logged" chip (keeps it feeling responsive).
  if (!chips.length) chips.push({ t: "Action logged", tone: "good" });


  chips.slice(0, 2).forEach((c) => pushEffectChip(c.t, c.tone));
}


/** Grey out med buttons when max doses used (ambulance + transport share same counts). */
function updateMedButtonStates() {
  const nitroMax = sim.interventions.nitroCount >= 3;
  const narMax = sim.interventions.narcoticDoses >= 4;
  const atrMax = sim.interventions.atropineCount >= 3;


  document.querySelectorAll("#app button[data-action]").forEach((btn) => {
    const a = btn.getAttribute("data-action");
    if (
      !["aspirin", "nitro", "zofran", "morphine", "fentanyl", "atropine", "pushEpi"].includes(
        a || ""
      )
    ) {
      return;
    }


    let depleted = false;
    if (a === "aspirin") depleted = sim.interventions.aspirinGiven;
    else if (a === "nitro") depleted = nitroMax;
    else if (a === "zofran") depleted = sim.interventions.zofranGiven;
    else if (a === "morphine" || a === "fentanyl") depleted = narMax;
    else if (a === "atropine") depleted = atrMax;
    else if (a === "pushEpi") depleted = sim.interventions.pushEpiCount >= 2;


    btn.classList.toggle("medDepleted", depleted);
    btn.disabled = depleted;
  });
}


/** Same thresholds as `computeAlarmReasons` — used for monitor red highlighting. */
function getMonitorAlarmFlags() {
  const sbp = sim.vitals.sbp;
  const spo2 = sim.vitals.spo2;
  const hr = sim.vitals.hr;
  return {
    lowBp: sbp < 90,
    highBp: sbp > 180,
    lowSpo2: spo2 < 88,
    brady: hr < 40,
    tachy: hr > 150,
  };
}


function updateAmbulanceMonitor() {
  const nodes = [
    document.getElementById("ambulanceVitalsScene"),
    document.getElementById("ambulanceVitalsTransport"),
  ].filter(Boolean);


  if (nodes.length === 0) return;


  const bpText =
    sim.displayedBp.sbp === null ? "-- / --" : `${Math.round(sim.displayedBp.sbp)}/${Math.round(sim.displayedBp.dbp)}`;


  const f = getMonitorAlarmFlags();
  const bpClass = f.lowBp || f.highBp ? " hudVital--alarm" : "";
  const hrClass = f.brady || f.tachy ? " hudVital--alarm" : "";
  const spo2 = Math.round(sim.vitals.spo2);
  const spo2WarnRoomAir = sim.interventions.oxygenMode === "room_air" && spo2 <= 94;
  let spo2Class = "hudSpo2Line";
  if (f.lowSpo2) spo2Class += " hudVital--alarm";
  else if (spo2WarnRoomAir) spo2Class += " hudVital--warn";


  const html = `
    BP: <span class="hudVitalLine${bpClass}">${bpText}</span><br>
    HR: <span class="hudVitalLine${hrClass}">${Math.round(sim.vitals.hr)}</span><br>
    RR: ${Math.round(sim.vitals.rr)}<br>
    SpO2: <span class="${spo2Class}">${spo2}</span><br>
    Pain: ${sim.patient.pain}/10<br>
    Rhythm: ${sim.patient.rhythmLabel}
  `;


  nodes.forEach((el) => (el.innerHTML = html));
}


/** Auto BP cycle interval — keep label + feedback in sync with `BP_CYCLE_MS`. */
const BP_CYCLE_MS = 20000;
const BP_CYCLE_SEC = BP_CYCLE_MS / 1000;


/** If a new cuff read rounds to the same as last display, nudge ±1 mmHg on SBP or DBP (display only). */
function displayedBpWithMeasurementJitter() {
  const prevRS = sim.displayedBp.sbp != null ? Math.round(sim.displayedBp.sbp) : null;
  const prevRD = sim.displayedBp.dbp != null ? Math.round(sim.displayedBp.dbp) : null;
  let rs = Math.round(sim.vitals.sbp);
  let rd = Math.round(sim.vitals.dbp);
  if (prevRS === null || prevRD === null || rs !== prevRS || rd !== prevRD) {
    return { sbp: rs, dbp: rd };
  }
  const tryS = (delta) => clamp(rs + delta, 55, 210);
  const tryD = (delta) => clamp(rd + delta, 35, 140);
  const options = [];
  [-1, 1].forEach((d) => {
    const ns = tryS(d);
    if (ns !== rs) options.push({ sbp: ns, dbp: rd });
  });
  [-1, 1].forEach((d) => {
    const nd = tryD(d);
    if (nd !== rd) options.push({ sbp: rs, dbp: nd });
  });
  if (!options.length) return { sbp: rs, dbp: rd };
  return options[Math.floor(Math.random() * options.length)];
}


function manualBP(fromAutoCycle) {
  const now = Date.now();
  if (!fromAutoCycle && now - lastBPTime < 1500) {
    showFeedback("Wait before rechecking BP");
    return;
  }
  lastBPTime = now;


  const next = displayedBpWithMeasurementJitter();
  sim.displayedBp.sbp = next.sbp;
  sim.displayedBp.dbp = next.dbp;


  updateAllDisplays();
  logActionOnce("bp", "Blood pressure obtained");
  showFeedback(`BP: ${Math.round(sim.displayedBp.sbp)}/${Math.round(sim.displayedBp.dbp)}`);
}


function cycleBP() {
  if (sim.bpCycleOn) {
    sim.bpCycleOn = false;
    clearBpCycleEngine();
    showFeedback("BP Cycle: OFF");
    logActionOnce("bpCycleOff", "BP cycling stopped");
    updateBpCycleLabel();
    return;
  }


  sim.bpCycleOn = true;
  showFeedback(`BP Cycle: ON (every ${BP_CYCLE_SEC}s)`);
  logActionOnce("bpCycleOn", `BP cycling started (${BP_CYCLE_SEC}s)`);
  updateBpCycleLabel();


  manualBP(true);
  sim.bpCycleNextReadAt = Date.now() + BP_CYCLE_MS;
  sim.bpCycleInterval = setInterval(() => {
    manualBP(true);
    sim.bpCycleNextReadAt = Date.now() + BP_CYCLE_MS;
    updateBpCycleLabel();
  }, BP_CYCLE_MS);


  sim.bpCycleUiInterval = setInterval(updateBpCycleLabel, 500);
  updateBpCycleLabel();
}


function updateBpCycleLabel() {
  let txt;
  if (!sim.bpCycleOn) {
    txt = "BP Cycle: OFF";
  } else {
    const msLeft = sim.bpCycleNextReadAt - Date.now();
    const sec = Math.max(0, Math.ceil(msLeft / 1000));
    txt = `BP Cycle: ON · next in ${sec}s`;
  }
  [
    "bpCycleStatusAmbulance",
    "bpCycleStatusTransport",
    "bpCycleStatusAmbulanceMobile",
    "bpCycleStatusTransportMobile",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerText = txt;
  });
}


/* Patient always has chest pain */
function updatePatientDialogue() {
  let message = "";


  const pickOne = (key, arr) => {
    const now = Date.now();
    sim._dlg = sim._dlg || { key: "", msg: "", until: 0, overrides: [] };


    // If we are still within the hold window for this same state, keep the same line.
    if (sim._dlg.key === key && sim._dlg.msg && now < (sim._dlg.until || 0)) return sim._dlg.msg;


    const msg = arr[rand(0, arr.length - 1)];
    sim._dlg.key = key;
    sim._dlg.msg = msg;
    // Hold the same line for a while so it doesn't "bam bam bam" cycle.
    sim._dlg.until = now + 6500;
    return msg;
  };


  const consumeOverride = () => {
    if (!sim._dlg || !Array.isArray(sim._dlg.overrides) || !sim._dlg.overrides.length) return null;
    const now = Date.now();
    // remove expired
    sim._dlg.overrides = sim._dlg.overrides.filter((o) => o && now < o.until);
    const next = sim._dlg.overrides.shift();
    return next ? next.msg : null;
  };


  const overrideMsg = consumeOverride();
  if (overrideMsg) {
    message = overrideMsg;
  } else {


    if (sim.patient.mentalStatus === "unresponsive") {
      message = "(Unresponsive)";
    } else if (sim.patient.mentalStatus === "altered") {
      message = pickOne("altered", [
        "I’m so dizzy… it’s hard to stay awake…",
        "Everything feels like it’s fading…",
        "I’m really weak…",
        "I… can’t focus…",
      ]);
    } else {
      // Context-first dialogue (one random line per state, held for a few seconds).
      if (sim.vitals.sbp < 85) {
        message = pickOne("lowbp", [
          "I feel like I’m going to pass out…",
          "I’m dizzy… everything’s spinning…",
          "I feel weak…",
        ]);
      } else if (
        (sim._lungFluidStrain || 0) > 34 &&
        sim.interventions.oxygenMode === "room_air" &&
        sim.vitals.spo2 < 98 &&
        sim.vitals.spo2 >= 88
      ) {
        message = pickOne("fluidWind", [
          "I’m getting more winded…",
          "It’s harder to breathe than a minute ago…",
          "I can’t get a full breath…",
        ]);
      } else if (
        (sim.patient.lungSounds === "rales" && sim.vitals.spo2 <= 95) ||
        sim.vitals.spo2 < 90
      ) {
        message = pickOne("sob", [
          "I can’t catch my breath…",
          "It’s hard to breathe…",
          "I feel like I’m suffocating…",
        ]);
      } else if (sim.patient.nausea && !sim.interventions.zofranGiven) {
        message = pickOne("nausea", [
          "My chest hurts… and I feel nauseous…",
          "I feel sick to my stomach…",
          "I might throw up…",
        ]);
      } else if (sim.vitals.hr < 50) {
        message = pickOne("brady", [
          "My heart feels slow… I’m getting lightheaded…",
          "I feel faint… like I might pass out…",
          "I’m getting woozy…",
        ]);
      } else if (sim.interventions.nitroCount > 0 && sim.vitals.sbp < 100) {
        message = pickOne("nitroDizzy", [
          "That nitro made me dizzy…",
          "I feel more lightheaded after that…",
        ]);
      } else if (sim.patient.pain > 7) {
        message = pickOne("painHigh", [
          "My chest still really hurts…",
          "It’s still a lot of pressure…",
          "It’s not letting up…",
        ]);
      } else if (sim.patient.pain > 4) {
        message = pickOne("painMid", ["My chest hurts.", "My chest still hurts.", "It’s still there…"]);
      } else {
        message = pickOne("painLow", ["It’s easing a little…", "That’s a bit better…", "I feel a little better…"]);
      }
    }
  }


  if (message !== sim.patient.currentDialogue) {
    sim.patient.currentDialogue = message;
    const nodes = [
      document.getElementById("patientDialogueAmbulance"),
      document.getElementById("patientDialogueTransport"),
      document.getElementById("patientDialogueAmbulanceMobile"),
      document.getElementById("patientDialogueTransportMobile"),
    ].filter(Boolean);


    nodes.forEach((el) => (el.innerText = `Patient: "${message}"`));
  }
}


function airwayCheck() {
  logActionOnce("airway", "Airway assessed");
  showFeedback("Airway patent and clear.");
}


function giveNC() {
  if (sim.interventions.oxygenMode === "nc") {
    sim.interventions.oxygenMode = "room_air";
    sim.interventions.oxygenLpm = 0;
    showFeedback("Nasal cannula removed.");
    logAction("Oxygen: nasal cannula removed");
    updateSimSceneOverlays();
    updateAllDisplays();
    return;
  }


  const wasNrb = sim.interventions.oxygenMode === "nrb";
  if (sim.vitals.spo2 >= 94) {
    sim.badActions++;
    showFeedback("Oxygen not required.");
  } else {
    showFeedback("Nasal cannula applied — set flow on the Oxygen panel.");
    sim._dlg = sim._dlg || { overrides: [] };
    sim._dlg.overrides = sim._dlg.overrides || [];
    sim._dlg.overrides.push({ msg: "That feels a little better…", until: Date.now() + 6000 });
  }
  sim.interventions.oxygenMode = "nc";
  sim.interventions.oxygenLpm = clampOxygenLpmForMode(wasNrb ? 4 : 2, "nc");
  logActionOnce("o2nc", `Oxygen via nasal cannula (${sim.interventions.oxygenLpm} L/min)`);
  updateSimSceneOverlays();
  updateAllDisplays();
}


function giveNRB() {
  if (sim.interventions.oxygenMode === "nrb") {
    sim.interventions.oxygenMode = "room_air";
    sim.interventions.oxygenLpm = 0;
    showFeedback("NRB removed.");
    logAction("Oxygen: NRB removed");
    updateSimSceneOverlays();
    updateAllDisplays();
    return;
  }


  if (sim.vitals.spo2 > 90) {
    sim.badActions++;
    showFeedback("NRB not indicated.");
  } else {
    showFeedback("NRB applied — set flow on the Oxygen panel.");
    sim._dlg = sim._dlg || { overrides: [] };
    sim._dlg.overrides = sim._dlg.overrides || [];
    sim._dlg.overrides.push({ msg: "Okay… I can breathe a little easier.", until: Date.now() + 7000 });
  }
  sim.interventions.oxygenMode = "nrb";
  sim.interventions.oxygenLpm = clampOxygenLpmForMode(12, "nrb");
  logActionOnce("o2nrb", `Oxygen via NRB (${sim.interventions.oxygenLpm} L/min)`);
  updateSimSceneOverlays();
  updateAllDisplays();
}


function attemptIV() {
  sim.interventions.ivAttempts++;


  if ((sim.interventions.ivSuccessCount || 0) >= 2) {
    showFeedback("IV access already established.");
    updateSimSceneOverlays();
    return;
  }


  if (Math.random() < 0.75) {
    sim.interventions.ivEstablished = true;
    sim.interventions.ivSuccessCount = (sim.interventions.ivSuccessCount || 0) + 1;


    if (sim.interventions.ivSuccessCount === 1) {
      showFeedback("IV established (left).");
      logActionOnce("iv1", "IV established (left)");
    } else {
      showFeedback("Second IV established.");
      logActionOnce("iv2", "Second IV established");
    }
    updateSimSceneOverlays();
  } else {
    showFeedback("IV attempt failed — try again.");
    pushEffectChip("IV failed — try again", "bad");
    logAction("IV attempt failed");
  }
}


function requireIvAccess() {
  if (!sim.interventions.ivEstablished) {
    showFeedback("You need IV access first.");
    return false;
  }
  return true;
}


/* Fluids */
function getFluidUI(isTransport = false) {
  return { slider: document.getElementById(isTransport ? "fluidRateSlider2" : "fluidRateSlider") };
}
function setFluidRateFromUI(isTransport = false) {
  const ui = getFluidUI(isTransport);
  if (!ui.slider) return;
  sim.interventions.fluidRateMlPerMin = clamp(
    Number(ui.slider.value),
    0,
    FLUID_SLIDER_MAX_ML_MIN
  );
  updateFluidDisplays();
}
function nudgeFluidRate(delta) {
  sim.interventions.fluidRateMlPerMin = clamp(
    sim.interventions.fluidRateMlPerMin + delta,
    0,
    FLUID_SLIDER_MAX_ML_MIN
  );
  updateFluidDisplays();
}
function setFluidRatePreset(preset) {
  if (preset === "kvo") sim.interventions.fluidRateMlPerMin = 30;
  if (preset === "slow") sim.interventions.fluidRateMlPerMin = 60;
  if (preset === "open") sim.interventions.fluidRateMlPerMin = FLUID_SLIDER_MAX_ML_MIN;


  logActionOnce(`fluidsRate-${preset}`, `Fluids rate set: ${preset.toUpperCase()}`);
  showFeedback(`Fluids rate: ${preset.toUpperCase()}`);
  updateFluidDisplays();
}
function addFluidTarget(amount) {
  if (!ensureDripLine("fluids")) return;


  const next = sim.interventions.fluidTarget + amount;
  if (next > SCENARIO_MAX_FLUID_ML) {
    showFeedback(`Total fluid order capped at ~${SCENARIO_MAX_FLUID_ML} mL this scenario.`);
    return;
  }


  sim.interventions.fluidTarget = next;
  sim.interventions.fluidRunning = true;


  logAction(`Fluids added: +${amount} mL`);
  showFeedback(`Fluids started: +${amount} mL`);
  updateFluidDisplays();
}
function stopFluids() {
  sim.interventions.fluidRunning = false;
  logActionOnce("fluidsStop", "Fluids stopped");
  showFeedback("Fluids stopped.");
  updateFluidDisplays();
}
function updateFluidDisplays() {
  const statusNodes = [
    document.getElementById("fluidStatusAmbulance"),
    document.getElementById("fluidStatusTransport"),
  ].filter(Boolean);


  const rateNodes = [
    document.getElementById("fluidRateAmbulance"),
    document.getElementById("fluidRateTransport"),
  ].filter(Boolean);


  const ui1 = getFluidUI(false);
  const ui2 = getFluidUI(true);
  if (ui1.slider) ui1.slider.value = String(Math.round(sim.interventions.fluidRateMlPerMin));
  if (ui2.slider) ui2.slider.value = String(Math.round(sim.interventions.fluidRateMlPerMin));


  const text = `Fluids: ${Math.round(sim.interventions.fluidGiven)} mL / ${Math.round(sim.interventions.fluidTarget)} mL`;
  statusNodes.forEach((el) => (el.innerText = text));


  const rateText =
    sim.interventions.fluidRateMlPerMin > 0
      ? `Rate: ${Math.round(sim.interventions.fluidRateMlPerMin)} mL/min${sim.interventions.fluidRunning ? "" : " (paused)"}`
      : "Rate: --";
  rateNodes.forEach((el) => (el.innerText = rateText));
}


function getOxygenUI(isTransport = false) {
  return {
    slider: document.getElementById(isTransport ? "oxygenLpmSlider2" : "oxygenLpmSlider"),
  };
}


function clampOxygenLpmForMode(lpm, mode) {
  const n = Number(lpm) || 0;
  if (mode === "nc") return clamp(Math.round(n), O2_NC_MIN_LPM, O2_NC_MAX_LPM);
  if (mode === "nrb") return clamp(Math.round(n), O2_NRB_MIN_LPM, O2_NRB_MAX_LPM);
  return 0;
}


function setOxygenRateFromUI(isTransport = false) {
  const mode = sim.interventions.oxygenMode;
  if (mode !== "nc" && mode !== "nrb") return;
  const ui = getOxygenUI(isTransport);
  if (!ui.slider) return;
  sim.interventions.oxygenLpm = clampOxygenLpmForMode(ui.slider.value, mode);
  const ui2 = getOxygenUI(!isTransport);
  if (ui2.slider) ui2.slider.value = String(sim.interventions.oxygenLpm);
  updateOxygenDisplays();
}


function nudgeOxygenLpm(delta, isTransport = false) {
  const mode = sim.interventions.oxygenMode;
  if (mode !== "nc" && mode !== "nrb") return;
  const cur = sim.interventions.oxygenLpm || clampOxygenLpmForMode(2, mode);
  sim.interventions.oxygenLpm = clampOxygenLpmForMode(cur + delta, mode);
  const ui = getOxygenUI(isTransport);
  const ui2 = getOxygenUI(!isTransport);
  if (ui.slider) ui.slider.value = String(sim.interventions.oxygenLpm);
  if (ui2.slider) ui2.slider.value = String(sim.interventions.oxygenLpm);
  updateOxygenDisplays();
}


function updateOxygenDisplays() {
  const mode = sim.interventions.oxygenMode;
  const lpm = sim.interventions.oxygenLpm;


  const statusAmb = document.getElementById("oxygenStatusAmbulance");
  const statusTr = document.getElementById("oxygenStatusTransport");
  const hintAmb = document.getElementById("oxygenHintAmbulance");
  const hintTr = document.getElementById("oxygenHintTransport");
  const labelAmb = document.getElementById("oxygenLpmLabelAmbulance");
  const labelTr = document.getElementById("oxygenLpmLabelTransport");
  const rowAmb = document.getElementById("oxygenDialRowAmbulance");
  const rowTr = document.getElementById("oxygenDialRowTransport");


  const ui1 = getOxygenUI(false);
  const ui2 = getOxygenUI(true);


  const syncSlider = (slider) => {
    if (!slider) return;
    if (mode === "nc") {
      slider.min = String(O2_NC_MIN_LPM);
      slider.max = String(O2_NC_MAX_LPM);
      slider.step = "1";
      slider.disabled = false;
    } else if (mode === "nrb") {
      slider.min = String(O2_NRB_MIN_LPM);
      slider.max = String(O2_NRB_MAX_LPM);
      slider.step = "1";
      slider.disabled = false;
    } else {
      slider.disabled = true;
    }
    if (mode === "nc" || mode === "nrb") {
      const v = clampOxygenLpmForMode(lpm || (mode === "nc" ? 2 : 12), mode);
      slider.value = String(v);
      if (!lpm) sim.interventions.oxygenLpm = v;
    }
  };


  syncSlider(ui1.slider);
  syncSlider(ui2.slider);


  const statusText =
    mode === "nc"
      ? `Nasal cannula @ ${sim.interventions.oxygenLpm || clampOxygenLpmForMode(2, "nc")} L/min`
      : mode === "nrb"
      ? `NRB @ ${sim.interventions.oxygenLpm || clampOxygenLpmForMode(12, "nrb")} L/min`
      : "Room air";


  [statusAmb, statusTr].forEach((el) => {
    if (el) el.innerText = statusText;
  });


  let hint = "Choose NC or NRB in Breathing, then set flow.";
  if (mode === "room_air") {
    hint = "Select NC or NRB under Breathing, then set flow.";
  } else {
    hint = "Adjust flow with the Oxygen dial.";
  }


  [hintAmb, hintTr].forEach((el) => {
    if (el) el.innerText = hint;
  });


  const lpmShow =
    mode === "room_air"
      ? "—"
      : `${sim.interventions.oxygenLpm} L/min (${mode === "nc" ? "NC" : "NRB"})`;
  [labelAmb, labelTr].forEach((el) => {
    if (el) el.innerText = lpmShow;
  });


  [rowAmb, rowTr].forEach((el) => {
    if (el) el.classList.toggle("oxygenDialRow--disabled", mode === "room_air");
  });
}


/* Meds */
function giveAspirin() {
  if (sim.interventions.aspirinGiven) {
    showFeedback("Aspirin already given.");
    return;
  }

  // PO meds are not appropriate if the patient can't protect their airway.
  if (sim.patient.mentalStatus === "unresponsive") {
    showFeedback("Aspirin failed — patient is unresponsive.");
    pushEffectChip("Aspirin failed (unresponsive)", "bad");
    logActionOnce("asaFailUnresp", "Aspirin attempted while patient unresponsive (failed)");
    return;
  }

  // If altered, allow the click (teaching point), but score it slightly later.
  if (sim.patient.mentalStatus === "altered") {
    sim._asaGivenWhenAltered = true;
    showFeedback("Aspirin given — caution: patient altered.");
    logActionOnce("asaAltered", "Aspirin given with altered mental status (caution)");
  } else if (sim.patient.allergy === "Aspirin") {
    sim.recklessActions++;
    showFeedback("Allergic to aspirin!");
    logActionOnce("asaAllergy", "Aspirin given despite allergy");
  } else {
    showFeedback("Aspirin given.");
    logActionOnce("asa", "Aspirin given");
  }

  sim.interventions.aspirinGiven = true;
  updateAllDisplays();
}


function giveZofran() {
  if (!requireIvAccess()) return;


  if (sim.interventions.zofranGiven) {
    showFeedback("Zofran already given.");
    return;
  }


  sim.interventions.zofranGiven = true;
  if (sim.patient.nausea) {
    sim.patient.nausea = false;
    showFeedback("Zofran given — nausea improved.");
    logActionOnce("zofran", "Zofran given (nausea improved)");
  } else {
    sim.badActions++;
    showFeedback("Zofran given (no nausea reported).");
    logActionOnce("zofranNotInd", "Zofran given (not indicated)");
  }
  updateAllDisplays();
}


function giveNitro() {
  if (lastActionTime["nitro"] && Date.now() - lastActionTime["nitro"] < 3000) {
    showFeedback("Slow down.");
    return;
  }
  lastActionTime["nitro"] = Date.now();


  if (sim.interventions.nitroCount >= 3) {
    showFeedback("Max nitro reached.");
    return;
  }


  const sbp = sim.vitals.sbp;
  const pde5 = sim.patient.pde5;
  const rv = sim.patient.rvInvolvement;


  if (sim.caseType === "inferior" && sbp < 110 && sbp >= 100 && !rv) {
    sim.recklessActions++;
    logActionOnce("nitroInferiorBorderlineBP", "Nitro in inferior STEMI with borderline BP");
    showFeedback("Caution: inferior STEMI — nitro risky with borderline BP / RV concerns.");
  }


  if (pde5) {
    sim.recklessActions++;
    logActionOnce("nitroPDE5", "Nitro given despite PDE5 history");
    showFeedback("Contraindicated (PDE5) — nitro given anyway!");
    sim.vitals.sbp -= 22;
    sim.vitals.dbp -= 12;
  }


  if (sbp < 100) {
    sim.recklessActions++;
    logActionOnce("nitroLowBP", "Nitro given despite SBP < 100");
    showFeedback("Contraindicated (SBP < 100) — nitro given anyway!");
    sim.vitals.sbp -= 18;
    sim.vitals.dbp -= 10;
  }


  if (rv) {
    sim.recklessActions++;
    logActionOnce("nitroRV", "Nitro given with suspected RV involvement");
    showFeedback("High-risk (RV involvement) — BP crash!");
    sim.vitals.sbp -= 30;
    sim.vitals.dbp -= 18;
  }


  sim.interventions.nitroCount++;
  sim.patient.pain = clampPain(sim.patient.pain - 1);
  logAction(`Nitro given x${sim.interventions.nitroCount}`);


  if (sim.vitals.sbp < 75) {
    sim.patient.mentalStatus = "unresponsive";
    logActionOnce("nitroUnresp", "Patient became unresponsive after nitro");
    showFeedback("Patient became unresponsive.");
  } else {
    showFeedback("Nitroglycerin given.");
  }


  updateAllDisplays();
}


function giveMorphine() {
  if (!requireIvAccess()) return;


  if (sim.interventions.narcoticDoses >= 4) {
    showFeedback("Maximum opioid doses for this scenario.");
    return;
  }


  if (sim.patient.allergy === "Morphine") {
    sim.recklessActions++;
    showFeedback("Allergic to morphine!");
    logActionOnce("morphAllergy", "Morphine given despite allergy");
  } else {
    sim.patient.pain = clampPain(sim.patient.pain - 2);
    showFeedback("Morphine given.");
    logActionOnce("morph", "Morphine given");
  }


  sim.interventions.narcoticDoses++;
  logAction(`Morphine — narcotic dose ${sim.interventions.narcoticDoses}/4`);


  if (!sim.patient.nausea && Math.random() < 0.25) {
    sim.patient.nausea = true;
    logActionOnce("opioidNausea", "Developed nausea after pain medication");
  }
  updateAllDisplays();
}


function giveFentanyl() {
  if (!requireIvAccess()) return;


  if (sim.interventions.narcoticDoses >= 4) {
    showFeedback("Maximum opioid doses for this scenario.");
    return;
  }


  sim.patient.pain = clampPain(sim.patient.pain - 2);
  showFeedback("Fentanyl given.");
  logActionOnce("fent", "Fentanyl given");


  sim.interventions.narcoticDoses++;
  logAction(`Fentanyl — narcotic dose ${sim.interventions.narcoticDoses}/4`);


  if (!sim.patient.nausea && Math.random() < 0.25) {
    sim.patient.nausea = true;
    logActionOnce("opioidNausea", "Developed nausea after pain medication");
  }
  updateAllDisplays();
}


function giveAtropine() {
  if (!requireIvAccess()) return;


  if (sim.interventions.atropineCount >= 3) {
    showFeedback("Maximum atropine doses for this scenario.");
    return;
  }


  const hr = sim.vitals.hr;
  const sbp = sim.vitals.sbp;
  const indicated = hr < 55 && (sim.patient.symptomaticBrady || sim.patient.mentalStatus !== "alert" || sbp < 100);

  if (hr > 60) {
    showFeedback("Atropine not indicated.");
    markUnnecessary("atropine", "Atropine given with HR > 60 (not indicated).");
  } else {
    showFeedback("Atropine given.");
    logActionOnce("atrop", "Atropine given");
  }


  sim.interventions.atropineCount++;
  logAction(`Atropine x${sim.interventions.atropineCount}`);

  // Immediate effect (felt): slight HR bump, and a small perfusion bump if BP isn't crashing.
  if (indicated) {
    sim._brady.atropineGivenWhenIndicated = true;
    sim.vitals.hr = clamp(sim.vitals.hr + rand(6, 10), 30, 180);
    if (sim.vitals.sbp >= 90) {
      sim.vitals.sbp = clamp(sim.vitals.sbp + rand(2, 5), 55, 210);
      sim.vitals.dbp = clamp(sim.vitals.dbp + rand(1, 3), 35, 140);
    }
    sim._dlg = sim._dlg || { overrides: [] };
    sim._dlg.overrides = sim._dlg.overrides || [];
    sim._dlg.overrides.push({ msg: "Okay… I feel less dizzy…", until: Date.now() + 6500 });
    pushEffectChip("Atropine response", "good");
    soundGood();
  } else {
    pushEffectChip("Atropine given", "warn");
  }
  updateAllDisplays();
}


function givePushEpi() {
  if (!requireIvAccess()) return;
  if (sim.interventions.pushEpiCount >= 2) {
    showFeedback("Maximum push-dose epinephrine for this scenario.");
    return;
  }


  sim.interventions.pushEpiCount++;
  sim.vitals.sbp = clamp(sim.vitals.sbp + 14, 55, 210);
  sim.vitals.dbp = clamp(sim.vitals.dbp + 8, 35, 140);
  sim.vitals.hr = clamp(sim.vitals.hr + 6, 30, 180);


  logAction(`Push-dose epinephrine x${sim.interventions.pushEpiCount}`);
  showFeedback("Push-dose epinephrine — BP/HR response.");
  updateAllDisplays();
}


/* Pressors */
function getPressorUI(isTransport = false) {
  return {
    medSelect: document.getElementById(isTransport ? "pressorMed2" : "pressorMed"),
    rate: document.getElementById(isTransport ? "pressorRate2" : "pressorRate"),
    status: document.getElementById(isTransport ? "pressorStatus2" : "pressorStatus"),
  };
}
function startPressor(isTransport = false) {
  if (!ensureDripLine("pressors")) return;


  // Scoring: starting pressors with normal BP is unnecessary.
  const sbp = sim.vitals.sbp;
  if (sbp >= 110 && sim.patient.mentalStatus === "alert") {
    markUnnecessary(
      "pressorsStable",
      `Pressors started with stable BP (SBP ${Math.round(sbp)}) and normal mentation.`,
      "bad"
    );
  }


  const ui = getPressorUI(isTransport);
  const med = ui.medSelect ? ui.medSelect.value : "norepi";


  sim.interventions.pressorActive = true;
  sim.interventions.pressorMed = med;


  if (sim.interventions.pressorRate === 0) sim.interventions.pressorRate = 6;


  showFeedback(`Pressor started: ${med.toUpperCase()}`);
  logActionOnce(`pressorStart-${med}`, `Pressor started: ${med}`);


  updatePressorDisplays();
}
function stopPressor() {
  sim.interventions.pressorActive = false;
  sim.interventions.pressorRate = 0;


  showFeedback("Pressors stopped.");
  logActionOnce("pressorStop", "Pressors stopped");
  updatePressorDisplays();
}
function setPressorRateFromUI(isTransport = false) {
  const ui = getPressorUI(isTransport);
  if (!ui.rate) return;


  const now = Date.now();
  if (lastActionTime["pressor"] && now - lastActionTime["pressor"] < 250) return;
  lastActionTime["pressor"] = now;


  sim.interventions.pressorRate = Number(ui.rate.value);
  sim.interventions.pressorActive = sim.interventions.pressorRate > 0;


  updatePressorDisplays();
}
function nudgePressor(delta) {
  const next = clamp(sim.interventions.pressorRate + delta, 0, 20);
  sim.interventions.pressorRate = next;
  sim.interventions.pressorActive = next > 0;
  updatePressorDisplays();
}
function updatePressorDisplays() {
  const ui1 = getPressorUI(false);
  const ui2 = getPressorUI(true);


  const text =
    sim.interventions.pressorActive && sim.interventions.pressorRate > 0
      ? `${sim.interventions.pressorMed.toUpperCase()} running — Rate: ${sim.interventions.pressorRate}/20`
      : "Off";


  [ui1, ui2].forEach((ui) => {
    if (ui.rate) ui.rate.value = String(sim.interventions.pressorRate);
    if (ui.status) ui.status.innerText = text;
  });
}


/* Transport flow */
function openTransportDecision() {
  showScreen("transportDecisionScreen");
  showFeedback("Choose transport priority.");
}
function chooseTransport(mode) {
  sim.transportMode = mode;
  showFeedback(mode === "emergent" ? "Emergent transport selected." : "Non-emergent transport selected.");
  logActionOnce(`transport-${mode}`, `Transport mode: ${mode}`);
  setTimeout(() => showScreen("destinationScreen"), 600);
}
function chooseDestination(dest) {
  sim.destination = dest;
  showFeedback(dest === "cath" ? "Transporting to hospital with cath lab capabilities." : "Transporting to local hospital.");
  logActionOnce(`dest-${dest}`, `Destination: ${dest}`);


  sim.transportSecondsRemaining = dest === "cath" ? 90 : 60;


  sim.phase = "transport";
  startTransportTimer();
  showScreen("transportScreen");
  // Start with no tab open so the scene is visible.
  showTab("__none__");


  updateAllDisplays();
  startRhythmRenderer();
}
function updateTransportTimerUI() {
  const text = `Time Remaining: ${sim.transportSecondsRemaining}s`;
  const urgent = sim.transportSecondsRemaining > 0 && sim.transportSecondsRemaining <= 15;
  ["transportTimer", "transportTimerMobile"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerText = text;
    el.classList.toggle("hudTimer--urgent", urgent);
  });
}


function startTransportTimer() {
  if (sim.transportInterval) clearInterval(sim.transportInterval);


  updateTransportTimerUI();
  sim.transportInterval = setInterval(() => {
    sim.transportSecondsRemaining--;
    updateTransportTimerUI();
    if (sim.transportSecondsRemaining <= 0) {
      clearInterval(sim.transportInterval);
      endScenario();
    }
  }, 1000);
}


function stopScenarioEngines() {
  if (sim.vitalsInterval) {
    clearInterval(sim.vitalsInterval);
    sim.vitalsInterval = null;
  }
  if (sim.transportInterval) {
    clearInterval(sim.transportInterval);
    sim.transportInterval = null;
  }
  clearBpCycleEngine();
  sim.bpCycleOn = false;
  updateBpCycleLabel();


  if (typeof rhythmEngine !== "undefined") {
    rhythmEngine.running = false;
    if (rhythmEngine.rafId) {
      cancelAnimationFrame(rhythmEngine.rafId);
      rhythmEngine.rafId = null;
    }
  }


  sim.alarms.active = false;
  sim.alarms.reasons = [];
  sim.alarms.lastBeepAt = 0;
  setAlarmBanner([]);
}


/** Min seconds alert in sim before “expected” aspirin (PO) — skips penalty if altered/unresponsive most of the run or only wakes at the end. */
const ASPIRIN_EXPECT_ALERT_SEC = 45;


function buildBadActionHintsForDebrief() {
  const seen = new Set();
  const parts = [];
  const push = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    parts.push(s);
  };


  for (const a of sim.actionsLog || []) {
    const t = a.text || "";
    if (t.includes("Incorrect primary priority")) push("Primary survey: incorrect priority once.");
    if (t.includes("Incorrect ECG interpretation")) push("12-lead: incorrect pattern once.");
  }


  if ((sim.actionsLog || []).some((a) => String(a.text || "").includes("Zofran") && String(a.text || "").includes("not indicated"))) {
    push("Zofran given without nausea.");
  }


  if ((sim.actionsLog || []).some((a) => String(a.text || "").includes("No IV access"))) push("IV/fluid action without access.");
  if ((sim.actionsLog || []).some((a) => String(a.text || "").includes("Need a second IV"))) push("Second drip without second IV line.");


  if (sim.unnecessaryLog && sim.unnecessaryLog.length) {
    sim.unnecessaryLog.slice(0, 8).forEach((m) => push(m));
  }


  return parts.join(" ");
}


/**
 * Single source of truth for scoring + debrief breakdown.
 * Each deduction includes a short teaching line for the results screen.
 */
function computeScenarioScore() {
  const items = [];
  const strengths = [];
  let score = 100;


  const addDeduction = (delta, title, teaching) => {
    score += delta;
    items.push({ delta, title, teaching: teaching || "" });
  };


  if (
    !sim.interventions.aspirinGiven &&
    sim.patient.allergy !== "Aspirin" &&
    (sim.alertContactSeconds || 0) >= ASPIRIN_EXPECT_ALERT_SEC
  ) {
    addDeduction(
      -30,
      "Aspirin not given (expected when patient had adequate alert time and no aspirin allergy)",
      "Early antiplatelet therapy is a core ACS intervention when PO medications are safe and not contraindicated."
    );
  }

  // Small penalty: aspirin given while AMS (PO medication safety).
  // This doesn't create a "lose-lose" because the main "missed aspirin" penalty only applies
  // after sufficient ALERT time (alertContactSeconds).
  if (sim.interventions.aspirinGiven && sim._asaGivenWhenAltered) {
    addDeduction(
      -4,
      "Aspirin given with altered mental status (PO safety concern)",
      "If mental status is altered, consider airway protection and whether PO meds are safe; reassess and follow protocol."
    );
  }


  if (sim.interventions.nitroCount === 0 && sim.caseType !== "inferior") {
    if (sim.vitals.sbp >= 100) {
      addDeduction(
        -12,
        "No nitroglycerin (non-inferior pattern; end SBP ≥ 100)",
        "When blood pressure allows and there are no contraindications, nitroglycerin is commonly used for ACS-related chest pain in teaching scenarios."
      );
    } else {
      strengths.push("Nitroglycerin withheld with end SBP < 100 — appropriate low-BP caution (no deduction for missing nitro).");
    }
  }


  if (sim.caseType === "inferior" && sim.interventions.nitroCount > 0 && sim.vitals.sbp < 110) {
    addDeduction(
      -12,
      "Nitroglycerin with borderline/low BP (inferior pattern; RV concern)",
      "Inferior STEMI may involve RV preload dependence — reassess perfusion before repeat nitro."
    );
  }


  if (sim.vitals.spo2 < 90 && sim.interventions.oxygenMode === "room_air") {
    addDeduction(
      -15,
      "Hypoxia (SpO₂ < 90%) on room air at scenario end",
      "Treat meaningful hypoxia with oxygen and reassess work of breathing."
    );
  }


  if (sim.vitals.sbp < 90 && sim.interventions.fluidGiven < 250 && !sim.interventions.pressorActive) {
    addDeduction(
      -20,
      "Hypotension (SBP < 90) without adequate fluid bolus or pressor support",
      "When hypotension is symptomatic and protocol supports it, address perfusion with volume and/or vasopressors."
    );
  }

  // Symptomatic bradycardia: a small "atropine when appropriate" grading point.
  if (sim._brady.symptomaticSeconds >= 8 && !sim._brady.atropineGivenWhenIndicated) {
    addDeduction(
      -8,
      "Symptomatic bradycardia without atropine treatment",
      "When bradycardia is symptomatic and perfusion is threatened, consider atropine per protocol (and support BP with fluids/pressors as indicated)."
    );
  }


  if (sim.patient.chf && sim.patient.lungSounds === "rales") {
    addDeduction(
      -10,
      "Worsening pulmonary congestion / rales with CHF context",
      "Fluids and overload can worsen CHF — monitor breathing sounds and SpO₂."
    );
  }


  if (sim.patient.mentalStatus === "unresponsive") {
    addDeduction(
      -15,
      "Patient unresponsive at scenario end",
      "Unresponsive patients need airway, breathing, circulation, and reversal of reversible causes before PO meds."
    );
  }


  if (isStemiCase()) {
    if (sim.transportMode && sim.transportMode !== "emergent") {
      addDeduction(
        -18,
        "STEMI pattern: non-emergent transport selected",
        "ST-elevation ACS is time-sensitive; emergent transport is typically expected when clinically appropriate."
      );
    }
    if (sim.destination && sim.destination !== "cath") {
      addDeduction(
        -22,
        "STEMI pattern: destination not cath/PCI-capable",
        "Timely reperfusion favors routing to a cath-capable facility when available and indicated."
      );
    }
  }


  const badPts = sim.badActions * 5;
  if (badPts) {
    const hint = buildBadActionHintsForDebrief();
    addDeduction(
      -badPts,
      `Mistimed / not-indicated actions (${sim.badActions} × 5 points)`,
      hint || "Open Patient Notes to see the full action log and align choices with vitals and presentation."
    );
  }


  const reckPts = sim.recklessActions * 15;
  if (reckPts) {
    addDeduction(
      -reckPts,
      `High-risk or contraindicated actions (${sim.recklessActions} × 15 points)`,
      "Examples include nitro with PDE5 use, nitro with SBP < 100, nitro with suspected RV involvement, or meds despite allergy — per sim rules."
    );
  }


  score = clamp(score, 0, 100);
  return { score, items, strengths };
}


function calculateScore() {
  return computeScenarioScore().score;
}


function getGrade(score) {
  if (score >= 90) return "Perfect";
  if (score >= 75) return "Good";
  if (score >= 60) return "Okay";
  return "Poor";
}


function endScenario() {
  stopScenarioEngines();


  const { score, items, strengths } = computeScenarioScore();
  const grade = getGrade(score);


  const gradeClass =
    grade === "Perfect" ? "grade-perfect" :
    grade === "Good" ? "grade-good" :
    grade === "Okay" ? "grade-ok" :
    "grade-poor";


  const positives = [];
  strengths.forEach((s) => positives.push(s));


  if (sim.interventions.aspirinGiven || sim.patient.allergy === "Aspirin") {
    positives.push("Addressed aspirin appropriately (given when safe, or correctly avoided with allergy).");
  }


  if (sim.vitals.spo2 < 90 && sim.interventions.oxygenMode !== "room_air") {
    positives.push("Treated hypoxia with supplemental oxygen.");
  }


  if (sim.recklessActions === 0) {
    positives.push("No reckless / contraindicated interventions counted by the sim.");
  }


  if (isStemiCase()) {
    const stemiOptimal = sim.transportMode === "emergent" && sim.destination === "cath";
    if (stemiOptimal) {
      positives.push("STEMI pathway: emergent transport toward PCI/cath-capable care.");
    }
  } else if (sim.caseType === "nstemi") {
    positives.push(
      "NSTEMI: transport and destination choices can vary with risk — follow your regional protocols."
    );
  }


  const breakdownHtml = items.length
    ? items
        .map((it) => {
          const sub = it.teaching ? `<div class="scoreTeaching">${it.teaching}</div>` : "";
          return `<div class="scoreBreakdownItem"><span class="scoreDelta">${it.delta}</span><span class="scoreDeductionTitle">${it.title}</span>${sub}</div>`;
        })
        .join("")
    : `<p class="scoreNoDeductions">• No deductions — full credit on all scored items this run.</p>`;


  const positivesHtml = positives.length
    ? positives.map((x) => `• ${x}`).join("<br>")
    : "• —";


  const summary = document.getElementById("finalSummary");
  if (summary) {
    summary.innerHTML = `
      <div class="scoreHead">
        <div><strong>Scenario score:</strong> <span class="scoreNumber">${score}</span><span class="scoreOutOf"> / 100</span></div>
        <p class="scoreSub">Based on this patient’s presentation and your choices in this run (vitals and case type vary each time).</p>
        <div class="gradeBig ${gradeClass}">${grade}</div>
      </div>


      <div class="debriefBox scoreBreakdownBox">
        <strong>How your score was calculated</strong>
        <p class="scoreBreakdownLead">Starting from <strong>100</strong>. Each line below subtracts points only if it applied to this run:</p>
        ${breakdownHtml}
      </div>


      <div class="debriefBox">
        <strong>Strengths &amp; positives</strong><br>
        ${positivesHtml}
      </div>


      <p class="scoreNotesHint"><strong>Tip:</strong> Open <strong>Patient Notes</strong> for the full timed action log.</p>
    `;
  }
 
  const caseStore = document.getElementById("scenarioCaseType");
  if (caseStore) caseStore.value = sim.caseType || "";


  sim.lastScenarioScore = score;
  updateEndScreenLessonUI(score);


  showScreen("endScreen");
}


function updateEndScreenLessonUI(score) {
  const lessonBtn = document.getElementById("lessonReviewBtn");
  const gateMsg = document.getElementById("ceLessonGateMsg");
  if (!lessonBtn) return;


  const goodEnough = score >= 75;


  if (sim.runMode === "practice") {
    lessonBtn.style.display = "none";
    if (gateMsg) {
      gateMsg.style.display = "none";
      gateMsg.textContent = "";
    }
    return;
  }


  if (sim.runMode === "ce") {
    if (goodEnough) {
      lessonBtn.style.display = "inline-block";
      if (gateMsg) {
        gateMsg.style.display = "none";
        gateMsg.textContent = "";
      }
    } else {
      lessonBtn.style.display = "none";
      if (gateMsg) {
        gateMsg.style.display = "block";
        gateMsg.textContent =
          "CE track: earn a Good score (75+) or better to unlock Lesson & review. Use Restart to try again with the same ECG focus, or Choose mode to pick a different path.";
      }
    }
    return;
  }


  lessonBtn.style.display = "inline-block";
  if (gateMsg) {
    gateMsg.style.display = "none";
    gateMsg.textContent = "";
  }
}


/* Notes modal */
function openNotes() {
  const panel = document.getElementById("notesPanel");
  if (!panel) return;


  panel.style.display = "block";


  const content = document.getElementById("notesContent");
  if (content) {
    content.innerHTML = `
      ${getPatientNotesHTML()}<br><br>
      <strong>Actions:</strong><br>
      ${
        sim.actionsLog.length
          ? sim.actionsLog.map((a) => `• <span class="actionTs">${formatActionTime(a.tMs)}</span> ${a.text}`).join("<br>")
          : "• —"
      }
    `;
  }
}
function closeNotes() {
  const panel = document.getElementById("notesPanel");
  if (panel) panel.style.display = "none";
}


/* Monitor alarms + beep */
function computeAlarmReasons() {
  const f = getMonitorAlarmFlags();
  const reasons = [];
  if (f.lowBp) reasons.push("LOW BP");
  if (f.highBp) reasons.push("HIGH BP");
  if (f.lowSpo2) reasons.push("LOW SpO2");
  if (f.brady) reasons.push("BRADY");
  if (f.tachy) reasons.push("TACHY");
  if (sim.patient.mentalStatus === "altered") reasons.push("AMS");
  if (sim.patient.mentalStatus === "unresponsive") reasons.push("UNRESP");
  return reasons;
}
function setAlarmBanner(reasons) {
  const on = reasons.length > 0;
  const txt = on ? `ALARM: ${reasons.join(" / ")}` : "ALARM";


  const a = document.getElementById("alarmBannerAmbulance");
  const b = document.getElementById("alarmBannerTransport");


  [a, b].forEach((el) => {
    if (!el) return;
    el.innerText = txt;
    el.classList.toggle("on", on);
  });


  /* Phone: scene-level cue when monitor drawer is closed / volume off */
  const sa = document.getElementById("alarmSceneCueAmbulance");
  const sb = document.getElementById("alarmSceneCueTransport");
  const tip = on ? reasons.join(" · ") : "";
  [sa, sb].forEach((el) => {
    if (!el) return;
    el.classList.toggle("simAlarmSceneCue--on", on);
    el.title = on ? `Monitor alert — ${tip}` : "";
    el.setAttribute("aria-hidden", on ? "false" : "true");
    if (on) el.setAttribute("aria-label", `Monitor alert: ${tip}`);
    else el.removeAttribute("aria-label");
  });


  document.querySelectorAll(".simAlarmSceneCue__detail").forEach((el) => {
    el.textContent = on && tip ? tip : "";
  });
}
function playAlarmBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;


    if (!playAlarmBeep.ctx) playAlarmBeep.ctx = new AudioCtx();
    const ctx = playAlarmBeep.ctx;


    if (ctx.state === "suspended") ctx.resume?.();


    const o = ctx.createOscillator();
    const g = ctx.createGain();


    o.type = "square";
    o.frequency.value = 880;


    g.gain.value = 0.0001;


    o.connect(g);
    g.connect(ctx.destination);


    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);


    o.start(t0);
    o.stop(t0 + 0.13);
  } catch {}
}
function updateAlarms() {
  const reasons = computeAlarmReasons();
  sim.alarms.reasons = reasons;
  sim.alarms.active = reasons.length > 0;


  setAlarmBanner(reasons);


  if (!sim.alarms.active) return;


  const now = Date.now();
  if (now - sim.alarms.lastBeepAt >= 1200) {
    sim.alarms.lastBeepAt = now;
    playAlarmBeep();
  }
}


/* Rhythm strip renderer (no sweep line) */
const rhythmEngine = {
  started: false,
  running: false,
  rafId: null,
  lastTs: 0,
  t: 0,
  streams: new Map(),
};


function startRhythmRenderer() {
  rhythmEngine.started = true;
  rhythmEngine.running = true;
  if (rhythmEngine.rafId) cancelAnimationFrame(rhythmEngine.rafId);
  rhythmEngine.rafId = requestAnimationFrame(rhythmLoop);
}
function rhythmLoop(ts) {
  if (!rhythmEngine.running) {
    rhythmEngine.rafId = null;
    return;
  }
  if (!rhythmEngine.lastTs) rhythmEngine.lastTs = ts;
  const dt = (ts - rhythmEngine.lastTs) / 1000;
  rhythmEngine.lastTs = ts;
  rhythmEngine.t += Math.min(dt, 0.05);


  renderRhythmToCanvas("rhythmCanvasAmbulance");
  renderRhythmToCanvas("rhythmCanvasTransport");


  rhythmEngine.rafId = requestAnimationFrame(rhythmLoop);
}
function getStream(canvasId) {
  if (!rhythmEngine.streams.has(canvasId)) {
    rhythmEngine.streams.set(canvasId, { nextBeatT: rhythmEngine.t + 0.4, beats: [] });
  }
  return rhythmEngine.streams.get(canvasId);
}
function rrForCurrentRhythm(baseRR) {
  const mode = sim.patient.rhythmMode;


  if (mode === "afib") {
    const jitter = (Math.random() - 0.5) * 0.55;
    return clamp(baseRR + jitter, 0.35, 1.6);
  }
  if (mode === "sinus_arrhythmia") {
    const wave = Math.sin(rhythmEngine.t * 2.2) * 0.18;
    return clamp(baseRR + wave, 0.45, 1.5);
  }


  const smallJitter = (Math.random() - 0.5) * 0.06;
  return clamp(baseRR + smallJitter, 0.35, 1.7);
}
function scheduleBeats(stream, rightT, baseRR) {
  const mode = sim.patient.rhythmMode;


  while (stream.nextBeatT < rightT + 1.0) {
    let rr = rrForCurrentRhythm(baseRR);
    let type = "normal";


    const baselinePVC = mode === "pvc" ? 0.08 : 0.0;
    const baselinePAC = mode === "sinus_pac" ? 0.09 : 0.0;


    if (mode === "pvc" && Math.random() < baselinePVC) type = "pvc";
    if (mode === "sinus_pac" && Math.random() < baselinePAC) type = "pac";


    if (type === "pac") rr *= 0.70;
    if (type === "pvc") rr *= 0.62;


    stream.beats.push({ t: stream.nextBeatT, type });
    stream.nextBeatT += rr;


    if (stream.beats.length > 200) stream.beats.splice(0, stream.beats.length - 200);
  }
}
function findNearestBeat(stream, t) {
  for (let i = stream.beats.length - 1; i >= 0; i--) {
    const bt = stream.beats[i].t;
    if (bt <= t) return stream.beats[i];
  }
  return null;
}
function renderRhythmToCanvas(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;


  const ctx = canvas.getContext("2d");
  if (!ctx) return;


  const w = canvas.width;
  const h = canvas.height;


  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#020202";
  ctx.fillRect(0, 0, w, h);


  ctx.strokeStyle = "rgba(0,255,102,0.05)";
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 20) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 20) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }


  const stream = getStream(canvasId);


  const hr = clamp(sim.vitals.hr, 30, 180);
  const baseRR = 60 / hr;


  const windowSec = 4.2;
  const leftT = rhythmEngine.t - windowSec;
  const rightT = rhythmEngine.t;


  scheduleBeats(stream, rightT, baseRR);


  ctx.strokeStyle = "#00ff66";
  ctx.lineWidth = 2;
  ctx.beginPath();


  const mid = Math.round(h * 0.55);
  const amp = h * 0.33;


  for (let x = 0; x < w; x++) {
    const t = leftT + (x / w) * windowSec;


    let y = 0.0;
    y += (Math.sin(t * 22) * 0.02);
    y += ((Math.random() - 0.5) * 0.008);


    const beat = findNearestBeat(stream, t);
    if (beat) {
      const dtBeat = t - beat.t;
      const mode = sim.patient.rhythmMode;


      const isPVC = beat.type === "pvc";
      const isPAC = beat.type === "pac";


      if (mode !== "afib" && !isPVC) {
        const pAmp = isPAC ? 0.12 : 0.10;
        y += pAmp * Math.exp(-Math.pow((dtBeat + 0.09) / 0.02, 2));
      }


      const qrsWidth = isPVC ? 0.042 : 0.018;
      const qrsAmp = isPVC ? 1.35 : 1.0;


      y += (-0.25 * qrsAmp) * Math.exp(-Math.pow((dtBeat + 0.012) / (qrsWidth * 0.65), 2));
      y += (1.10 * qrsAmp) * Math.exp(-Math.pow((dtBeat) / qrsWidth, 2));
      y += (-0.40 * qrsAmp) * Math.exp(-Math.pow((dtBeat - 0.016) / (qrsWidth * 0.85), 2));


      const tAmp = isPVC ? 0.22 : 0.28;
      y += tAmp * Math.exp(-Math.pow((dtBeat - 0.10) / 0.05, 2));
    }


    const py = mid - y * amp;
    if (x === 0) ctx.moveTo(x, py);
    else ctx.lineTo(x, py);
  }


  ctx.stroke();


  ctx.fillStyle = "rgba(0,255,102,0.75)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  ctx.fillText(sim.patient.rhythmLabel, 10, 16);
}


/* ========= Lesson / quiz / demo certificate ========= */


const LESSON_CASE_LABELS = {
  inferior: "Inferior STEMI",
  anterior: "Anterior STEMI",
  lateral: "Lateral STEMI",
  nstemi: "NSTEMI (no STEMI pattern)",
};


let lessonFlow = {
  caseKey: "inferior",
  slides: [],
  slideIndex: 0,
  waitTimer: null,
  countdownTimer: null,
  remainingSec: 0,
};


function getLessonCaseKey() {
  const hid = document.getElementById("scenarioCaseType");
  const fromDom = hid && hid.value;
  if (fromDom && LESSON_CASE_LABELS[fromDom]) return fromDom;
  if (sim.caseType && LESSON_CASE_LABELS[sim.caseType]) return sim.caseType;
  return "inferior";
}


function clearLessonTimers() {
  if (lessonFlow.waitTimer) clearTimeout(lessonFlow.waitTimer);
  if (lessonFlow.countdownTimer) clearInterval(lessonFlow.countdownTimer);
  lessonFlow.waitTimer = null;
  lessonFlow.countdownTimer = null;
}


function buildLessonSlides(key) {
  const shared1 = {
    headline: "ACS basics (all cases)",
    bullets: [
      "Ischemia means heart muscle isn’t getting enough oxygen for the work it’s doing.",
      "Aspirin (when not contraindicated) helps platelets — early antiplatelet therapy is a core STEMI/NSTEMI concept.",
      "Oxygen targets real hypoxia; titrate to your protocol and SpO₂.",
    ],
    lockSeconds: 4,
  };
  const shared2 = {
    headline: "Before nitroglycerin",
    bullets: [
      "Nitro reduces preload and can drop blood pressure — risky if SBP is low or RV preload is needed.",
      "PDE5 inhibitors + nitro can cause dangerous hypotension (this sim models that risk).",
      "Treat hypotension with fluids/pressors per protocol — not more nitro.",
    ],
    lockSeconds: 5,
  };


  if (key === "inferior") {
    return [
      shared1,
      {
        headline: "Inferior STEMI — territory",
        bullets: [
          "ST elevation in II, III, aVF points to inferior wall ischemia (often RCA territory).",
          "You’re thinking blood supply to the inferior wall of the left ventricle.",
        ],
        lockSeconds: 4,
      },
      {
        headline: "Inferior + RV caution",
        bullets: [
          "Inferior MI can involve the RV — RV often needs preload; nitro can unload the RV and crash BP.",
          "Right-sided or additional leads may be used per protocol when RV involvement is suspected.",
        ],
        lockSeconds: 5,
      },
      shared2,
    ];
  }
  if (key === "anterior") {
    return [
      shared1,
      {
        headline: "Anterior STEMI — territory",
        bullets: [
          "ST elevation in V1–V4 suggests anterior wall injury (often LAD-related).",
          "Anterior infarcts can be large and hemodynamically significant — early cath-capable center when indicated.",
        ],
        lockSeconds: 4,
      },
      {
        headline: "Why actions still center on perfusion + safety",
        bullets: [
          "Pain control and hemodynamic support must match BP, rhythm, and breathing status.",
          "Fluids/pressors address hypotension; nitro is not automatic if BP or RV concerns exist.",
        ],
        lockSeconds: 4,
      },
      shared2,
    ];
  }
  if (key === "lateral") {
    return [
      shared1,
      {
        headline: "Lateral STEMI — territory",
        bullets: [
          "ST elevation in I, aVL, V5–V6 suggests lateral wall involvement (often LCx/Diag branches — varies).",
          "Lateral injury is still ACS — time-sensitive care and destination decisions matter.",
        ],
        lockSeconds: 4,
      },
      {
        headline: "Hemodynamics + nitro",
        bullets: [
          "Nitro helps angina by reducing preload/afterload when blood pressure supports it.",
          "If hypotensive, nitro can worsen perfusion — stabilize BP first per protocol.",
        ],
        lockSeconds: 4,
      },
      shared2,
    ];
  }
  return [
    shared1,
    {
      headline: "NSTEMI (no STEMI on this ECG)",
      bullets: [
        "No ST elevation here — you’re not labeling a STEMI pattern on this strip.",
        "Risk stratification, serial ECGs/troponins, and destination follow local protocol.",
      ],
      lockSeconds: 4,
    },
    {
      headline: "Treatment theme",
      bullets: [
        "Antiplatelet therapy and medical management are still central unless contraindicated.",
        "Ongoing ischemia, instability, or dynamic ECG changes may change destination/timing per protocol.",
      ],
      lockSeconds: 4,
    },
    shared2,
  ];
}


const LESSON_QUIZ = {
  inferior: [
    { q: "Which leads most specific to inferior STEMI in this sim?", opts: ["V1–V4", "II, III, aVF", "I, aVL, V5–V6"], a: 1 },
    { q: "Why can nitroglycerin be dangerous with suspected RV involvement?", opts: ["It always causes tachycardia", "It can reduce preload the RV may need", "It raises SpO₂"], a: 1 },
    { q: "Aspirin in ACS is primarily aimed at which effect?", opts: ["Sedation", "Platelet antiplatelet effect", "Bronchodilation"], a: 1 },
    { q: "Before nitro, which factor is a classic concern?", opts: ["Low blood pressure", "High SpO₂", "Clear lung sounds"], a: 0 },
    { q: "Inferior wall injury in this scenario is paired with which vascular territory most often in teaching?", opts: ["RCA (commonly)", "Only pulmonary artery", "Only aortic valve"], a: 0 },
  ],
  anterior: [
    { q: "Anterior STEMI pattern in this sim uses elevation in which leads?", opts: ["II, III, aVF", "V1–V4", "I, aVL only"], a: 1 },
    { q: "Which statement fits anterior STEMI teaching?", opts: ["It is always benign", "It may involve a large territory — timely care matters", "It never affects blood pressure"], a: 1 },
    { q: "Why give aspirin if not allergic?", opts: ["Antiplatelet therapy for ACS", "To treat nausea", "To increase BP"], a: 0 },
    { q: "Nitro is riskiest when:", opts: ["SBP is very low", "SpO₂ is 98% on room air", "Patient is alert"], a: 0 },
    { q: "PDE5 inhibitors + nitro are dangerous because:", opts: ["They add preload", "They can synergize vasodilation / hypotension", "They prevent pain"], a: 1 },
  ],
  lateral: [
    { q: "Lateral STEMI pattern in this sim includes ST elevation in:", opts: ["V1–V4 only", "I, aVL, V5–V6", "III and aVF only"], a: 1 },
    { q: "A core reason to titrate oxygen is:", opts: ["Treat real hypoxia / respiratory distress", "Always raise SpO₂ to 100% in every patient", "Replace nitro"], a: 0 },
    { q: "Nitroglycerin’s main hemodynamic concern in hypotension is:", opts: ["Further lowering BP", "Increasing clot formation", "Fixed heart block"], a: 0 },
    { q: "Aspirin helps ACS primarily via:", opts: ["Platelet pathway", "Increasing afterload", "Sedation"], a: 0 },
    { q: "Fluids in hypotension may help when:", opts: ["IV access exists and protocol supports volume", "SpO₂ is 99% and BP is high", "Patient refuses monitoring"], a: 0 },
  ],
  nstemi: [
    {
      q: "In this sim, a 12-lead result of ‘No STEMI’ means:",
      opts: [
        "The scenario strip does not show a STEMI ST‑elevation pattern",
        "Acute coronary syndrome (ACS) is ruled out by that finding alone",
        "No ED evaluation or serial testing is indicated",
      ],
      a: 0,
    },
    {
      q: "The 12‑lead shows no STEMI, but the presentation still worries you for ACS. What fits usual teaching?",
      opts: [
        "ACS isn’t ruled out — expect serial ECGs/troponins and next steps per protocol",
        "A non‑STEMI ECG means ACS is excluded without more testing",
        "You only need repeat evaluation if ST elevation develops later",
      ],
      a: 0,
    },
    { q: "Aspirin may still be considered when appropriate because:", opts: ["Antiplatelet therapy is common in ACS unless contraindicated", "It treats CHF rales directly", "It is only for STEMI"], a: 0 },
    { q: "Nitro still requires attention to:", opts: ["Blood pressure and contraindications", "Hair color", "Shoe size"], a: 0 },
    { q: "Destination/time decisions in NSTEMI should follow:", opts: ["Local protocol and patient stability", "Random choice", "Only distance"], a: 0 },
  ],
};


function openLessonFlow() {
  if (sim.runMode === "ce" && (sim.lastScenarioScore == null || sim.lastScenarioScore < 75)) {
    showFeedback("Earn a Good score (75+) in CE mode to unlock the lesson.");
    return;
  }
  clearLessonTimers();
  lessonFlow.caseKey = getLessonCaseKey();
  lessonFlow.slides = buildLessonSlides(lessonFlow.caseKey);
  lessonFlow.slideIndex = 0;


  const tag = document.getElementById("lessonCaseTag");
  if (tag) tag.textContent = LESSON_CASE_LABELS[lessonFlow.caseKey] || lessonFlow.caseKey;


  showScreen("lessonScreen");
  renderLessonSlide();
}


function renderLessonSlide() {
  const headline = document.getElementById("lessonHeadline");
  const prog = document.getElementById("lessonProgress");
  const ul = document.getElementById("lessonBullets");
  const note = document.getElementById("lessonTimerNote");
  const nextBtn = document.getElementById("lessonNextBtn");


  const slide = lessonFlow.slides[lessonFlow.slideIndex];
  if (!slide) return;


  if (headline) headline.textContent = slide.headline;
  if (prog) prog.textContent = `Screen ${lessonFlow.slideIndex + 1} of ${lessonFlow.slides.length}`;
  if (ul) {
    ul.innerHTML = "";
    slide.bullets.forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b;
      ul.appendChild(li);
    });
  }


  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.textContent = lessonFlow.slideIndex + 1 >= lessonFlow.slides.length ? "Start quiz" : "Next";
    nextBtn.onclick = onLessonNextClick;
  }


  const sec = Math.max(2, Math.min(12, slide.lockSeconds || 4));
  lessonFlow.remainingSec = sec;
  if (note) note.textContent = `Next unlocks in ${lessonFlow.remainingSec}s…`;


  clearLessonTimers();
  lessonFlow.countdownTimer = setInterval(() => {
    lessonFlow.remainingSec -= 1;
    if (note) {
      if (lessonFlow.remainingSec > 0) note.textContent = `Next unlocks in ${lessonFlow.remainingSec}s…`;
      else note.textContent = "You can continue.";
    }
    if (lessonFlow.remainingSec <= 0) {
      clearInterval(lessonFlow.countdownTimer);
      lessonFlow.countdownTimer = null;
      if (nextBtn) nextBtn.disabled = false;
    }
  }, 1000);
}


function onLessonNextClick() {
  if (lessonFlow.slideIndex + 1 >= lessonFlow.slides.length) {
    clearLessonTimers();
    openQuizScreen();
    return;
  }
  lessonFlow.slideIndex += 1;
  renderLessonSlide();
}


function openQuizScreen() {
  clearLessonTimers();
  lessonFlow.caseKey = getLessonCaseKey();
  const list = LESSON_QUIZ[lessonFlow.caseKey] || LESSON_QUIZ.inferior;
  const host = document.getElementById("quizQuestions");
  const fb = document.getElementById("quizFeedback");
  const retry = document.getElementById("quizRetryBtn");
  const toCert = document.getElementById("quizToCertBtn");
  if (fb) {
    fb.textContent = "";
    fb.className = "quizFeedback";
  }
  if (retry) retry.style.display = "none";
  if (toCert) toCert.style.display = "none";
  if (host) {
    host.innerHTML = "";
    list.forEach((item, i) => {
      const wrap = document.createElement("div");
      wrap.className = "quizQ";
      const p = document.createElement("p");
      p.textContent = `${i + 1}. ${item.q}`;
      const opts = document.createElement("div");
      opts.className = "quizOpts";
      item.opts.forEach((txt, j) => {
        const id = `q${i}_o${j}`;
        const label = document.createElement("label");
        const inp = document.createElement("input");
        inp.type = "radio";
        inp.name = `lessonq_${i}`;
        inp.value = String(j);
        inp.id = id;
        label.appendChild(inp);
        label.appendChild(document.createTextNode(" " + txt));
        opts.appendChild(label);
      });
      wrap.appendChild(p);
      wrap.appendChild(opts);
      host.appendChild(wrap);
    });
  }
  showScreen("quizScreen");
}


function submitLessonQuiz() {
  const list = LESSON_QUIZ[lessonFlow.caseKey] || LESSON_QUIZ.inferior;
  let correct = 0;
  list.forEach((item, i) => {
    const sel = document.querySelector(`input[name="lessonq_${i}"]:checked`);
    if (sel && Number(sel.value) === item.a) correct += 1;
  });
  const pass = correct >= 4;
  const fb = document.getElementById("quizFeedback");
  const retry = document.getElementById("quizRetryBtn");
  const toCert = document.getElementById("quizToCertBtn");
  if (fb) {
    fb.className = "quizFeedback " + (pass ? "pass" : "fail");
    fb.textContent = pass
      ? `Score: ${correct}/5 — passed. You can continue to the demo certificate.`
      : `Score: ${correct}/5 — need 4/5. Retake the quiz or go back to results.`;
  }
  if (retry) retry.style.display = "inline-block";
  if (toCert) toCert.style.display = pass ? "inline-block" : "none";
}


function retryLessonQuiz() {
  openQuizScreen();
}


function goToCertName() {
  const nameEl = document.getElementById("certLearnerName");
  if (nameEl) nameEl.value = "";
  showScreen("certNameScreen");
}


function backFromCertName() {
  showScreen("quizScreen");
}


function showCertificate() {
  const nameEl = document.getElementById("certLearnerName");
  const name = (nameEl && nameEl.value.trim()) || "";
  if (!name) {
    alert("Please enter your name for the demo certificate.");
    return;
  }
  const nm = document.getElementById("certNameDisplay");
  const cs = document.getElementById("certCaseDisplay");
  const dt = document.getElementById("certDateDisplay");
  if (nm) nm.textContent = name;
  if (cs) cs.textContent = "Case: " + (LESSON_CASE_LABELS[getLessonCaseKey()] || getLessonCaseKey());
  if (dt) dt.textContent = new Date().toLocaleString();
  showScreen("certScreen");
}


function closeLessonFlow() {
  clearLessonTimers();
  showScreen("endScreen");
  if (sim.lastScenarioScore != null) updateEndScreenLessonUI(sim.lastScenarioScore);
}


function closeLessonFlowFromQuiz() {
  clearLessonTimers();
  showScreen("endScreen");
  if (sim.lastScenarioScore != null) updateEndScreenLessonUI(sim.lastScenarioScore);
}


/** Base scene uses CSS background (not <img>); force resolved URLs for file:// / odd paths. */
function ensureSimSceneImageUrls() {
  try {
    const base = new URL(".", window.location.href).href;
    // Prefer hosted URLs so CodePen (and other hosted pages) can load the images.
    // For local runs, we still resolve relative URLs from the page.
    const hostedA = "https://i.imgur.com/FZbAyMr.png";
    const hostedB = "https://i.imgur.com/rSPrGRU.png";
    const hostedNRB = "https://i.imgur.com/m7jpxLv.png";
    const hostedIvLeft = "https://i.imgur.com/OxsO8md.png";
    const hostedIvRight = "https://i.imgur.com/ygDM2Md.png";
    const hostedFluidsLeft = "https://i.imgur.com/k2UMBRU.png";
    const hostedDripRight = "https://i.imgur.com/Y85BAx0.png";


    const urlA = hostedA || new URL("a.png", base).href;
    const urlB = hostedB || new URL("b.png", base).href;
    const urlNRB = hostedNRB || new URL("nrb.png", base).href;
    const urlIvLeft = hostedIvLeft || new URL("iv-left.png", base).href;
    const urlIvRight = hostedIvRight || new URL("iv-right.png", base).href;
    const urlFluidsLeft = hostedFluidsLeft || new URL("fluids-left.png", base).href;
    const urlDripRight = hostedDripRight || new URL("drip-right.png", base).href;
    document.querySelectorAll(".simStageFigure").forEach((el) => {
      el.style.backgroundImage = `url("${urlA}")`;
    });
    document.querySelectorAll("img.simStageNcOverlay").forEach((el) => {
      el.src = urlB;
    });
    document.querySelectorAll("img.simStageNrbOverlay").forEach((el) => {
      el.src = urlNRB;
    });
    document.querySelectorAll("img.simStageIvLeftOverlay").forEach((el) => {
      el.src = urlIvLeft;
    });
    document.querySelectorAll("img.simStageIvRightOverlay").forEach((el) => {
      el.src = urlIvRight;
    });
    document.querySelectorAll("img.simStageFluidsLeftOverlay").forEach((el) => {
      el.src = urlFluidsLeft;
    });
    document.querySelectorAll("img.simStageDripRightOverlay").forEach((el) => {
      el.src = urlDripRight;
    });
  } catch (_) {
    /* ignore */
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureSimSceneImageUrls);
} else {
  ensureSimSceneImageUrls();
}


function initActionTooltips() {
  const hints = {
    airway: "Check airway patency first.",
    lungs: "Assess lung sounds (rales vs clear).",
    mental: "Assess mentation (alert/altered/unresponsive).",
    nc: "Low-flow oxygen if hypoxic.",
    nrb: "High-flow oxygen for significant hypoxia.",
    aspirin: "If no allergy/contraindications.",
    nitro: "Avoid if hypotensive/PDE5/RV concern.",
    zofran: "For nausea/vomiting.",
    morphine: "Pain control; monitor BP/respirations.",
    fentanyl: "Pain control; monitor BP/respirations.",
    atropine: "For symptomatic bradycardia.",
    pushEpi: "Bolus vasopressor for sudden hypotension (scenario-limited).",
    iv: "Start IV access (max 2 lines).",
  };


  document.querySelectorAll("button[data-action]").forEach((btn) => {
    const key = btn.getAttribute("data-action");
    const hint = hints[key];
    if (hint && !btn.getAttribute("title")) btn.setAttribute("title", hint);
  });
}


// Simple press-and-hold hint for touch users.
let holdTimer = null;
let holdTipEl = null;
function showHoldTip(target, text) {
  if (!text) return;
  if (holdTipEl) holdTipEl.remove();
  holdTipEl = document.createElement("div");
  holdTipEl.style.position = "fixed";
  holdTipEl.style.zIndex = "2000";
  holdTipEl.style.maxWidth = "280px";
  holdTipEl.style.padding = "8px 10px";
  holdTipEl.style.borderRadius = "12px";
  holdTipEl.style.background = "rgba(10,14,20,0.85)";
  holdTipEl.style.border = "1px solid rgba(255,255,255,0.12)";
  holdTipEl.style.boxShadow = "0 12px 26px rgba(0,0,0,0.55)";
  holdTipEl.style.color = "rgba(232,238,247,0.92)";
  holdTipEl.style.fontSize = "13px";
  holdTipEl.style.pointerEvents = "none";
  holdTipEl.textContent = text;


  const r = target.getBoundingClientRect();
  holdTipEl.style.left = `${Math.max(10, Math.min(window.innerWidth - 290, r.left))}px`;
  holdTipEl.style.top = `${Math.max(10, r.top - 44)}px`;
  document.body.appendChild(holdTipEl);
  setTimeout(() => holdTipEl && holdTipEl.remove(), 2200);
}


document.addEventListener("touchstart", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest("button[data-action]") : null;
  if (!btn) return;
  const title = btn.getAttribute("title");
  holdTimer = setTimeout(() => showHoldTip(btn, title), 450);
}, { passive: true });
document.addEventListener("touchend", () => {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}, { passive: true });


if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initActionTooltips);
} else {
  initActionTooltips();
}
