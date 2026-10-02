// Texhub compile server: receives a project's files, runs a real LaTeX engine, returns the PDF (or the log).
//
//   POST /compile   { mainFile, engine, files:[{path, content, encoding:"utf8"|"base64"}] }
//   GET  /health    engine availability + queue state
//
// Response (always JSON):
//   200 { ok:true,  pdf:"<base64>", log, errors:[], warnings:[], durationMs, engine }
//   422 { ok:false, pdf:"<base64>"|null, log, errors:[...], warnings:[...], timedOut, exitCode }   <- compile failed, log included
//   400/401/413/503 { ok:false, error:"..." }                                                       <- bad request / auth / too big / busy
import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS || 90_000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 2);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20);
const MAX_FILES = 400;
const MAX_BODY = process.env.MAX_BODY || "60mb";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || ""; // set it to require a valid Firebase login token

const ENGINES = {
  pdflatex: { bin: "latexmk", args: ["-pdf"] },
  xelatex:  { bin: "latexmk", args: ["-xelatex"] },
  lualatex: { bin: "latexmk", args: ["-lualatex"] },
  tectonic: { bin: "tectonic", args: ["--keep-logs", "--keep-intermediates"] }
};
const LATEXMK_COMMON = ["-f", "-interaction=nonstopmode", "-file-line-error", "-no-shell-escape"];

