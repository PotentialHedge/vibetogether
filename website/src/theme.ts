/** The site's theme: the system's by default, or light or dark as the person
 * chose, remembered per browser. The CSS follows the system on its own; a
 * choice only adds `light` or `dark` to the root. */

import { useState } from "react";

export type Theme = "system" | "light" | "dark";

const key = "theme";

function stored(): Theme {
	try {
		const theme = localStorage.getItem(key);
		if (theme === "light" || theme === "dark") return theme;
	} catch {}
	return "system";
}

function apply(theme: Theme) {
	const root = document.documentElement.classList;
	root.toggle("light", theme === "light");
	root.toggle("dark", theme === "dark");
}

apply(stored());

/** The theme, and choosing it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
	const [theme, setTheme] = useState(stored);
	return [
		theme,
		(theme) => {
			try {
				if (theme === "system") localStorage.removeItem(key);
				else localStorage.setItem(key, theme);
			} catch {}
			apply(theme);
			setTheme(theme);
		},
	];
}
