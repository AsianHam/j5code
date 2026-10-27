# J5 Code marketing site

The public site for J5 Code at https://j5.codes. This directory replaces upstream's T3 Code
marketing site wholesale (see FORK.md, "Replaced wholesale"); only the fonts and harness marks
are upstream's.

- `vp run dev:marketing` serves it on port 4173.
- `vp run build:marketing` writes `dist/`.
- Deployed by Vercel from this directory; `vercel.ts` carries the install and build commands,
  the headers for `/install.sh`, and the rewrite that shows thread prompt links on `/new`. The Vercel project needs Root Directory `apps/marketing` with
  files outside the root included, because the build reads `FORK.md` and stages
  `scripts/install.sh` from the repository root.

Status words on the site are deliberate: **Shipped** means ready to use, **Charted** means in dry
dock and being built, **Horizon** means on the roadmap. The latest stable release's upstream pin,
its date and the branch it tracks are read from `FORK.md`'s `Released pin:` line at build time.
