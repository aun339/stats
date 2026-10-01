# Texhub compile server: Node 20 + TeX Live (pdfLaTeX, XeLaTeX, LuaLaTeX, latexmk, biber).
# Works on Render, Railway, Fly.io, or anywhere that runs Docker.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# "extra" collections cover templates like AltaCV (fontawesome5, paracol, tcolorbox, lato, roboto...).
# If a template still reports "File 'xyz.sty' not found", add the matching texlive-* package here,
# or replace this whole list with: texlive-full (about 5 GB, but nothing is ever missing).
RUN apt-get update && apt-get install -y --no-install-recommends \
      latexmk biber perl ghostscript fontconfig ca-certificates \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended texlive-fonts-extra \
      texlive-xetex texlive-luatex texlive-plain-generic \
      texlive-science texlive-pictures texlive-publishers texlive-bibtex-extra \
      texlive-lang-european texlive-lang-english texlive-lang-other \
      fonts-lmodern fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./

ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
