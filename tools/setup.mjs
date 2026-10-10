// One-command workspace for the jacob.gg games on any computer:
//   git clone https://github.com/biccyanzac-pixel/jacob.gg && cd jacob.gg && npm run setup
//
// - clones every game in games.json (live and in development) next to this folder, so ../<game> works the same
//   on every machine; games already there are pulled, but only when they have nothing uncommitted
// - installs the daily-games skill (.claude/skills/daily-games) into this computer's ~/.claude/skills, so Claude
//   finds it whichever game folder a session starts in
// - `npm run setup -- --install` also runs npm install in every repo (and worker/) that has a package.json
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PARENT = path.dirname(HUB);
const install = process.argv.includes('--install');
const manifest = JSON.parse(fs.readFileSync(path.join(HUB, 'games.json'), 'utf8'));
const repos = [...manifest.games, ...(manifest.inDevelopment || [])];

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const results = [];

for (const g of repos) {
  const dir = path.join(PARENT, g.id);
  try {
    if (!fs.existsSync(dir)) {
      git(['clone', `https://github.com/${g.repo}.git`, dir], PARENT);
      results.push([g.id, 'cloned']);
    } else if (!fs.existsSync(path.join(dir, '.git'))) {
      results.push([g.id, `SKIPPED: ${dir} exists but is not a git repo`]);
      continue;
    } else if (git(['status', '--porcelain'], dir)) {
      results.push([g.id, 'not pulled: has uncommitted changes (someone may be working in it)']);
    } else {
      const before = git(['rev-parse', 'HEAD'], dir);
      git(['pull', '--ff-only', '--quiet'], dir);
      results.push([g.id, before === git(['rev-parse', 'HEAD'], dir) ? 'up to date' : 'pulled']);
    }
    // every game commits as the owner's GitHub identity (repo-local, so it never touches global git config)
    git(['config', 'user.name', 'biccyanzac-pixel'], dir);
    git(['config', 'user.email', '285977456+biccyanzac-pixel@users.noreply.github.com'], dir);
  } catch (e) {
    results.push([g.id, `FAILED: ${(e.stderr || e.message).toString().trim().split('\n').pop()}`]);
  }
}
git(['config', 'user.name', 'biccyanzac-pixel'], HUB);
git(['config', 'user.email', '285977456+biccyanzac-pixel@users.noreply.github.com'], HUB);

// the skill, for sessions started in any game folder on this computer
const skillSrc = path.join(HUB, '.claude', 'skills', 'daily-games');
const skillDst = path.join(os.homedir(), '.claude', 'skills', 'daily-games');
fs.mkdirSync(skillDst, { recursive: true });
for (const f of fs.readdirSync(skillSrc)) fs.copyFileSync(path.join(skillSrc, f), path.join(skillDst, f));
results.push(['daily-games skill', `installed in ${skillDst}`]);

if (install) {
  for (const dir of [HUB, ...repos.map((g) => path.join(PARENT, g.id))]) {
    for (const sub of ['.', 'worker']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(path.join(d, 'package.json'))) continue;
      try {
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: d, stdio: 'ignore', shell: process.platform === 'win32' });
        results.push([path.relative(PARENT, d), 'npm install ok']);
      } catch {
        results.push([path.relative(PARENT, d), 'npm install FAILED (run it there by hand)']);
      }
    }
  }
}

const w = Math.max(...results.map(([k]) => k.length));
console.log(`\njacob.gg workspace in ${PARENT}\n`);
for (const [k, v] of results) console.log(`  ${k.padEnd(w)}  ${v}`);
console.log(`
Next:
  - open jacob.gg/jacob.gg.code-workspace in VS Code to see the hub and every game in one window
  - deploying needs, once per computer:  git push access to github.com/biccyanzac-pixel  and  npx wrangler login
  - house rules and how-to: jacob.gg/PLAYBOOK.md
`);
