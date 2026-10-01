import {
  auth, db, provider, signInWithPopup, signOut, onAuthStateChanged,
  doc, collection, getDoc, updateDoc, onSnapshot, writeBatch,
  query, where, arrayUnion, serverTimestamp
} from "./firebase-config.js";

const $ = s => document.querySelector(s);
const CLIENT = Math.random().toString(36).slice(2);          // identifies this tab, so we ignore our own echoes
const S = { user: null, projects: [], cur: null, unsubList: null, unsubDoc: null, beat: null, saveT: null };
const PALETTE = ["#e07a5f", "#3d85c6", "#8e6bbf", "#d19a2a", "#1f7a5c", "#c2556e"];

const SAMPLE = `\\documentclass{article}
\\usepackage{amsmath}
\\title{Thermal Drift in Cold-Start Sensors}
\\author{Group 7}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
We measure sensor drift over a 24-hour window and compare three calibration schemes.
\\end{abstract}

\\section{Introduction}
Cold-start sensors drift as they warm up. This report shows that a \\textbf{two-point} calibration removes most of the error, with residuals near $\\sigma = 0.02$.

\\section{Method}
We follow three steps:
\\begin{enumerate}
  \\item Record a baseline at room temperature.
  \\item Heat the unit and log readings every minute.
  \\item Fit the \\textit{drift curve} and subtract it.
\\end{enumerate}

\\subsection{Equipment}
\\begin{itemize}
  \\item Reference thermometer
  \\item Three sensor boards
\\end{itemize}

\\section{Results}
Edit this text and watch the preview update live.
\\end{document}
`;

