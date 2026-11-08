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
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
