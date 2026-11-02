# Rasd / رصد — Egyptian price tracker (GitHub version)

A free website that tracks prices at Egyptian stores, shows record lows and price history, and updates itself.

- **Site:** `index.html` (GitHub Pages)
- **Scraper:** `scraper/scrape.mjs` (runs every hour on GitHub Actions, free for public repositories)
- **Data:** `data/` (written by the scraper, read by the site)
- **No affiliate links.** Links go straight to the store.

## Setup (once) / الإعداد

1. Create a **public** repository on GitHub and upload everything in this folder (keep the `.github/workflows/scrape.yml` path).
   If the upload skips the hidden `.github` folder: *Add file → Create new file*, type `.github/workflows/scrape.yml` as the name and paste the file's content.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write permissions → Save.**
4. **Actions** tab → *Update prices and deploy site* → **Run workflow**.
5. Your site: `https://YOUR-USERNAME.github.io/REPO-NAME/`

## Change the Telegram link / تغيير رابط تيليجرام

Two ways, either one:

- **Edit the file:** open `config.json` on GitHub → pencil icon → change the `"telegram"` value → *Commit changes*. The site redeploys in about a minute.
- **Run workflow form:** Actions → *Update prices and deploy site* → *Run workflow* → type the new link in **New Telegram link**.

Leave `"telegram": ""` empty to hide all Telegram buttons. `facebook` and `whatsapp` work the same way.

## Add products by hand / إضافة منتجات

The scraper finds products by itself. To add specific ones: put links in `watchlist.txt` (one per line, optional `| category`), or use the **Add product links** box in *Run workflow*.

## Check that it works

Open the finished run in the **Actions** tab. The scraper step prints how many products it checked, added, and any errors. Stores change their pages, so some may need small fixes in the `STORES` section at the top of `scraper/scrape.mjs`.

## Notes

- Sample (demo) products show first and disappear automatically once 15 real products have prices.
- Schedule: edit the `cron` line in `.github/workflows/scrape.yml`. GitHub pauses scheduled runs in public repositories after 60 days without repository activity; if that happens, press **Run workflow** once.
- Each update commits the data files, so the repository grows over time.
