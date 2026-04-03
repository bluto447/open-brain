/**
 * backfill-memory-types.js
 *
 * Classifies all existing memories that still have the default 'semantic' type.
 * Uses gpt-4o-mini with the same prompt as the hyper-worker Edge Function.
 *
 * Usage:
 *   node backfill-memory-types.js              # full run
 *   node backfill-memory-types.js --dry-run    # log only, no writes
 *   node backfill-memory-types.js --ids 1,2,3  # process specific IDs
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 200;
const VALID_MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'preference', 'decision'];

const SYSTEM_PROMPT = `You are a memory classification assistant. Given a piece of text, classify it into exactly one memory type. Return ONLY valid JSON with a single "memory_type" field.

Memory types:
- episodic: A specific event, session, meeting, or experience with a time/place context. Example: "Met with Alice on Tuesday to discuss the roadmap."
- semantic: A fact, concept, or general knowledge not tied to a specific event. Example: "Supabase uses PostgreSQL under the hood."
- procedural: A how-to, process, workflow, or set of steps. Example: "To deploy, run supabase functions deploy."
- preference: A personal preference, opinion, or value judgment. Example: "I prefer dark mode for coding."
- decision: A choice that was made, with or without rationale. Example: "We decided to use pgvector instead of Pinecone."

Example output: {"memory_type": "semantic"}`;

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const idsFlag = args.find(a => a.startsWith('--ids'));
const specificIds = idsFlag
  ? args[args.indexOf(idsFlag) + 1]?.split(',').map(Number).filter(n => !isNaN(n))
  : null;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Classification (mirrors hyper-worker/index.ts:172-219)
// ---------------------------------------------------------------------------

async function classifyMemoryType(content) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);

  if (VALID_MEMORY_TYPES.includes(parsed.memory_type)) {
    return parsed.memory_type;
  }

  throw new Error(`Invalid type returned: ${parsed.memory_type}`);
}

// ---------------------------------------------------------------------------
// Batch processor
// ---------------------------------------------------------------------------

async function processBatch(batch) {
  return Promise.all(batch.map(async (memory) => {
    try {
      const newType = await classifyMemoryType(memory.content);

      if (!dryRun) {
        const { error } = await supabase
          .from('open_brain')
          .update({ memory_type: newType })
          .eq('id', memory.id);

        if (error) throw new Error(`Supabase update failed: ${error.message}`);
      }

      return { id: memory.id, old_type: memory.memory_type, new_type: newType, status: 'ok' };
    } catch (err) {
      return { id: memory.id, old_type: memory.memory_type, new_type: null, status: 'error', error: err.message };
    }
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n--- Open Brain: Backfill Memory Types ---`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (specificIds) console.log(`Targeting IDs: ${specificIds.join(', ')}`);
  console.log('');

  // Fetch memories to classify
  let query = supabase
    .from('open_brain')
    .select('id, content, memory_type')
    .is('valid_to', null)
    .order('id');

  if (specificIds) {
    query = query.in('id', specificIds);
  } else {
    query = query.eq('memory_type', 'semantic');
  }

  const { data: memories, error } = await query;

  if (error) {
    console.error('Failed to fetch memories:', error.message);
    process.exit(1);
  }

  console.log(`Found ${memories.length} memories to classify.\n`);

  if (memories.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Process in batches
  const results = [];
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(memories.length / BATCH_SIZE);

    process.stdout.write(`Batch ${batchNum}/${totalBatches}...`);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);

    const ok = batchResults.filter(r => r.status === 'ok').length;
    const fail = batchResults.filter(r => r.status === 'error').length;
    console.log(` ${ok} ok, ${fail} failed`);

    if (i + BATCH_SIZE < memories.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Summary
  const succeeded = results.filter(r => r.status === 'ok');
  const failed = results.filter(r => r.status === 'error');

  const counts = {};
  for (const type of VALID_MEMORY_TYPES) counts[type] = 0;
  for (const r of succeeded) counts[r.new_type]++;

  console.log(`\n--- Classification Results ---`);
  for (const [type, count] of Object.entries(counts)) {
    const pct = memories.length > 0 ? ((count / memories.length) * 100).toFixed(1) : '0.0';
    console.log(`  ${type.padEnd(12)} ${String(count).padStart(4)}  (${pct}%)`);
  }
  if (failed.length > 0) {
    console.log(`  ${'failed'.padEnd(12)} ${String(failed.length).padStart(4)}  (${((failed.length / memories.length) * 100).toFixed(1)}%)`);
    console.log(`\nFailed memories:`);
    for (const f of failed) {
      console.log(`  ID ${f.id}: ${f.error}`);
    }
  }

  // Write results file
  const resultsPath = path.join(__dirname, 'backfill-results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({
    ran_at: new Date().toISOString(),
    dry_run: dryRun,
    total: memories.length,
    succeeded: succeeded.length,
    failed: failed.length,
    distribution: counts,
    results,
  }, null, 2));
  console.log(`\nResults written to ${resultsPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
