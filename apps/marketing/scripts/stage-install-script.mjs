// The site serves the repo's scripts/install.sh at /install.sh, so it is copied
// (gitignored) into public/ before every dev server and build. A missing source
// (say, a Vercel build without files outside the root directory) fails loudly
// rather than deploying a dead URL.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.dirname(NodePath.dirname(marketingDir));
const source = NodePath.join(repoRoot, "scripts", "install.sh");
const publicDir = NodePath.join(marketingDir, "public");

if (!NodeFS.existsSync(source)) {
  console.error(`stage-install-script: ${source} is missing; the site cannot serve /install.sh`);
  process.exit(1);
}
NodeFS.mkdirSync(publicDir, { recursive: true });
NodeFS.copyFileSync(source, NodePath.join(publicDir, "install.sh"));
