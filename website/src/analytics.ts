/** Counting visits with Umami, Potential Hedge's at analytics.potentialhedge.com, on the
 * site's own host alone. Each page sends its one view itself: a script loaded
 * from Umami would run with the site's whole power.
 *
 * Some addresses of the site carry secrets: an invite's code in /i/<code>, an
 * open session in ?session=, an OTP's code. So Umami gets a
 * page's path and nothing else: no query, no hash, /i/<code> as /i/, and a
 * referrer from another site as its origin. */

const host = "vibetogether.potentialhedge.com";
const umami = "https://analytics.potentialhedge.com/api/send";
const website = "ddd157e7-b8da-48af-ae04-9d1c8e2c3b4f";

/** An address as Umami may see it: this site's path, with an invite's code
 * cut, or another site's origin. */
function clean(address: string): string {
	const url = new URL(address, location.href);
	if (url.origin !== location.origin) return url.origin;
	return url.origin + url.pathname.replace(/\/i\/.*$/, "/i/");
}

if (location.hostname === host) {
	const view = {
		website,
		hostname: host,
		url: clean(location.href),
		referrer: document.referrer && clean(document.referrer),
		title: document.title,
		screen: `${screen.width}x${screen.height}`,
		language: navigator.language,
	};
	fetch(umami, {
		method: "POST",
		keepalive: true,
		credentials: "omit",
		referrerPolicy: "no-referrer",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "event", payload: view }),
	}).catch(() => {});
}
