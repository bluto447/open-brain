#!/usr/bin/env node

/**
 * notion-sync.js
 *
 * Syncs entries from the Notion Session Log database into the Supabase
 * open_brain table. For each session:
 *   1. Fetches page content from Notion (title + rich-text blocks)
 *   2. Generates an embedding via OpenAI text-embedding-3-small
 *   3. Extracts structured metadata (tags, topics, people, action_items) via gpt-4o-mini
 *   4. Upserts the result into Supabase, deduplicating on session title + date
 *
 * Usage:
 *   node notion-sync.js           # Only sync new entries since last run
 *   node notion-sync.js --full    # Force re-sync all entries
 *
 * Required environment variables (see .env.example):
 *   NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const { Client: NotionClient }  = require('@notionhq/client');
const { createClient }          = require('@supabase/supabase-js');
const OpenAI                    = require('openai');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NOTION_DATABASE_ID = '746da027-1b1b-4799-a122-3510c71e2395';
const LAST_SYNC_FILE     = path.join(__dirname, '.last-sync');
const RATE_LIMIT_MS      = 1000; // 1 second between Notion API calls
const SOURCE             = 'notion';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args     = process.argv.slice(2);
const FULL_SYNC = args.includes('--full');

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  'NOTION_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[ERROR] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Client initialisation
// ---------------------------------------------------------------------------

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the last-sync timestamp from disk.
 * Returns null if the file does not exist or cannot be parsed.
 */
function readLastSync() {
  try {
    const raw = fs.readFileSync(LAST_SYNC_FILE, 'utf8').trim();
    const ts  = new Date(raw);
    if (isNaN(ts.getTime())) return null;
    return ts.toISOString();
  } catch {
    return null;
  }
}

/** Persist the current UTC timestamp to .last-sync. */
function writeLastSync() {
  fs.writeFileSync(LAST_SYNC_FILE, new Date().toISOString(), 'utf8');
}

/**
 * Flatten a Notion rich-text array into a plain string.
 * @param {Array} richTextArr - The rich_text array from a Notion property or block.
 */
function richTextToString(richTextArr = []) {
  return richTextArr.map((rt) => rt.plain_text || '').join('');
}

/**
 * Extract the page title from a Notion page object.
 * Notion stores titles under the "title" property type.
 */
function getPageTitle(page) {
  // The Session field is the title property — find it regardless of its key name.
  for (const [, prop] of Object.entries(page.properties)) {
    if (prop.type === 'title') {
      return richTextToString(prop.title);
    }
  }
  return '(Untitled)';
}

/**
 * Pull plain text from a Notion property by name.
 * Handles rich_text and title property types.
 */
function getPropertyText(page, propertyName) {
  const prop = page.properties[propertyName];
  if (!prop) return '';

  switch (prop.type) {
    case 'title':
      return richTextToString(prop.title);
    case 'rich_text':
      return richTextToString(prop.rich_text);
    default:
      return '';
  }
}

/**
 * Retrieve the last-edited date of a Notion page as an ISO string.
 */
function getPageDate(page) {
  return page.last_edited_time || page.created_time || new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all pages from the Session Log database.
 * If `sinceIso` is provided, filters to pages edited after that timestamp.
 *
 * @param {string|null} sinceIso - ISO 8601 timestamp or null for all pages.
 * @returns {Promise<Array>} Array of Notion page objects.
 */
async function fetchNotionPages(sinceIso) {
  const pages  = [];
  let cursor   = undefined;
  let pageNum  = 0;

  const filter = sinceIso
    ? {
        timestamp: 'last_edited_time',
        last_edited_time: { after: sinceIso },
      }
    : undefined;

  console.log(
    sinceIso
      ? `[Notion] Fetching pages edited after ${sinceIso}…`
      : '[Notion] Fetching ALL pages (full sync)…'
  );

  do {
    const response = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter,
      start_cursor: cursor,
      page_size: 100,
    });

    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
    pageNum++;

    console.log(
      `[Notion] Page ${pageNum}: retrieved ${response.results.length} entries (total so far: ${pages.length})`
    );

    if (response.has_more) {
      await sleep(RATE_LIMIT_MS);
    }
  } while (cursor);

  return pages;
}

/**
 * Fetch all block children for a Notion page and extract plain text.
 * Only paragraph, heading, and bulleted/numbered list blocks are included.
 *
 * @param {string} pageId - Notion page ID.
 * @returns {Promise<string>} Concatenated plain text of the page body.
 */
