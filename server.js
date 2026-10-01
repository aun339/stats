// Texhub compile server: POST /compile  { files:[{name,kind:"text"|"binary",content}], main:"main.tex" }
const express = require("express"), cors = require("cors");
const fs = require("fs/promises"), os = require("os"), path = require("path");
const { execFile } = require("child_process");

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));   // set ALLOWED_ORIGIN to your Vercel URL in production
app.use(express.json({ limit: "40mb" }));
app.get("/", (_, res) => res.send("Texhub compile server is running"));

// Keep every file inside the temp directory (blocks ../ and absolute paths)
function safePath(root, name) {
  const full = path.join(root, path.normalize(String(name)));
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid file name: " + name);
  return full;
}
const run = (cmd, args, cwd) => new Promise(resolve =>
  execFile(cmd, args, { cwd, timeout: 60000, maxBuffer: 20e6 }, (err, stdout) => resolve({ err, stdout: stdout || "" })));

function parseLog(log) {
  const errors = [], warnings = [], seen = new Set();
  const add = (list, o) => { const k = o.file + o.line + o.message; if (!seen.has(k)) { seen.add(k); list.push(o); } };
  for (const line of log.split("\n")) {
    let m;
    if ((m = line.match(/^(.+?\.(?:tex|sty|cls)):(\d+): (.*)$/))) add(errors, { file: m[1], line: +m[2], message: m[3] });
    else if ((m = line.match(/^! (.*)$/))) add(errors, { file: "", line: 0, message: m[1] });
    else if ((m = line.match(/^(?:LaTeX|Package \S+|Class \S+) Warning: (.*)$/))) {
      const ln = line.match(/on input line (\d+)/);
      add(warnings, { file: "main.tex", line: ln ? +ln[1] : 0, message: m[1] });
    }
  }
  return { errors, warnings };
}

let active = 0;
app.post("/compile", async (req, res) => {
  const { files, main = "main.tex" } = req.body || {};
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ ok: false, errors: [{ message: "No files received" }], warnings: [] });
  if (active >= 2) return res.status(429).json({ ok: false, errors: [{ message: "Server busy, try again in a moment" }], warnings: [] });
  active++;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "texhub-"));
  try {
    for (const f of files) {
      const full = safePath(dir, f.name);
      await fs.mkdir(path.dirname(full), { recursive: true });
      if (f.kind === "binary") await fs.writeFile(full, Buffer.from(f.content, "base64"));
      else await fs.writeFile(full, String(f.content), "utf8");
    }
    const base = path.basename(main, ".tex");
    const args = ["-interaction=nonstopmode", "-file-line-error", "-no-shell-escape", main];
    let r = await run("pdflatex", args, dir);
    let log = await fs.readFile(path.join(dir, base + ".log"), "utf8").catch(() => r.stdout);
    if (/Rerun to get|undefined references|Label\(s\) may have changed/i.test(log)) {   // second pass for refs/TOC
      r = await run("pdflatex", args, dir);
      log = await fs.readFile(path.join(dir, base + ".log"), "utf8").catch(() => r.stdout);
    }
    const pdf = await fs.readFile(path.join(dir, base + ".pdf")).catch(() => null);
    const { errors, warnings } = parseLog(log);
    const pages = (log.match(/Output written on .*\((\d+) pages?/) || [])[1];
    res.json({ ok: !!pdf && !errors.length, pdf: pdf ? pdf.toString("base64") : null, pages: pages ? +pages : 1, errors, warnings, log: log.slice(-30000) });
  } catch (e) {
    res.status(500).json({ ok: false, errors: [{ message: e.message }], warnings: [] });
  } finally {
    active--;
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(process.env.PORT || 3001, () => console.log("Texhub compile server on :" + (process.env.PORT || 3001)));
