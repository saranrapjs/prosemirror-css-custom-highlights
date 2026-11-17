import { defineConfig } from "vite";
import { resolve } from "node:path";

const demoDir = resolve(import.meta.dirname, "demo");

export default defineConfig({
	root: demoDir,
	// Relative base so the build works under a GitHub Pages project path (/<repo>/)
	base: "./",
	build: {
		outDir: resolve(import.meta.dirname, "demo-dist"),
		emptyOutDir: true,
		rolldownOptions: {
			input: {
				index: resolve(demoDir, "index.html"),
				perf: resolve(demoDir, "perf.html"),
			},
		},
	},
});
