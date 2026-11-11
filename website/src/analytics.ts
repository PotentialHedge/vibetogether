/** Counting visits with Umami, self-hosted at umami.potentialhedge.com, on the
 * site's own host alone. Each page sends its one view itself: a script loaded
 * from Umami would run with the site's whole power.
 *
 * Some addresses of the site carry secrets: an invite's code in /i/<code>, an
 * open session in ?session=, an OTP's code, an OAuth request. So Umami gets a
 * page's path and nothing else: no query, no hash, /i/<code> as /i/, and a
 * referrer from another site as its origin. */

const host = "vibetogether.potentialhedge.com";
const umami = "https://umami.potentialhedge.com/api/send";
const website = "f8b0bbb7-6350-45ca-aca3-6d673f4f9f54";

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
