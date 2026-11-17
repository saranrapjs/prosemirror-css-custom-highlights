import { defineConfig } from "vitest/config";
import { webdriverio } from "@vitest/browser-webdriverio";

declare module "vitest" {
	interface ProvidedContext {
		fuzzSeeds: number;
		fuzzSteps: number;
		fuzzSeedBase: number | null;
		paintBench: boolean;
		paintBenchRuns: string;
	}
}

// For driving Safari from a Linux machine
const driverHost = process.env.SAFARIDRIVER_HOST;

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 120_000,
		api: driverHost ? { host: "0.0.0.0", port: 63315, strictPort: true } : undefined,
		provide: {
			fuzzSeeds: Number(process.env.FUZZ_SEEDS ?? 0),
			fuzzSteps: Number(process.env.FUZZ_STEPS ?? 2000),
			fuzzSeedBase: process.env.FUZZ_SEED_BASE ? Number(process.env.FUZZ_SEED_BASE) : null,
			paintBench: process.env.PAINT_BENCH === "1",
			paintBenchRuns: process.env.PAINT_BENCH_RUNS ?? "",
		},
		browser: {
			enabled: true,
			headless: false,
			provider: webdriverio(driverHost ? { hostname: driverHost, port: 4444 } : {}),
			instances: [
				{ browser: "safari", name: "safari" },
			],
		},
	},
});
