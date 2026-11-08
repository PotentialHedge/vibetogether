import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Every page is a directory of its own with an index.html, so that any static
 * server serves `/start` as it is, with no fallback to rewrite paths. */
const pages = [
	"",
	"how-it-works/",
	"start/",
	"account/",
	"account/sign-in/",
	"account/consent/",
	"account/device/",
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
	// The account service, as `just dev` in vibetogether-accounts serves it.
	server: {
		port: 5173,
		proxy: Object.fromEntries(
			["/api", "/.well-known"].map((path) => [path, "http://127.0.0.1:8793"]),
		),
	},
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
