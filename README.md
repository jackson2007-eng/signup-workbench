# Signup Workbench

A scheduler's workbench for designing paratransit and microtransit signups: sketch or import demand, auto-build weekly shift packages against your rules, tweak them visually, and score every change against the demand pattern.

This copy ships with **synthetic sample data only** — a fictional 40-run board and template demand curves. Your real data never lives in this code: keep it in a project file (Save project / Load project inside the app) that stays on your own computer.

## Run it locally (5 minutes)

1. Install Node.js (LTS) from https://nodejs.org if you don't have it.
2. In this folder:

   ```
   npm install
   npm run dev
   ```

3. Open the printed local URL (usually http://localhost:5173). Use **Load project** to open your real signup project file.

## Deploy free — Option A: Cloudflare Pages (recommended, easiest)

1. Create a free account at https://github.com and one at https://dash.cloudflare.com.
2. Create a new GitHub repository (private is fine) and push this folder to it:

   ```
   git init
   git add .
   git commit -m "Signup Workbench"
   git branch -M main
   git remote add origin https://github.com/YOURNAME/signup-workbench.git
   git push -u origin main
   ```

3. In Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**, pick the repo.
4. Build settings: Framework preset **Vite**, build command `npm run build`, output directory `dist`.
5. Deploy. You get a free `https://signup-workbench.pages.dev` URL with HTTPS. Every future `git push` redeploys automatically.
6. (Optional, later) Add a custom domain under the project's **Custom domains** tab.

## Deploy free — Option B: Netlify

Same idea: https://app.netlify.com → **Add new site → Import an existing project** → pick the GitHub repo → build command `npm run build`, publish directory `dist`.

## Deploy free — Option C: GitHub Pages

1. Push the repo as above.
2. In the repo, create `.github/workflows/deploy.yml` with:

   ```yaml
   name: Deploy
   on: { push: { branches: [main] } }
   permissions: { contents: read, pages: write, id-token: write }
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20 }
         - run: npm ci && npm run build
         - uses: actions/upload-pages-artifact@v3
           with: { path: dist }
     deploy:
       needs: build
       runs-on: ubuntu-latest
       environment: { name: github-pages }
       steps:
         - uses: actions/deploy-pages@v4
   ```

3. Repo **Settings → Pages → Source: GitHub Actions**. Your site appears at `https://YOURNAME.github.io/signup-workbench/`.

## Working with real data on the live site

- Keep your agency's project file (e.g. `signup-project-*.json`) on your own machines — email/drive it between teammates, never commit it to the repo.
- On the live site: **Load project** → pick the file → work → **Save project** to capture changes.
- The site itself stores nothing; closing the tab discards everything not saved to a file.

## Updating the app

Edit the code (or ask Claude / Claude Code to), commit, and `git push` to keep GitHub in sync — but **pushing does not deploy the live site**. This app is hosted on Cloudflare Workers with no CI hook connected, so you also need to run:

```
npm run deploy
```

locally (requires `npx wrangler login` once, the first time) to actually update `https://signup-workbench.jackson2007.workers.dev`. The whole app lives in `src/App.jsx`; sample data in `src/sampleData.js`.
