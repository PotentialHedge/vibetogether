import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Every page is a directory of its own with an index.html, so that any static
 * server serves `/account` as it is, with no fallback to rewrite paths. */
const pages = [
	"",
	"account/",
	"account/otp/",
	"account/settings/",
	"i/",
	"welcome/",
];

export default defineConfig({
	base: "./",
	build: {
		// The client's module waits for its WebAssembly at the top level.
		target: "es2022",
		rollupOptions: {
			input: Object.fromEntries(
				pages.map((page) => [
					page.replace(/\/$/, "").replaceAll("/", "-") || "home",
					fileURLToPath(new URL(`./${page}index.html`, import.meta.url)),
				]),
			),
		},
	},
	// The backend, which `just backend::dev` serves at 8793, or another chosen
	// with BACKEND.
	server: {
		port: 5173,
		proxy: Object.fromEntries(
			["/api"].map((path) => [
				path,
				process.env.BACKEND ?? "http://127.0.0.1:8793",
			]),
		),
	},
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
