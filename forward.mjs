// Set this to the new HTTPS page URL before replacing the old page.
const newPage = '';
if (window.top === window.self && newPage) {
  location.replace(newPage + location.hash);
}