const app = express();
app.disable("x-powered-by");
app.use(cors({
  origin: ORIGINS.includes("*") ? true : ORIGINS,
  methods: ["POST", "GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));
app.use(express.json({ limit: MAX_BODY }));

/* ---------- optional auth: verify a Firebase ID token (no service account needed) ---------- */
let jwks = null, jose = null;
async function requireAuth(req, res, next) {
  if (!FIREBASE_PROJECT_ID) return next();
  try {
    jose ||= await import("jose");
    jwks ||= jose.createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("missing token");
    const { payload } = await jose.jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`, audience: FIREBASE_PROJECT_ID
    });
    req.uid = payload.sub; next();
  } catch (e) { res.status(401).json({ ok: false, error: "Sign in again: " + (e.code || e.message) }); }
}

/* ---------- tiny semaphore so a few big documents cannot starve the machine ---------- */
let running = 0; const waiting = [];
const acquire = () => new Promise((ok, no) => {
  if (running < MAX_CONCURRENT) { running++; return ok(); }
  if (waiting.length >= MAX_QUEUE) return no(new Error("busy"));
  waiting.push(ok);
});
const release = () => { const n = waiting.shift(); if (n) n(); else running--; };

/* ---------- helpers ---------- */
// Turn a user supplied path into a safe relative path (no absolute, no "..", no control chars), or null.
function safeRel(p) {
  if (typeof p !== "string") return null;
  const n = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!n || n === "." || n.startsWith("/") || n.startsWith("../") || n === ".." || /[\u0000-\u001f]/.test(n)) return null;
  return n;
}
function run(bin, args, cwd, env) {
  return new Promise(resolve => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false;
    const cap = d => { if (out.length < 2_000_000) out += d; };
    child.stdout.on("data", cap); child.stderr.on("data", cap);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, TIMEOUT_MS);
    child.on("error", e => { clearTimeout(timer); resolve({ code: 127, out: out + `\nCould not start ${bin}: ${e.message}\n`, timedOut }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}
// Pull errors/warnings out of a TeX log so the UI can list them and jump to file:line.
function parseLog(log) {
  const errors = [], warnings = [], lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    if ((m = l.match(/^(?:\.\/)?([^\s:][^:]*\.(?:tex|cls|sty|bib|def|cfg)):(\d+): (.*)$/i))) {
      errors.push({ file: m[1], line: +m[2], message: m[3].trim(), context: (lines[i + 1] || "").slice(0, 200) });
    } else if (l.startsWith("! ") && !/^! (?:Emergency stop|==> Fatal error)/.test(l)) {
      let line = null;
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) { const x = lines[j].match(/^l\.(\d+)/); if (x) { line = +x[1]; break; } }
      errors.push({ file: null, line, message: l.slice(2).trim(), context: "" });
    } else if (/(LaTeX|Package [\w-]+|Class [\w-]+) Warning:/.test(l)) {
      let msg = l.trim(); while (lines[i + 1] && /^\(\w+\)\s/.test(lines[i + 1])) msg += " " + lines[++i].replace(/^\(\w+\)\s+/, "");
      const ln = msg.match(/on input line (\d+)/);
      warnings.push({ file: null, line: ln ? +ln[1] : null, message: msg });
    } else if (/^(Over|Under)full \\[hv]box/.test(l)) {
      const ln = l.match(/lines? (\d+)/);
      warnings.push({ file: null, line: ln ? +ln[1] : null, message: l.trim(), kind: "typesetting" });
    }
    if (errors.length > 200 || warnings.length > 200) break;
  }
  // an error already reported with file:line also appears as "! ..."; drop the pairs with no location when duplicated
  const seen = new Set(errors.filter(e => e.file).map(e => e.message)), uniq = new Set();
  const keep = (list, f) => list.filter(x => { const k = `${x.file}|${x.line}|${x.message}`; return f(x) && !uniq.has(k) && uniq.add(k); });
  return { errors: keep(errors, e => e.file || !seen.has(e.message)), warnings: keep(warnings, () => true) };
}

/* ---------- routes ---------- */
app.get("/", (_req, res) => res.type("text").send("Texhub compile server. POST /compile, GET /health\n"));
app.get("/health", async (_req, res) => {
  const probe = async bin => (await run(bin, ["--version"], tmpdir(), process.env)).code === 0;
  const engines = {};
  for (const [name, e] of Object.entries(ENGINES)) engines[name] = await probe(e.bin).catch(() => false);
  res.json({ ok: true, running, queued: waiting.length, authRequired: !!FIREBASE_PROJECT_ID, engines });
});

app.post("/compile", requireAuth, async (req, res) => {
  const t0 = Date.now();
  const { mainFile = "main.tex", engine = "pdflatex", files, clean } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ ok: false, error: "No files were sent." });
  if (files.length > MAX_FILES) return res.status(413).json({ ok: false, error: `Too many files (max ${MAX_FILES}).` });
  const eng = ENGINES[engine]; if (!eng) return res.status(400).json({ ok: false, error: `Unknown engine "${engine}".` });
  const main = safeRel(mainFile);
  if (!main || !/\.tex$/i.test(main)) return res.status(400).json({ ok: false, error: "The main document must be a .tex file." });

  try { await acquire(); } catch { return res.status(503).json({ ok: false, error: "The compiler is busy. Try again in a few seconds." }); }
  let dir;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "texhub-"));
    const root = path.join(dir, "proj"); await mkdir(root, { recursive: true });
    let hasMain = false;
    for (const f of files) {
      const rel = safeRel(f?.path); if (!rel) return res.status(400).json({ ok: false, error: `Illegal file path: ${JSON.stringify(f?.path)}` });
      const abs = path.join(root, rel);
      if (!abs.startsWith(root + path.sep)) return res.status(400).json({ ok: false, error: `Illegal file path: ${rel}` });
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, f.encoding === "base64" ? Buffer.from(String(f.content || ""), "base64") : String(f.content ?? ""), f.encoding === "base64" ? undefined : "utf8");
      if (rel === main) hasMain = true;
    }
    if (!hasMain) return res.status(400).json({ ok: false, error: `Main document "${main}" is not in the project.` });

    const base = main.replace(/\.tex$/i, ""); // keeps sub-folder, e.g. "chapters/a"
    const args = eng.bin === "latexmk" ? [...eng.args, ...LATEXMK_COMMON, main] : [...eng.args, main];
    const env = {
      PATH: process.env.PATH, HOME: dir, TEXMFVAR: path.join(dir, ".texvar"), TEXMFCONFIG: path.join(dir, ".texcfg"),
      TEXMFHOME: path.join(dir, ".texhome"), XDG_CACHE_HOME: path.join(dir, ".cache"), LANG: "C.UTF-8",
      openout_any: "p", openin_any: "a"
    };
    const r = await run(eng.bin, args, root, env);

    let log = ""; try { log = await readFile(path.join(root, base + ".log"), "utf8"); } catch {}
    if (!log) log = r.out; else if (r.code !== 0 && r.out) log += "\n\n----- " + eng.bin + " output -----\n" + r.out.slice(-20000);
    if (r.timedOut) log += `\n\n! Compilation stopped: it took longer than ${Math.round(TIMEOUT_MS / 1000)} s.`;
    if (log.length > 600_000) log = log.slice(0, 200_000) + "\n\n... log truncated ...\n\n" + log.slice(-350_000);
    let pdf = null; try { pdf = (await readFile(path.join(root, base + ".pdf"))).toString("base64"); } catch {}

    const { errors, warnings } = parseLog(log);
    const ok = r.code === 0 && !r.timedOut && !!pdf;
    if (!ok && !errors.length) errors.push({ file: null, line: null, message: r.timedOut ? "Compilation timed out." : pdf ? "The compiler exited with an error." : "No PDF was produced. See the raw log." });
    res.status(ok ? 200 : 422).json({ ok, engine, pdf, log, errors, warnings, exitCode: r.code, timedOut: r.timedOut, durationMs: Date.now() - t0 });
  } catch (e) {
    console.error(e); if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error: " + e.message });
  } finally {
    release(); if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((err, _req, res, _next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ ok: false, error: `Project is larger than ${MAX_BODY}.` });
  res.status(400).json({ ok: false, error: err?.message || "Bad request" });
});

app.listen(PORT, () => console.log(`Texhub compiler on :${PORT} (origins: ${ORIGINS.join(", ")}, auth: ${FIREBASE_PROJECT_ID ? "Firebase " + FIREBASE_PROJECT_ID : "off"})`));