/* ---------- helpers ---------- */
const initials = n => (n || "?").split(/[ .@]+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join("");
const colorOf = uid => PALETTE[[...uid].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const av = (n, c, sz = 32, online = true, photo = "") => `<div class="relative shrink-0" title="${esc(n || "")}">${photo
  ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" class="rounded-full border-2" style="width:${sz}px;height:${sz}px;border-color:var(--panel)">`
  : `<div class="rounded-full grid place-items-center text-white font-semibold border-2" style="width:${sz}px;height:${sz}px;background:${c};border-color:var(--panel);font-size:${sz * .38}px">${initials(n)}</div>`}${online ? '<span class="dot"></span>' : ""}</div>`;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.add("hidden"), 2600); }
function show(id) { ["landing", "dash", "editor"].forEach(x => { const e = $("#" + x); e.classList.toggle("hidden", x !== id); e.classList.remove("flex"); if (x === id && id === "editor") e.classList.add("flex"); }); }
const uni = e => /^[^@\s]+@[^@\s]+\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i.test(e || "");
const profile = () => ({ name: S.user.displayName || S.user.email, photo: S.user.photoURL || "" });

/* ---------- Auth ---------- */
$("#gbtn").onclick = async () => {
  const er = $("#authErr"); er.classList.add("hidden");
  try {
    await signInWithPopup(auth, provider);
    // University-only check (uni(email)) is no longer enforced: any Google account can sign in.
  } catch (e) {
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    er.textContent = e.code === "auth/unauthorized-domain"
      ? "This domain is not authorized. Add it under Firebase Console > Authentication > Settings > Authorized domains."
      : "Sign-in failed: " + (e.code || e.message);
    er.classList.remove("hidden");
  }
};
$("#out").onclick = () => signOut(auth);

onAuthStateChanged(auth, user => {
  if (user) {
    S.user = user; renderDash(); watchProjects(); show("dash");
  } else {
    S.user = null; S.cur = null; stopEditor();
    if (S.unsubList) { S.unsubList(); S.unsubList = null; }
    show("landing");
  }
});

/* ---------- Dashboard ---------- */
function renderDash() {
  $("#hello").textContent = "Welcome, " + (S.user.displayName || S.user.email).split(" ")[0];
  $("#dUser").textContent = S.user.email;
  $("#dAv").innerHTML = av(profile().name, colorOf(S.user.uid), 32, true, profile().photo);
  renderList();
}
function renderList() {
  const L = $("#plist");
  L.innerHTML = S.projects.length ? S.projects.map(p => `<button data-id="${p.id}" class="proj card rounded-xl w-full p-4 flex items-center justify-between text-left hover:border-[color:var(--accent)]"><span><span class="font-medium block">${esc(p.name)}</span><span class="text-xs" style="color:var(--mute)">${p.headUid === S.user.uid ? "You are the group head" : "Group head: " + esc(p.headName)} · ${p.members.length} member${p.members.length === 1 ? "" : "s"}</span></span><span class="mono text-sm">${p.code}</span></button>`).join("")
    : `<p style="color:var(--mute)">No projects yet. Create one or join with a code.</p>`;
  L.querySelectorAll(".proj").forEach(b => b.onclick = () => openProject(b.dataset.id));
}
function watchProjects() {
  if (S.unsubList) S.unsubList();
  S.unsubList = onSnapshot(query(collection(db, "projects"), where("members", "array-contains", S.user.uid)), snap => {
    S.projects = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 9e9) - (a.createdAt?.seconds || 9e9));
    renderList();
  }, e => toast("Could not load projects: " + e.code));
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const c = "OL-" + (1000 + Math.floor(Math.random() * 9000));
    if (!(await getDoc(doc(db, "codes", c))).exists()) return c;
  }
  throw new Error("Could not generate a unique code");
}
$("#create").onclick = async () => {
  const btn = $("#create"); btn.disabled = true;
  try {
    const name = $("#pname").value.trim() || "Untitled project";
    const code = await uniqueCode();
    const ref = doc(collection(db, "projects")), me = profile(), uid = S.user.uid;
    const batch = writeBatch(db);
    batch.set(ref, {
      name, code, headUid: uid, headName: me.name, members: [uid], memberProfiles: { [uid]: me }, presence: { [uid]: Date.now() },
      src: SAMPLE.replace("Thermal Drift in Cold-Start Sensors", name).replace("Group 7", me.name),
      updatedBy: CLIENT, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    batch.set(doc(db, "codes", code), { projectId: ref.id, headUid: uid });
    await batch.commit();
    toast("Created. Join code " + code);
    openProject(ref.id);
  } catch (e) { toast("Could not create project: " + (e.code || e.message)); }
  btn.disabled = false;
};
$("#join").onclick = async () => {
  const er = $("#codeErr"), v = $("#code").value.trim().toUpperCase(), btn = $("#join");
  btn.disabled = true; er.classList.add("hidden");
  try {
    const c = await getDoc(doc(db, "codes", v || "none"));
    if (!c.exists()) throw { code: "nocode" };
    const pid = c.data().projectId, uid = S.user.uid;
    await updateDoc(doc(db, "projects", pid), { members: arrayUnion(uid), [`memberProfiles.${uid}`]: profile() });
    toast("Joined project");
    openProject(pid);
  } catch (e) {
    er.textContent = e.code === "nocode" || e.code === "permission-denied"
      ? `No project matches ${v || "that code"}. Check the code with your group head.` : "Could not join: " + (e.code || e.message);
    er.classList.remove("hidden");
  }
  btn.disabled = false;
};
$("#code").addEventListener("keydown", e => { if (e.key === "Enter") $("#join").click(); });

/* ---------- Editor ---------- */
function openProject(id) {
  stopEditor();
  const ref = doc(db, "projects", id); let first = true;
  S.unsubDoc = onSnapshot(ref, snap => {
    if (!snap.exists()) { toast("Project no longer exists"); backToDash(); return; }
    const p = { id, ...snap.data() }; S.cur = p;
    $("#eName").textContent = p.name; $("#copy").textContent = p.code + " · copy";
    renderAvatars(p);
    const ta = $("#src");
    if (first) { ta.value = p.src; sync(false); show("editor"); tab("code"); first = false; }
    else if (!snap.metadata.hasPendingWrites && p.updatedBy !== CLIENT && !S.saveT && p.src !== ta.value) {
      const pos = ta.selectionStart; ta.value = p.src; ta.setSelectionRange(Math.min(pos, p.src.length), Math.min(pos, p.src.length)); sync(false);
    }
  }, e => { toast("Lost access to project: " + e.code); backToDash(); });
  const beat = () => updateDoc(ref, { [`presence.${S.user.uid}`]: Date.now() }).catch(() => {});
  beat(); S.beat = setInterval(beat, 20000);
}
function renderAvatars(p) {
  const online = uid => Date.now() - (p.presence?.[uid] || 0) < 45000 || uid === S.user.uid;
  const ids = [S.user.uid, ...p.members.filter(u => u !== S.user.uid)];
  $("#avs").innerHTML = ids.map(u => { const m = p.memberProfiles?.[u] || { name: "Member" }; return av(m.name, colorOf(u), 34, online(u), m.photo); }).join("")
    + `<span class="pl-3 self-center text-xs" style="color:var(--mute)">${ids.filter(online).length} online</span>`;
}
function stopEditor() {
  if (S.unsubDoc) { S.unsubDoc(); S.unsubDoc = null; }
  clearInterval(S.beat); clearTimeout(S.saveT); S.saveT = null;
}
function backToDash() { stopEditor(); S.cur = null; renderDash(); show("dash"); }
$("#back").onclick = backToDash;
$("#copy").onclick = () => { try { navigator.clipboard.writeText(S.cur.code); } catch (e) {} toast("Join code " + S.cur.code + " copied"); };

function hl(t) { return esc(t).replace(/(%.*$)|(\\(?:begin|end)\{[^}]*\})|(\\[a-zA-Z]+)|(\$[^$\n]*\$)/gm, (m, a, b, c) => a ? `<span class="c-com">${m}</span>` : b ? `<span class="c-env">${m}</span>` : c ? `<span class="c-cmd">${m}</span>` : `<span class="c-math">${m}</span>`); }
let BIB = {};
const SYM = { chi: "χ", eta: "η", sigma: "σ", alpha: "α", beta: "β", mu: "μ", geq: "≥", leq: "≤", ge: "≥", le: "≤", times: "×", pm: "±", approx: "≈", neq: "≠" };
const mathy = x => x.replace(/\\([a-zA-Z]+)/g, (m, k) => SYM[k] || m).replace(/\^\{?2\}?/g, "²").replace(/\^\{?3\}?/g, "³").replace(/_\{?([^}\s]*)\}?/g, "<sub>$1</sub>");
function inl(s) { return esc(s).replace(/\\textbf\{([^}]*)\}/g, "<b>$1</b>").replace(/\\(?:textit|emph)\{([^}]*)\}/g, "<i>$1</i>").replace(/\\cite\{([^}]*)\}/g, (m, k) => "[" + k.split(",").map(x => BIB[x.trim()] || "?").join(", ") + "]").replace(/\$([^$]*)\$/g, (m, x) => "<i>" + mathy(x) + "</i>").replace(/\\LaTeX/g, "LaTeX").replace(/\\\\/g, "<br>").replace(/\\%/g, "%").replace(/\\&amp;/g, "&amp;").replace(/--/g, "–").replace(/~/g, "&nbsp;"); }
function render(src) {
  BIB = {}; let bi = 0; for (const mm of src.matchAll(/\\bibitem\{([^}]+)\}/g)) BIB[mm[1]] = ++bi;
  const g = k => { const m = src.match(new RegExp("\\\\" + k + "\\{([^}]*)\\}")); return m ? m[1] : ""; };
  const bm = src.split("\\begin{document}"); if (bm.length < 2) return `<p style="color:#b33">Missing \\begin{document}</p>`;
  const body = bm[1].split("\\end{document}")[0];
  const title = g("title"), au = g("author"), dt = g("date") === "\\today" ? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : g("date");
  let out = "", para = [], list = null, sec = 0, sub = 0, tab = null, bib = false;
  const flush = () => { if (para.length) { out += `<p>${inl(para.join(" "))}</p>`; para = []; } };
  for (const raw of body.split("\n")) {
    const l = raw.replace(/(^|[^\\])%.*$/, "$1").trim(); let m;
    if (!l) { flush(); continue; }
    if (tab) {
      if (/^\\end\{tabular\}/.test(l)) { out += `<table class="tb">${tab.map((r, i) => `<tr>${r.map(c => i ? `<td>${inl(c.trim())}</td>` : `<th>${inl(c.trim())}</th>`).join("")}</tr>`).join("")}</table>`; tab = null; continue; }
      const row = l.replace(/\\(hline|toprule|midrule|bottomrule)/g, "").replace(/\\\\\s*$/, "").trim();
      if (row) tab.push(row.split("&"));
      continue;
    }
    if (/^\\begin\{tabular\}/.test(l)) { flush(); tab = []; continue; }
    if (/^\\begin\{thebibliography\}/.test(l)) { flush(); bib = true; out += `<h2>References</h2><ol class="bibl">`; continue; }
    if (/^\\end\{thebibliography\}/.test(l)) { out += `</ol>`; bib = false; continue; }
    if (bib && (m = l.match(/^\\bibitem\{[^}]*\}\s*(.*)/))) { out += `<li>${inl(m[1])}</li>`; continue; }
    if (/^\\(centering|label\{[^}]*\}|noindent|newpage|clearpage)\b/.test(l) || /^\\(begin|end)\{(center|table\*?)\}/.test(l)) continue;
    if (/^\\begin\{figure\*?\}/.test(l)) { flush(); out += `<div class="fig">`; continue; }
    if (/^\\end\{figure\*?\}/.test(l)) { out += `</div>`; continue; }
    if (/^\\includegraphics/.test(l)) { out += `<div class="figph">Figure (image not shown in preview)</div>`; continue; }
    if (m = l.match(/^\\caption\{(.*)\}/)) { flush(); out += `<div class="cap">${inl(m[1])}</div>`; continue; }
    if (l === "\\maketitle") { flush(); out += `<h1>${inl(title)}</h1><p class="au">${inl(au)}</p><p class="dt">${inl(dt)}</p>`; continue; }
    if (l === "\\begin{abstract}") { flush(); out += `<div class="abs"><b>Abstract</b>`; continue; }
    if (l === "\\end{abstract}") { flush(); out += `</div>`; continue; }
    if (m = l.match(/^\\begin\{(itemize|enumerate)\}/)) { flush(); list = m[1] === "itemize" ? "ul" : "ol"; out += `<${list}>`; continue; }
    if (/^\\end\{(itemize|enumerate)\}/.test(l)) { out += `</${list}>`; list = null; continue; }
    if (list && (m = l.match(/^\\item\s*(.*)/))) { out += `<li>${inl(m[1])}</li>`; continue; }
    if (m = l.match(/^\\section\*?\{(.*)\}/)) { flush(); sub = 0; out += `<h2>${++sec} &nbsp;${inl(m[1])}</h2>`; continue; }
    if (m = l.match(/^\\subsection\*?\{(.*)\}/)) { flush(); out += `<h3>${sec}.${++sub} &nbsp;${inl(m[1])}</h3>`; continue; }
    para.push(l);
  }
  flush(); return out;
}
/* sync(save): refresh highlight + preview; when save is true, push the text to Firestore (debounced) */
function sync(save = true) {
  const t = $("#src").value;
  $("#hl").innerHTML = hl(t) + "\n";
  const n = t.split("\n").length;
  $("#gut").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  $("#page").innerHTML = render(t);
  if (S.cur) S.cur.src = t;
  if (!save || !S.cur) return;
  $("#eSave").textContent = "Saving…";
  clearTimeout(S.saveT);
  const id = S.cur.id;
  S.saveT = setTimeout(async () => {
    try {
      await updateDoc(doc(db, "projects", id), { src: $("#src").value, updatedBy: CLIENT, updatedAt: serverTimestamp() });
      $("#eSave").textContent = "All changes saved";
    } catch (e) { $("#eSave").textContent = "Not saved: " + (e.code || "error"); }
    S.saveT = null;
  }, 500);
}
$("#src").addEventListener("input", () => sync(true));
$("#src").addEventListener("scroll", e => { $("#hl").scrollTop = e.target.scrollTop; $("#hl").scrollLeft = e.target.scrollLeft; $("#gut").scrollTop = e.target.scrollTop; });
$("#src").addEventListener("keydown", e => { if (e.key === "Tab") { e.preventDefault(); const t = e.target; t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end"); sync(true); } });
function tab(w) {
  const c = w === "code";
  $("#pCode").classList.toggle("hidden", !c); $("#pPrev").classList.toggle("hidden", c);
  $("#pPrev").classList.add("lg:block"); $("#pCode").classList.add("lg:block");
  $("#tCode").style.color = c ? "var(--accent)" : ""; $("#tPrev").style.color = c ? "" : "var(--accent)";
}
$("#tCode").onclick = () => tab("code"); $("#tPrev").onclick = () => tab("prev");

/* ---------- Downloads: .tex source and PDF ---------- */
const fileBase = () => ((S.cur?.name || "document").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "document");
$("#dlTex").onclick = () => {
  const blob = new Blob([$("#src").value], { type: "application/x-tex;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = fileBase() + ".tex";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Downloaded " + a.download);
};
$("#dlPdf").onclick = async () => {
  if (!window.html2pdf) { toast("PDF library not loaded. Opening print dialog instead."); window.print(); return; }
  const btn = $("#dlPdf"); btn.disabled = true;
  // Render an off-screen A4-width copy so it works even when the preview tab is hidden on mobile
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;background:#fff";
  const clone = $("#page").cloneNode(true);
  clone.style.cssText = "max-width:none;width:794px;min-height:0;box-shadow:none;margin:0;padding:40px 72px";
  host.appendChild(clone); document.body.appendChild(host);
  try {
    await window.html2pdf().set({
      margin: [12, 0, 12, 0], filename: fileBase() + ".pdf",
      image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "legacy"] }
    }).from(clone).save();
    toast("Downloaded " + fileBase() + ".pdf");
  } catch (e) { toast("PDF failed: " + (e.message || e)); }
  host.remove(); btn.disabled = false;
};
