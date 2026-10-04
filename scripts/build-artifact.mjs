// Builds a single self-contained HTML fragment (inlined JS + CSS) suitable for
// hosting in a sandboxed page, e.g. a claude.ai Artifact. Output: dist-artifact/hip-templater.html
import { build } from 'vite';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

process.env.VITE_EMBED = '1';
await build({ logLevel: 'warn', build: { outDir: 'dist-artifact/tmp', emptyOutDir: true, modulePreload: false } });

const dir = 'dist-artifact/tmp';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const assets = join(dir, 'assets');
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');

const title = html.match(/<title>.*?<\/title>/s)[0];
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[^>]*src=[^>]*><\/script>/g, '');
const safeJs = js.replace(/<\/script/gi, '<\\/script');
const out = `${title}\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${safeJs}\n</script>\n`;
mkdirSync('dist-artifact', { recursive: true });
writeFileSync('dist-artifact/hip-templater.html', out);
console.log(`dist-artifact/hip-templater.html  ${(out.length / 1024).toFixed(1)} kB`);
