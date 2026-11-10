import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Every page is a directory of its own with an index.html, so that any static
 * server serves `/account` as it is, with no fallback to rewrite paths. */
const pages = [
	"",
	"account/",
	"account/sign-in/",
	"account/consent/",
	"account/device/",
	"account/session/",
];

export default defineConfig({
	base: "./",
	build: {
		rollupOptions: {
			input: Object.fromEntries(
				pages.map((page) => [
					page.replace(/\/$/, "").replaceAll("/", "-") || "home",
					fileURLToPath(new URL(`./${page}index.html`, import.meta.url)),
				]),
			),
		},
	},
	// The account service: `just dev` in vibetogether-accounts serves it at
	// 8793, `just stack` at 8798, chosen with ACCOUNTS.
	server: {
		port: 5173,
		proxy: Object.fromEntries(
			["/api", "/.well-known"].map((path) => [
				path,
				process.env.ACCOUNTS ?? "http://127.0.0.1:8793",
			]),
		),
	},
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
