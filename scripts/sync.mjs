#!/usr/bin/env node
/**
 * sync.mjs — reads the course JSONBin, visits every topic URL, pulls its
 * metadata, and writes data/content.json.
 *
 * Runs in GitHub Actions. The key lives in repo Secrets and NEVER reaches
 * the browser. The hub only ever reads the generated data/content.json.
 *
 * Env:
 *   JSONBIN_KEY     required — X-Master-Key (or X-Access-Key, see JSONBIN_KEY_TYPE)
 *   JSONBIN_BIN_ID  required — the bin id, e.g. 6aa953c7ac6210605ad0a374
 *   JSONBIN_KEY_TYPE optional — "master" (default) or "access"
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/content.json');

const KEY = process.env.JSONBIN_KEY;
const BIN = process.env.JSONBIN_BIN_ID;
const KEY_TYPE = (process.env.JSONBIN_KEY_TYPE || 'master').toLowerCase();

if (!KEY || !BIN) {
  console.error('Missing JSONBIN_KEY or JSONBIN_BIN_ID. Set them as repo secrets.');
  process.exit(1);
}

const headerName = KEY_TYPE === 'access' ? 'X-Access-Key' : 'X-Master-Key';

/* ---------------------------------------------------------------- helpers */

const decode = (s = '') =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .trim();

/** Pull a <meta> value by property= or name=, order-insensitive. */
function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decode(m[1]);
  }
  return '';
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1].replace(/\s+/g, ' ')) : '';
}

/** Crude but effective: count <section> or <h2> blocks as "sections". */
function countSections(html) {
  const sections = (html.match(/<section\b/gi) || []).length;
  if (sections) return sections;
  return (html.match(/<h2\b/gi) || []).length;
}

function absolutise(src, base) {
  if (!src) return '';
  try { return new URL(src, base).href; } catch { return ''; }
}

const splitList = (s) =>
  (s || '')
    .split(/[,|]/)
    .map((x) => x.trim())
    .filter(Boolean);

/* ------------------------------------------------------------- scrape one */

async function scrape(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'CFBC-CourseHub-Sync/1.0 (+github-actions)' },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const html = await res.text();

    return {
      ok: true,
      status: res.status,
      scraped: {
        title: meta(html, 'og:title') || pageTitle(html),
        description: meta(html, 'og:description') || meta(html, 'description'),
        image: absolutise(meta(html, 'og:image'), url),
        siteName: meta(html, 'og:site_name'),
        themeColor: meta(html, 'theme-color'),
        // custom lesson manifest — every lesson page we build carries these
        duration: meta(html, 'lesson:duration'),
        difficulty: meta(html, 'lesson:difficulty'),
        objectives: meta(html, 'lesson:objectives'),
        questions: meta(html, 'lesson:questions'),
        topics: splitList(meta(html, 'lesson:topics')),
        activities: splitList(meta(html, 'lesson:activities')),
        sections: Number(meta(html, 'lesson:sections')) || countSections(html),
        updated: meta(html, 'lesson:updated'),
      },
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- run it */

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return { topics: [] };
  }
}

async function main() {
  console.log(`Reading bin ${BIN} with ${headerName}…`);

  const binRes = await fetch(`https://api.jsonbin.io/v3/b/${BIN}/latest`, {
    headers: { [headerName]: KEY, 'X-Bin-Meta': 'false' },
  });

  if (!binRes.ok) {
    const body = await binRes.text().catch(() => '');
    console.error(`JSONBin returned ${binRes.status}. ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const raw = await binRes.json();
  // Tolerate both {record:{...}} and a bare object, in case X-Bin-Meta changes.
  const bin = raw.record ?? raw;

  const previous = await loadPrevious();
  const prevById = new Map((previous.topics || []).map((t) => [t.id, t]));

  const inputTopics = Array.isArray(bin.topics) ? bin.topics : [];
  if (!inputTopics.length) console.warn('Warning: bin contains no topics[].');

  const topics = [];
  let failures = 0;

  for (const [i, t] of inputTopics.entries()) {
    const id = t.id || `topic-${i + 1}`;
    const url = (t.url || '').trim();
    process.stdout.write(`  [${i + 1}/${inputTopics.length}] ${id} … `);

    let scraped = {};
    if (url) {
      const result = await scrape(url);
      if (result.ok) {
        scraped = result.scraped;
        console.log('ok');
      } else {
        failures++;
        const fallback = prevById.get(id);
        scraped = fallback ? fallback.meta || {} : {};
        console.log(`FAILED (${result.status || result.error}) — kept previous metadata`);
      }
    } else {
      console.log('no url, skipping fetch');
    }

    topics.push({
      id,
      url,
      // Anything set explicitly in the bin always beats what we scraped.
      title: t.title || scraped.title || id,
      blurb: t.blurb || scraped.description || '',
      number: t.number ?? i + 1,
      status: t.status || 'live',        // live | soon | locked
      tags: t.tags || scraped.topics || [],
      accent: t.accent || '',
      icon: t.icon || '',
      meta: scraped,
      fetchedAt: new Date().toISOString(),
    });
  }

  // Resources are links the bin lists directly (mind maps, simulators, past papers).
  // We try to enrich them with page metadata, but the bin's own values always win —
  // many third-party sites block scrapers or render their title in JavaScript.
  const resources = [];
  for (const [i, r] of (Array.isArray(bin.resources) ? bin.resources : []).entries()) {
    const url = (r.url || '').trim();
    let scraped = {};
    if (url) {
      const result = await scrape(url);
      if (result.ok) scraped = result.scraped;
      console.log(`  resource ${i + 1}: ${result.ok ? 'ok' : 'no metadata, using bin values'}`);
    }
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    resources.push({
      id: r.id || `resource-${i + 1}`,
      url,
      title: r.title || scraped.title || host || 'Resource',
      blurb: r.blurb || scraped.description || '',
      kind: r.kind || '',
      accent: r.accent || '',
      host,
    });
  }

  const out = {
    course: bin.course || {},
    resources,
    generatedAt: new Date().toISOString(),
    sourceBin: BIN,
    topicCount: topics.length,
    failures,
    topics,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${OUT} — ${topics.length} topics, ${failures} fetch failure(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
