import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

/**
 * wrangler.jsonc binds KV and D1 by name. A `kv_namespaces` entry with no `id`
 * and a `d1_databases` entry with no `database_id` make `wrangler deploy`
 * reuse the resources the deployed Worker holds under those binding names, and
 * create them where no such Worker exists. An interactive first deploy then
 * writes the IDs it created or connected back into the config file, which is
 * one `git add -A` away from pinning every fork to a single account. This
 * suite reads the committed file through wrangler's own parser and refuses any
 * ID it finds.
 *
 * The `.node.` infix routes this file to the plain node pool, because workerd
 * backs node:fs with a virtual filesystem and cannot read a repository file
 * off disk.
 */

/**
 * Paths are strings rather than URL instances: this project's types carry both
 * the Workers URL and node's, and wrangler's reader accepts only the second.
 */
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');

/** One binding entry: the name the Worker sees, plus whatever else the file says about it. */
interface BindingEntry {
  readonly binding: string;
  readonly [field: string]: unknown;
}

/** The two binding lists wrangler provisions on deploy, as read from the committed file. */
interface ProvisionableBindings {
  readonly kv_namespaces: readonly BindingEntry[];
  readonly d1_databases: readonly BindingEntry[];
}

/**
 * The committed configuration as wrangler reads it for a deploy. The read
 * validates the file on the way through, so a config wrangler would refuse
 * fails here before it fails a deploy.
 */
const config: ProvisionableBindings = unstable_readConfig({ config: CONFIG_PATH });

/** Every field that would pin a binding to one account's resource. */
const pinningFields = [
  { list: 'kv_namespaces', field: 'id' },
  { list: 'kv_namespaces', field: 'preview_id' },
  { list: 'd1_databases', field: 'database_id' },
] as const;

describe('wrangler.jsonc', () => {
  it.each(pinningFields)('carries no $field under $list', ({ list, field }) => {
    const entries = config[list];
    expect(entries.length, `wrangler.jsonc declares no ${list}, so this check asserts nothing`).toBeGreaterThan(0);

    const pinned = entries.filter((entry) => entry[field] !== undefined).map((entry) => entry.binding);
    expect(
      pinned,
      `wrangler.jsonc sets ${field} on ${pinned.join(', ')}. The committed config binds by name, and a deploy writes IDs only into a local copy: discard them with \`git checkout -- wrangler.jsonc\``,
    ).toEqual([]);
  });
});
