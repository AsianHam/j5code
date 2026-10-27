import type { VercelConfig } from "@vercel/config/v1";

// The Vercel project's root directory is apps/marketing and deploys come from
// the Git integration on j5/main. Install runs from the workspace root so vp
// resolves the pnpm workspace and its catalog.
export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@t3tools/marketing...'",
  buildCommand: "vp run --filter @t3tools/marketing build",
  outputDirectory: "dist",
  // `curl … | sh` needs the installer served as a plain shell script. Caches may
  // keep it for up to five minutes, so a changed installer reaches everyone
  // within five minutes of a deploy.
  // A thread prompt link, j5.codes/<environment>/<thread>?prompt=…, shows the /new page, which
  // reads the thread from the address. Vercel serves the site's own pages before any rewrite.
  rewrites: [
    {
      source: "/:environment/:thread",
      has: [{ type: "query", key: "prompt" }],
      destination: "/new/index.html",
    },
  ],
  headers: [
    {
      source: "/install.sh",
      headers: [
        { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
        { key: "Cache-Control", value: "public, max-age=300" },
      ],
    },
  ],
};
