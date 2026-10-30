# Hindsight links

The static page at `r/` reads the payload from the URL fragment. It stores no recording data and makes no third-party requests. The link key is public: encryption provides friction, not access control.

## Local checks

Set `BROWSER_BIN` to a compatible headless browser binary, then run `node --test codec.test.mjs page.test.mjs`. The browser test uses a disposable profile, a random loopback port, and intercepts external destinations; it does not launch the app or contact Drive.

## Moving the page

Publish the page and codec at the new host. Set `newPage` in `forward.mjs` to the new HTTPS page URL, without a fragment. Replace the old `r/index.html` with `forward.html` and put the configured `forward.mjs` alongside it. The forwarder preserves the fragment; the supplied template does nothing until configured.

Do not publish before the required security review.
