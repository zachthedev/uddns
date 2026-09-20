import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The real migrations, handed to the test worker so a suite can build the
// schema the deployment actually runs rather than a copy of it that drifts.
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
	test: {
		// Two pools, because workerd backs node:fs with a virtual filesystem and
		// cannot read a repository file off disk. A suite that asserts on what a
		// committed file says has to run outside the Worker, so a `.node.` infix
		// in the filename is what routes it to the plain node pool.
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: './wrangler.jsonc' },
						miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
					}),
				],
				test: {
					name: 'workers',
					include: ['tests/**/*.test.ts'],
					exclude: ['tests/**/*.node.test.ts'],
					// The first Durable Object call in a run pays for the namespace
					// starting up, which can outlast the 5s default on a cold or
					// loaded machine.
					testTimeout: 15_000,
				},
			},
			{
				test: {
					name: 'node',
					include: ['tests/**/*.node.test.ts'],
				},
			},
		],
		coverage: {
			provider: 'istanbul',
			reporter: ['text', 'json-summary', 'json'],
			reportOnFailure: true,
			include: ['src/**/*.ts'],
		},
	},
});