async function fetchPageBodyText(pageId) {
  const lines  = [];
  let cursor   = undefined;

  const SUPPORTED_BLOCK_TYPES = new Set([
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'toggle',
    'quote',
    'callout',
  ]);

  do {
    const response = await notion.blocks.children.list({
      block_id:     pageId,
      start_cursor: cursor,
      page_size:    100,
    });

    for (const block of response.results) {
      if (SUPPORTED_BLOCK_TYPES.has(block.type)) {
        const blockData = block[block.type];
        if (blockData && blockData.rich_text) {
          const text = richTextToString(blockData.rich_text).trim();
          if (text) lines.push(text);
        }
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
    if (response.has_more) await sleep(RATE_LIMIT_MS);
  } while (cursor);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

/**
 * Generate an embedding for the given text using text-embedding-3-small.
 *
 * @param {string} text - Text to embed.
 * @returns {Promise<number[]>} Embedding vector.
 */
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Use gpt-4o-mini to extract structured metadata from a session content string.
 *
 * @param {string} sessionTitle - The session name.
 * @param {string} content      - Full combined content string.
 * @returns {Promise<Object>}   { tags, topics, people, action_items }
 */
async function extractMetadata(sessionTitle, content) {
  const systemPrompt = `You are a metadata extractor for personal knowledge management.
Given the content of a session log entry, extract the following as JSON:
- tags: string[] — short descriptive tags (max 8, lowercase, no spaces — use hyphens)
- topics: string[] — broader topic areas covered (max 5)
- people: string[] — names of people mentioned
- action_items: string[] — concrete action items or next steps mentioned

Respond ONLY with valid JSON matching this schema:
{
  "tags": ["string"],
  "topics": ["string"],
  "people": ["string"],
  "action_items": ["string"]
}`;

  const userPrompt = `Session: ${sessionTitle}\n\n${content}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content);
    return {
      tags:         Array.isArray(parsed.tags)         ? parsed.tags         : [],
      topics:       Array.isArray(parsed.topics)       ? parsed.topics       : [],
      people:       Array.isArray(parsed.people)       ? parsed.people       : [],
      action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    };
  } catch (err) {
    console.warn('[OpenAI] Failed to parse metadata JSON:', err.message);
    return { tags: [], topics: [], people: [], action_items: [] };
  }
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a single entry into the open_brain table.
 * Deduplication key: metadata->>'notion_session_id'
 *
 * @param {Object} entry - The record to upsert.
 */
async function upsertEntry(entry) {
  // Use the notion_session_id stored inside metadata as the logical dedup key.
  // We rely on the Supabase upsert with onConflict targeting a unique index or
  // handle via delete + insert pattern with a select-first check.
  //
  // Strategy: check if a row with this notion_session_id already exists,
  // then update it; otherwise insert.

  const notionSessionId = entry.metadata.notion_session_id;

  // Check for existing row
  const { data: existing, error: selectErr } = await supabase
    .from('open_brain')
    .select('id')
    .eq('source', SOURCE)
    .filter('metadata->>notion_session_id', 'eq', notionSessionId)
    .maybeSingle();

  if (selectErr) {
    throw new Error(`Supabase select failed: ${selectErr.message}`);
  }

  if (existing) {
    // Update existing row
    const { error: updateErr } = await supabase
      .from('open_brain')
      .update({
        content:   entry.content,
        embedding: entry.embedding,
        metadata:  entry.metadata,
        source:    SOURCE,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (updateErr) throw new Error(`Supabase update failed: ${updateErr.message}`);
    return 'updated';
  } else {
    // Insert new row
    const { error: insertErr } = await supabase
      .from('open_brain')
      .insert({
        content:   entry.content,
        embedding: entry.embedding,
        metadata:  entry.metadata,
        source:    SOURCE,
      });

    if (insertErr) throw new Error(`Supabase insert failed: ${insertErr.message}`);
    return 'inserted';
  }
}

// ---------------------------------------------------------------------------
// Per-page processing
// ---------------------------------------------------------------------------

/**
 * Process a single Notion page end-to-end.
 *
 * @param {Object} page - Notion page object from the database query.
 * @returns {Promise<'inserted'|'updated'|'skipped'>}
 */
async function processPage(page) {
  const sessionTitle = getPageTitle(page);
  const pageDate     = getPageDate(page);

  // Build a stable dedup key from title + created_time
  const notionSessionId = `${page.id}`;

  console.log(`  → Processing: "${sessionTitle}" (${page.id})`);

  // ── 1. Extract inline property text ──────────────────────────────────────
  const whatWeDid      = getPropertyText(page, 'What We Did');
  const decisionsMade  = getPropertyText(page, 'Decisions Made');
  const nextSteps      = getPropertyText(page, 'Next Steps');

  // ── 2. Fetch full page body blocks ───────────────────────────────────────
  await sleep(RATE_LIMIT_MS);
  let bodyText = '';
  try {
    bodyText = await fetchPageBodyText(page.id);
  } catch (err) {
    console.warn(`  [WARN] Could not fetch body blocks for "${sessionTitle}": ${err.message}`);
  }

  // ── 3. Combine into a single content string ───────────────────────────────
  const parts = [`# ${sessionTitle}`];

  if (whatWeDid)     parts.push(`## What We Did\n${whatWeDid}`);
  if (decisionsMade) parts.push(`## Decisions Made\n${decisionsMade}`);
  if (nextSteps)     parts.push(`## Next Steps\n${nextSteps}`);
  if (bodyText)      parts.push(`## Session Notes\n${bodyText}`);

  const content = parts.join('\n\n').trim();

  if (!content || content === `# ${sessionTitle}`) {
    console.log(`  [SKIP] No content found for "${sessionTitle}"`);
    return 'skipped';
  }

  // ── 4. Generate embedding ─────────────────────────────────────────────────
  let embedding;
  try {
    embedding = await generateEmbedding(content);
  } catch (err) {
    throw new Error(`Embedding generation failed: ${err.message}`);
  }

  // ── 5. Extract metadata ───────────────────────────────────────────────────
  let extractedMeta;
  try {
    extractedMeta = await extractMetadata(sessionTitle, content);
  } catch (err) {
    console.warn(`  [WARN] Metadata extraction failed for "${sessionTitle}": ${err.message}`);
    extractedMeta = { tags: [], topics: [], people: [], action_items: [] };
  }

  // ── 6. Build the record ───────────────────────────────────────────────────
  const entry = {
    content,
    embedding,
    source: SOURCE,
    metadata: {
      notion_session_id: notionSessionId,
      notion_page_id:    page.id,
      session_title:     sessionTitle,
      session_date:      pageDate,
      tags:              extractedMeta.tags,
      topics:            extractedMeta.topics,
      people:            extractedMeta.people,
      action_items:      extractedMeta.action_items,
      synced_at:         new Date().toISOString(),
    },
  };

  // ── 7. Upsert into Supabase ───────────────────────────────────────────────
  const result = await upsertEntry(entry);
  console.log(`  [${result.toUpperCase()}] "${sessionTitle}"`);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('  Notion → Open Brain Sync');
  console.log(`  Mode: ${FULL_SYNC ? 'FULL (re-sync everything)' : 'INCREMENTAL'}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  // Determine since-timestamp
  const sinceIso = FULL_SYNC ? null : readLastSync();
  if (!FULL_SYNC && sinceIso) {
    console.log(`[Sync] Last sync was at: ${sinceIso}`);
  } else if (!FULL_SYNC) {
    console.log('[Sync] No .last-sync file found — fetching all pages this run.');
  }

  // Fetch pages from Notion
  let pages;
  try {
    pages = await fetchNotionPages(sinceIso);
  } catch (err) {
    console.error('[ERROR] Failed to fetch pages from Notion:', err.message);
    process.exit(1);
  }

  if (pages.length === 0) {
    console.log('[Sync] No new or updated entries found. Nothing to do.');
    writeLastSync();
    return;
  }

  console.log(`\n[Sync] Processing ${pages.length} page(s)…\n`);

  // Process each page
  const stats = { inserted: 0, updated: 0, skipped: 0, errored: 0 };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    console.log(`[${i + 1}/${pages.length}]`);

    try {
      const result = await processPage(page);
      stats[result]++;
    } catch (err) {
      console.error(`  [ERROR] Failed to process page ${page.id}: ${err.message}`);
      stats.errored++;
    }

    // Rate-limit between pages (already rate-limited inside per-page calls,
    // but this adds a buffer between full page processing cycles)
    if (i < pages.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Persist last-sync timestamp
  writeLastSync();

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  Sync Complete');
  console.log(`  Inserted : ${stats.inserted}`);
  console.log(`  Updated  : ${stats.updated}`);
  console.log(`  Skipped  : ${stats.skipped}`);
  console.log(`  Errored  : ${stats.errored}`);
  console.log(`  Finished : ${new Date().toISOString()}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
