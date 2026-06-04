/**
 * backfill-entity-graph.js
 *
 * Populates the v2.0 entity graph (entities / memory_entities / entity_edges)
 * from the people/topics/tags already stored in open_brain.metadata.
 *
 * All the work happens server-side in the rebuild_entity_graph() RPC, which
 * replays every memory through the SAME upsert_memory_entities() path used by
 * the live ingest pipeline (hyper-worker Step 6) — so there is zero drift
 * between backfill and ingest. The rebuild is idempotent: safe to re-run.
 *
 * Usage:
 *   node backfill-entity-graph.js              # live rebuild
 *   node backfill-entity-graph.js --dry-run    # report current graph state, no writes
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function currentCounts() {
  const tables = ['entities', 'memory_entities', 'entity_edges'];
  const counts = {};
  for (const t of tables) {
    const { count, error } = await supabase
      .from(t)
      .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`count(${t}) failed: ${error.message}`);
    counts[t] = count ?? 0;
  }
  return counts;
}

async function distributionByType() {
  // Pull all entity types and tally client-side (dataset is small, ~hundreds).
  const { data, error } = await supabase
    .from('entities')
    .select('entity_type');
  if (error) throw new Error(`distribution query failed: ${error.message}`);
  const dist = {};
  for (const row of data) dist[row.entity_type] = (dist[row.entity_type] || 0) + 1;
  return dist;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n--- Open Brain: Backfill Entity Graph ---`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

  const before = await currentCounts();
  console.log('Current graph state:');
  console.log(`  entities         ${String(before.entities).padStart(5)}`);
  console.log(`  memory_entities  ${String(before.memory_entities).padStart(5)}`);
  console.log(`  entity_edges     ${String(before.entity_edges).padStart(5)}\n`);

  let rebuildResult = null;

  if (dryRun) {
    console.log('Dry run — skipping rebuild_entity_graph(). No writes performed.');
  } else {
    console.log('Calling rebuild_entity_graph()...');
    const { data, error } = await supabase.rpc('rebuild_entity_graph');
    if (error) {
      console.error('rebuild_entity_graph() failed:', error.message);
      process.exit(1);
    }
    rebuildResult = data;
    console.log(
      `Rebuilt: ${data.entities} entities, ${data.links} links, ${data.edges} edges.\n`
    );
  }

  const after = dryRun ? before : await currentCounts();
  const distribution = await distributionByType();

  console.log('Entity distribution by type:');
  for (const [type, count] of Object.entries(distribution).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(10)} ${String(count).padStart(5)}`);
  }

  // Write results file
  const resultsPath = path.join(__dirname, 'backfill-entity-results.json');
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        ran_at: new Date().toISOString(),
        dry_run: dryRun,
        before,
        after,
        rebuild_result: rebuildResult,
        distribution_by_type: distribution,
      },
      null,
      2
    )
  );
  console.log(`\nResults written to ${resultsPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
